/* 用法：node --test tests/desktop/test_chatgpt_web.cjs。
 * 用假的网页容器检查控制脚本能编译、模型流程与结果事件，不使用真实账号。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createHash } = require("node:crypto");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const { createChatGPTWeb, readAccountId, modelMenu, composerSend, composerReady, composerAttachments, promptMatches } = require("../../electron/chatgpt-web.cjs");
const { INSTRUCTIONS, mergeInstructions, projectPage } = require("../../electron/chatgpt-project.cjs");

// 模拟 Chromium Runtime，不依赖 Electron 等待整页资源加载的脚本入口。
function installRuntime(wc, readAccount = async () => 'account') {
  wc.session ||= {};
  wc.session.fetch = async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/api/auth/session');
    assert.equal(options.credentials, 'include');
    const id = await readAccount();
    return { ok: true, status: 200, json: async () => id ? { user: { id } } : {} };
  };
  const debug = wc.debugger ||= { isAttached: () => true, attach() {}, on() {} };
  debug.attach ||= () => {};
  const send = debug.sendCommand?.bind(debug);
  debug.sendCommand = async (method, args) => method === 'Runtime.evaluate'
    ? { result: { value: await wc.executeJavaScript(args.expression) } } : send?.(method, args);
}

// 独立执行宿主只记录容器归属，不模拟账号或真实浏览器。
class BackgroundWindow extends EventEmitter {
  constructor() {
    super();
    this.contentView = { children: [], addChildView: view => { this.contentView.children.push(view); },
      removeChildView: view => { this.contentView.children = this.contentView.children.filter(item => item !== view); } };
  }
  isDestroyed() { return !!this.destroyed; }
  destroy() { this.destroyed = true; }
}

test('登录核验使用账号会话，不依赖页面输入框或读取聊天正文', async () => {
  const run = response => readAccountId({
    fetch: async (url, options) => {
      assert.equal(url, 'https://chatgpt.com/api/auth/session');
      assert.equal(options.credentials, 'include');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.redirect, 'error');
      return response;
    },
  });
  const ok = data => ({ ok: true, status: 200, json: async () => data });
  assert.equal(await run(ok({ user: { id: 'account' }, accessToken: '不得返回的令牌' })), 'account',
    '项目目录没有聊天输入框，仍应识别有效登录');
  assert.equal(await run(ok({})), '', '空会话不能识别为已登录');
  assert.equal(await run({ ok: false, status: 401 }), '');
  await assert.rejects(run({ ok: false, status: 503 }), /HTTP 503/);
  await assert.rejects(run({ ok: false, status: 403 }), /HTTP 403/);
  await assert.rejects(run({ ok: true, json: async () => { throw new SyntaxError('HTML'); } }), /未返回有效数据/);
  await assert.rejects(run(ok({ user: { name: '残缺的用户资料' } })), /未返回完整用户信息/);
  await assert.rejects(run(ok(null)), /格式异常/);
  await assert.rejects(readAccountId({ fetch: async () => { throw new TypeError('Failed to fetch\n堆栈'); } }),
    { message: 'ChatGPT 账号接口连接失败：Failed to fetch' });
});

test('纯文字编辑区可用时无需附件入口，禁用输入框不能发送', () => {
  const box = { matches: () => true, getAttribute: () => null, getBoundingClientRect: () => ({ width: 600, height: 80 }) };
  const run = () => runInNewContext(`(${composerReady.toString()})()`, { document: { querySelector: () => box } });
  assert.equal(run().ready, true);
  box.disabled = true;
  assert.equal(run().ready, false);
});

test("侧栏项目行提供项目地址时直接复用，不触发同名创建", () => {
  const original = { document: global.document, location: global.location };
  const project = { getAttribute: key => ({ "data-app-action-sidebar-project-label": "翻译",
    "data-app-action-sidebar-project-id": "g-p-existing" })[key] || null };
  global.document = { querySelectorAll: selector => selector.includes("data-app-action-sidebar-project-id") ? [project] : [] };
  global.location = { origin: "https://chatgpt.com" };
  try {
    assert.deepEqual(projectPage("find", "翻译"), { url: "https://chatgpt.com/g/g-p-existing/project" });
    assert.equal(projectPage("find", "其他项目"), null);
  } finally {
    global.document = original.document;
    global.location = original.location;
  }
});

test('项目指令读取跳过尺寸为零的旧弹层', t => {
  const original = global.document;
  t.after(() => { global.document = original; });
  const box = value => ({ value, getBoundingClientRect: () => ({ width: 200, height: 100 }),
    closest: () => null, matches: () => false });
  const dialog = (width, value) => ({ getBoundingClientRect: () => ({ width, height: 100 }),
    closest: () => null, querySelectorAll: () => [box(value)] });
  global.document = { querySelectorAll: selector => selector === '[role="dialog"],dialog'
    ? [dialog(0, '旧指令'), dialog(300, '当前指令')] : [] };
  assert.deepEqual(projectPage('read-instructions'), { opened: true, text: '当前指令' });
});

test("项目目录能找到侧栏未显示的同名项目", () => {
  const original = { document: global.document, location: global.location };
  const open = { getAttribute: key => key === "aria-label" ? "在项目中开始新聊天" : null,
    click() { this.opened = true; } };
  const row = { querySelectorAll: selector => selector === "span" ? [{ children: [], innerText: "翻译" }] : [open] };
  global.document = { querySelectorAll: selector => selector === "[data-project-row]" ? [row] : [] };
  global.location = { origin: "https://chatgpt.com" };
  try {
    assert.deepEqual(projectPage("find", "翻译"), { present: true });
    assert.equal(projectPage("open-existing", "翻译"), true);
    assert.equal(open.opened, true);
  } finally {
    global.document = original.document;
    global.location = original.location;
  }
});

test("项目指令保留已有内容且重复执行不会追加副本", () => {
  const merged = mergeInstructions("用户原有规则");
  assert.match(merged, /^用户原有规则/);
  assert.ok(merged.includes(INSTRUCTIONS));
  assert.equal(mergeInstructions(merged), merged);
  assert.equal((merged.match(/EasyRead 通用指令·版本/g) || []).length, 1);
});

test("升级项目指令时清理历史版本和手工粘贴的重复段落", () => {
  const legacy = "【EasyRead 通用指令·版本 1】\n旧规则\n【EasyRead 通用指令结束】";
  const pasted = "【EasyRead 通用指令·v2】\n手工粘贴的规则\n【EasyRead 通用指令结束】";
  const merged = mergeInstructions(`用户原有规则\n\n${legacy}\n\n${pasted}\n\n其他规则`);
  assert.equal(merged, `用户原有规则\n\n其他规则\n\n${INSTRUCTIONS}`);
  assert.equal(mergeInstructions(merged), merged);
});

test("富文本编辑器换行方式不同仍能确认提示词正文完整", () => {
  const old = global.document;
  global.document = { querySelector: () => ({ matches: () => true, innerText: "第一页\n\n公式", textContent: "第一页公式" }) };
  try {
    assert.equal(promptMatches("第一页\n公式").correct, true);
    assert.equal(promptMatches("第一页\n公式和图").correct, false);
  } finally { global.document = old; }
});

test("发送按钮在编辑区内识别，排除屏幕外的备用控件并等待附件完成", () => {
  const send = { disabled: true, type: "button", getAttribute: name => name === "data-testid" ? "composer-submit-button" : null,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 32, height: 32 }), click() { this.clicks = (this.clicks || 0) + 1; } };
  const offscreen = { ...send, disabled: false,
    getBoundingClientRect: () => ({ left: -60, top: 20, width: 32, height: 32 }) };
  const root = { parentElement: null, querySelectorAll: () => [offscreen, send] };
  const box = { parentElement: root };
  const old = global.document;
  global.document = { querySelector: () => box };
  try {
    assert.deepEqual(composerSend(), { found: true, ready: false, x: 14, y: 36 });
    send.disabled = false;
    assert.deepEqual(composerSend(), { found: true, ready: true, x: 14, y: 36 });
    send.type = 'submit';
    send.form = { requestSubmit(button) { assert.equal(button, send); this.submitted = true; } };
    composerSend('submit');
    assert.equal(send.form.submitted, true, '通过表单提交保留网页校验及 submitter');
  } finally { global.document = old; }
});

test("模型菜单识别 portal 中普通 menuitem，并能选中它", async () => {
  const item = { innerText: "GPT Test\n适合翻译", getBoundingClientRect: () => ({ width: 130, height: 34 }),
    getAttribute: name => name === "aria-checked" ? "true" : null, click() { this.clicked = true; } };
  const popup = { getBoundingClientRect: () => ({ width: 240, height: 300 }), querySelectorAll: () => [item] };
  const button = { innerText: "GPT Auto", getBoundingClientRect: () => ({ width: 120, height: 34 }),
    getAttribute: name => name === "aria-expanded" ? "false" : null,
    click() { this.clicks = (this.clicks || 0) + 1; } };
  const old = global.document;
  global.document = { querySelector: () => button,
    querySelectorAll: selector => selector.startsWith('[data-testid*="model-switcher"]') || selector.startsWith('button[aria-label="选择 ChatGPT 模型"]') ? [button] : [popup],
    getElementById: () => null };
  try {
    const result = await modelMenu("list");
    assert.deepEqual(result.models, [{ name: "GPT Test", selected: true }]);
    assert.equal(button.clicks, 2);
    await modelMenu("select", "GPT Test");
    assert.equal(item.clicked, undefined, "已选中的模型不能再次点击，避免开启新会话");
    item.getAttribute = () => null;
    assert.equal((await modelMenu("select", "GPT Test")).changed, true);
    assert.equal(item.clicked, true);
    popup.querySelectorAll = selector => selector.includes("menuitem") ? [] : [item];
    assert.deepEqual((await modelMenu("list")).models, [{ name: "GPT Test", selected: false }]);
  } finally { global.document = old; }
});

test("附件核验限定当前编辑区，项目库同名文件不能冒充已上传附件", () => {
  const old = global.document;
  const input = { accept: '.pdf,.txt', setAttribute(name, value) { this[name] = value; } };
  const images = { accept: 'image/png,image/jpeg,image/webp', setAttribute(name, value) { this[name] = value; } };
  let draft = [];
  const root = { querySelectorAll: selector => selector === 'button' ? draft : [images, input] };
  global.document = { querySelector: () => ({ closest: () => root }), querySelectorAll: () => [] };
  try {
    assert.equal(composerAttachments("state", "source.pdf").attached, false);
    input.disabled = images.disabled = true;
    assert.deepEqual(composerAttachments('ready'), { ready: false, loading: true });
    assert.equal(composerAttachments('input', 'source.pdf').input, false);
    input.disabled = images.disabled = false;
    assert.equal(composerAttachments('ready').ready, true);
    assert.equal(composerAttachments("input", "source.pdf").input, true);
    assert.equal(input['data-easyread-upload-input'], 'true');
    assert.equal(images['data-easyread-upload-input'], undefined, "PDF 不能走图片专用上传控件");
    draft = [{ getAttribute: () => "移除 source.pdf", click() { draft = []; } }];
    assert.equal(composerAttachments("state", "source.pdf").attached, true);
    assert.equal(composerAttachments("clear").removed, 1);
    assert.equal(composerAttachments("state", "source.pdf").attached, false);
  } finally { global.document = old; }
});

test("网页模型选择和回答回传保持一次完成事件", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "easyread-web-"));
  try {
    const pdf = path.join(home, "paper.pdf");
    fs.writeFileSync(pdf, "%PDF-1.4\n");
    let answerReads = 0;
    let fullAnswerReads = 0;
    let attached = false;
    let uploadFinished = false;
    const networkListeners = [];
    const sentFiles = [];
    const mouseEvents = [];
    const inputCommands = [];
    const loadedURLs = [];
    let submitted = false;
    let rejectNextDraft = false;
    let composerChecks = 0;
    let failNextUpload = false;
    let accountReads = 0;
    const typed = [];
    const projectURL = "https://chatgpt.com/g/g-p-translation/project";
    const deletedURL = "https://chatgpt.com/g/g-p-deleted/project";
    fs.writeFileSync(path.join(home, "chatgpt-web-project.json"), JSON.stringify({
      accountId: createHash("sha256").update("account").digest("hex"),
      url: deletedURL, instructionsHash: createHash("sha256").update(INSTRUCTIONS).digest("hex"),
      memoryScope: "project-only",
    }));
    const projectActions = [];
    let projectCreated = false, projectInstructions = "用户原有规则", projectMemory = "默认";
    const views = [], added = [], removed = [];
    class WebContentsView {
      constructor() {
        views.push(this);
        let current = "";
        const handlers = {};
        this.webContents = {
          handlers,
          session: { cookies: { get: async () => [{ name: "session", value: "account" }] } },
          setWindowOpenHandler() {}, on(name, fn) { handlers[name] = fn; }, isDestroyed: () => false, close() {},
          focus() {}, getURL: () => current,
          loadURL: async url => { current = url; loadedURLs.push(url); },
          debugger: { isAttached: () => true, attach() {}, on(event, listener) { if (event === 'message') networkListeners.push(listener); }, sendCommand: async (method, args) => {
            inputCommands.push(method);
            if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
            if (method === "DOM.querySelector") return { nodeId: 2 };
            if (method === "DOM.setFileInputFiles") {
              if (failNextUpload) {
                failNextUpload = false;
                throw Object.assign(new Error('模拟附件控件暂不可用'), { code: 'WEB_ATTACHMENT_NOT_READY' });
              }
              sentFiles.push(...args.files); attached = true;
              for (const listener of networkListeners) listener({}, 'Network.requestWillBeSent', {
                requestId: 'upload', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/files/process_upload_stream' },
              });
              setTimeout(() => {
                uploadFinished = true;
                for (const listener of networkListeners) listener({}, 'Network.loadingFinished', { requestId: 'upload' });
              }, 2000);
            }
            if (method === "Input.insertText") {
              if (args.text.includes("【EasyRead 通用指令")) projectInstructions = args.text;
              else { typed.push(args.text); submitted = false; }
            }
            if (method === "Input.dispatchMouseEvent" && args.type === "mouseReleased") {
              mouseEvents.push("click"); submitted = true; current = "https://chatgpt.com/g/g-p-translation/c/paper-chat-t1";
            }
            if (method === "Input.dispatchKeyEvent" && args.key === "Enter" && args.type === "keyUp") {
              mouseEvents.push("click"); submitted = true; current = "https://chatgpt.com/g/g-p-translation/c/paper-chat-t1";
            }
            return {};
          } },
          executeJavaScript: async source => {
            // 真实运行前先确认生成的页面脚本语法正确。
            new Function("return " + source);
            if (source.includes("!!document.querySelector('[data-testid=\"prompt-textarea\""))
              return false;
            if (source.includes("function projectPage")) {
              const args = JSON.parse(source.match(/\)\(\.\.\.(\[[\s\S]*\])\)$/)[1]);
              const [action, value] = args;
              projectActions.push(action);
              if (action === "find") return projectCreated ? { url: projectURL } : null;
              if (action === "submit-create") { projectCreated = true; current = projectURL; }
              if (action === "read-instructions") return { opened: true, text: projectInstructions };
              if (action === "focus-instructions") return true;
              if (action === "read-memory") return { text: projectMemory };
              if (action === "select-project-memory") { projectMemory = "仅限项目"; return true; }
              return true;
            }
            if (source.includes("main h1,main h2")) return current === projectURL;
            if (source.includes("async function modelMenu")) return { current: "GPT Test", models: [{ name: "GPT Test", selected: true }] };
            if (source.includes("const list = pageMessages().answers")) {
              answerReads++;
              if (answerReads === 2) throw new Error("网页短暂重绘");
              const text = answerReads <= 16 ? "**前半**" : "**前半**后半";
              const full = !source.endsWith("(...[false])");
              if (full) fullAnswerReads++;
              return answerReads === 1 ? { text: "", length: 0, count: 0, busy: false }
                : { text: full ? text : "", length: text.length, count: mouseEvents.length,
                  busy: false, complete: answerReads > 16 };
            }
            if (source.includes("function promptMatches")) {
              if (rejectNextDraft) { rejectNextDraft = false; throw new Error('模拟提交前草稿失败'); }
              return { correct: !submitted, actualLength: 10, expectedLength: 10 };
            }
            if (source.includes("function composerSend")) {
              const [action] = JSON.parse(source.match(/\)\(\.\.\.(\[[\s\S]*\])\)$/)[1]);
              if (action === "submit") {
                assert.equal(uploadFinished, true, '按钮变亮时仍须等待附件解析完成');
                mouseEvents.push("click"); submitted = true; current = "https://chatgpt.com/g/g-p-translation/c/paper-chat-t1";
              }
              return { found: true, ready: true, x: 32, y: 48 };
            }
            if (source.includes("function composerAttachments")) {
              const [action] = JSON.parse(source.match(/\)\(\.\.\.(\[[\s\S]*\])\)$/)[1]);
              if (action === 'ready') return { ready: ++composerChecks >= 4, loading: composerChecks < 4 };
              assert.ok(composerChecks >= 4, '须等历史加载完成、上传入口解除禁用后才能处理附件');
              if (action === "clear") { attached = false; return { removed: 0 }; }
              return { attached, input: true };
            }
            if (source.includes("function pageUserCount")) return mouseEvents.length;
            if (source.includes(".some(e => (e.innerText || e.getAttribute('aria-label')")) return attached;
            if (source.includes("!!document.querySelector('input[type=\"file\"]')")) return true;
            return null;
          },
        };
        installRuntime(this.webContents, async () => ++accountReads === 3 ? '' : 'account');
        this.setBounds = bounds => { this.bounds = bounds; };
        this.setVisible = value => { this.visible = value; };
      }
    }
    const win = { on() {}, getContentSize: () => [1200, 800], show() {}, focus() {},
      contentView: { addChildView(view) { added.push(view); }, removeChildView(view) { removed.push(view); } } };
    const app = { getPath: () => home, getLocale: () => "zh-CN" };
    const ipcMain = new EventEmitter();
    const web = createChatGPTWeb({ app, window: win, BrowserWindow: BackgroundWindow, WebContentsView, ipcMain });
    assert.equal((await web.status()).ready, true);
    assert.deepEqual(await web.initializeProject(), { ready: true, url: projectURL },
      "桌面启动时识别已删除的旧项目，重新创建并配置新项目");
    assert.ok(accountReads >= 4, '状态检查独立核验登录，账号指纹读取暂时失败时先重读');
    assert.deepEqual((await web.models()).models.map(x => x.name), ["GPT Test"]);
    const events = [];
    const execution = web.execute({ id: "r1", kind: "translation", model: "GPT Test", session: "paper/chat/t1",
      cwd: home, prompt: "问题", files: [pdf], marks_rev: "0" }, async event => events.push(event));
    const deadline = Date.now() + 20000;
    while (mouseEvents.length < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(mouseEvents.length, 1, "测试应完成自动发送");
    await views[0].webContents.loadURL("https://chatgpt.com/c/unrelated");
    views[0].webContents.handlers["did-navigate"]();
    const pendingState = JSON.parse(fs.readFileSync(path.join(home, "chatgpt-web-sessions.json"), "utf8"));
    assert.equal(pendingState["paper/chat/t1"].url, "https://chatgpt.com/g/g-p-translation/c/paper-chat-t1",
      "发送中误打开其他聊天不能覆盖原任务地址");
    await views[0].webContents.loadURL("https://chatgpt.com/g/g-p-translation/c/paper-chat-t1");
    web.show();
    assert.equal((await web.status()).running, true, "从顶栏打开网页不能中断当前翻译");
    assert.equal((await web.status()).visible, true);
    web.hide();
    assert.equal((await web.status()).running, true, "收起网页只改变显示状态");
    await execution;
    assert.deepEqual(sentFiles, [pdf]);
    assert.ok(projectActions.includes("open-create"), "首次使用自动建项目");
    assert.ok(projectActions.includes("save-instructions"), "项目通用指令写入后才发送");
    assert.ok(projectInstructions.includes(INSTRUCTIONS));
    assert.equal(projectMemory, "仅限项目");
    const savedSession = JSON.parse(fs.readFileSync(path.join(home, "chatgpt-web-sessions.json"), "utf8"));
    assert.equal(savedSession["paper/chat/t1"].projectURL, projectURL);
    assert.equal(savedSession["paper/chat/t1"].url, "https://chatgpt.com/g/g-p-translation/c/paper-chat-t1");
    assert.equal(typed.length, 1);
    assert.match(typed[0], /问题/);
    assert.deepEqual(mouseEvents, ["click"]);
    assert.equal(views[0].bounds.width, 1000, "打开或收起监视侧栏不改变后台执行视口");
    assert.deepEqual(events.filter(x => x.text || x.done || x.error).map(x => x.text || (x.done ? "done" : x.error)),
      ["**前半**后半"], "回答短暂停顿时不应提前结束，并且只回传稳定的最终正文");
    assert.equal((await web.status()).pending, 0);
    assert.equal(fullAnswerReads, 1, "发送前和生成期间只读状态，完成时才提取完整正文");
    assert.ok(inputCommands.includes("Emulation.setFocusEmulationEnabled"), "后台输入必须先启用焦点模拟");
    assert.ok(inputCommands.includes("Emulation.setDeviceMetricsOverride"), "后台页面必须保留实际视口");
    const previousLoads = loadedURLs.length;
    const previousSettings = projectActions.filter(action => action === "open-settings-menu").length;
    const secondEvents = [];
    await web.execute({ id: "r2", kind: "translation", model: "GPT Test", session: "paper/chat/t1",
      cwd: home, prompt: "继续翻译", files: [pdf], marks_rev: "0" }, async event => secondEvents.push(event));
    assert.equal(loadedURLs.length, previousLoads, "后续批次复用当前论文会话，不往返项目首页");
    assert.equal(projectActions.filter(action => action === "open-settings-menu").length, previousSettings);
    assert.deepEqual(sentFiles, [pdf], "同一会话中已确认上传的 PDF 不重复上传");
    assert.equal(secondEvents.filter(event => event.done).length, 1);
    assert.equal((await web.status()).pending, 0);
    // 连续批次中途失败：新附件未提交，不能污染历史；重试必须清掉旧草稿、重新上传。
    const additional = path.join(home, 'next-page.jpg');
    fs.writeFileSync(additional, 'synthetic-image');
    rejectNextDraft = true;
    const failedEvents = [];
    await web.execute({ id: 'r3', kind: 'translation', model: 'GPT Test', session: 'paper/chat/t1',
      cwd: home, prompt: '失败草稿', files: [pdf, additional] }, async event => failedEvents.push(event));
    assert.match(failedEvents.at(-1).error, /模拟提交前草稿失败/);
    assert.equal(mouseEvents.length, 2, '失败草稿不能发送模型请求');
    const beforeRetry = JSON.parse(fs.readFileSync(path.join(home, 'chatgpt-web-sessions.json'), 'utf8'));
    assert.equal(beforeRetry['paper/chat/t1'].files[additional], undefined);
    // 模拟旧页面没回报结束的上传请求；已清理的草稿不能阻挡下一批。
    for (const listener of networkListeners) listener({}, 'Network.requestWillBeSent', {
      requestId: 'stale-upload', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/files' },
    });
    const retriedEvents = [];
    await web.execute({ id: 'r4', kind: 'translation', model: 'GPT Test', session: 'paper/chat/t1',
      cwd: home, prompt: '恢复草稿', files: [pdf, additional] }, async event => retriedEvents.push(event));
    assert.equal(sentFiles.filter(file => file === additional).length, 2, '未提交的附件应在重试时重新上传');
    assert.equal(retriedEvents.filter(event => event.done).length, 1);
    const afterRetry = JSON.parse(fs.readFileSync(path.join(home, 'chatgpt-web-sessions.json'), 'utf8'));
    assert.ok(afterRetry['paper/chat/t1'].files[additional]);
    assert.equal(afterRetry['paper/chat/t1'].pending, undefined);
    const later = path.join(home, 'later-page.jpg');
    fs.writeFileSync(later, 'later-image');
    failNextUpload = true;
    const autoRetried = [];
    await web.execute({ id: 'r5', kind: 'translation', model: 'GPT Test', session: 'paper/chat/t1',
      cwd: home, prompt: '自动恢复附件', files: [pdf, additional, later] }, async event => autoRetried.push(event));
    assert.equal(autoRetried.filter(event => event.done).length, 1);
    assert.equal(autoRetried.filter(event => event.submission_started).length, 1, '准备阶段重载不能重复提交');
    assert.ok(autoRetried.some(event => /重新加载原会话/.test(event.message || '')));
    assert.equal(mouseEvents.length, 4);
    assert.deepEqual(added.filter(view => view !== views[0] && view !== views[3]), [views[1], views[2]], "网页任务继续在同一后台容器中完成");
    assert.equal(views[0].bounds.x, 0, "执行网页保持在独立后台宿主中");
    assert.equal(views[0].visible, true);
    web.show();
    assert.deepEqual(added.slice(-2), [views[1], views[2]]);
    assert.match(decodeURIComponent(views[1].webContents.getURL()), /关闭 ChatGPT 网页/);
    assert.equal(views[0].bounds.width, 696);
    // 仅拖动条能调整宽度；松手后保存比例，再拖至右边缘自动收起。
    ipcMain.emit("easyread:chatgpt-pane-drag", { sender: views[0].webContents }, { phase: "start", delta: 0 });
    ipcMain.emit("easyread:chatgpt-pane-drag", { sender: views[2].webContents }, { phase: "start", delta: 0 });
    ipcMain.emit("easyread:chatgpt-pane-drag", { sender: views[2].webContents }, { phase: "move", delta: 120 });
    assert.equal(views[0].bounds.width, 576);
    ipcMain.emit("easyread:chatgpt-pane-drag", { sender: views[2].webContents }, { phase: "end", delta: 120 });
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "chatgpt-web-pane.json"), "utf8")).fraction, 0.48);
    ipcMain.emit("easyread:chatgpt-pane-drag", { sender: views[2].webContents }, { phase: "start", delta: 0 });
    ipcMain.emit("easyread:chatgpt-pane-drag", { sender: views[2].webContents }, { phase: "end", delta: 500 });
    assert.equal((await web.status()).visible, false);
    assert.deepEqual(removed.filter(view => view !== views[0] && view !== views[3]).slice(-2), [views[2], views[1]]);
    assert.equal(views[0].visible, true);
    web.show();
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    views[1].webContents.handlers["will-navigate"](event, "https://easyread.invalid/close-chatgpt");
    assert.equal(event.prevented, true);
    assert.deepEqual(removed.filter(view => view !== views[0] && view !== views[3]).slice(-2), [views[2], views[1]]);
    assert.equal((await web.status()).visible, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("成功配置跨启动复用，显式检查时才修复网页项目设置", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "easyread-web-project-startup-"));
  try {
    const url = "https://chatgpt.com/g/g-p-existing/project";
    const accountId = createHash("sha256").update("account").digest("hex");
    const instructionsHash = createHash("sha256").update(INSTRUCTIONS).digest("hex");
    fs.writeFileSync(path.join(home, "chatgpt-web-project.json"), JSON.stringify({
      accountId, url, instructionsHash, memoryScope: "project-only",
    }));
    let instructions = "用户原有说明", memory = "默认";
    const actions = [];
    class WebContentsView {
      constructor() {
        let current = "";
        this.webContents = {
          focus() {}, getURL: () => current, loadURL: async next => { current = next; },
          debugger: { isAttached: () => true, attach() {}, on() {}, sendCommand: async (name, args) => {
            if (name === "Input.insertText") instructions = args.text;
          } },
          executeJavaScript: async source => {
            new Function("return " + source);
            if (source.includes("function projectPage")) {
              const [action] = JSON.parse(source.match(/\)\(\.\.\.(\[[\s\S]*\])\)$/)[1]);
              actions.push(action);
              if (action === "read-instructions") return { opened: true, text: instructions };
              if (action === "read-memory") return { text: memory };
              if (action === "select-project-memory") { memory = "仅限项目"; return true; }
              return true;
            }
            if (source.includes("main h1,main h2")) return current === url;
            return true;
          },
          on() {}, setWindowOpenHandler() {}, isDestroyed: () => false, close() {},
        };
        installRuntime(this.webContents);
        this.setBounds = bounds => { this.bounds = bounds; };
        this.setVisible = () => {};
      }
    }
    const win = { on() {}, getContentSize: () => [1200, 800], show() {}, focus() {},
      contentView: { addChildView() {}, removeChildView() {} } };
    const web = createChatGPTWeb({ app: { getPath: () => home, getLocale: () => "zh-CN" },
      window: win, BrowserWindow: BackgroundWindow, WebContentsView, ipcMain: new EventEmitter() });
    assert.deepEqual(await web.initializeProject(), { ready: true, url });
    assert.equal(actions.includes("read-instructions"), false, "普通启动复用账号和指令版本一致的成功配置");
    assert.deepEqual(await web.initializeProject({ refresh: true }), { ready: true, url });
    assert.ok(actions.includes("read-instructions"));
    assert.ok(instructions.includes(INSTRUCTIONS));
    assert.equal(memory, "仅限项目");
    assert.equal((instructions.match(/EasyRead 通用指令·版本/g) || []).length, 1);
    const previousReads = actions.filter(action => action === "read-instructions").length;
    assert.deepEqual(await web.initializeProject(), { ready: true, url });
    assert.equal(actions.filter(action => action === "read-instructions").length, previousReads,
      "同一次启动完成网页核对后不重复打开设置");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("未登录时项目检查和网页任务保持 EasyRead 界面，只有手动打开才显示网页", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "easyread-web-hidden-"));
  try {
    const views = [];
    let readError = '', failReads = 0, authenticated = false, accountReads = 0;
    class WebContentsView {
      constructor() {
        let current = "";
        views.push(this);
        this.webContents = {
          focus() {}, getURL: () => current, loadURL: async url => { current = url; },
          debugger: { isAttached: () => false },
          executeJavaScript: async source => {
            new Function("return " + source);
            return false;
          },
          on() {}, setWindowOpenHandler() {}, isDestroyed: () => false, close() {},
        };
        installRuntime(this.webContents, async () => {
          accountReads++;
          if (failReads-- > 0) throw new Error(readError);
          return authenticated ? 'account' : '';
        });
        this.setBounds = () => {};
        this.setVisible = value => { this.visible = value; };
      }
    }
    const calls = { show: 0, focus: 0, added: 0 };
    const win = { on() {}, getContentSize: () => [1200, 800],
      show() { calls.show++; }, focus() { calls.focus++; },
      contentView: { addChildView() { calls.added++; }, removeChildView() {} } };
    const web = createChatGPTWeb({ app: { getPath: () => home, getLocale: () => "zh-CN" },
      window: win, BrowserWindow: BackgroundWindow, WebContentsView, ipcMain: new EventEmitter() });
    assert.deepEqual(await web.initializeProject(), { ready: false, reason: "login-required" });
    await assert.rejects(web.models(), /打开 ChatGPT 完成登录/);
    const events = [];
    await web.execute({ id: "unsigned", session: "paper/chat", prompt: "问题" }, async event => events.push(event));
    assert.match(events.at(-1).error, /需要登录或验证/);
    readError = '模拟网络连接失败';
    failReads = 3;
    await web.execute({ id: 'read-failed', session: 'paper/chat', prompt: '问题' }, async event => events.push(event));
    assert.match(events.at(-1).error, /登录状态检查失败：ChatGPT 账号接口连接失败：模拟网络连接失败/);
    assert.doesNotMatch(events.at(-1).error, /需要登录或验证/);
    failReads = 1;
    const beforeRetry = accountReads;
    await web.execute({ id: 'read-retry', session: 'paper/chat', prompt: '问题' }, async event => events.push(event));
    assert.equal(accountReads - beforeRetry, 2, '短暂网络故障后应重新读取真实登录状态');
    assert.match(events.at(-1).error, /需要登录或验证/);
    // 模拟用户停在项目目录，登录有效但页面没有输入框；状态检查不可导航或提交。
    authenticated = true;
    await web.webContents.loadURL('https://chatgpt.com/projects');
    assert.equal((await web.status()).ready, true);
    assert.equal(web.webContents.getURL(), 'https://chatgpt.com/projects');
    await web.webContents.loadURL('https://auth.openai.com/log-in');
    const beforeRedirect = accountReads;
    assert.equal((await web.status()).ready, false);
    assert.equal(accountReads, beforeRedirect, '登录跳转页面不得注入账号接口请求');
    assert.equal((await web.status()).visible, false);
    assert.equal(views[0].visible, true, "后台容器保持布局，收起时位于主页面下面");
    assert.deepEqual(calls, { show: 0, focus: 0, added: 0 });
    web.show();
    assert.equal((await web.status()).visible, true);
    assert.deepEqual({ show: calls.show, focus: calls.focus }, { show: 1, focus: 1 });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("上次网页发送未确认时，另一个任务不能导航覆盖原回答", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "easyread-web-pending-"));
  try {
    fs.writeFileSync(path.join(home, "chatgpt-web-sessions.json"), JSON.stringify({
      "paper-one/translation": { url: "https://chatgpt.com/c/original", pending: { id: "old", at: Date.now() } },
    }));
    const urls = [], added = [];
    class WebContentsView {
      constructor() {
        let current = "";
        const handlers = {};
        this.webContents = { focus() {}, getURL: () => current, loadURL: async url => { current = url; urls.push(url); },
          on(name, fn) { handlers[name] = fn; }, setWindowOpenHandler() {}, isDestroyed: () => false, close() {},
          handlers };
        installRuntime(this.webContents);
        this.setBounds = () => {};
        this.setVisible = () => {};
      }
    }
    const win = { on() {}, getContentSize: () => [1200, 800], show() {}, focus() {},
      contentView: { addChildView(view) { added.push(view); }, removeChildView() {} } };
    const web = createChatGPTWeb({ app: { getPath: () => home, getLocale: () => "zh-CN" },
      window: win, BrowserWindow: BackgroundWindow, WebContentsView, ipcMain: new EventEmitter() });
    assert.deepEqual(await web.initializeProject(), { ready: false, reason: "pending" });
    assert.equal(urls.filter(url => url.startsWith("https://chatgpt.com/")).length, 0,
      "未确认任务存在时启动配置不能导航 ChatGPT 网页");
    const events = [];
    await web.execute({ id: "new", session: "paper-two/translation" }, async event => events.push(event));
    assert.match(events.at(-1).error, /上次网页发送尚未确认/);
    assert.equal(added.length, 0, "重复点击不能自动弹出网页侧栏");
    assert.equal(urls.filter(url => url.startsWith("https://chatgpt.com/")).length, 0,
      "新任务不能导航到其他 ChatGPT 会话");
    await web.webContents.loadURL("https://chatgpt.com/c/unrelated");
    web.webContents.handlers["did-navigate"]();
    const saved = JSON.parse(fs.readFileSync(path.join(home, "chatgpt-web-sessions.json"), "utf8"));
    assert.equal(saved["paper-one/translation"].url, "https://chatgpt.com/c/original",
      "查看其他聊天不能改写未确认任务的原会话地址");
    assert.deepEqual(web.clearPending(), { ok: true });
    const backup = fs.readdirSync(home).find(name => name.startsWith("chatgpt-web-pending-backup-"));
    assert.ok(backup, "用户手动清除未确认记录前应保留可追溯副本");
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, backup), "utf8"))["paper-one/translation"].url,
      "https://chatgpt.com/c/original");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("同一请求重试先回收网页已完成回答，不再次发送", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "easyread-web-recover-"));
  try {
    const prompt = "翻译第一页";
    const projectURL = "https://chatgpt.com/g/g-p-translation/project";
    const url = "https://chatgpt.com/g/g-p-translation/c/recover";
    const account = createHash("sha256").update("account").digest("hex");
    const promptHash = createHash("sha256").update(prompt).digest("hex");
    const stateFile = path.join(home, "chatgpt-web-sessions.json");
    fs.writeFileSync(stateFile, JSON.stringify({ paper: { url, projectURL, accountId: account, files: {},
      pending: { id: "previous", promptHash, beforeAnswers: 0 } } }));
    const urls = [], inserted = [];
    let fullAnswerReads = 0;
    class WebContentsView {
      constructor() {
        let current = "";
        this.webContents = {
          focus() {}, getURL: () => current, loadURL: async next => { current = next; urls.push(next); },
          session: { cookies: { get: async () => [{ name: "session", value: "account" }] } },
          executeJavaScript: async source => {
            new Function("return " + source);
            if (source.includes("const list = pageMessages().answers")) {
              const full = !source.endsWith("(...[false])");
              if (full) fullAnswerReads++;
              return { count: 1, text: full ? '{"pages":[]}' : '', length: 12,
                revision: 1, busy: false, complete: true };
            }
            if (source.includes("function pageUserCount")) return 1;
            if (source.includes("function composerSend")) inserted.push("send");
            if (source.includes("!!document.querySelector('[data-testid=\"prompt-textarea\"")) return true;
            return null;
          },
          on() {}, setWindowOpenHandler() {}, isDestroyed: () => false, close() {},
        };
        installRuntime(this.webContents);
        this.setBounds = () => {};
        this.setVisible = () => {};
      }
    }
    const win = { on() {}, getContentSize: () => [1200, 800], show() {}, focus() {},
      contentView: { addChildView() {}, removeChildView() {} } };
    const web = createChatGPTWeb({ app: { getPath: () => home, getLocale: () => "zh-CN" },
      window: win, BrowserWindow: BackgroundWindow, WebContentsView, ipcMain: new EventEmitter() });
    const events = [];
    await web.execute({ id: "retry", session: "paper", prompt, files: [], cwd: home }, async event => events.push(event));
    assert.deepEqual(events.filter(x => x.text || x.done || x.error).map(x => [x.text, x.done, x.error]),
      [['{"pages":[]}', true, undefined]]);
    assert.deepEqual(inserted, []);
    assert.equal(fullAnswerReads, 1, "恢复任务同样只提取一次完整正文");
    assert.deepEqual(urls.filter(x => x.startsWith("https://chatgpt.com/")), [url]);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).paper.pending, undefined);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("附属资源未加载完时，DOM 就绪即可检查页面，状态查询不改账号缓存", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "easyread-web-dom-"));
  try {
    let accountReads = 0;
    class WebContentsView {
      constructor() {
        let current = "";
        this.webContents = new EventEmitter();
        Object.assign(this.webContents, {
          focus() {}, getURL: () => current,
          loadURL: url => {
            current = url;
            queueMicrotask(() => this.webContents.emit("dom-ready"));
            return new Promise(() => {});
          },
          executeJavaScript: async source => {
            throw new Error('网页脚本不可执行时也应可以核验登录状态');
          },
          setWindowOpenHandler() {}, isDestroyed: () => false, close() {},
        });
        installRuntime(this.webContents, async () => { accountReads++; return 'account'; });
        this.setBounds = () => {};
        this.setVisible = () => {};
      }
    }
    const win = { on() {}, getContentSize: () => [1200, 800], show() {}, focus() {},
      contentView: { addChildView() {}, removeChildView() {} } };
    const web = createChatGPTWeb({ app: { getPath: () => home, getLocale: () => "zh-CN" },
      window: win, BrowserWindow: BackgroundWindow, WebContentsView, ipcMain: new EventEmitter() });
    const status = await web.status();
    assert.equal(status.ready, true);
    assert.equal(status.visible, false);
    assert.equal(accountReads, 1, '状态查询通过账号接口确认登录，不修改持久化账号缓存');
    assert.equal(fs.existsSync(path.join(home, 'chatgpt-web-project.json')), false);
    web.close();
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// 模拟已配置过的项目及纯文字网页，附件入口故意完全不可用。
function textChatFixture(t, { staleComposer = false, failAccount = 0, pending = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'easyread-text-chat-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const projectURL = 'https://chatgpt.com/g/g-p-text/project';
  const chatURL = 'https://chatgpt.com/g/g-p-text/c/chat-one';
  const accountId = createHash('sha256').update('account').digest('hex');
  const originalProject = { accountId, url: projectURL, instructionsHash: 'old', memoryScope: 'default' };
  fs.writeFileSync(path.join(home, 'chatgpt-web-project.json'), JSON.stringify(originalProject));
  const request = { id: 'text-chat', kind: 'chat', session: 'paper/chat', model: 'GPT Test',
    prompt: '解释勾画的段落', cwd: home, files: [], options: { project_sync: true } };
  if (pending) fs.writeFileSync(path.join(home, 'chatgpt-web-sessions.json'), JSON.stringify({
    [request.session]: { url: chatURL, projectURL, accountId,
      pending: { promptHash: createHash('sha256').update(request.prompt).digest('hex'), beforeAnswers: 0 } },
  }));
  const urls = [], events = [], inputs = [];
  let sent = 0, projectLoads = 0, accountReads = 0;
  class WebContentsView {
    constructor() {
      let current = '';
      this.webContents = { focus() {}, getURL: () => current,
        loadURL: async url => { current = url; urls.push(url); if (url === projectURL) projectLoads++; },
        on() {}, setWindowOpenHandler() {}, isDestroyed: () => false, close() {},
        debugger: { isAttached: () => true, attach() {}, on() {}, sendCommand: async method => {
          assert.notEqual(method, 'DOM.setFileInputFiles', '问答不能上传任何附件');
        } },
        executeJavaScript: async source => {
          new Function('return ' + source);
          if (source.includes('function projectPage') || source.includes('function projectFilesPage'))
            throw new Error('问答不能修改项目设置或同步项目文件');
          if (source.includes('/api/auth/session')) throw new Error('不能通过网页脚本核验登录');
          if (source.includes('function composerReady')) return { ready: !staleComposer || projectLoads >= 2 };
          if (source.includes('function composerAttachments')) {
            assert.ok(source.endsWith('(...["clear"])'), '只允许移除旧草稿附件，不等待上传控件');
            return { removed: 0 };
          }
          if (source.includes('function modelMenu')) return { current: 'GPT Test' };
          if (source.includes('function pastePrompt')) { inputs.push(request.prompt); return true; }
          if (source.includes('function promptMatches')) return { correct: !sent, actualLength: request.prompt.length };
          if (source.includes('function pageUserCount')) return sent;
          if (source.includes('function composerSend')) {
            if (source.endsWith('(...["submit"])')) { sent++; current = chatURL; }
            return { found: true, ready: true };
          }
          if (source.includes('const list = pageMessages().answers'))
            return { count: sent, length: sent ? 2 : 0, text: sent ? '解释' : '', complete: !!sent, busy: false };
          return true;
        },
      };
      installRuntime(this.webContents, async () => {
        accountReads++;
        if (accountReads <= failAccount) throw new TypeError('Failed to fetch');
        return 'account';
      });
      this.setBounds = () => {};
      this.setVisible = () => {};
    }
  }
  const win = { on() {}, getContentSize: () => [1200, 800], show() {}, focus() {},
    contentView: { addChildView() {}, removeChildView() {} } };
  const web = createChatGPTWeb({ app: { getPath: () => home, getLocale: () => 'zh-CN' },
    window: win, BrowserWindow: BackgroundWindow, WebContentsView, ipcMain: new EventEmitter() });
  t.after(() => web.close());
  return { web, home, request, urls, events, inputs, projectURL, chatURL, originalProject,
    run: () => web.execute(request, async event => events.push(event)), sent: () => sent };
}

test('问 AI 复用已有项目，只发送文字；旧指令和锁定记忆模式不触发设置', async t => {
  const f = textChatFixture(t);
  await f.run();
  assert.equal(f.events.at(-1).text, '解释');
  assert.equal(f.events.at(-1).done, true);
  assert.equal(f.sent(), 1);
  assert.deepEqual(f.inputs, [f.request.prompt]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'chatgpt-web-project.json'), 'utf8')), f.originalProject);
  assert.equal(f.urls.filter(url => url === f.projectURL).length, 1);
});

test('首次项目输入框不可用时自动刷新一次，恢复后只提交一次问题', async t => {
  const f = textChatFixture(t, { staleComposer: true });
  await f.run();
  assert.equal(f.events.at(-1).done, true);
  assert.equal(f.sent(), 1);
  assert.equal(f.urls.filter(url => url === f.projectURL).length, 2);
  assert.ok(f.events.some(event => /刷新原页面/.test(event.message || '')));
});

test('登录网络短暂故障可以恢复；未确认回答存在时不能自动刷新', async t => {
  const f = textChatFixture(t, { failAccount: 1 });
  await f.run();
  assert.equal(f.events.at(-1).done, true);
  assert.equal(f.sent(), 1);
  assert.ok(f.events.some(event => /刷新后重新核验/.test(event.message || '')));
  const waiting = textChatFixture(t, { failAccount: 3, pending: true });
  await waiting.run();
  assert.match(waiting.events.at(-1).error, /账号接口连接失败/);
  assert.equal(waiting.sent(), 0);
  assert.deepEqual(waiting.urls.filter(url => url.startsWith('https://chatgpt.com/')), [waiting.chatURL]);
  assert.equal((await waiting.web.status()).pending, 1);
});
