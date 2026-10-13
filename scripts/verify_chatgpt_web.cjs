/*
 * 用法（Windows PowerShell）：
 *   node .\scripts\dev_desktop.cjs .\scripts\verify_chatgpt_web.cjs --inspect
 *   node .\scripts\dev_desktop.cjs .\scripts\verify_chatgpt_web.cjs --inspect-pending
 *   node .\scripts\dev_desktop.cjs .\scripts\verify_chatgpt_web.cjs --clear-pending
 *   node .\scripts\dev_desktop.cjs .\scripts\verify_chatgpt_web.cjs --setup-project
 *   node .\scripts\dev_desktop.cjs .\scripts\verify_chatgpt_web.cjs --inspect-project
 *   node .\scripts\dev_desktop.cjs .\scripts\verify_chatgpt_web.cjs C:\path\to\source.pdf "模型名"
 * --inspect 只查看登录和项目数量；--setup-project 核对或设置项目；传入论文会发送一次测试提问。
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

async function main() {
  const inspect = process.argv[2] === "--inspect";
  const inspectPending = process.argv[2] === "--inspect-pending";
  const clearPending = process.argv[2] === "--clear-pending";
  const setup = process.argv[2] === "--setup-project";
  const inspectProject = process.argv[2] === "--inspect-project";
  const pdf = !inspect && !inspectPending && !clearPending && !setup && !inspectProject ? path.resolve(process.argv[2] || "") : "";
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
