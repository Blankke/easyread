const { app, BrowserWindow, dialog, Menu, shell, ipcMain } = require("electron");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const windowState = require("./window-state.cjs");
const { installWindowControls } = require("./window-controls.cjs");
const { URL } = require("url");
const http = require("http");
const startup = require("./startup-feedback.cjs");
const { registerUpdates } = require("./desktop-updates.cjs");
const deepLink = require("./deep-link.cjs");
const dataDir = require("./data-dir.cjs");
const { randomBytes } = require("crypto");
const { WebContentsView } = require("electron");
const webBridgeSecret = randomBytes(32).toString("hex");
let chatgptWeb;
let webPollTimer;
let webHeartbeatTimer;

// 窗口缓存等放 %APPDATA%\EasyRead（默认会用 package.json 的 name，叫 easyread-desktop）。
// 论文和设置不放这里：Windows 安装版放 <安装目录>\data（见 data-dir.cjs），其余平台用 ~/EasyRead。
// 环境变量不全（比如从精简环境的脚本里启动）时 getPath("appData") 会直接抛错，
// 这时按 Electron 自己的默认位置算一份，免得一启动就弹主进程报错框。
function appDataDir() {
  try {
    return app.getPath("appData");
  } catch {
    const home = os.homedir();
    if (process.platform === "win32") return process.env.APPDATA || path.join(home, "AppData", "Roaming");
    if (process.platform === "darwin") return path.join(home, "Library", "Application Support");
    return process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  }
}
app.setPath("userData", path.join(appDataDir(), "EasyRead"));
startup.mark(app, "electron-entry");

// 桌面版自己的几句报错跟系统语言走（界面语言由后端决定，见 easyread/app/i18n.py）
const isZh = () => app.getLocale().toLowerCase().startsWith("zh");
let backend;
let mainWindow;
let backendReady;
let windowOpening = false;
let backendUrl;
let quitting = false;
let pendingOpen = deepLink.fromArgv(process.argv);

function projectRoot() {
  return path.resolve(__dirname, "..");
}

function packagedBackend() {
  const name = process.platform === "win32" ? "easyread-backend.exe" : "easyread-backend";
  return path.join(process.resourcesPath, "backend", name);
}

function backendCommand() {
  if (app.isPackaged) {
    const executable = packagedBackend();
    if (!fs.existsSync(executable)) {
      throw new Error(isZh() ? `找不到打包后的 EasyRead 后端：${executable}` : `Bundled EasyRead backend not found: ${executable}`);
    }
    return { command: executable, args: ["serve", "--port", "0"], cwd: os.homedir() };
  }

  const root = projectRoot();
  const python = process.platform === "win32"
    ? path.join(root, ".venv", "Scripts", "python.exe")
    : path.join(root, ".venv", "bin", "python");
  const command = fs.existsSync(python) ? python : (process.platform === "win32" ? "python" : "python3");
  return { command, args: ["-m", "easyread", "serve", "--port", "0"], cwd: root };
}

