const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

async function desktop(platform = "darwin", lock = true, ready = true, argv = [], appDataBroken = false, projectStarts = null, env = {}) {
  const app = new EventEmitter();
  Object.assign(app, {
    setPath(name, value) { this.paths = { ...this.paths, [name]: value }; },
    getPath(name) { if (appDataBroken && name === "appData") throw new Error("Failed to get 'appData' path"); return "/tmp"; }, getLocale: () => "zh-CN", isPackaged: true,
    requestSingleInstanceLock: () => lock, whenReady: () => Promise.resolve(), isReady: () => true,
    setAsDefaultProtocolClient(scheme) { this.protocol = scheme; },
    quit() { this.quitCalled = true; this.emit("before-quit", { preventDefault() {} }); },
    relaunch() { this.relaunched = true; }, exit() { this.exited = true; },
  });
  const windows = [], launches = [], menus = [], stages = [], requests = [], handlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (name, fn) => handlers.set(name, fn);
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {};
      this.webContents.setZoomFactor = factor => { this.webContents.zoomFactor = factor; };
      this.webContents.getZoomFactor = () => this.webContents.zoomFactor;
      this.webContents.mainFrame = { url: "http://127.0.0.1:9876/" };
      this.webContents.isDestroyed = () => false;
      // 页面收到保存请求后回执，模拟退出前等待阅读进度落盘。
      this.webContents.send = channel => { requests.push("asked:" + channel); queueMicrotask(() => ipcMain.emit("easyread:page-saved", { sender: this.webContents, senderFrame: this.webContents.mainFrame })); };
      windows.push(this); }
    static getAllWindows() { return windows.filter(w => !w.closed); }
    async loadURL(url) { this.url = url; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    setFullScreen(value) { this.fullScreen = value; }
    isFullScreen() { return !!this.fullScreen; }
    isMinimized() { return false; }
    close() {
      let prevented = false;
      this.emit("close", { preventDefault() { prevented = true; } });
      if (!prevented) { this.closed = true; this.emit("closed"); }
    }
  }
  const Menu = {
    buildFromTemplate(items) { return { items, popup() { menus.push(items); } }; },
    setApplicationMenu(menu) { app.menu = menu; },
  };
  const childProcess = {
    execFileSync: () => "__PATH__/usr/bin:/bin__PATH__",
    spawn(command, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => { child.killed = true; child.emit("exit", 0, "SIGTERM"); };
      launches.push({ command, args, options, child });
      if (ready) queueMicrotask(() => child.stdout.emit("data", "EasyRead 已启动：http://127.0.0.1:9876\n"));
      return child;
    },
  };
  const proc = new EventEmitter();
  Object.assign(proc, { platform, env, resourcesPath: "/tmp/Resources", argv: ["EasyRead.exe", ...argv] });
  const fakeRequire = name => name === "electron" ? { app, BrowserWindow: Window, Menu, ipcMain,
    WebContentsView: projectStarts ? class {} : undefined,
    dialog: { showErrorBox() {}, showOpenDialog: async () => ({ canceled: false, filePaths: ["/tmp/chosen"] }) }, shell: {} }
    : name === "child_process" ? childProcess : name === "fs" ? { existsSync: () => true }
    : name === "http" ? { request(url, options, callback) {
      requests.push(url.pathname);
      const req = new EventEmitter(); req.setTimeout = () => {}; req.end = () => queueMicrotask(() => {
        const res = new EventEmitter(); res.statusCode = 200; res.setEncoding = () => {}; callback(res);
        res.emit("data", JSON.stringify(url.pathname === "/api/library" ? { token: "test-token" } : { ok: true }));
        res.emit("end");
        if (url.pathname === "/api/shutdown") launches[launches.length - 1].child.kill();
      }); return req;
    } }
    : name === "./startup-feedback.cjs" ? { ...require("../../electron/startup-feedback.cjs"), mark(_app, stage) { stages.push(stage); }, loginShellPath: async () => "/usr/bin:/bin" }
    : name === "./desktop-updates.cjs" ? { registerUpdates() {} }
    : name === "./chatgpt-web.cjs" && projectStarts ? { createChatGPTWeb: () => ({
      initializeProject: async () => { projectStarts.push("initialized"); return { ready: true }; },
      status: async () => ({ ready: true }), models: async () => ({ models: [] }),
      show() {}, hide() {}, clearPending() { return { ok: true }; }, execute: async () => {}, cancel() {},
    }) }
    : name === "./deep-link.cjs" ? require("../../electron/deep-link.cjs")
    : name === "./data-dir.cjs" ? { prepare: async () => null }
    : name === "electron-updater" ? { autoUpdater: {} }
    : name === "./window-state.cjs" ? { options: () => ({ opts: { width: 1440, height: 960 }, maximized: false, zoomFactor: 1.15 }), track() {} }
    : name === "./window-controls.cjs" ? require("../../electron/window-controls.cjs")
    : require(name);
  const source = fs.readFileSync(path.join(__dirname, "../../electron/main.cjs"), "utf8");
  vm.runInNewContext(source, { require: fakeRequire, process: proc, __dirname: "/tmp/electron", setTimeout, clearTimeout, console });
  const settled = () => new Promise(resolve => setImmediate(resolve));
  await settled();
  return { app, windows, launches, menus, handlers, stages, requests, ipcMain, settled };
}

