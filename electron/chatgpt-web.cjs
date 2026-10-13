/*
 * 用法：由 main.cjs 的桌面桥调用 createChatGPTWeb({ app, window, WebContentsView, ipcMain })。
 * 只在主进程操作独立的 ChatGPT 页面；网页没有 preload 和本地服务凭据。
 */
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { PROJECT_NAME, INSTRUCTIONS, projectPage, mergeInstructions } = require("./chatgpt-project.cjs");

const { readAnswer, createAnswerGate } = require("./chatgpt-answer.cjs");

const URL_HOME = "https://chatgpt.com/";
const CLOSE_URL = "https://easyread.invalid/close-chatgpt";
const TOOLBAR_HEIGHT = 44;
const GRIP_WIDTH = 10;
const COLLAPSE_WIDTH = 160;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 项目聊天地址可能带项目名 slug；必须匹配项目 ID，普通 /c/ 会话不能用于翻译。
function inProject(url, projectURL, conversation = false) {
  try {
    const project = new URL(projectURL), current = new URL(url);
    const id = project.pathname.match(/^\/g\/(g-p-[^/]+)\/project\/?$/)?.[1];
    if (!id || project.origin !== URL_HOME.slice(0, -1) || current.origin !== project.origin) return false;
    const segment = current.pathname.split('/')[2];
    return (segment === id || segment?.startsWith(id + '-')) &&
      (conversation ? /^\/g\/[^/]+\/c\/[^/]+\/?$/.test(current.pathname) :
        current.pathname === project.pathname || /^\/g\/[^/]+\/c\/[^/]+\/?$/.test(current.pathname));
  } catch (_) { return false; }
}

// 此函数序列化后在 ChatGPT 网页内执行；菜单可能由 Radix portal 挂在页面末尾。
async function modelMenu(action, wanted) {
  const visible = el => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const label = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || "")
    .split("\n").map(x => x.trim()).find(Boolean) || "";
  let button;
  for (let attempt = 0; attempt < 240; attempt++) {
    // 优先采用顶部模型入口，避免侧栏的 ChatGPT 导航按钮被误当成模型菜单。
    button = [...document.querySelectorAll('button[aria-label="选择 ChatGPT 模型"],button[aria-label="Choose ChatGPT model"],button[aria-label="Select ChatGPT model"]')].find(visible) ||
      [...document.querySelectorAll('[data-testid*="model-switcher"]')].find(visible) ||
      [...document.querySelectorAll('main button[aria-haspopup],main [role="button"][aria-haspopup]')]
      .filter(visible).find(el =>
        /model|gpt|chatgpt|auto|instant|thinking|模型|思考|自动/i.test(
          `${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-testid") || ""} ${label(el)}`));
    if (button) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!button) throw new Error("找不到 ChatGPT 模型按钮，请在内置网页检查顶部模型菜单");
  const current = label(button);
  if (action === "button") {
    const r = button.getBoundingClientRect();
    return { current, expanded: button.getAttribute("aria-expanded") === "true", x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  if (action === "select" && current === wanted) return { current, models: [{ name: wanted, selected: true }] };
  if (button.getAttribute("aria-expanded") !== "true") {
    // Radix 菜单使用 pointerdown 打开；等待展开后再决定是否需要 click。
    if (typeof PointerEvent !== 'undefined' && button.dispatchEvent) {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }));
      button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0 }));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (button.getAttribute("aria-expanded") !== "true") button.click();
  }
  let items = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 250));
    const controlled = document.getElementById(button.getAttribute("aria-controls") || "");
    const popups = [...document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper], [data-testid*="model-switcher-menu"]')]
      .filter(visible);
    const root = controlled && visible(controlled) ? controlled : popups.at(-1) || document;
    let choices = [...root.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"]')];
    // 网页有时把模型项渲染为普通 button；只在已经识别到弹层时启用回退。
    if (!choices.length && root !== document) choices = [...root.querySelectorAll('button,[data-testid*="model"],[tabindex="0"]')];
    items = choices
      .filter(el => visible(el) && el.getAttribute("aria-disabled") !== "true")
      .map(el => ({ element: el, name: label(el), selected: el.getAttribute("aria-checked") === "true" ||
        el.getAttribute("aria-selected") === "true" || el.getAttribute("data-state") === "checked" }))
      .filter(item => item.name && item.name.length < 100);
    if (items.length) break;
  }
  if (!items.length) throw new Error("模型菜单已打开，但找不到可读取的选项；请检查网页是否仍在加载");
  if (action === "select") {
    const item = items.find(entry => entry.name === wanted);
    if (!item) throw new Error(`当前账号不可选模型：${wanted}`);
    // 读取与选择在同一次菜单操作中完成；重复点击已选项可能开启新会话。
    if (!item.selected) {
      item.element.click();
      return { current, changed: true };
    }
  }
  // Escape 同时关闭 Radix 菜单和普通弹层，不再次触发模型入口。
  if (button.dispatchEvent && typeof KeyboardEvent !== 'undefined')
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  else button.click();
  return { current, models: [...new Map(items.map(({ name, selected }) => [name, { name, selected }])).values()] };
}

// 发送按钮在不同网页版本中的属性不同；只检查输入框所在的编辑区，避免点到其他按钮。
function composerSend(action) {
  const box = document.querySelector('[data-testid="prompt-textarea"], #prompt-textarea, [contenteditable="true"][role="textbox"]');
  if (!box) return { found: false, ready: false };
  const visible = el => {
    const rect = el.getBoundingClientRect();
    // 网页保留了屏幕外的备用提交按钮，正尺寸不代表按钮位于可点击区域。
    return rect.width > 0 && rect.height > 0 && rect.left + rect.width > 0 && rect.top + rect.height > 0 &&
      rect.left >= 0 && rect.top >= 0 && rect.left < (globalThis.innerWidth ?? Infinity) &&
      rect.top < (globalThis.innerHeight ?? Infinity);
  };
  const named = button => /send|submit|发送|提交/i.test(
    [button.getAttribute('data-testid'), button.getAttribute('aria-label'), button.getAttribute('title')].filter(Boolean).join(' '));
  let button, submit;
  for (let root = box.parentElement, depth = 0; root && depth < 8 && !button; root = root.parentElement, depth++) {
    const buttons = [...root.querySelectorAll('button')].filter(visible);
    button = buttons.find(named);
    submit ||= buttons.find(b => b.type === 'submit');
  }
  button ||= submit;
  if (!button) return { found: false, ready: false };
  const ready = !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  const rect = button.getBoundingClientRect();
  if (action === "submit" && ready) {
    // 通过表单触发网页自身的 onSubmit，保留校验和 submitter；长草稿无需依赖鼠标坐标。
    if (button.form && button.type === 'submit') button.form.requestSubmit(button);
    else button.click();
  }
  return { found: true, ready, x: rect.left + Math.min(4, rect.width / 2), y: rect.top + rect.height / 2 };
}

// 富文本编辑器可能把换行拆成多个段落；核对非空白字符，确保正文完整且不会因排版差异误报。
function promptMatches(text) {
  const host = document.querySelector('[data-testid="prompt-textarea"], #prompt-textarea, [contenteditable="true"][role="textbox"]');
  const box = host?.matches('textarea, [contenteditable="true"]') ? host :
    host?.querySelector('textarea, [contenteditable="true"]');
  if (!box) return { correct: false, actualLength: 0, expectedLength: text.length };
  const actual = box.value ?? box.innerText ?? box.textContent ?? '';
  const normalize = value => String(value).normalize('NFC').replace(/\s/gu, '');
  const normalizedActual = normalize(actual), expected = normalize(text);
  return { correct: normalizedActual === expected,
    actualLength: normalizedActual.length, expectedLength: expected.length };
}

