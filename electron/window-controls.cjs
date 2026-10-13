/*
 * 用法：在主窗口创建后调用 installWindowControls(win, 1.15, process.platform)。
 * 主进程统一处理桌面缩放与全屏，保证页面切换后沿用同一个缩放比例。
 */
const MIN_ZOOM = 0.75;
const MAX_ZOOM = 2;
const STEP = 0.1;

function installWindowControls(win, initialZoom, platform = process.platform) {
  const contents = win.webContents;
  const standard = Number.isFinite(initialZoom) ? initialZoom : 1.15;
  let zoom = standard;
  const apply = () => contents.setZoomFactor(zoom);

  // 加载页会改变 Chromium 的页面来源；每次加载后恢复用户选定的缩放。
  contents.on("did-finish-load", apply);
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11" && !input.control && !input.meta && !input.alt) {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
      return;
    }
    if (!(platform === "darwin" ? input.meta : input.control) || input.alt) return;
    const code = input.code || "";
    const key = input.key || "";
    let next;
    if (code === "Minus" || code === "NumpadSubtract" || key === "-") next = zoom - STEP;
    else if (code === "Equal" || code === "NumpadAdd" || key === "+" || key === "=") next = zoom + STEP;
    else if (code === "Digit0" || code === "Numpad0" || key === "0") next = standard;
    else return;
    event.preventDefault();
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(next * 100) / 100));
    apply();
  });
  apply();
}

module.exports = { installWindowControls };
