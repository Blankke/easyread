/*
 * 用法：node scripts/dev_desktop.cjs scripts/verify_web_background.cjs
 * 在隐藏的 Electron 窗口和网页容器中验证实际视口、富文本状态、表单发送与回答提取。
 * 使用本地测试页面，另以临时 Chromium 会话验证 Cookie 登录核验；不访问真实账号或发送论文。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, WebContentsView } = require('electron');
const { ipcMain } = require('electron');
const { createChatGPTWeb, readAccountId, composerSend, promptMatches, pastePrompt } = require('../electron/chatgpt-web.cjs');
const { readAnswer } = require('../electron/chatgpt-answer.cjs');

app.whenReady().then(async () => {
  // 真实网页即使把 fetch 包装成失败函数，会话网络层仍应携带同一容器的 Cookie。
  const server = http.createServer((req, res) => {
    if (req.url === '/auth') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.headers.cookie?.includes('fixture=ready') ? { user: { id: 'fixture-account' } } : {}));
    } else {
      res.setHeader('Set-Cookie', 'fixture=ready; Path=/; HttpOnly; SameSite=Lax');
      res.setHeader('Content-Type', 'text/html');
      res.end('<script>window.fetch=()=>Promise.reject(new TypeError("Failed to fetch"))</script>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const authView = new WebContentsView({ webPreferences: { partition: `easyread-auth-fixture-${Date.now()}` } });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await authView.webContents.loadURL(base);
    assert.equal(await authView.webContents.executeJavaScript('fetch("/auth").catch(error => error.message)'), 'Failed to fetch');
    const id = await readAccountId({ fetch: (url, options) => {
      assert.equal(url, 'https://chatgpt.com/api/auth/session');
      return authView.webContents.session.fetch(base + '/auth', options);
    } });
    assert.equal(id, 'fixture-account');
    console.log(JSON.stringify({ sessionAuth: true, cookieShared: true, pageFetchIndependent: true }));
  } finally {
    authView.webContents.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  const win = new BrowserWindow({ width: 1200, height: 800, show: false });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'easyread-background-'));
  const web = createChatGPTWeb({ app: { getPath: () => home, getLocale: () => 'zh-CN' },
    window: win, BrowserWindow, WebContentsView, ipcMain });
  const wc = web.webContents;
  try {
    await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
      <form><div id="prompt-textarea" contenteditable="true" role="textbox">旧草稿</div>
      <button id="send" aria-label="发送" type="submit">发送</button></form><script>
      window.sent=[];let model='旧草稿';
      document.querySelector('#prompt-textarea').addEventListener('paste',event=>{
        event.preventDefault();model=event.clipboardData.getData('text/plain');
        document.querySelector('#prompt-textarea').textContent=model;
      });
      document.querySelector('form').addEventListener('submit',event=>{
        event.preventDefault();
        window.sent.push(model);
      });
      </script>`));
    wc.debugger.attach();
    wc.focus();
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 0, mobile: false });
    await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await wc.executeJavaScript(`document.getElementById('prompt-textarea').focus()`);
    for (const type of ['keyDown', 'keyUp'])
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
        modifiers: process.platform === 'darwin' ? 4 : 2 });
    assert.equal(await wc.executeJavaScript(`(${pastePrompt.toString()})(${JSON.stringify('隐藏状态下输入中文\n公式 $x^2$')})`), true);
    const matches = await wc.executeJavaScript(`(${promptMatches.toString()})(${JSON.stringify('隐藏状态下输入中文\n公式 $x^2$')})`);
    assert.equal(matches.correct, true);
    const target = await wc.executeJavaScript(`(${composerSend.toString()})()`);
    assert.equal(target.ready, true);
    for (const type of ['mousePressed', 'mouseReleased'])
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: target.x, y: target.y,
        button: 'left', clickCount: 1 });
    const result = await wc.executeJavaScript(`new Promise(resolve=>{
      let frames=0; const paint=()=>{frames++;requestAnimationFrame(paint)};requestAnimationFrame(paint);
      setTimeout(()=>resolve({focused:document.hasFocus(),sent:window.sent,viewportWidth:innerWidth,
        visibility:document.visibilityState,frames}),500);
    })`);
    assert.equal(result.focused, true);
    assert.deepEqual(result.sent, ['隐藏状态下输入中文\n公式 $x^2$']);
    assert.equal(win.isVisible(), false);
    assert.equal(result.viewportWidth, 1000);
    assert.ok(result.frames > 0, '后台网页必须持续调度渲染');
    console.log(JSON.stringify({ visibility: result.visibility, frames: result.frames }));
    assert.ok(BrowserWindow.getAllWindows().every(window => !window.isVisible()));
    const image = await Promise.race([wc.capturePage(), new Promise((_, reject) =>
      setTimeout(() => reject(new Error('隐藏页面截图超时')), 5000))]);
    assert.equal(image.isEmpty(), false, '后台网页必须提供非空画面');
    console.log(JSON.stringify({ captureSize: image.getSize(), bitmapBytes: image.toBitmap().length }));
    // 在真实 Chromium DOM 中验证长 JSON、自动链接和代码复制按钮，避免仅靠模拟节点通过。
    const answerCheck = await wc.executeJavaScript(`(() => {
      const read = ${readAnswer.toString()};
      const article = document.createElement('article');
      article.innerHTML = '<div data-message-author-role="assistant"><div class="markdown"><pre><button aria-label="复制代码">复制代码</button><code></code></pre></div></div>';
      document.body.append(article);
      const node = article.firstElementChild, code = article.querySelector('code');
      const text = JSON.stringify({ translation: '学术译文'.repeat(25000) });
      code.textContent = text;
      const start = performance.now();
      const partial = read([node], false);
      const button = document.createElement('button');
      button.setAttribute('aria-label', '复制');
      article.append(button);
      const complete = read([node]);
      const extracted = complete.text.replace(/^\x60\x60\x60\\s*|\\s*\x60\x60\x60$/g, '');
      article.querySelector('.markdown').innerHTML = '{"url":"<a href="https://example.com/a">https://example.com/a</a>"}';
      const linked = read([node]);
      article.remove();
      return { partialComplete: partial.complete, complete: complete.complete,
        correct: JSON.parse(extracted).translation.length === 100000,
        linkedURL: JSON.parse(linked.text).url, elapsedMs: Math.round(performance.now() - start) };
    })()`);
    assert.equal(answerCheck.partialComplete, false);
    assert.equal(answerCheck.complete, true);
    assert.equal(answerCheck.correct, true);
    assert.equal(answerCheck.linkedURL, 'https://example.com/a');
    console.log(JSON.stringify({ answerExtraction: answerCheck }));
    console.log(JSON.stringify({ hidden: true, editorPaste: true, formSend: true, viewportWidth: result.viewportWidth }));
  } finally {
    web.close();
    win.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}).then(() => app.quit(), error => { console.error(error.message); app.exit(1); });