test("startup survives a missing appData path instead of crashing the main process", async () => {
  const d = await desktop("win32", true, true, [], true);
  assert.ok(d.app.paths.userData.endsWith("EasyRead"));
  assert.equal(d.windows.length, 1);
  d.app.quit();
});

test("便携版启动不会覆盖系统的 easyread 协议关联", () => {
  const calls = [];
  const app = { setAsDefaultProtocolClient: (...args) => calls.push(args) };
  require("../../electron/deep-link.cjs").register(app, { env: { PORTABLE_EXECUTABLE_DIR: "D:\\EasyRead" } });
  assert.deepEqual(calls, []);
});

test("Windows 隔离运行使用进程级 APPDATA 保存浏览器缓存", async () => {
  const d = await desktop("win32", true, true, [], false, null, { APPDATA: "/isolated/appdata" });
  assert.equal(d.app.paths.userData, path.join("/isolated/appdata", "EasyRead"));
  d.app.quit();
});

test("macOS keeps native editing roles and offers input context actions", async () => {
  const d = await desktop();
  assert.deepEqual(Array.from(d.app.menu.items, x => x.role), ["appMenu", "editMenu", "windowMenu"]);
  d.windows[0].webContents.emit("context-menu", {}, { isEditable: true, selectionText: "", editFlags: { canPaste: true } });
  assert.ok(d.menus[0].some(x => x.role === "paste" && x.enabled));
  d.app.quit();
});

test("reopening a macOS window reuses one backend, even during repeated activation", async () => {
  const d = await desktop();
  d.windows[0].close();
  d.app.emit("activate"); d.app.emit("activate");
  await d.settled();
  assert.equal(d.launches.length, 1);
  assert.equal(d.windows.length, 2);
  d.app.emit("second-instance");
  assert.equal(d.windows[1].focused, true);
  d.app.quit();
  await d.settled();
  assert.equal(d.launches[0].child.killed, true);
});

test("a second app instance exits before starting a backend", async () => {
  const d = await desktop("darwin", false);
  assert.equal(d.app.quitCalled, true);
  assert.equal(d.launches.length, 0);
});

test("Windows retains its existing menu behavior", async () => {
  const d = await desktop("win32");
  assert.equal(d.app.menu, null);
  assert.equal(d.windows[0].options.frame, true);
  assert.equal(d.windows[0].options.minWidth, 640);
  assert.equal(d.windows[0].webContents.zoomFactor, 1.15);
  d.app.quit();
});

test("desktop zoom shortcuts persist through navigation and F11 toggles fullscreen", async () => {
  const d = await desktop("win32");
  const win = d.windows[0];
  const input = (code, key, control = true) => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    win.webContents.emit("before-input-event", event, { type: "keyDown", code, key, control });
    assert.equal(event.prevented, true);
  };
  input("Equal", "+");
  assert.equal(win.webContents.zoomFactor, 1.25);
  win.webContents.zoomFactor = 1;
  win.webContents.emit("did-finish-load");
  assert.equal(win.webContents.zoomFactor, 1.25);
  input("Minus", "-");
  assert.equal(win.webContents.zoomFactor, 1.15);
  input("Digit0", "0");
  assert.equal(win.webContents.zoomFactor, 1.15);
  input("F11", "F11", false);
  assert.equal(win.isFullScreen(), true);
  input("F11", "F11", false);
  assert.equal(win.isFullScreen(), false);
  d.app.quit();
});

test("quitting asks the page to save before stopping the backend", async () => {
  const d = await desktop("win32");
  d.app.quit();
  await new Promise(resolve => setTimeout(resolve, 200));
  const order = d.requests.filter(x => x.startsWith("asked:") || x === "/api/shutdown");
  assert.deepEqual(Array.from(order), ["asked:easyread:before-quit", "/api/shutdown"]);
});

test("Windows close button saves before the renderer is destroyed", async () => {
  const d = await desktop("win32");
  d.windows[0].close();
  assert.notEqual(d.windows[0].closed, true);
  await d.settled();
  const order = d.requests.filter(x => x.startsWith("asked:") || x === "/api/shutdown");
  assert.deepEqual(Array.from(order), ["asked:easyread:before-quit", "/api/shutdown"]);
});