// macOS / Linux 从启动台、桌面图标打开时，拿不到终端里配的 PATH（Homebrew、npm 全局目录），
// 后端会找不到 claude / codex。向用户的登录 shell 要一份 PATH 补上。
function startBackend() {
  // On macOS an app can stay alive after its last window closes. Reopening
  // the window must reuse that backend, rather than orphaning the old one.
  if (backendReady) return backendReady;
  backendReady = (async () => {
  const launch = backendCommand();
  const env = { ...process.env, PYTHONUTF8: "1", EASYREAD_SYSTEM_LANG: app.getLocale(), EASYREAD_WEB_BRIDGE_SECRET: webBridgeSecret };  // 后端按它决定界面语言
  startup.mark(app, "shell-path-start");
  const shellPath = await startup.loginShellPath(process.platform);
  startup.mark(app, "shell-path-ready");
  if (quitting) throw new Error(isZh() ? "启动已取消" : "Startup cancelled");
  const home = await dataDir.prepare(app, line => startup.mark(app, line));
  if (home) env.EASYREAD_HOME = home;
  if (shellPath) {
    env.PATH = [...new Set([...shellPath.split(":"), ...(env.PATH || "").split(":")].filter(Boolean))].join(":");
  }
  if (process.platform !== "win32") {
    const fallback = [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
    env.PATH = [...new Set([...(env.PATH || "").split(":"), ...fallback.filter(p => fs.existsSync(p))].filter(Boolean))].join(":");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error((isZh() ? "EasyRead 后端启动超时。" : "EasyRead backend timed out while starting. ") + output.slice(-500)));
      stopBackend();
    }, 30000);

    startup.mark(app, "backend-spawn");
    backend = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    backend.stdout.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-65536);
      const match = output.match(/EasyRead\s+已启动：\s*(http:\/\/127\.0\.0\.1:\d+)/);
      if (match && !settled) { startup.mark(app, "backend-http-ready"); backendUrl = match[1]; finish(resolve, match[1]); }
    });
    backend.stderr.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-65536);
    });
    backend.once("error", (error) => finish(reject, error));
    backend.once("exit", (code, signal) => {
      if (!settled) finish(reject, new Error((isZh() ? `EasyRead 后端退出（code=${code}, signal=${signal}）。` : `EasyRead backend exited (code=${code}, signal=${signal}). `) + output.slice(-500)));
      backend = undefined;
      backendReady = undefined;
      backendUrl = undefined;
    });
  });
  })();
  backendReady.catch(() => { backendReady = undefined; });
  return backendReady;
}

function backendJson(endpoint, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(endpoint, backendUrl), {
      method: token ? "POST" : "GET",
      headers: token ? { "X-Token": token, "Content-Type": "application/json", "Content-Length": 2 } : {},
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", part => { body += part; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode !== 200) return reject(new Error(data.error || `HTTP ${res.statusCode}`));
          resolve(data);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error(isZh() ? "后端关闭超时，请稍后重试" : "Backend shutdown timed out. Try again later.")));
    req.on("error", reject);
    req.end(token ? "{}" : undefined);
  });
}

// 桌面主进程持有桥凭据；阅读页只通过受信 IPC 查询登录和模型状态。
function webBridgeRequest(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? "" : JSON.stringify(body);
    const req = http.request(new URL(endpoint, backendUrl), { method: body == null ? "GET" : "POST",
      headers: { "X-Desktop-Bridge": webBridgeSecret, ...(body == null ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }) } }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { out += chunk; });
      res.on("end", () => {
        try {
          const value = JSON.parse(out);
          if (res.statusCode !== 200) throw new Error(value.error || `HTTP ${res.statusCode}`);
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error("ChatGPT 网页任务桥超时")));
    req.on("error", reject);
    req.end(data || undefined);
  });
}

