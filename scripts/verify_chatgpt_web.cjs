/*
 * 用法（Windows PowerShell）：
 *   node .\scripts\dev_desktop.cjs .\scripts\verify_chatgpt_web.cjs --inspect-status
 *   node .\scripts\dev_desktop.cjs .\scripts\verify_chatgpt_web.cjs --inspect-pending
 *   node .\scripts\dev_desktop.cjs .\scripts\verify_chatgpt_web.cjs --clear-pending
 *   node .\scripts\dev_desktop.cjs .\scripts\verify_chatgpt_web.cjs --setup-project
 *   node .\scripts\dev_desktop.cjs .\scripts\verify_chatgpt_web.cjs --inspect-project
 *   node .\scripts\dev_desktop.cjs .\scripts\verify_chatgpt_web.cjs --inspect-controls
 *   node .\scripts\dev_desktop.cjs .\scripts\verify_chatgpt_web.cjs --inspect-resources
 *   node .\scripts\dev_desktop.cjs .\scripts\verify_chatgpt_web.cjs --inspect-composer <论文ID>
 *   node .\scripts\dev_desktop.cjs .\scripts\verify_chatgpt_web.cjs --sync-resources library/<论文ID>
 * --sync-resources 实际同步项目术语资料并核验持久化，重复运行验证版本复用，不发送翻译请求。
 * 资料与编辑区诊断只打开网页菜单，不上传文件或发送问题。
 * --inspect-controls 只打开项目菜单，输出控件标签以排查 DOM，不修改资料或指令。
 *   node .\scripts\dev_desktop.cjs .\scripts\verify_chatgpt_web.cjs C:\path\to\source.pdf "模型名"
 * --inspect-status 只查看登录和项目数量；--setup-project 核对或设置项目；传入论文会发送一次测试提问。
 * 性能诊断：先设置 $env:EASYREAD_WEB_TRACE="1"，再运行论文验证命令，查看各阶段耗时。
 * 仅输出状态和回答长度，不打印论文、回答正文或账号资料。
 */
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { app, BrowserWindow, WebContentsView, ipcMain } = require("electron");
const { createChatGPTWeb } = require("../electron/chatgpt-web.cjs");

app.setName("EasyRead");
app.setPath("userData", path.join(app.getPath("appData"), "EasyRead"));
// 诊断中的网页导航可关闭临时窗口，退出由 main 的完成或失败统一决定。
app.on('window-all-closed', () => {});

