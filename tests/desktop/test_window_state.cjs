/*
 * 用法：node --test tests/desktop/test_window_state.cjs。
 * 检查桌面窗口的默认缩放、关窗保存与下次启动恢复。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

test("desktop window restores its saved zoom after closing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "easyread-window-"));
  try {
    const source = fs.readFileSync(path.join(__dirname, "../../electron/window-state.cjs"), "utf8");
    const module = { exports: {} };
    const electron = { app: { getPath: () => home }, screen: {
      getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }),
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    } };
    vm.runInNewContext(source, { module, require: name => name === "electron" ? electron : require(name) });
    const state = module.exports;
    assert.equal(state.options().zoomFactor, 1.15);
    assert.equal(state.options().maximized, true);
    const win = new EventEmitter();
    win.isDestroyed = () => false;
    win.isMinimized = () => false;
    win.isMaximized = () => false;
    win.getNormalBounds = () => ({ x: 80, y: 70, width: 1100, height: 740 });
    win.webContents = { getZoomFactor: () => 1.35 };
    state.track(win);
    win.emit("close");
    assert.equal(state.options().zoomFactor, 1.35);
    assert.equal(state.options().opts.width, 1100);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