async function pollWebBridge() {
  if (!chatgptWeb || quitting || !backendUrl) return;
  let delay = 800;
  try {
    const next = await webBridgeRequest("/api/desktop/web/next");
    if (next.request) await chatgptWeb.execute(next.request, async event => {
      let ack, failure;
      // 网络确认丢失时用原请求编号和原序号重发，由后端去重，避免译文增量重复拼接。
      for (let attempt = 0; attempt < 3; attempt++) {
        try { ack = await webBridgeRequest("/api/desktop/web/event", event); break; }
        catch (error) {
          failure = error;
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
      if (!ack) throw failure;
      if (ack.cancelled) chatgptWeb.cancel();
      return ack;
    });
    // 有任务时立即领取下一项；只有空队列或连接失败才退回间隔轮询。
    if (next.request) delay = 0;
  } catch (error) {
    // 后端重启时轮询会恢复；具体网页任务错误由任务本身回传。
    console.warn("ChatGPT 网页任务桥：", error.message);
  } finally {
    if (chatgptWeb && !quitting) webPollTimer = setTimeout(pollWebBridge, delay);
  }
}

function startChatGPTWeb() {
  if (!WebContentsView || chatgptWeb || !mainWindow) return;
  chatgptWeb = require("./chatgpt-web.cjs").createChatGPTWeb({ app, window: mainWindow, BrowserWindow, WebContentsView, ipcMain });
  // 项目由第一项任务按需配置；启动期间不反复导航或重试设置，避免覆盖正在续译的会话。
  clearTimeout(webHeartbeatTimer);
  const beat = async () => {
    if (backendUrl && chatgptWeb) await webBridgeRequest("/api/desktop/web/heartbeat").catch(() => {});
    if (chatgptWeb && !quitting) webHeartbeatTimer = setTimeout(beat, 3000);
  };
  webHeartbeatTimer = setTimeout(beat, 3000);
  clearTimeout(webPollTimer);
  pollWebBridge();
}

ipcMain.handle("easyread:web-status", async event => { trustedWindow(event); return chatgptWeb ? chatgptWeb.status() : { ready: false }; });
ipcMain.handle("easyread:web-models", async event => { trustedWindow(event); return chatgptWeb.models(); });
ipcMain.handle("easyread:web-open", async event => { trustedWindow(event); chatgptWeb.show(); return { ok: true }; });
ipcMain.handle("easyread:web-close", async event => { trustedWindow(event); chatgptWeb.hide(); return { ok: true }; });
ipcMain.handle("easyread:web-clear-pending", async event => { trustedWindow(event); return chatgptWeb.clearPending(); });
ipcMain.handle("easyread:web-rotate", async (event, key) => { trustedWindow(event); return chatgptWeb.rotateSession(key); });

async function stopBackendGracefully() {
  const child = backend;
  if (!child) return;
  const info = await backendJson("/api/library");
  await backendJson("/api/shutdown", info.token);
  // 后端清掉占用标记、关闭 HTTP 服务后才启动新进程。
  if (backend !== child) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.removeListener("exit", exited); reject(new Error(isZh() ? "后端尚未退出，请稍后重试" : "The backend has not exited yet. Try again later.")); }, 8000);
    function exited() { clearTimeout(timer); resolve(); }
    child.once("exit", exited);
  });
}

/* 退出前先让页面把没落盘的东西写回去再停后端；页面没应就照常退出 */
function savePageState() {
  const wc = mainWindow && mainWindow.webContents;
  if (!wc || wc.isDestroyed()) return Promise.resolve();
  return new Promise(resolve => {
    let timer;
    function done() {
      clearTimeout(timer);
      ipcMain.removeListener("easyread:page-saved", saved);
      resolve();
    }
    function saved(event) {
      if (event.sender === wc && event.senderFrame === wc.mainFrame) done();
    }
    timer = setTimeout(done, 1200);
    ipcMain.on("easyread:page-saved", saved);
    wc.send("easyread:before-quit");
  });
}

function trustedWindow(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
      !backendUrl || new URL(event.senderFrame.url).origin !== backendUrl) {
    throw new Error("Untrusted IPC sender");
  }
}

ipcMain.handle("easyread:pick-folder", async event => {
  trustedWindow(event);
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0] || null;
});
ipcMain.handle("easyread:relaunch", async event => {
  trustedWindow(event);
  await stopBackendGracefully();
  app.relaunch();
  app.exit(0);
});