async function main() {
  // 避免使用 Electron 会吞掉并开启调试端口的 --inspect 参数。
  const inspect = process.argv[2] === "--inspect-status";
  const inspectPending = process.argv[2] === "--inspect-pending";
  const clearPending = process.argv[2] === "--clear-pending";
  const setup = process.argv[2] === "--setup-project";
  const inspectProject = process.argv[2] === "--inspect-project";
  const inspectControls = process.argv[2] === '--inspect-controls';
  const inspectResources = process.argv[2] === '--inspect-resources';
  const inspectComposer = process.argv[2] === '--inspect-composer';
  const syncResources = process.argv[2] === '--sync-resources';
  const pdf = !inspect && !inspectPending && !clearPending && !setup && !inspectProject && !inspectControls && !inspectResources && !inspectComposer && !syncResources ? path.resolve(process.argv[2] || "") : "";
  const model = pdf ? process.argv[3] || "" : "";
  if (pdf && (!fs.existsSync(pdf) || !model)) throw new Error("请提供现有论文的 source.pdf 路径和网页模型名称");
  const page = pdf ? path.join(path.dirname(pdf), "extract", "page-001.txt") : "";
  if (pdf && !fs.existsSync(page)) throw new Error("论文缺少 extract/page-001.txt，无法验证翻译流程");
  const win = new BrowserWindow({ width: 1200, height: 800, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const web = createChatGPTWeb({ app, window: win, BrowserWindow, WebContentsView, ipcMain });
  const deadline = setTimeout(() => web.cancel(), 300000);
  try {
    let status;
    for (let attempt = 0; attempt < 45; attempt++) {
      status = await web.status();
      if (status.ready) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!status.ready) throw new Error("当前 Windows 桌面登录会话不可用，请先在 EasyRead 内登录 ChatGPT");
    if (syncResources) {
      if (!process.argv[3]) throw new Error('请提供论文目录');
      const result = await web.syncResources(path.resolve(process.argv[3]));
      console.log(JSON.stringify(result));
      if (result.status !== 'confirmed') throw new Error(result.error || '项目资料同步未确认');
      return;
    }
    if (inspectResources || inspectComposer) {
      const wc = web.webContents;
      if (!wc.debugger.isAttached()) wc.debugger.attach();
      const evaluate = async expression => {
        const result = await wc.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
      };
      const project = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'chatgpt-web-project.json')));
      const sessions = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'chatgpt-web-sessions.json')));
      const saved = Object.entries(sessions).find(([key]) => key.includes(process.argv[3]) && key.endsWith('/translation'))?.[1];
      if (inspectComposer && !saved?.url) throw new Error('找不到指定论文的翻译会话');
      await Promise.race([wc.loadURL(inspectComposer ? saved.url : project.url).catch(() => {}), new Promise(resolve => setTimeout(resolve, 12000))]);
      for (let attempt = 0; attempt < 120; attempt++) {
        const ready = await evaluate(inspectComposer ? `!!document.querySelector('main input[type="file"]')` :
          `[...document.querySelectorAll('main h1,main h2')].some(el=>el.textContent.trim()==='翻译')`);
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const snapshot = `(() => ({
        controls:[...document.querySelectorAll('main button,[role="tab"],[role="menuitem"],[role="dialog"] button')]
          .filter(el => el.getBoundingClientRect().width > 0).slice(-65).map(el => ({
            tag:el.tagName,role:el.getAttribute('role'),label:(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0,150),
            disabled:el.disabled,expanded:el.getAttribute('aria-expanded'),selected:el.getAttribute('aria-selected'),
            attrs:[...el.attributes].filter(a=>/^(data-|id$|aria-controls)/.test(a.name)).map(a=>[a.name,a.value.slice(0,160)])})),
        inputs:[...document.querySelectorAll('input[type="file"]')].map(el=>({accept:el.accept,disabled:el.disabled,inForm:!!el.closest('form'),html:el.outerHTML.slice(0,900)})),
        panels:[...document.querySelectorAll('[role="tabpanel"],[role="dialog"]')].filter(el=>el.getBoundingClientRect().width>0)
          .map(el=>({text:el.innerText.slice(0,500),html:el.outerHTML.replace(/<svg[\\s\\S]*?<\\/svg>/g,'').slice(0,16000)}))
      }))()`;
      console.log(JSON.stringify({ before: await evaluate(snapshot) }));
      if (inspectResources) await evaluate(`(() => {
        const tab=[...document.querySelectorAll('button,[role="tab"]')].find(el=>el.getBoundingClientRect().width>0 && /^(来源|资料|sources)(\\s*\\d+)?$/i.test((el.textContent||'').trim()));
        tab?.click(); return !!tab;
      })()`);
      else {
        const { composerAttachments } = require('../electron/chatgpt-web.cjs');
        console.log(JSON.stringify({ open: await evaluate(`(${composerAttachments.toString()})('open')`) }));
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (inspectResources) for (let attempt = 0; attempt < 120; attempt++) {
        const ready = await evaluate(`(() => {
          const tab=[...document.querySelectorAll('[role="tab"]')].find(el=>/来源|sources/i.test(el.textContent));
          const panel=tab && document.getElementById(tab.getAttribute('aria-controls'));
          return panel && panel.getBoundingClientRect().width>0 && ![...panel.querySelectorAll('[role="status"]')]
            .some(el=>/加载|loading/i.test(el.textContent));
        })()`);
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      console.log(JSON.stringify({ after: await evaluate(snapshot) }));
      return;
    }
    if (inspectControls) {
      const { projectPage } = require('../electron/chatgpt-project.cjs');
      const cached = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'chatgpt-web-project.json'), 'utf8'));
      const wc = web.webContents;
      if (!wc.debugger.isAttached()) wc.debugger.attach();
      const evaluate = async expression => {
        const result = await wc.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
      };
      await Promise.race([wc.loadURL(cached.url).catch(error => {
        // 网站客户端重定向可能使 loadURL 返回 ERR_ABORTED，随后仍按可见标题核实。
        if (error.code !== 'ERR_ABORTED' && error.errno !== -3) throw error;
      }), new Promise(resolve => setTimeout(resolve, 12000))]);
      let ready = false;
      for (let n = 0; n < 120 && !ready; n++) {
        ready = await evaluate(`!![...document.querySelectorAll('main h1,main h2')].find(el => el.textContent.trim() === '翻译')`);
        if (!ready) await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!ready) throw new Error('项目页面尚未加载完成');
      const controls = `JSON.stringify([...document.querySelectorAll('main button,[role="menuitem"],[role="dialog"] button')]
        .filter(el => el.getBoundingClientRect().width > 0).slice(0,40).map(el => ({
          label:(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0,100),
          testid:el.getAttribute('data-testid'), role:el.getAttribute('role'), disabled:el.disabled,
          expanded:el.getAttribute('aria-expanded')})))`;
      console.log(await evaluate(controls));
      console.log(JSON.stringify(await evaluate(`(${projectPage.toString()})('open-settings-menu','翻译')`)));
      await new Promise(resolve => setTimeout(resolve, 1500));
      console.log(await evaluate(controls));
      console.log(JSON.stringify(await evaluate(`(${projectPage.toString()})('open-settings')`)));
      await new Promise(resolve => setTimeout(resolve, 1500));
      let instructions = await evaluate(`(${projectPage.toString()})('read-instructions')`);
      if (!instructions.opened) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        instructions = await evaluate(`(${projectPage.toString()})('read-instructions')`);
      }
      console.log(JSON.stringify({ instructionsOpened: instructions.opened, length: instructions.text?.length,
        currentVersion: instructions.text?.includes('【EasyRead 通用指令·版本 3】'), error: instructions.error }));
      console.log(await evaluate(controls));
      return;
    }
    if (inspectProject) {
      // 从项目页面的会话列表核验归属；不使用普通会话作为翻译验证。
      const cached = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "chatgpt-web-project.json"), "utf8"));
      const wc = web.webContents;
      await Promise.race([wc.loadURL(cached.url), new Promise(resolve => setTimeout(resolve, 12000))]);
      await new Promise(resolve => setTimeout(resolve, 10000));
      const snapshot = await wc.executeJavaScript(`(() => ({
        heading: [...document.querySelectorAll('main h1,main h2')].some(el => el.textContent.trim()==='翻译'),
        conversations: [...document.querySelectorAll('main a[href*="/c/"]')].slice(0,30)
          .map(el => ({ path: new URL(el.href).pathname, title: el.textContent.trim().slice(0,80) })),
        rowAttributes: [...document.querySelectorAll('main [data-conversation-id],main [data-thread-id]')]
          .slice(0,30).map(el=>el.getAttribute('data-conversation-id')||el.getAttribute('data-thread-id'))
      }))()`);
      console.log(JSON.stringify(snapshot));
      return;
    }
    if (clearPending) {
      const userData = app.getPath("userData");
      const before = new Set(fs.readdirSync(userData).filter(name => /^chatgpt-web-pending-backup-\d+\.json$/.test(name)));
      web.clearPending();
      const backup = fs.readdirSync(userData).find(name => /^chatgpt-web-pending-backup-\d+\.json$/.test(name) && !before.has(name));
      console.log(JSON.stringify({ pending: (await web.status()).pending, backup: backup ? path.join(userData, backup) : null }));
      return;
    }
    if (inspectPending) {
      const file = path.join(app.getPath("userData"), "chatgpt-web-sessions.json");
      const sessions = JSON.parse(fs.readFileSync(file, "utf8"));
      const old = Object.values(sessions).find(value => value.pending);
      if (!old) { console.log(JSON.stringify({ pending: false })); return; }
      const wc = web.webContents;
      await Promise.race([wc.loadURL(old.url).catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 12000))]);
      let answer = { count: 0, text: "", busy: false, complete: false };
      for (let attempt = 0; attempt < 60; attempt++) {
        answer = await web.inspectAnswer().catch(() => answer);
        if (answer.count > old.pending.beforeAnswers && answer.complete) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      const users = await wc.executeJavaScript(`(() => {
        const legacy = [...document.querySelectorAll('[data-message-author-role="user"]')];
        if (legacy.length) return legacy.map(el => el.innerText || el.textContent || '');
        return [...document.querySelectorAll('h4.sr-only')]
          .filter(el => /^(你说|you said)/i.test((el.textContent || '').trim()))
          .map(el => el.closest('div[class^="block-"]')?.innerText || '');
      })()`).catch(() => []);
      const hash = text => createHash("sha256").update(text).digest("hex");
      console.log(JSON.stringify({ pending: true, beforeAnswers: old.pending.beforeAnswers,
        currentAnswers: answer.count, answerCharacters: answer.text.length,
        busy: answer.busy, complete: answer.complete, hasProject: !!old.projectURL,
        userCount: users.length, lastUserLength: users.at(-1)?.length || 0,
        conversationURL: old.url?.includes('/c/'),
        lastUserHashMatches: users.some(text => hash(text) === old.pending.promptHash) }));
      const links = await wc.debugger.sendCommand('Runtime.evaluate', { returnByValue: true,
        expression: `JSON.stringify([...document.querySelectorAll('a[href],button')]
          .filter(el => /sandbox:|\\.json|下载|download/i.test((el.getAttribute('href') || '') + (el.textContent || '')))
          .slice(0,12).map(el => ({ tag:el.tagName, label:(el.textContent || '').trim().slice(0,100),
            href:(el.getAttribute('href') || '').split('?')[0].slice(0,200),
            width:el.getBoundingClientRect().width, height:el.getBoundingClientRect().height })))` });
      console.log(links.result.value);
      // 诊断虚拟滚动及新版文件卡片：只输出控件结构与短标签，不输出论文全文。
      const structure = await wc.debugger.sendCommand('Runtime.evaluate', { returnByValue: true,
        expression: `(() => {
          const roots = [...document.querySelectorAll('[data-message-author-role="assistant"], h4.sr-only')]
            .filter(el => el.matches('[data-message-author-role="assistant"]') || /^(ChatGPT|助手)/i.test(el.textContent.trim()))
            .map(el => el.matches('h4') ? el.closest('div[class^="block-"]') : el).filter(Boolean);
          roots.at(-1)?.scrollIntoView({block:'end'});
          return roots.slice(-2).map(el => ({tag:el.tagName, cls:el.className,
            controls:[...el.querySelectorAll('button,[role="button"],a[href],[title]')].slice(0,30)
              .map(control => ({tag:control.tagName, label:(control.getAttribute('aria-label') ||
                control.getAttribute('title') || control.textContent || '').slice(0,160),
                width:control.getBoundingClientRect().width, height:control.getBoundingClientRect().height}))}));
        })()` });
      console.log(JSON.stringify({ structure: structure.result.value }));
      await new Promise(resolve => setTimeout(resolve, 1500));
      const image = await wc.capturePage().catch(() => null);
      if (image) {
        const file = path.join(require('node:os').tmpdir(), 'easyread-pending-debug.png');
        fs.writeFileSync(file, image.toPNG());
        console.log(JSON.stringify({ debugImage: file }));
      }
      return;
    }
    if (inspect) {
      const wc = web.webContents;
      await Promise.race([wc.loadURL("https://chatgpt.com/projects").catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 12000))]);
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        ready = await wc.executeJavaScript(`!!document.querySelector('[data-projects-rows]')`).catch(() => false);
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!ready) throw new Error("ChatGPT 项目目录尚未加载");
      const count = await wc.executeJavaScript(`(() => [...document.querySelectorAll('[data-project-row]')]
        .filter(row => [...row.querySelectorAll('span')].some(el => !el.children.length &&
          (el.innerText || el.textContent || '').trim() === '翻译')).length)()`);
      console.log(JSON.stringify({ ready: true, pending: status.pending, translationProjects: count }));
      return;
    }
    if (setup) {
      // 与正式启动一致：项目配置在隐藏的网页容器中完成。
      const result = await web.initializeProject({ refresh: true });
      if (!result.ready) throw new Error(result.error || "ChatGPT 项目尚未就绪，请先登录");
      const url = result.url;
      console.log(JSON.stringify({ ready: true, project: "翻译", projectURL: url,
        instructionsSaved: true, memoryScope: "project-only" }));
      return;
    }
    // 正式任务会在项目内选择并核验模型，验证脚本也走同一执行路径。
    const original = fs.readFileSync(page, "utf8").slice(0, 2000);
    // 每轮使用不同标识，确保核验的是本次输入，旧草稿无法误通过正文匹配。
    const prompt = `验证编号：${Date.now()}。\n请把下面论文第一页的一小段翻译成中文。只返回 JSON 对象，格式为 {"translation":"译文"}。\n\n${original}`;
    let answer = "", completed = false, failure = "";
    const started = performance.now();
    await web.execute({ id: `verify-${Date.now()}`, kind: "translation", model,
      session: `validation/${path.basename(path.dirname(pdf))}`, cwd: path.dirname(pdf), prompt,
      files: [pdf], marks_rev: "0" }, async event => {
      if (event.text) answer += event.text;
      if (event.done) completed = true;
      if (event.error) failure = event.error;
    });
    if (failure) {
      if (process.env.EASYREAD_WEB_TRACE === '1') {
        const image = await Promise.race([web.webContents.capturePage(),
          new Promise(resolve => setTimeout(resolve, 3000))]);
        if (image && !image.isEmpty()) {
          const file = path.join(require('node:os').tmpdir(), 'easyread-web-debug.png');
          fs.writeFileSync(file, image.toPNG());
          console.log(JSON.stringify({ debugImage: file }));
        }
      }
      throw new Error(failure);
    }
    if (!completed) throw new Error("网页没有回传完成事件");
    let parsed = false;
    try { parsed = typeof JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, "")).translation === "string"; }
    catch (_) { /* 格式检查在下方统一报告。 */ }
    if (!parsed) throw new Error(`收到 ${answer.length} 字回答，但翻译 JSON 格式不符合约定`);
    console.log(JSON.stringify({ ready: true, model, answerCharacters: answer.length, jsonParsed: parsed,
      elapsedMs: Math.round(performance.now() - started) }));
  } finally {
    clearTimeout(deadline);
    web.close();
    win.close();
  }
}

app.whenReady().then(main).then(() => app.quit(), error => {
  console.error(`ChatGPT 网页验证失败：${error.message}`);
  app.exit(1);
});
