/*
 * 用法（关闭 EasyRead 后，在 Windows PowerShell 中执行）：
 *   . .\.venv\Scripts\Activate.ps1
 *   python -c "import sys; print(sys.executable)"
 *   node scripts/dev_desktop.cjs scripts/verify_web_translation.cjs f611888c63ef 3-4
 *   node scripts/dev_desktop.cjs scripts/verify_web_translation.cjs --fixture file 4
 * --fixture 生成隔离的合成论文；可选 --project-sync、--rotate-after-one（逐页翻译并轮换）。
 * 省略页码时续译全部未完成页；追加 --monitor 验证任务中开关监视面板（测试窗口保持隐藏）。
 * 在设置中选择 text/file/auto 和批量后运行；任务指标可用 web_translation_metrics.cjs 导出。
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
  const args = process.argv.slice(2).filter(arg => !['--monitor', '--project-sync', '--rotate-after-one'].includes(arg));
  let [pid, pages] = args, home = path.resolve(process.env.EASYREAD_HOME || root);
  const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!process.env.VIRTUAL_ENV || !fs.existsSync(python)) throw new Error('请先激活项目 .venv 并确认 Python 路径');
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  if (cfg.engine !== 'chatgpt_web') throw new Error('请先在 EasyRead 设置中选择 ChatGPT 网页翻译来源');
  if (args[0] === '--fixture') {
    const rotate = process.argv.includes('--rotate-after-one');
    const fixture = require('./web_translation_fixture.cjs').createFixture(root, args[1], Number(args[2]), cfg.chatgpt_web.model,
      { project_sync: process.argv.includes('--project-sync'), ...(rotate ? { batch_pages: 1, file_batch_pages: 1, rotate_requests: 1 } : {}) });
    ({ home, pid } = fixture);
    pages = undefined;
    console.log(JSON.stringify({ fixture: home, paper: fixture.paper, mode: args[1], pages: Number(args[2]) }));
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(pid || '')) throw new Error('请提供文献库中的论文 ID 和可选页码');
  // 文献库只能由一个服务写入；不要在桌面程序仍运行时启动验证后端。
  const marker = path.join(home, '.server.json');
  if (fs.existsSync(marker)) {
    const saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
    const live = await fetch(new URL('/api/library', saved.url), { signal: AbortSignal.timeout(1500) }).catch(() => null);
    if (live?.ok) throw new Error('EasyRead 服务仍在运行，请先关闭桌面程序');
  }
  const secret = randomBytes(32).toString('hex');
  const child = spawn(python, ['-m', 'easyread', 'serve', '--port', '0'], { cwd: root, windowsHide: true,
    env: { ...process.env, EASYREAD_HOME: home, EASYREAD_LIBRARY: '', PYTHONUTF8: '1', EASYREAD_WEB_BRIDGE_SECRET: secret } });
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
    const fileDeliveries = [];
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
                try {
                  const image = await web.webContents.capturePage();
                  const imagePath = path.join(require('node:os').tmpdir(), 'easyread-translation-debug.png');
                  fs.writeFileSync(imagePath, image.toPNG());
                  console.log(JSON.stringify({ debugImage: imagePath }));
                } catch (_) { /* 截图失败不能阻止错误事件落盘或掩盖原失败原因。 */ }
              }
            }
            if (event.done) {
              console.log(JSON.stringify({ receivedCharacters: event.text?.length || 0,
                artifactStatus: event.artifact_status || 'text', metrics: event.metrics }));
              if (request.output_mode === 'file') {
                if (event.artifact_status !== 'validated' || !event.artifact_path)
                  throw new Error('文件模式未交付通过校验的本地附件');
                // 真实验证必须读取正式下载文件，不能只凭完成事件或模型文字声明通过。
                const artifact = require('../electron/chatgpt-artifacts.cjs').readArtifact(event.artifact_path, request);
                fileDeliveries.push({ taskId: request.task_id, pages: artifact.requested_pages,
                  blocks: artifact.result.blocks.length, bytes: fs.statSync(event.artifact_path).size });
              }
            }
            const ack = await api('/api/desktop/web/event', event, true);
            if (ack.cancelled) web.cancel();
            return ack;
          });
        } else await sleep(300);
      }
    })().catch(error => { bridgeError = error; });
    const started = Date.now();
    const { data: existingJob } = await api(`/api/p/${pid}/part/job`);
    if (!['queued', 'running'].includes(existingJob.state))
      await api(`/api/p/${pid}/translate`, pages ? { pages, confirmed: true } : { scope: 'all', confirmed: true });
    let previous = '', lastDiagnostic = Date.now();
    while (Date.now() - started < 45 * 60 * 1000) {
      await sleep(1000);
      if (bridgeError) throw bridgeError;
      const { data: job } = await api(`/api/p/${pid}/part/job`);
      const progress = JSON.stringify({ state: job.state, done: job.done, total: job.total, error: job.error });
      if (progress !== previous) { console.log(progress); previous = progress; }
      if (process.env.EASYREAD_WEB_TRACE === '1' && stage === 'answer' && Date.now() - lastDiagnostic >= 30000) {
        lastDiagnostic = Date.now();
        // 长论文生成可能持续数分钟，只记录状态，避免将论文正文写进诊断日志。
        const answer = await web.inspectAnswer(false).catch(() => null);
        if (answer) console.log(JSON.stringify({ waiting: 'answer', elapsed: Math.round((Date.now() - started) / 1000),
          answers: answer.count, characters: answer.length, busy: answer.busy, complete: answer.complete }));
      }
      if (['done', 'partial', 'error', 'cancelled'].includes(job.state)) {
        const { data: paper } = await api(`/api/p/${pid}/part/paper`);
        console.log(JSON.stringify({ donePages: paper.translation?.done_pages, requests, hidden: !win.isVisible() }));
        if (job.error || job.state !== 'done') throw new Error(job.error || `任务未完成：${job.state}`);
        // 后端合并和 Electron 清除 pending 相邻发生，等执行器收尾后再检查可继续下一批。
        let status = await web.status();
        for (let attempt = 0; status.running && attempt < 30; attempt++) {
          await sleep(100); status = await web.status();
        }
        if (status.running || status.pending) throw new Error('译文已保存，但网页待回收状态尚未清除');
        for (const delivery of fileDeliveries) {
          if (!delivery.pages.every(page => paper.translation?.done_pages?.includes(page)))
            throw new Error('结果附件的页码尚未全部写回论文');
        }
        console.log(JSON.stringify({ fileDeliveries, pending: status.pending }));
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