function stopBackend() {
  backendReady = undefined;
  if (backend && !backend.killed) {
    if (process.platform === "win32") {
      // PyInstaller's one-file launcher creates a child process. Killing only
      // the launcher would leave the local HTTP service running after exit.
      try {
        execFileSync("taskkill", ["/pid", String(backend.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch (_) {
        // The process may already have exited while the window was closing.
      }
    } else {
      backend.kill();
    }
    backend = undefined;
  }
}

// 窗口还在启动时先记下，后端就绪后 createWindow 直接打开这篇
function openLink(target) {
  if (!target) return;
  if (!mainWindow || windowOpening || !backendUrl) {
    pendingOpen = target;
    if (!mainWindow && app.isReady()) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.loadURL(new URL(target, backendUrl).href);
}

async function createWindow() {
  if (windowOpening || mainWindow) return;
  windowOpening = true;
  const state = windowState.options();
  mainWindow = new BrowserWindow({
    ...state.opts,
    // 保留 Windows 原生标题栏及贴靠行为；较小下限允许半屏阅读。
    frame: true,
    minWidth: 640,
    minHeight: 520,
    icon: path.join(__dirname, "assets", "icon.ico"),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  installWindowControls(mainWindow, state.zoomFactor, process.platform);
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });
  // A native context menu is separate from the application Edit menu.
  // Electron does not emit this event when the page prevents contextmenu,
  // so the library's and reader's custom menus keep working.
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const flags = params.editFlags || {};
    const items = params.isEditable
      ? [{ role: "undo", enabled: flags.canUndo }, { role: "redo", enabled: flags.canRedo },
         { type: "separator" }, { role: "cut", enabled: flags.canCut }, { role: "copy", enabled: flags.canCopy },
         { role: "paste", enabled: flags.canPaste }, { type: "separator" }, { role: "selectAll" }]
      : params.selectionText.trim() ? [{ role: "copy" }] : [];
    if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });
  windowState.track(mainWindow);
  const openingWindow = mainWindow;
  mainWindow.once("ready-to-show", () => {
    if (mainWindow !== openingWindow) return;
    if (state.maximized) openingWindow.maximize();
    openingWindow.show();
  });
  mainWindow.on("close", event => {
    if (process.platform !== "darwin" && !quitting && backend) {
      event.preventDefault();
      app.quit();  // before-quit saves while the renderer is still alive.
    }
  });
  mainWindow.on("closed", () => {
    chatgptWeb = undefined;
    clearTimeout(webPollTimer);
    clearTimeout(webHeartbeatTimer);
    mainWindow = undefined;
  });
  try {
    await openingWindow.loadURL(startup.loadingUrl(isZh()));
    if (mainWindow !== openingWindow || quitting) return;
    if (state.maximized) openingWindow.maximize();
    openingWindow.show();
    startup.mark(app, "startup-window-visible");
    const url = await startBackend();
    if (mainWindow !== openingWindow || quitting) return;
    const first = pendingOpen ? new URL(pendingOpen, url).href : url;
    pendingOpen = undefined;
    await openingWindow.loadURL(first);
    startChatGPTWeb();
    startup.mark(app, "library-loaded");
  } catch (error) {
    if (mainWindow !== openingWindow || quitting) return;
    startup.mark(app, "startup-failed");
    dialog.showErrorBox(isZh() ? "EasyRead 启动失败" : "EasyRead failed to start", error.message);
    app.quit();
  } finally {
    windowOpening = false;
    // 加载文献库期间又点了 easyread:// 链接，openLink 只记下了它，这里补开
    if (pendingOpen && mainWindow === openingWindow && !quitting) openLink(pendingOpen);
  }
}

// Keep the web application's own header at the top of the content area. The
// default Electron File/Edit/View/Window strip would otherwise create a second
// toolbar row above it. The macOS menu is at the top of the screen and
// its Edit roles provide Cmd+C/V/X/A/Z.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  Menu.setApplicationMenu(process.platform === "darwin"
    ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
    : null);
  // macOS 用 open-url 传链接，可能早于 ready
  app.on("open-url", (event, link) => {
    event.preventDefault();
    openLink(deepLink.openPath(link));
  });
  app.whenReady().then(() => {
    deepLink.register(app, process);
    registerUpdates({
      app, ipcMain, updater: require("electron-updater").autoUpdater, trustedWindow,
      getWindow: () => mainWindow,
      prepareInstall: stopBackendGracefully,
      recover: async () => {
        if (backend) return;  // 后端没停（正在翻译、拒绝关闭）：页面别刷新，弹窗留着显示原因
        const url = await startBackend();
        if (mainWindow) await mainWindow.loadURL(url);
      },
    });
    return createWindow();
  });
  app.on("before-quit", event => {
    if (quitting) return;
    quitting = true;
    clearTimeout(webPollTimer);
    clearTimeout(webHeartbeatTimer);
    if (!backend) return;
    event.preventDefault();
    savePageState().then(stopBackendGracefully).catch(stopBackend).finally(() => app.quit());
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on("second-instance", (_event, argv) => {
    const target = deepLink.fromArgv(argv);
    if (target) return void openLink(target);
    if (!mainWindow) return void createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  process.on("exit", stopBackend);
}