// 富文本编辑器通过自己的粘贴处理器更新内部文档，避免仅有 DOM 文字而提交内容仍为空。
function pastePrompt(text) {
  const host = document.querySelector('[data-testid="prompt-textarea"],#prompt-textarea,[contenteditable="true"][role="textbox"]');
  const box = host?.matches('textarea,[contenteditable="true"]') ? host : host?.querySelector('textarea,[contenteditable="true"]');
  if (!box?.isContentEditable) return false;
  box.focus();
  const data = new DataTransfer();
  data.setData('text/plain', text);
  const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: data });
  box.dispatchEvent(event);
  return event.defaultPrevented;
}

// 附件只在本轮编辑区识别，项目文件库和历史消息里的同名 PDF 不算本轮附件。
function composerAttachments(action, name = "") {
  const box = document.querySelector('[data-testid="prompt-textarea"],#prompt-textarea,[contenteditable="true"][role="textbox"]');
  const root = box?.closest('form') || box?.closest('[data-testid="composer-root"]');
  if (!root) return { attached: false, input: false, removed: 0 };
  const buttons = [...root.querySelectorAll('button')];
  const label = el => el.getAttribute('aria-label') || el.innerText || '';
  const removers = buttons.filter(el => /^(remove|移除|删除)\s*/i.test(label(el)));
  if (action === "clear") {
    for (const button of removers) button.click();
    return { removed: removers.length };
  }
  const attached = removers.some(el => label(el).includes(name));
  if (action === "input") {
    const inputs = [...root.querySelectorAll('input[type="file"]')];
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    const mime = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext] || '';
    const input = inputs.find(el => {
      const types = (el.accept || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      return !el.disabled && (!types.length || types.some(type => type === '*' || type === '*/*' || type === ext ||
        type === mime || type.endsWith('/*') && mime.startsWith(type.slice(0, -1))));
    });
    for (const old of document.querySelectorAll('[data-easyread-upload-input]')) old.removeAttribute('data-easyread-upload-input');
    if (input) input.setAttribute('data-easyread-upload-input', 'true');
    return { attached, input: !!input };
  }
  if (action === "open") {
    const button = buttons.find(el => /添加文件等内容|添加附件|添加照片和文件|attach files|add photos.*files/i.test(label(el)) ||
      el.getAttribute('data-testid') === 'composer-plus-btn');
    button?.click();
  }
  return { attached };
}

// ChatGPT 会在不同版本中切换消息属性与无障碍标题；两种结构均按语义识别。
function pageMessages() {
  const legacyUsers = [...document.querySelectorAll('[data-message-author-role="user"]')];
  const legacyAnswers = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  if (legacyUsers.length || legacyAnswers.length) return { users: legacyUsers, answers: legacyAnswers };
  const users = [], answers = [];
  for (const heading of document.querySelectorAll('h4.sr-only')) {
    const block = heading.closest('div[class^="block-"]');
    if (!block) continue;
    const label = (heading.textContent || '').trim();
    if (/^(你说|you said)/i.test(label)) users.push(block);
    else if (/^(chatgpt|assistant)\s*(说|said)/i.test(label)) answers.push(block);
  }
  return { users, answers };
}

// 页面脚本独立执行，复用同一套节点定位规则统计发送前后的用户消息。
function pageUserCount() {
  const legacy = document.querySelectorAll('[data-message-author-role="user"]');
  if (legacy.length) return legacy.length;
  return [...document.querySelectorAll('h4.sr-only')]
    .filter(el => /^(你说|you said)/i.test((el.textContent || '').trim()) && el.closest('div[class^="block-"]')).length;
}

