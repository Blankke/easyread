/*
 * 用法（关闭 EasyRead 后，在 Windows PowerShell 中执行）：
 *   . .\.venv\Scripts\Activate.ps1
 *   python -c "import sys; print(sys.executable)"
 *   node scripts/dev_desktop.cjs scripts/verify_web_translation.cjs f611888c63ef 3-4
 * 省略页码时续译全部未完成页；追加 --monitor 验证任务中开关监视面板（测试窗口保持隐藏）。
 * 此脚本会实际发送论文并保存译文，使用当前设置和登录会话。
 * 通过正式 HTTP 接口、任务队列、网页执行器核验完整链路；每次阶段变化输出进度，不打印正文和凭据。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const { createChatGPTWeb } = require('../electron/chatgpt-web.cjs');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.setPath('userData', path.join(app.getPath('appData'), 'EasyRead'));
// 等待后端清理完再退出，不能让关闭最后一个隐藏窗口吞掉失败退出码。
app.on('window-all-closed', () => {});

async function main() {
  const monitor = process.argv.includes('--monitor');
  const [pid, pages] = process.argv.slice(2).filter(arg => arg !== '--monitor');
  if (!/^[a-zA-Z0-9_-]+$/.test(pid || '')) throw new Error('请提供文献库中的论文 ID 和可选页码');
  const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!process.env.VIRTUAL_ENV || !fs.existsSync(python)) throw new Error('请先激活项目 .venv 并确认 Python 路径');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  if (cfg.engine !== 'chatgpt_web') throw new Error('请先在 EasyRead 设置中选择 ChatGPT 网页翻译来源');
  // 文献库只能由一个服务写入；不要在桌面程序仍运行时启动验证后端。
  const marker = path.join(root, '.server.json');
  if (fs.existsSync(marker)) {
    const saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
    const live = await fetch(new URL('/api/library', saved.url), { signal: AbortSignal.timeout(1500) }).catch(() => null);
    if (live?.ok) throw new Error('EasyRead 服务仍在运行，请先关闭桌面程序');
  }
  const secret = randomBytes(32).toString('hex');
  const child = spawn(python, ['-m', 'easyread', 'serve', '--port', '0'], { cwd: root, windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', EASYREAD_WEB_BRIDGE_SECRET: secret } });
  let base = '', token = '', stopping = false;
  let heartbeat, work, web, win;
  const api = async (route, body, bridge = false) => {
    const response = await fetch(new URL(route, base), { method: body == null ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(bridge ? { 'X-Desktop-Bridge': secret } : { 'X-Token': token }) },
      body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    return value;
  };
  try {
    base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('后端启动超时')), 30000);
      let output = '';
      child.stdout.on('data', chunk => {
        output = (output + chunk.toString()).slice(-4000);
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      child.stderr.on('data', () => {}); // 完整服务日志由后端写入 easyread.log。
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`后端提前退出：${code}`)); });
    });
    ({ token } = await api('/api/library'));
    win = new BrowserWindow({ width: 1200, height: 800, show: false });
    // 监视测试真实挂载侧栏，但不弹出系统窗口或抢焦点。
    const host = { contentView: win.contentView, getContentSize: () => win.getContentSize(),
      on: (...args) => win.on(...args), show() {}, focus() {} };
    web = createChatGPTWeb({ app, window: host, BrowserWindow, WebContentsView, ipcMain });
    await api('/api/desktop/web/heartbeat', null, true);
    heartbeat = setInterval(() => api('/api/desktop/web/heartbeat', null, true).catch(() => {}), 3000);
    let stage = '', requests = 0, bridgeError, monitorResult;
    work = (async () => {
      while (!stopping) {
        const { request } = await api('/api/desktop/web/next', null, true);
        if (request) {
          requests++;
          console.log(JSON.stringify({ request: requests, files: request.files.length, model: request.model }));
          await web.execute(request, async event => {
            if (event.phase && stage !== event.phase) {
              stage = event.phase;
              console.log(JSON.stringify({ stage, elapsed: Math.round((Date.now() - started) / 1000) }));
            }
            if (monitor && event.phase === 'answer' && !monitorResult) {
              web.show();
              let frameReady = false;
              for (let attempt = 0; attempt < 20 && !frameReady; attempt++) {
                await sleep(500);
                for (const view of win.contentView.children) {
                  const contents = view.webContents;
                  if (!contents?.getURL().startsWith('data:')) continue;
                  frameReady ||= await contents.executeJavaScript(`!!document.getElementById('frame')?.naturalWidth`).catch(() => false);
                }
              }
              web.hide();
              monitorResult = { frameReady, stillRunning: (await web.status()).running,
                allWindowsHidden: BrowserWindow.getAllWindows().every(window => !window.isVisible()) };
              console.log(JSON.stringify({ monitor: monitorResult }));
            }
            if (event.error) {
              console.log(JSON.stringify({ webError: event.error }));
              if (process.env.EASYREAD_WEB_TRACE === '1') {
                const image = await web.webContents.capturePage();
                const imagePath = path.join(require('node:os').tmpdir(), 'easyread-translation-debug.png');
                fs.writeFileSync(imagePath, image.toPNG());
                console.log(JSON.stringify({ debugImage: imagePath }));
              }
            }
            if (event.done) console.log(JSON.stringify({ receivedCharacters: event.text?.length || 0 }));
            const ack = await api('/api/desktop/web/event', event, true);
            if (ack.cancelled) web.cancel();
          });
        } else await sleep(300);
      }
    })().catch(error => { bridgeError = error; });
    const started = Date.now();
    const { data: existingJob } = await api(`/api/p/${pid}/part/job`);
    if (!['queued', 'running'].includes(existingJob.state))
      await api(`/api/p/${pid}/translate`, pages ? { pages, confirmed: true } : { scope: 'all', confirmed: true });
    let previous = '';
    while (Date.now() - started < 45 * 60 * 1000) {
      await sleep(1000);
      if (bridgeError) throw bridgeError;
      const { data: job } = await api(`/api/p/${pid}/part/job`);
      const progress = JSON.stringify({ state: job.state, done: job.done, total: job.total, error: job.error });
      if (progress !== previous) { console.log(progress); previous = progress; }
      if (['done', 'partial', 'error', 'cancelled'].includes(job.state)) {
        const { data: paper } = await api(`/api/p/${pid}/part/paper`);
        console.log(JSON.stringify({ donePages: paper.translation?.done_pages, requests, hidden: !win.isVisible() }));
        if (job.error || job.state !== 'done') throw new Error(job.error || `任务未完成：${job.state}`);
        if (monitor && requests && (!monitorResult?.frameReady || !monitorResult.stillRunning || !monitorResult.allWindowsHidden))
          throw new Error('翻译已保存，但监视面板验证未通过');
        return;
      }
    }
    throw new Error('翻译验证超过 45 分钟');
  } finally {
    stopping = true;
    clearInterval(heartbeat);
    if (web) web.cancel();
    if (base) await api(`/api/p/${pid}/cancel`, {}).catch(() => {});
    if (work) await Promise.race([work, sleep(3000)]);
    if (web) web.close();
    if (win && !win.isDestroyed()) win.destroy();
    if (base) await api('/api/shutdown', {}).catch(() => {});
    if (child.exitCode == null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(5000)]);
    if (child.exitCode == null) child.kill();
  }
}
app.whenReady().then(main).then(() => app.quit(), error => {
  console.error(`真实翻译验证失败：${error.message}`);
  app.exit(1);
});
