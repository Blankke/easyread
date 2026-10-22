// 用法：Windows Node.js 22+ 执行 node scripts/smoke_portable.cjs dist/electron/EasyRead-Portable-<version>-x64.exe
// 在独立目录、移除 Python/Node 的 PATH 下启动真实便携 EXE，核对页面、后端及重启后的数据。
// 测试产物保存在 build/portable-smoke-*，方便排查；不读取现有文献库和浏览器登录状态。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  assert.equal(process.platform, "win32", "必须使用 Windows Node.js");
  assert.ok(process.argv[2], "请传入便携 EXE 路径");
  const artifact = path.resolve(process.argv[2]);
  // 与本轮构建目录核对，避免源码在压缩期间被修改后误测旧版本。
  const asar = require("@electron/asar");
  const archive = path.join(path.dirname(artifact), "win-unpacked", "resources", "app.asar");
  const sourceDir = path.resolve(__dirname, "../electron");
  for (const name of fs.readdirSync(sourceDir).filter(name => name.endsWith(".cjs"))) {
    assert.ok(asar.extractFile(archive, `electron/${name}`).equals(fs.readFileSync(path.join(sourceDir, name))), `源码 ${name} 在打包期间发生变化，请重新构建`);
  }
  const build = path.resolve(__dirname, "../build");
  fs.mkdirSync(build, { recursive: true });
  const root = fs.mkdtempSync(path.join(build, "portable-smoke-"));
  const folder = path.join(root, "便携 程序");
  fs.mkdirSync(folder);
  const exe = path.join(folder, path.basename(artifact));
  fs.copyFileSync(artifact, exe);
  const data = path.join(folder, "data");
  fs.mkdirSync(data);
  // 使用空文献库，关闭自动翻译，测试过程不调用任何模型服务。
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ engine: "none", auto_translate: false }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(path|python.*|virtual_env|easyread_.*|electron_run_as_node|portable_executable_.*)$/i.test(key)) delete env[key];
  }
  env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
  env.APPDATA = path.join(root, "appdata");
  env.LOCALAPPDATA = path.join(root, "localappdata");
  fs.mkdirSync(env.APPDATA);
  fs.mkdirSync(env.LOCALAPPDATA);
  for (let round = 1; round <= 2; round++) {
    console.log(`[${round}/2] 启动真实 EXE，验证独立运行及数据持久化`);
    const port = await freePort();
    const log = fs.openSync(path.join(root, `launch-${round}.log`), "w");
    const child = spawn(exe, [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"], { cwd: folder, env, stdio: ["ignore", log, log] });
    let error;
    child.on("error", value => { error = value; });
    try {
      let page;
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        if (error) throw error;
        if (child.exitCode !== null) throw new Error(`EXE 提前退出：${child.exitCode}`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
          const pages = await response.json();
          page = pages.find(item => item.type === "page" && /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url));
          if (page) break;
        } catch { /* 解压和后端启动期间等待调试端口就绪。 */ }
        await delay(500);
      }
      assert.ok(page, `90 秒内未打开阅读窗口，请检查 ${root}`);
      assert.ok(fs.existsSync(path.join(env.APPDATA, "EasyRead")), "浏览器缓存未写入隔离目录");
      const url = new URL(page.url).origin;
      const html = await (await fetch(url)).text();
      assert.match(html, /EasyRead/);
      const response = await fetch(`${url}/api/library`);
      assert.equal(response.status, 200);
      const library = await response.json();
      assert.ok(library.token, "后端未返回有效会话");
      assert.equal(library.engine, "none", "未使用测试目录的模型配置");
      assert.deepEqual(library.items, [], "测试应使用独立空文献库");
      if (round === 1) {
        const saved = await fetch(`${url}/api/prefs`, {
          method: "POST", headers: { "Content-Type": "application/json", "X-Token": library.token },
          body: JSON.stringify({ ui: { keys_on: false } }),
        });
        assert.equal(saved.status, 200);
      } else {
        const prefs = await (await fetch(`${url}/api/prefs`)).json();
        assert.equal(prefs.ui.keys_on, false, "后端未恢复上一次启动保存的设置");
      }
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, "prefs.json"), "utf8")).ui.keys_on, false);
      console.log(`PASS: ${page.title}；后端响应正常；数据目录 ${data}`);
      // 通过 Chromium 调试协议关闭应用，让后端退出及便携解压目录清理走正常流程。
      const socket = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.close(); reject(new Error("连接窗口调试端口超时")); }, 5000);
        socket.addEventListener("open", () => { clearTimeout(timer); socket.send(JSON.stringify({ id: 1, method: "Browser.close" })); resolve(); }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("无法关闭测试窗口")); }, { once: true });
      });
      const exitDeadline = Date.now() + 15000;
      while (child.exitCode === null && Date.now() < exitDeadline) await delay(200);
      socket.close();
      assert.equal(child.exitCode, 0, "便携应用未正常退出");
    } finally {
      // 仅结束本次启动的进程树，包含 NSIS 外层、Electron 和冻结后端。
      if (child.pid && child.exitCode === null) spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      fs.closeSync(log);
    }
    await delay(1500);
  }
  console.log(`PASS: 不依赖外部 Python/Node 的便携版启动、中文路径、重启数据保留。验证目录：${root}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