function createChatGPTWeb({ app, window, BrowserWindow, WebContentsView, ipcMain }) {
  // 执行窗口始终隐藏并持续绘制，人工侧栏不再是自动化页面的宿主。
  const worker = new BrowserWindow({ width: 1000, height: 800, useContentSize: true, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const partition = "persist:easyread-chatgpt";
  const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true,
    nodeIntegration: false, backgroundThrottling: false } });
  const wc = view.webContents;
  // 独立工具栏始终在 ChatGPT 网页上方，避免网页覆盖 EasyRead 的关闭入口。
  const toolbar = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const toolbarWC = toolbar.webContents;
  // 拖动条由本地页面和受限 preload 构成；远端 ChatGPT 页面拿不到 IPC。
  const grip = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true,
    nodeIntegration: false, preload: path.join(__dirname, "chatgpt-grip-preload.cjs") } });
  const gripWC = grip.webContents;
  const preview = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const previewWC = preview.webContents;
  previewWC.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8">
    <style>body{margin:0;background:#f7f8fa;font:13px system-ui}p{padding:8px;margin:0}img{width:100%;display:block}</style>
    <p id="stage">后台任务准备中…</p><img id="frame">`)).catch(() => {});
  const gripHtml = `<!doctype html><html><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;cursor:col-resize;touch-action:none;user-select:none}
    body{background:#e1e5eb;display:flex;align-items:center;justify-content:center}
    body:before{content:"";height:54px;width:4px;border-radius:4px;background:#929ca9}
    body:hover,body:active{background:#bdcbe0}
  </style><body><script>
    let start=0,dragging=false;
    document.body.addEventListener('pointerdown',e=>{if(e.button!==0)return;start=e.screenX;dragging=true;
      document.body.setPointerCapture(e.pointerId);easyreadGrip.drag('start',0);e.preventDefault()});
    document.body.addEventListener('pointermove',e=>{if(dragging)easyreadGrip.drag('move',e.screenX-start)});
    for(const phase of ['pointerup','pointercancel'])document.body.addEventListener(phase,e=>{
      if(!dragging)return;dragging=false;easyreadGrip.drag('end',e.screenX-start)});
  </script></body></html>`;
  gripWC.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(gripHtml)).catch(() => {});
  const zh = app.getLocale().toLowerCase().startsWith("zh");
  const toolbarTitle = zh ? "ChatGPT 网页" : "ChatGPT website";
  const closeLabel = zh ? "关闭" : "Close";
  const closeTitle = zh ? "关闭 ChatGPT 网页，返回 EasyRead" : "Close ChatGPT and return to EasyRead";
  const toolbarHtml = `<!doctype html><html lang="${zh ? "zh" : "en"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{margin:0;font:13px system-ui,"Microsoft YaHei",sans-serif;color:#202124;background:#f7f8fa}
    header{height:43px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;border-bottom:1px solid #dce0e5}
    span{font-weight:600}a{padding:5px 10px;border:1px solid #cbd0d7;border-radius:7px;color:inherit;text-decoration:none;background:white}
    a:hover,a:focus-visible{background:#e8edf4;outline:2px solid #8faee5;outline-offset:1px}
    @media(prefers-color-scheme:dark){body{color:#eee;background:#24272b}header{border-color:#444}a{color:#eee;background:#363a40;border-color:#555}a:hover,a:focus-visible{background:#465166}}</style>
    <header><span>${toolbarTitle}</span><a href="${CLOSE_URL}" aria-label="${closeTitle}">${closeLabel} ✕</a></header></html>`;
  toolbarWC.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(toolbarHtml)).catch(() => {});
  const stateFile = path.join(app.getPath("userData"), "chatgpt-web-sessions.json");
  const projectFile = path.join(app.getPath("userData"), "chatgpt-web-project.json");
  const paneFile = path.join(app.getPath("userData"), "chatgpt-web-pane.json");
  let paneFraction = 0.58;
  try {
    const saved = JSON.parse(fs.readFileSync(paneFile, "utf8"));
    if (Number.isFinite(saved.fraction) && saved.fraction > 0 && saved.fraction < 1) paneFraction = saved.fraction;
  } catch (_) { /* 首次启动使用默认宽度。 */ }
  let sessions = {};
  try { sessions = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch (_) { sessions = {}; }
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) sessions = {};
  let project = {};
  try { project = JSON.parse(fs.readFileSync(projectFile, "utf8")); } catch (_) { project = {}; }
  if (!project || typeof project !== "object" || Array.isArray(project)) project = {};
  let visible = false;
  let running = false;
  let activeSession = "";
  let account = "";
  let cancelled = false;
  let lastError = "";
  let projectSetupPromise = null;
  let projectVerifiedThisRun = false;
  let projectState = "idle";
  let phase = "idle";
  let modelsPromise = null;
  let initialLoadPromise = null;
  let taskReport = null;
  let lastPulse = 0;
  let dismissingMenu = false;
  let networkTraceAttached = false;
  let submissionObservation = null;
  const uploadRequests = new Set();
  let uploadActivity = 0;
  let dragStartWidth = null;
  let dragPaneWidth = null;
  let pageSize = { width: 1000, height: 800 };
  let onOwner = false;
  let previewTimer = null;
  let previewGeneration = 0;
  let disposed = false;
  let traceStarted = 0, tracePrevious = 0;
  const trace = stage => {
    if (process.env.EASYREAD_WEB_TRACE === "1") {
      const now = performance.now();
      console.warn("ChatGPT 网页阶段", JSON.stringify({ stage,
        elapsedMs: Math.round(now - traceStarted), stepMs: Math.round(now - tracePrevious) }));
      tracePrevious = now;
    }
  };

  function save() {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(sessions), "utf8");
  }
  function saveProject() {
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, JSON.stringify(project), "utf8");
  }

  // 宽度按窗口比例保存；拖到右边缘并松开时收起侧栏。
  function paneWidthFor(width) {
    const min = Math.min(320, Math.floor(width / 2));
    const max = Math.max(min, width - min);
    return Math.max(min, Math.min(max, dragPaneWidth ?? Math.round(width * paneFraction)));
  }
  function layout() {
    const [width, height] = window.getContentSize();
    const paneWidth = dragPaneWidth === null ? paneWidthFor(width) : Math.max(1, Math.min(width, dragPaneWidth));
    const x = width - paneWidth;
    pageSize = onOwner ? { width: paneWidth, height: Math.max(1, height - TOOLBAR_HEIGHT) } : { width: 1000, height: 800 };
    view.setBounds(onOwner ? { x, y: TOOLBAR_HEIGHT, ...pageSize } : { x: 0, y: 0, ...pageSize });
    if (!visible) return;
    preview.setBounds({ x, y: TOOLBAR_HEIGHT, width: paneWidth, height: Math.max(1, height - TOOLBAR_HEIGHT) });
    toolbar.setBounds({ x, y: 0, width: paneWidth, height: TOOLBAR_HEIGHT });
    grip.setBounds({ x: Math.max(0, x - GRIP_WIDTH), y: 0, width: GRIP_WIDTH, height });
  }
  async function refreshPreview(generation) {
    if (!visible || onOwner || disposed || generation !== previewGeneration) return;
    const labels = zh ? { idle: '准备网页', login: '核验登录', project: '准备翻译项目', model: '选择模型',
      attachments: '上传附件', sending: '发送提示词', answer: '等待回答', error: '任务出错' } :
      { idle: 'Preparing website', login: 'Checking sign-in', project: 'Preparing project', model: 'Selecting model',
        attachments: 'Uploading files', sending: 'Submitting prompt', answer: 'Waiting for answer', error: 'Task failed' };
    try {
      await previewWC.executeJavaScript(`document.getElementById('stage').textContent=${JSON.stringify(labels[phase] || phase)}`);
      // 截图期间让 Chromium 绘制页面，原生执行窗口仍保持隐藏。
      const frame = await Promise.race([wc.capturePage(), sleep(3000).then(() => {
        throw new Error('后台预览暂未取得画面');
      })]);
      if (visible && !onOwner && !disposed && generation === previewGeneration) await previewWC.executeJavaScript(`(() => {
        document.getElementById('frame').src=${JSON.stringify(frame.toDataURL())};
      })()`);
    } catch (_) { /* 页面正在导航时下一帧重试，预览失败不影响后台任务。 */ }
    if (visible && !onOwner && !disposed && generation === previewGeneration)
      previewTimer = setTimeout(() => refreshPreview(generation), 1500);
  }
  function syncDisplay() {
    const interactive = visible && !running && !projectSetupPromise && projectState !== 'checking';
    if (interactive !== onOwner) {
      if (onOwner) window.contentView.removeChildView(view);
      else worker.contentView.removeChildView(view);
      onOwner = interactive;
      if (onOwner) {
        window.contentView.addChildView(view, 1);
        // 人工浏览恢复侧栏的真实尺寸，避免后台固定视口把界面裁到侧栏以外。
        if (wc.debugger.isAttached()) wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {});
      }
      else worker.contentView.addChildView(view);
    }
    clearTimeout(previewTimer);
    const generation = ++previewGeneration;
    window.contentView.removeChildView(preview);
    if (visible && !onOwner) {
      window.contentView.addChildView(preview, 1);
      previewTimer = setTimeout(() => refreshPreview(generation), 0);
    }
    layout();
  }
  function show() {
    if (!visible) {
      visible = true;
      syncDisplay();
      window.contentView.addChildView(toolbar);
      window.contentView.addChildView(grip);
    }
    layout();
    window.show();
    window.focus();
    // 启动不预先配置项目，但人工打开必须加载具体页面；存在待确认任务时打开原会话。
    ensureLoaded().catch(error => { lastError = error.message; });
  }
  function hide() {
    if (visible) {
      window.contentView.removeChildView(grip);
      window.contentView.removeChildView(toolbar);
    }
    visible = false;
    dragStartWidth = null;
    dragPaneWidth = null;
    syncDisplay();
  }
  function onGripDrag(event, message) {
    if (event.sender !== gripWC || !visible || !message || !["start", "move", "end"].includes(message.phase) ||
      !Number.isFinite(message.delta) || Math.abs(message.delta) > 10000) return;
    const [width] = window.getContentSize();
    if (message.phase === "start") { dragStartWidth = paneWidthFor(width); return; }
    if (dragStartWidth === null) return;
    dragPaneWidth = Math.max(1, Math.min(width, dragStartWidth - message.delta));
    if (message.phase === "end") {
      if (dragPaneWidth <= COLLAPSE_WIDTH) { hide(); return; }
      const finalWidth = paneWidthFor(width);
      paneFraction = finalWidth / width;
      fs.mkdirSync(path.dirname(paneFile), { recursive: true });
      fs.writeFileSync(paneFile, JSON.stringify({ fraction: paneFraction }), "utf8");
      dragPaneWidth = null;
      dragStartWidth = null;
    }
    layout();
  }
  ipcMain.on("easyread:chatgpt-pane-drag", onGripDrag);
  window.on("resize", layout);
  // 人工界面只在空闲时承载交互网页；后台任务期间展示只读画面。
  worker.contentView.addChildView(view);
  view.setVisible(true);
  layout();
  function dispose() {
    if (disposed) return;
    disposed = true;
    previewGeneration++;
    clearTimeout(previewTimer);
    ipcMain.removeListener("easyread:chatgpt-pane-drag", onGripDrag);
    for (const contents of [wc, toolbarWC, gripWC, previewWC]) if (!contents.isDestroyed()) contents.close();
    if (!worker.isDestroyed()) worker.destroy();
  }
  window.on("closed", dispose);
  for (const contents of [wc, toolbarWC, gripWC]) contents.on("before-input-event", (event, input) => {
    if (input.key === "Escape" && !dismissingMenu) { event.preventDefault(); hide(); }
  });
  toolbarWC.on("will-navigate", (event, target) => {
    event.preventDefault();
    if (target === CLOSE_URL) hide();
  });
  toolbarWC.setWindowOpenHandler(() => ({ action: "deny" }));
  gripWC.on("will-navigate", event => event.preventDefault());
  gripWC.setWindowOpenHandler(() => ({ action: "deny" }));
  previewWC.on("will-navigate", event => event.preventDefault());
  previewWC.setWindowOpenHandler(() => ({ action: "deny" }));
  const permittedHost = target => {
    try {
      const u = new URL(target);
      return u.protocol === "https:" && (u.hostname === "chatgpt.com" || u.hostname.endsWith(".openai.com") ||
        ["accounts.google.com", "login.microsoftonline.com", "login.live.com", "appleid.apple.com"].includes(u.hostname));
    } catch (_) { return false; }
  };
  wc.setWindowOpenHandler(({ url }) => {
    if (process.env.EASYREAD_WEB_TRACE === "1") {
      const target = new URL(url);
      console.warn("ChatGPT 网页新窗口", JSON.stringify({ protocol: target.protocol, host: target.hostname, path: target.pathname.slice(0, 120) }));
    }
    if (!permittedHost(url)) return { action: "deny" };
    return { action: "allow", overrideBrowserWindowOptions: {
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
    } };
  });
  wc.on("will-navigate", (event, target) => {
    if (!permittedHost(target)) event.preventDefault();
  });
  // 新建会话的 /c/ 地址可能在回答生成中才出现，立即保存以便重启后找回原回复。
  function rememberPendingURL() {
    const url = wc.getURL();
    // 只跟踪当前发送中的会话；用户打开其他聊天或只读诊断不能改写旧任务地址。
    if (!running || !activeSession || !sessions[activeSession]?.pending ||
        !url.startsWith(URL_HOME) || !url.includes('/c/')) return;
    const previous = sessions[activeSession].url || "";
    // 新消息先出现 local-chatgpt 临时路由，随后才换成可恢复的服务端会话 ID。
    const temporary = value => /\/c\/local-chatgpt(?::|%3A)/i.test(value);
    if (temporary(url)) return;
    if (previous.includes('/c/') && !temporary(previous) && previous !== url) return;
    sessions[activeSession].url = url;
    save();
  }
  wc.on("did-navigate", rememberPendingURL);
  wc.on("did-navigate-in-page", rememberPendingURL);

  async function loadPage(url) {
    // ChatGPT 的附属资源可能长时间不结束；DOM 就绪即可开始等待业务控件。
    let timeout, onReady;
    const ready = new Promise(resolve => {
      onReady = resolve;
      if (wc.once) wc.once("dom-ready", onReady);
    });
    const expired = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        wc.stop?.();
        reject(new Error("ChatGPT 网页导航超时，请检查网络连接后重试"));
      }, 45000);
    });
    const completed = Promise.race([wc.loadURL(url), ready, expired]).then(() => true);
    try {
      while (!await Promise.race([completed, sleep(250).then(() => false)])) await pulse();
    } catch (error) { wc.stop?.(); throw error; }
    finally {
      clearTimeout(timeout);
      wc.removeListener?.("dom-ready", onReady);
    }
  }
  async function ensureLoaded() {
    if (initialLoadPromise) return initialLoadPromise;
    if (wc.getURL()) return;
    const pending = Object.values(sessions).find(value => value.pending);
    const target = pending?.url?.startsWith(URL_HOME) ? pending.url : URL_HOME;
    initialLoadPromise = loadPage(target).finally(() => { initialLoadPromise = null; });
    return initialLoadPromise;
  }
  async function prepareBackgroundInput() {
    // 让 Chromium 的编辑器在隐藏或最小化时也接受原生输入，不抢 EasyRead 窗口焦点。
    if (!wc.debugger.isAttached()) wc.debugger.attach();
    if (!onOwner) wc.focus();
    if (!networkTraceAttached) {
      networkTraceAttached = true;
      const requests = new Set();
      wc.debugger.on("message", (_event, method, params) => {
        if (method === "Network.requestWillBeSent") {
          const pathname = new URL(params.request.url).pathname;
          // 附件卡片和发送按钮可能先于后台上传/解析完成，等待整个上传请求结束。
          if ((params.request.method === 'POST' && /^\/backend-api\/files(?:\/|$)/.test(pathname)) ||
              params.request.method === 'PUT') {
            uploadRequests.add(params.requestId);
            uploadActivity = Date.now();
          }
          if (submissionObservation && params.request.method === 'POST' &&
              /\/conversation(?:$|\/turn$)/.test(pathname)) {
            submissionObservation.dispatched = true;
            const current = sessions[activeSession]?.pending;
            if (current) { current.transport = 'dispatched'; save(); }
          }
          if (process.env.EASYREAD_WEB_TRACE !== '1') return;
          if (params.request.method === "POST" && /^\/backend-api\/(?:f\/)?(?:conversation|files)(?:\/|$)/.test(pathname)) {
            requests.add(params.requestId);
            console.warn("ChatGPT 网页 POST", pathname);
          }
        } else if (requests.has(params.requestId) && method === "Network.responseReceived")
          console.warn("ChatGPT 会话提交响应", params.response.status);
        else if (requests.has(params.requestId) && method === "Network.loadingFailed")
          console.warn("ChatGPT 会话提交网络错误", params.errorText);
        if (['Network.loadingFinished', 'Network.loadingFailed'].includes(method) && uploadRequests.delete(params.requestId))
          uploadActivity = Date.now();
      });
      await wc.debugger.sendCommand("Network.enable");
      if (process.env.EASYREAD_WEB_TRACE === '1') {
        wc.debugger.on('message', (_event, method, params) => {
          if (method === 'Runtime.exceptionThrown') console.warn('ChatGPT 网页异常',
            (params.exceptionDetails.exception?.description || params.exceptionDetails.text || '').slice(0, 800));
        });
        await wc.debugger.sendCommand('Runtime.enable');
      }
    }
    // 隐藏或裁剪的原生 View 可能报告零视口；显式设置 Chromium 的布局尺寸。
    await wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { ...pageSize, deviceScaleFactor: 0, mobile: false });
    await wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  }
  async function evalPage(source, args = []) {
    await pulse();
    if (!wc.getURL().startsWith(URL_HOME)) throw new Error("请在内置网页完成 ChatGPT 登录或验证");
    // executeJavaScript 会等所有网页资源停止加载，第三方资源挂起时连状态检查也卡住。
    // DOM 就绪后直接在主上下文运行，沿用网页自己的事件和编辑器。
    if (!wc.debugger.isAttached()) wc.debugger.attach();
    let timer;
    const evaluation = wc.debugger.sendCommand('Runtime.evaluate', {
      expression: `(${source})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    const completed = Promise.race([evaluation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`ChatGPT 网页步骤超时：${phase}`)), 75000);
    })]).then(result => ({ result }));
    try {
      let outcome;
      while (!(outcome = await Promise.race([completed, sleep(250).then(() => null)]))) await pulse();
      if (outcome.result.exceptionDetails) throw new Error(outcome.result.exceptionDetails.exception?.description ||
        outcome.result.exceptionDetails.text || 'ChatGPT 网页脚本执行失败');
      return outcome.result.result?.value;
    } finally { clearTimeout(timer); }
  }
  async function pulse() {
    // 准备项目、上传和输入阶段也查询取消状态，不等到模型开始回答才响应停止。
    if (taskReport && Date.now() - lastPulse >= 1000) {
      lastPulse = Date.now();
      await taskReport({ phase });
    }
    if (running && cancelled && phase !== "answer") throw new Error("已停止");
  }
  async function signedIn() {
    await ensureLoaded();
    return evalPage(`() => !!document.querySelector('[data-testid="prompt-textarea"], #prompt-textarea, [contenteditable="true"][role="textbox"]')`);
  }
  async function waitForLogin() {
    // 后台任务保持 EasyRead 原界面；认证页只由用户主动打开。
    for (let i = 0; i < 120; i++) {
      if (cancelled) throw new Error("已停止");
      if (await signedIn().catch(() => false)) return;
      await sleep(250);
    }
    throw new Error("ChatGPT 需要登录或验证；请在 EasyRead 中主动打开 ChatGPT，完成后重试");
  }
  async function fingerprint() {
    // 登录 Cookie 会自动轮换；读取网页自身会话中的稳定用户 ID，仅持久化其哈希。
    const id = await evalPage(`async () => {
      const response = await fetch('/api/auth/session', { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
      if (!response.ok) return '';
      const session = await response.json();
      return typeof session.user?.id === 'string' ? session.user.id : '';
    }`).catch(() => "");
    return id ? createHash("sha256").update(id).digest("hex") : "";
  }
  async function checkAccount() {
    const now = await fingerprint();
    if (!now) throw new Error("无法确认 ChatGPT 登录账号，请在内置网页重新登录");
    if (account && now && account !== now) {
      // 登录状态改变时保留仍需人工核对的发送记录，避免自动重复提交。
      sessions = Object.fromEntries(Object.entries(sessions).filter(([, value]) => value.pending));
      save();
      project = { creationAttempts: project.creationAttempts || {} };
      projectVerifiedThisRun = false;
      projectState = "idle";
    }
    account = now;
  }
  async function status() {
    try {
      const ready = await signedIn();
      // 状态查询只读；不能在执行中的任务里重置账号或项目缓存。
      return { ready, visible, running, phase, projectState, pending: Object.values(sessions).filter(x => x.pending).length, error: lastError };
    } catch (error) { return { ready: false, visible, running, phase, projectState, pending: Object.values(sessions).filter(x => x.pending).length, error: error.message }; }
  }

  async function listModels() {
    if (!await signedIn()) throw new Error("请先在 EasyRead 中打开 ChatGPT 完成登录，再刷新模型列表");
    await prepareBackgroundInput();
    await openModelMenu();
    const result = await evalPage(modelMenu.toString(), ["list"]);
    await dismissModelMenu();
    return result;
  }
  async function dismissModelMenu() {
    // 在真实网页中关闭浮层，避免菜单遮挡后续附件与发送按钮。
    dismissingMenu = true;
    try {
      for (const type of ["keyDown", "keyUp"])
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    } finally { dismissingMenu = false; }
  }
  async function openModelMenu(button) {
    button ||= await evalPage(modelMenu.toString(), ["button"]);
    if (!button.expanded && Number.isFinite(button.x) && Number.isFinite(button.y)) {
      for (const type of ["mousePressed", "mouseReleased"])
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type, x: button.x, y: button.y,
          button: "left", clickCount: 1 });
    }
  }

  function models() {
    if (running || projectSetupPromise) return Promise.reject(new Error("ChatGPT 网页正在执行任务，请等本次回答结束后刷新模型"));
    if (modelsPromise) return modelsPromise;
    modelsPromise = listModels().finally(() => { modelsPromise = null; });
    return modelsPromise;
  }

  async function selectModel(name) {
    if (!name) throw new Error("请先在 EasyRead 选择 ChatGPT 网页模型");
    // 顶部已显示目标模型时直接使用，避免每一批都打开、关闭和再次打开菜单。
    const current = await evalPage(modelMenu.toString(), ["button"]);
    const modelLabel = value => String(value || '').replace(/^ChatGPT\s*/i, '').trim();
    if (modelLabel(current.current) === modelLabel(name)) return;
    await openModelMenu(current);
    let selected;
    try { selected = await evalPage(modelMenu.toString(), ["select", name]); }
    finally { await dismissModelMenu(); }
    if (selected.models?.some(item => item.name === name && item.selected)) return;
    // 切换后先检查顶部按钮；只有页面尚未反映选中状态时才重新打开菜单核验。
    for (let i = 0; i < 8; i++) {
      if (i) await sleep(250);
      const button = await evalPage(modelMenu.toString(), ["button"]);
      if (modelLabel(button.current) === modelLabel(name)) return;
    }
    const checked = await listModels();
    if (!checked.models.some(item => item.name === name && item.selected))
      throw new Error(`网页未确认切换到模型：${name}`);
  }

  async function projectAction(action, value = "") {
    const result = await evalPage(projectPage.toString(), [action, value]);
    if (result?.error) throw new Error(`ChatGPT 项目操作 ${action} 失败：${result.error}`);
    return result;
  }

  async function projectHeading() {
    return evalPage(`name => [...document.querySelectorAll('main h1,main h2')]
      .some(el => (el.innerText || el.textContent || '').trim() === name)`, [PROJECT_NAME]);
  }

  async function ensureProject() {
    // 同一账号和指令版本复用成功配置；同一运行中的后续批次不导航回项目首页。
    const instructionsHash = createHash("sha256").update(INSTRUCTIONS).digest("hex");
    const configured = project.accountId === account && project.url?.startsWith(URL_HOME) &&
      project.instructionsHash === instructionsHash && project.memoryScope === "project-only";
    if (configured && projectVerifiedThisRun) { projectState = "ready"; return project.url; }
    projectState = "checking";
    await prepareBackgroundInput();
    let url = "";
    if (project.accountId === account && project.url?.startsWith(URL_HOME)) {
      await loadPage(project.url);
      // 已删除的项目可能打开错误页且没有输入框；先核对标题，不能当成登录失效等待。
      for (let i = 0; i < 20 && !await projectHeading().catch(() => false); i++) await sleep(250);
      if (await projectHeading().catch(() => false)) url = project.url;
    }
    if (!url) {
      if (wc.getURL() !== URL_HOME) await loadPage(URL_HOME);
      await waitForLogin();
      for (let i = 0; i < 40 && !await projectAction("sidebar-ready"); i++) await sleep(250);
      if (!await projectAction("sidebar-ready")) {
        const state = await evalPage(`() => {
          const el = document.querySelector('button[aria-label="添加新项目"]');
          return { path: location.pathname, bodyWidth: document.body.getBoundingClientRect().width,
            button: !!el, buttonWidth: el?.getBoundingClientRect().width || 0,
            hidden: !!el?.closest('[aria-hidden="true"]'), display: el ? getComputedStyle(el).display : '' };
        }`);
        throw new Error(`ChatGPT 项目侧栏尚未加载（${JSON.stringify(state)}）`);
      }
      let found = await projectAction("find", PROJECT_NAME);
      if (!found) {
        // 侧栏只显示最近使用的项目；目录页会列出账号中的全部项目。
        await loadPage(`${URL_HOME}projects`);
        for (let i = 0; i < 60 && !await projectAction("directory-ready"); i++) await sleep(250);
        if (!await projectAction("directory-ready"))
          throw new Error("ChatGPT 项目目录尚未加载，无法确认“翻译”项目是否存在");
        // 项目目录会分批渲染；无匹配项时至少观察 10 秒，并等行数稳定 2 秒。
        let previousCount = -1, stableCount = 0;
        for (let i = 0; i < 80 && !found; i++) {
          found = await projectAction("find", PROJECT_NAME);
          const count = await projectAction("directory-count");
          stableCount = count === previousCount ? stableCount + 1 : 0;
          previousCount = count;
          if (i >= 40 && stableCount >= 8) break;
          if (!found) await sleep(250);
        }
        if (!found && stableCount < 8) throw new Error("ChatGPT 项目目录仍在更新，请稍后再试");
      }
      if (!found) {
        // 创建回执不确定时等待网页同步；超过五分钟且目录仍查无项目才允许重新提交。
        const lastAttempt = Number(project.creationAttempts?.[account] || 0);
        if (lastAttempt && Date.now() - lastAttempt < 5 * 60 * 1000)
          throw new Error("“翻译”项目创建请求已提交，但网页尚未显示项目；请稍后重试或在内置网页核对");
        await loadPage(URL_HOME);
        await waitForLogin();
        for (let i = 0; i < 40 && !await projectAction("sidebar-ready"); i++) await sleep(250);
        if (!await projectAction("sidebar-ready")) throw new Error("ChatGPT 新建项目入口尚未加载");
        await projectAction("open-create");
        await sleep(400);
        if (!await projectAction("fill-create", PROJECT_NAME)) throw new Error("ChatGPT 未接收项目名称");
        await sleep(150);
        project.creationAttempts = { ...project.creationAttempts, [account]: Date.now() };
        saveProject();
        try { await projectAction("submit-create"); }
        catch (error) {
          // 控件不可用意味着请求未提交；允许下次从头尝试。
          delete project.creationAttempts[account];
          saveProject();
          throw error;
        }
        for (let i = 0; i < 80; i++) {
          if (cancelled) throw new Error("已停止");
          await sleep(250);
          found = await projectAction("find", PROJECT_NAME);
          if (found?.url) break;
          if (wc.getURL() !== URL_HOME && await projectHeading()) {
            found = { url: wc.getURL() }; break;
          }
        }
        if (!found) {
          const state = await evalPage(`name => ({
            path: location.pathname,
            dialog: !!document.querySelector('[role="dialog"],dialog'),
            projectRow: [...document.querySelectorAll('button[aria-label]')].some(el =>
              el.getAttribute('aria-label') === name + ' 的项目操作'),
            heading: [...document.querySelectorAll('main h1,main h2')].some(el =>
              (el.innerText || el.textContent || '').trim() === name),
            notices: [...document.querySelectorAll('[role="alert"],[role="status"],[data-sonner-toast]')]
              .map(el => (el.innerText || el.textContent || '').trim().slice(0, 120)).filter(Boolean).slice(0, 4),
          })`, [PROJECT_NAME]);
          throw new Error(`ChatGPT 未确认“翻译”项目已创建（${JSON.stringify(state)}）`);
        }
      }
      if (found.url && found.url !== wc.getURL()) await loadPage(found.url);
      else if (!found.url) {
        await projectAction("open-existing", PROJECT_NAME);
        for (let i = 0; i < 80 && !await projectHeading(); i++) await sleep(250);
      }
      await waitForLogin();
      for (let i = 0; i < 40 && !await projectHeading(); i++) await sleep(250);
      if (!await projectHeading()) throw new Error("ChatGPT 未确认已进入“翻译”项目");
      url = wc.getURL();
      if (!url.startsWith(URL_HOME) || url === URL_HOME)
        throw new Error("ChatGPT 未提供“翻译”项目地址");
    }
    if (project.accountId !== account || project.url !== url || project.instructionsHash !== instructionsHash ||
        project.memoryScope !== "project-only") {
      await projectAction("open-settings-menu", PROJECT_NAME);
      await sleep(250);
      await projectAction("open-settings");
      await sleep(250);
      let state = await projectAction("read-instructions");
      if (!state.opened) {
        await sleep(250);
        state = await projectAction("read-instructions");
      }
      if (!state.opened) throw new Error("ChatGPT 项目指令输入框尚未打开");
      const wanted = mergeInstructions(state.text);
      if (wanted !== state.text) {
        await projectAction("focus-instructions");
        await prepareBackgroundInput();
        await wc.debugger.sendCommand("Input.insertText", { text: wanted });
        await sleep(250);
        const typed = await projectAction("read-instructions");
        if (!typed.opened || typed.text !== wanted) throw new Error("ChatGPT 未接收项目指令");
        await projectAction("save-instructions");
        await sleep(500);
        // 重新打开设置核对持久化结果，避免 React 未保存时继续发送论文。
        await loadPage(url);
        for (let i = 0; i < 40 && !await projectHeading(); i++) await sleep(250);
        if (!await projectHeading()) throw new Error("ChatGPT 项目页面尚未重新加载完成");
        await projectAction("open-settings-menu", PROJECT_NAME);
        await sleep(250);
        await projectAction("open-settings");
        await sleep(250);
        state = await projectAction("read-instructions");
        if (!state.opened || !state.text.includes(INSTRUCTIONS))
          throw new Error("ChatGPT 未确认“翻译”项目指令已保存");
      }
      const memory = await projectAction("read-memory");
      if (!/^(仅限项目|仅项目记忆|project.only|project only)$/i.test(memory.text)) {
        await projectAction("open-memory");
        let selected = false;
        for (let i = 0; i < 40 && !selected; i++) {
          await sleep(250);
          selected = await projectAction("select-project-memory");
        }
        if (!selected) throw new Error("ChatGPT 当前无法选择“仅限项目”记忆，请在项目设置中检查记忆权限");
        await sleep(250);
        await projectAction("save-instructions");
        await sleep(750);
        await loadPage(url);
        for (let i = 0; i < 40 && !await projectHeading(); i++) await sleep(250);
        if (!await projectHeading()) throw new Error("ChatGPT 项目页面尚未重新加载完成");
        await projectAction("open-settings-menu", PROJECT_NAME);
        await sleep(250);
        await projectAction("open-settings");
        await sleep(250);
        const checked = await projectAction("read-memory");
        if (!/^(仅限项目|仅项目记忆|project.only|project only)$/i.test(checked.text))
          throw new Error("ChatGPT 未确认“仅限项目”记忆已保存");
      }
      await loadPage(url);
      if (project.creationAttempts) delete project.creationAttempts[account];
      project = { ...project, accountId: account, url, instructionsHash, memoryScope: "project-only" };
      saveProject();
    }
    if (project.creationAttempts?.[account]) {
      delete project.creationAttempts[account];
      saveProject();
    }
    projectState = "ready";
    projectVerifiedThisRun = true;
    return url;
  }

  async function attach(file) {
    // 通过 Chromium 的文件控件上传；路径只来自后端已验证的论文目录。
    const name = path.basename(file);
    for (let n = 0; n < 12; n++) {
      const shown = await evalPage(composerAttachments.toString(), ["input", name]);
      if (shown.attached) return;
      let ready = shown.input;
      if (!ready) {
        await evalPage(composerAttachments.toString(), ["open", name]);
        await sleep(250);
        ready = (await evalPage(composerAttachments.toString(), ["input", name])).input;
      }
      if (ready) {
        const debug = wc.debugger;
        if (!debug.isAttached()) debug.attach();
        const root = await debug.sendCommand("DOM.getDocument");
        const node = await debug.sendCommand("DOM.querySelector", { nodeId: root.root.nodeId, selector: '[data-easyread-upload-input="true"]' });
        if (!node.nodeId) throw new Error("找不到网页上传控件");
        await debug.sendCommand("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [file] });
        // 等待网站接收和上传确认。无确认时不发送问题。
        for (let i = 0; i < 40; i++) {
          if ((await evalPage(composerAttachments.toString(), ["state", name])).attached) return;
          await sleep(500);
        }
        throw new Error(`附件未确认上传完成：${name}`);
      }
      await sleep(250);
    }
    throw new Error("找不到 ChatGPT 附件入口，请打开网页检查");
  }

  async function fillAndSend(prompt, onSending) {
    if (process.env.EASYREAD_WEB_TRACE === "1") console.warn("ChatGPT 编辑区布局", JSON.stringify(await evalPage(`() => ({
      width: innerWidth, height: innerHeight,
      editors: [...document.querySelectorAll('textarea,[contenteditable="true"]')].slice(0, 10).map(el => {
        const r = el.getBoundingClientRect();
        return { tag: el.tagName, role: el.getAttribute('role'), testid: el.getAttribute('data-testid'), id: el.id,
          x: r.x, y: r.y, width: r.width, height: r.height };
      }),
      buttons: [...document.querySelectorAll('main button')].slice(-15).map(el => {
        const r = el.getBoundingClientRect();
        return { label: el.getAttribute('aria-label'), testid: el.getAttribute('data-testid'), type: el.type,
          disabled: el.disabled, x: r.x, y: r.y, width: r.width, height: r.height };
      })
    })`)));
    await evalPage(`() => {
      const host = document.querySelector('[data-testid="prompt-textarea"], #prompt-textarea, [contenteditable="true"][role="textbox"]');
      const box = host?.matches('textarea, [contenteditable="true"]') ? host :
        host?.querySelector('textarea, [contenteditable="true"]');
      if (!box) throw new Error('找不到 ChatGPT 输入框');
      box.focus();
      if (document.activeElement !== box && !box.contains(document.activeElement))
        throw new Error('ChatGPT 输入框无法获得焦点');
    }`);
    const debug = wc.debugger;
    if (!debug.isAttached()) debug.attach();
    // 完整按下并释放修饰键，避免 Ctrl/Command 状态残留影响随后发送。
    const modifier = process.platform === 'darwin' ? { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, modifiers: 4 } :
      { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 };
    await debug.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", ...modifier });
    for (const type of ["keyDown", "keyUp"])
      await debug.sendCommand("Input.dispatchKeyEvent", { type, key: "a", code: "KeyA", windowsVirtualKeyCode: 65,
        modifiers: modifier.modifiers });
    await debug.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...modifier, modifiers: 0 });
    await sleep(100);
    // 长粘贴会被网页转换为文本附件；逐段通过编辑器输入，保持其内部文档与可见正文一致。
    for (const type of ["keyDown", "keyUp"])
      await debug.sendCommand("Input.dispatchKeyEvent", { type, key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    // 按 Unicode 字符分段，避免把数学字母、emoji 的代理对截成两个无效字符。
    for (const chunk of prompt.match(/[\s\S]{1,2000}/gu) || []) {
      const pasted = await evalPage(pastePrompt.toString(), [chunk]);
      if (!pasted) await debug.sendCommand("Input.insertText", { text: chunk });
      await sleep(50);
    }
    let matching;
    for (let i = 0; i < 10; i++) {
      matching = await evalPage(promptMatches.toString(), [prompt]);
      if (matching.correct) break;
      await sleep(100);
    }
    if (!matching?.correct) throw new Error(`ChatGPT 输入框未接收完整问题（应为 ${matching?.expectedLength || 0} 字，网页为 ${matching?.actualLength || 0} 字）`);
    // 附件名已显示时，网页可能还在上传；等发送按钮实际可用后再点击。
    let target = null;
    let found = false;
    for (let i = 0; i < 360; i++) {
      if (cancelled) throw new Error("已停止");
      const state = await evalPage(composerSend.toString());
      found ||= state.found;
      // 已确认上传请求结束且网页发送按钮可用；短暂让网页完成附件状态重绘。
      if (state.ready && !uploadRequests.size && Date.now() - uploadActivity >= 500) { target = state; break; }
      await sleep(500);
    }
    if (!target) throw new Error(found ? "ChatGPT 发送按钮持续不可用，请检查附件上传或网页提示" :
      "找不到 ChatGPT 发送按钮，请打开网页检查编辑区");
    // 编辑区可能在附件处理完成时重绘；重新核对后直接触发网页自己的发送控件。
    target = await evalPage(composerSend.toString());
    if (!target.ready) throw new Error("发送按钮状态已变化，请检查附件上传或网页提示");
    const beforeUsers = await evalPage(pageUserCount.toString());
    if (process.env.EASYREAD_WEB_TRACE === "1") {
      const hit = await evalPage(`point => {
        window.__easyreadSubmitTrace = [];
        for (const type of ['pointerdown','mousedown','mouseup','click','keydown','submit','invalid']) {
          const listener = event => window.__easyreadSubmitTrace.push({ type, trusted: event.isTrusted,
            tag: event.target?.tagName, label: event.target?.closest?.('button')?.getAttribute('aria-label') });
          document.addEventListener(type, listener, { capture: true, once: true });
        }
        const el = document.elementFromPoint(point.x, point.y);
        const button = el?.closest('button');
        return { target: point, hit: el?.tagName, label: button?.getAttribute('aria-label'),
          testid: button?.getAttribute('data-testid'),
          form: button?.form?.tagName, valid: button?.form?.checkValidity(),
          menus: document.querySelectorAll('[role="menu"]').length };
      }`, [target]);
      console.warn("ChatGPT 发送控件", JSON.stringify(hit));

    }
    onSending(beforeUsers);
    submissionObservation = { dispatched: false };
    await evalPage(composerSend.toString(), ['submit']);
    // 新用户消息或草稿清空才视为已提交；不确定时保留待核对记录。
    for (let i = 0; i < 120; i++) {
      if (cancelled) throw new Error("已停止");
      const state = await evalPage(promptMatches.toString(), [prompt]);
      const users = await evalPage(pageUserCount.toString());
      if (!state.correct || users > beforeUsers) return;
      await sleep(500);
    }
    if (process.env.EASYREAD_WEB_TRACE === "1") console.warn("ChatGPT 提交诊断", JSON.stringify(await evalPage(`() => ({
      events: window.__easyreadSubmitTrace || [], focused: document.hasFocus(),
      active: document.activeElement?.tagName, path: location.pathname,
      alerts: [...document.querySelectorAll('[role="alert"],[data-sonner-toast]')]
        .map(el => (el.innerText || '').slice(0, 160)).slice(0, 3)
    })`)));
    const stillDraft = await evalPage(promptMatches.toString(), [prompt]);
    const users = await evalPage(pageUserCount.toString());
    if (!submissionObservation.dispatched && stillDraft.correct && users === beforeUsers) {
      // 先终止当前页面的异步提交链，再确认未发出模型请求，防止迟到提交与重试重叠。
      await loadPage(wc.getURL());
      if (!submissionObservation.dispatched) {
        delete sessions[activeSession]?.pending;
        save();
        throw new Error('ChatGPT 未提交本次问题，网页已自动重置；可直接重试');
      }
    }
    throw new Error("发送结果尚未确认，请在内置网页核对后再重试");
  }

  async function answerState(full = true) {
    return evalPage(`full => {
      const pageMessages = ${pageMessages.toString()};
      const list = pageMessages().answers;
      return (${readAnswer.toString()})(list, full);
    }`, [full]);
  }

  async function stopAnswer() {
    const stopped = await evalPage(`() => {
      const button = [...document.querySelectorAll('button')].find(el =>
        /^(stop|停止)/i.test((el.getAttribute('aria-label') || '').trim()) && !el.disabled);
      if (button) button.click();
      return !!button;
    }`).catch(() => false);
    if (stopped) {
      let quiet = 0;
      for (let n = 0; n < 20; n++) {
        await sleep(250);
        const state = await answerState(false).catch(() => null);
        quiet = state && !state.busy ? quiet + 1 : 0;
        if (quiet >= 8) {
          delete sessions[activeSession]?.pending;
          save();
          break;
        }
      }
    }
    throw new Error("已停止");
  }

  async function waitForAnswer(beforeCount, timeout = 1200000) {
    const ready = createAnswerGate(beforeCount);
    const deadline = Date.now() + timeout;
    let readFailures = 0;
    while (Date.now() < deadline) {
      if (cancelled) await stopAnswer();
      let state;
      try { state = await answerState(false); readFailures = 0; }
      catch (error) {
        ready(null);
        if (++readFailures > 10) throw error;
      }
      if (ready(state)) {
        // 提取后再次核对版本及完成状态，避免读取期间网页继续生成或替换等长正文。
        const final = await answerState();
        if (cancelled) await stopAnswer();
        if (final.text && ready(final)) return final;
      }
      // evalPage 内统一检查取消与心跳，不额外发送第二套空事件。
      await sleep(state?.complete && !state.busy ? 250 : 500);
    }
    throw new Error("等待 ChatGPT 网页回复超时，请打开网页核对后再重试");
  }

  async function waitConversation(url) {
    if (!url.includes('/c/')) return;
    // loadURL 结束时 React 可能仍在加载旧消息；历史会话至少应出现一条用户消息。
    for (let i = 0; i < 80; i++) {
      if (cancelled) throw new Error("已停止");
      if (await evalPage(pageUserCount.toString()).catch(() => 0)) return;
      await sleep(250);
    }
    throw new Error("ChatGPT 会话历史仍未加载完成，请稍后重试");
  }

  async function execute(req, emit) {
    if (running) throw new Error("ChatGPT 网页正在处理另一项任务");
    running = true; activeSession = req.session || ""; cancelled = false; lastError = "";
    traceStarted = tracePrevious = performance.now();
    syncDisplay();
    let seq = 0;
    let delivery = Promise.resolve();
    const report = data => {
      const event = { id: req.id, seq: ++seq, ...data };
      // 状态查询与任务进度可能同时产生事件；按序发送，避免完成事件被心跳抢先覆盖。
      delivery = delivery.then(() => emit(event));
      return delivery;
    };
    taskReport = report;
    lastPulse = Date.now();
    try {
      // 全部修改网页的操作串行完成；模型读取和显式配置也必须先结束。
      if (modelsPromise) await modelsPromise.catch(() => {});
      if (projectSetupPromise) await projectSetupPromise;
      phase = "login";
      const fullPrompt = (req.files || []).some(x => path.basename(x).startsWith("marks-"))
        ? `请以本次附上的 marks-${req.marks_rev}.txt 阅读标记为准。\n\n${req.prompt || ""}` : String(req.prompt || "");
      const promptHash = createHash("sha256").update(fullPrompt).digest("hex");
      const unresolved = Object.entries(sessions).find(([, value]) => value.pending);
      if (unresolved && (unresolved[0] !== req.session || unresolved[1].pending.promptHash !== promptHash ||
          !unresolved[1].url?.includes('/c/'))) {
        const error = new Error("上次网页发送尚未确认；请先打开 ChatGPT 核对回答，再允许重试");
        error.code = "WEB_PENDING";
        throw error;
      }
      await waitForLogin();
      await checkAccount();
      trace("account-ready");
      if (unresolved) {
        const [key, old] = unresolved;
        // 同一批次重试时先从原会话回收已完成的回答，绝不重新发送一遍。
        if (key === req.session && old.accountId === account && old.pending.promptHash === promptHash &&
            old.url?.includes('/c/')) {
          if (wc.getURL() !== old.url) await loadPage(old.url);
          await waitForLogin();
          await waitConversation(old.url);
          phase = 'answer';
          const state = await answerState(false);
          const timeout = state.busy || old.pending.transport === 'dispatched' ? 1200000 : 20000;
          const recovered = await waitForAnswer(old.pending.beforeAnswers, timeout);
          trace("answer-ready");
          if (!old.projectURL || !inProject(wc.getURL(), old.projectURL, true))
            throw new Error('网页回答的会话归属尚未确认为“翻译”项目，已保留待确认记录');
          await report({ text: recovered.text, done: true });
          trace("delivered");
          delete old.pending;
          save();
          return;
        }
        const error = new Error("上次网页发送尚未确认；请先打开 ChatGPT 核对回答，再允许重试");
        error.code = "WEB_PENDING";
        throw error;
      }
      const saved = sessions[req.session];
      phase = "project";
      const projectURL = await ensureProject();
      trace("project-ready");
      // 旧版普通会话没有项目归属；新轮次从项目新建会话，并由本地问答历史补足上下文。
      const reuse = saved?.url && saved.accountId === account && saved.projectURL === projectURL &&
        inProject(saved.url, projectURL, true);
      const targetURL = reuse ? saved.url : projectURL;
      if (wc.getURL() !== targetURL) await loadPage(targetURL);
      trace("loaded");
      await waitForLogin();
      if (!reuse) {
        // 项目首页会恢复上一次草稿；新会话必须从空附件开始，防止误用其他论文或过期上传。
        let removed = 0;
        for (let i = 0; i < 20; i++) {
          removed = (await evalPage(composerAttachments.toString(), ["clear"])).removed;
          if (!removed) break;
          await sleep(250);
        }
        if (removed) throw new Error("ChatGPT 旧草稿附件尚未清理完成");
      }
      phase = "model";
      await prepareBackgroundInput();
      await selectModel(req.model);
      trace("model-ready");
      await waitConversation(targetURL);
      trace("history-ready");
      if (!inProject(wc.getURL(), projectURL)) throw new Error('网页未处于“翻译”项目，已停止本次发送');
      const seenFiles = reuse ? saved.files || {} : {};
      for (const file of req.files || []) {
        phase = "attachments";
        if (cancelled) throw new Error("已停止");
        if (!fs.existsSync(file) || !fs.realpathSync(file).startsWith(fs.realpathSync(req.cwd) + path.sep)) throw new Error("附件路径不属于当前论文");
        const version = file.endsWith(".txt") ? req.marks_rev : String(fs.statSync(file).mtimeMs);
        if (seenFiles[file] === version) continue;
        await attach(file);
        seenFiles[file] = version;
      }
      trace("attachments-ready");
      const before = await answerState(false);
      trace("before-send");
      phase = "sending";
      await fillAndSend(fullPrompt,
      beforeUsers => {
        sessions[req.session] = { url: wc.getURL(), accountId: account, projectURL, files: seenFiles,
          pending: { id: req.id, at: Date.now(), promptHash, beforeUsers, beforeAnswers: before.count } };
        save();
      });
      trace("after-send");
      phase = "answer";
      rememberPendingURL();
      const final = await waitForAnswer(before.count);
      trace("answer-ready");
      if (!inProject(wc.getURL(), projectURL, true))
        throw new Error('网页回答的会话归属尚未确认为“翻译”项目，已保留待确认记录');
      await report({ text: final.text, done: true });
      trace("delivered");
      sessions[req.session] = { url: wc.getURL(), accountId: account, projectURL, files: seenFiles };
      save();
    } catch (error) {
      lastError = error.message;
      if (projectState === "checking") projectState = "error";
      if (!cancelled) {
        await report({ error: error.message });
      }
    } finally { submissionObservation = null; taskReport = null; activeSession = ""; running = false; phase = lastError ? "error" : "idle"; if (!disposed) syncDisplay(); }
  }

  function clearPending() {
    if (running) throw new Error("网页任务仍在执行，请等本次请求结束后核对");
    const unresolved = Object.fromEntries(Object.entries(sessions).filter(([, value]) => value.pending));
    if (Object.keys(unresolved).length) {
      // 用户确认清除前先保存会话地址和请求指纹，便于事后人工核对原网页回答。
      const backup = path.join(app.getPath("userData"), `chatgpt-web-pending-backup-${Date.now()}.json`);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.writeFileSync(backup, JSON.stringify(unresolved), "utf8");
    }
    for (const key of Object.keys(unresolved)) delete sessions[key];
    save();
    lastError = "";
    return { ok: true };
  }
  function initializeProject({ refresh = false } = {}) {
    if (projectSetupPromise) return projectSetupPromise;
    if (running) return Promise.resolve({ ready: false, reason: "busy" });
    if (!refresh && projectVerifiedThisRun && projectState === "ready")
      return Promise.resolve({ ready: true, url: project.url });
    projectState = "checking";
    syncDisplay();
    projectSetupPromise = (async () => {
      if (modelsPromise) await modelsPromise.catch(() => {});
      // 未确认发送需要保留原会话供人工核对；启动配置稍后重试。
      if (Object.values(sessions).some(value => value.pending)) {
        projectState = "waiting";
        return { ready: false, reason: "pending" };
      }
      // 桌面启动不等待登录；用户稍后完成登录时由主进程重试。
      if (!await signedIn()) { projectState = "login-required"; return { ready: false, reason: "login-required" }; }
      await checkAccount();
      if (!account) throw new Error("无法确认 ChatGPT 登录账号");
      // 仅用户显式要求检查设置时打开设置；常规任务复用上次成功配置。
      if (refresh) { projectVerifiedThisRun = false; project.instructionsHash = ""; }
      const url = await ensureProject();
      lastError = "";
      return { ready: true, url };
    })().catch(error => {
      lastError = error.message;
      projectState = "error";
      return { ready: false, reason: "setup-failed", error: error.message };
    }).finally(() => { projectSetupPromise = null; if (!disposed) syncDisplay(); });
    return projectSetupPromise;
  }
  return { show, hide, status, models, execute, initializeProject, webContents: wc, inspectAnswer: answerState, clearPending, cancel: () => { cancelled = true; },
    close: () => {
      hide();
      dispose();
    } };
}

module.exports = { createChatGPTWeb, modelMenu, composerSend, composerAttachments, promptMatches, pastePrompt, inProject };