test("quitting goes ahead when the page never answers", async () => {
  const d = await desktop("win32");
  d.windows[0].webContents.send = () => {};  // 页面卡住，一声不吭
  d.app.quit();
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.ok(d.requests.includes("/api/shutdown"), "不该卡在退出上");
  assert.equal(d.launches[0].child.killed, true);
});

test("the startup window is visible while the backend is still starting", async () => {
  const d = await desktop("darwin", true, false);
  assert.equal(d.windows.length, 1);
  assert.equal(d.windows[0].shown, true);
  assert.match(d.windows[0].url, /^data:text\/html/);
  assert.ok(d.stages.indexOf("startup-window-visible") < d.stages.indexOf("backend-spawn"));
  d.launches[0].child.stdout.emit("data", "EasyRead 已启动：http://127.0.0.1:9876\n");
  await d.settled();
  assert.equal(d.windows[0].url, "http://127.0.0.1:9876");
  assert.ok(d.stages.includes("library-loaded"));
  d.app.quit(); await d.settled();
});

test("桌面启动只接通任务桥，项目配置由任务按需执行", async () => {
  const starts = [];
  const d = await desktop("win32", true, true, [], false, starts);
  await d.settled();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(d.windows[0].url, "http://127.0.0.1:9876");
  assert.deepEqual(starts, [], "启动时不能反复导航到项目设置");
  d.app.quit();
});

test("login shell discovery yields without blocking and tolerates shell errors", async () => {
  const { loginShellPath } = require("../../electron/startup-feedback.cjs");
  let callback;
  const pending = loginShellPath("darwin", "/bin/zsh", (_shell, _args, options, done) => {
    assert.equal(options.timeout, 5000); callback = done;
  });
  assert.ok(pending instanceof Promise);
  callback(null, "noise\n__PATH__/usr/local/bin:/usr/bin__PATH__\n");
  assert.equal(await pending, "/usr/local/bin:/usr/bin");
  assert.equal(await loginShellPath("darwin", "/bin/zsh", (_s, _a, _o, done) => done(new Error("timeout"))), "");
  assert.equal(await loginShellPath("win32", "", () => { throw new Error("unexpected shell"); }), "");
});


test("cloud library IPC restricts folder picking and relaunch to the local main frame", async () => {
  const d = await desktop();
  const sender = d.windows[0].webContents;
  const event = { sender, senderFrame: sender.mainFrame };
  assert.equal(await d.handlers.get("easyread:pick-folder")(event), "/tmp/chosen");
  await assert.rejects(d.handlers.get("easyread:pick-folder")({ sender: {}, senderFrame: sender.mainFrame }), /Untrusted/);
  await assert.rejects(d.handlers.get("easyread:pick-folder")({ sender, senderFrame: { url: "https://example.com" } }), /Untrusted/);
  for (const name of ["web-status", "web-models", "web-open", "web-close", "web-clear-pending"]) {
    await assert.rejects(d.handlers.get("easyread:" + name)({ sender: {}, senderFrame: sender.mainFrame }), /Untrusted/);
  }
  await d.handlers.get("easyread:relaunch")(event);
  assert.equal(d.launches[0].child.killed, true);
  assert.equal(d.app.relaunched, true);
  assert.equal(d.app.exited, true);
});

const SHA = "a".repeat(64);

test("easyread:// links open the paper once the backend is ready", async () => {
  const d = await desktop("win32", true, true, [`easyread://open?sha256=${SHA}&block=p3-2`]);
  await d.settled();
  assert.equal(d.app.protocol, "easyread");
  assert.equal(d.windows[0].url, `http://127.0.0.1:9876/open?sha256=${SHA}&block=p3-2`);
  d.app.quit();
});

test("a link from a second instance reuses the open window", async () => {
  const d = await desktop("win32");
  await d.settled();
  d.app.emit("second-instance", {}, ["EasyRead.exe", "easyread://open?id=abc123def456"]);
  assert.equal(d.windows.length, 1);
  assert.equal(d.windows[0].url, "http://127.0.0.1:9876/open?id=abc123def456");
  assert.equal(d.windows[0].focused, true);
  d.app.quit();
});

test("macOS open-url links are handled and unknown links ignored", async () => {
  const d = await desktop();
  await d.settled();
  d.app.emit("open-url", { preventDefault() {} }, "easyread://other?id=abc123def456");
  assert.equal(d.windows[0].url, "http://127.0.0.1:9876");
  d.app.emit("open-url", { preventDefault() {} }, `easyread://open?sha256=${SHA}&block=<x>`);
  assert.equal(d.windows[0].url, `http://127.0.0.1:9876/open?sha256=${SHA}`);
  d.app.quit();
});
