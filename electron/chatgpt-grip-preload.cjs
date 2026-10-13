/*
 * 用法：由 chatgpt-web.cjs 作为本地拖动条页面的 preload 加载。
 * 只转发拖动阶段和位移；主进程仍会核对发送方与参数。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("easyreadGrip", {
  drag: (phase, delta) => ipcRenderer.send("easyread:chatgpt-pane-drag", { phase, delta }),
});
