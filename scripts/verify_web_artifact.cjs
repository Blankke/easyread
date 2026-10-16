/*
 * 用法：node scripts/dev_desktop.cjs scripts/verify_web_artifact.cjs
 * 用本地 HTTP 附件验证真实 Electron will-download、保存、校验和离线回收。
 * 不访问 ChatGPT；阶段通过 stdout 输出。此测试不代表 ChatGPT 附件 UI 已验证。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow } = require('electron');
const { createArtifactCollector } = require('../electron/chatgpt-artifacts.cjs');
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'easyread-real-download-'));
  const task = { protocol: 'easyread-translation-v1', task_id: 'a'.repeat(32),
    source_sha256: 'b'.repeat(64), requested_pages: [1] };
  const name = `easyread-${task.task_id}.json`;
  const value = { ...task, status: 'complete', result: { meta: {}, glossary: [], references: [], checks: [],
    blocks: [{ id: 'p1', page: 1, type: 'para', en: 'Source', zh: '译文' }] } };
  const server = http.createServer((req, res) => {
    if (req.url === '/' + name) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${name}"` });
      res.end(JSON.stringify(value));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<a id="download" href="/${name}" download="${name}">${name}</a>`);
    }
  });
  let win, collector;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await win.loadURL(base);
    collector = createArtifactCollector(win.webContents);
    const result = await collector.collect({ cwd, task, link: { href: `${base}/${name}`, name },
      click: () => win.webContents.executeJavaScript('document.getElementById("download").click()', true),
      report: async phase => console.log(JSON.stringify({ phase })) });
    assert.deepEqual(result.value, value);
    const recovered = await collector.collect({ cwd, task, link: {}, click: () => assert.fail('不应重复下载') });
    assert.equal(recovered.recovered, true);
    console.log(JSON.stringify({ electronDownload: true, jsonValidated: true, offlineRecovery: true }));
  } finally {
    collector?.close();
    win?.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}).then(() => app.quit(), error => { console.error(error.message); app.exit(1); });
