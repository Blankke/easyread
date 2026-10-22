const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("easyreadDesktop", {
  isElectron: true,
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke("easyread:pick-folder"),
  relaunch: () => ipcRenderer.invoke("easyread:relaunch"),
  chatgptStatus: () => ipcRenderer.invoke("easyread:web-status"),
  chatgptModels: () => ipcRenderer.invoke("easyread:web-models"),
  chatgptOpen: () => ipcRenderer.invoke("easyread:web-open"),
  chatgptClose: () => ipcRenderer.invoke("easyread:web-close"),
  chatgptClearPending: () => ipcRenderer.invoke("easyread:web-clear-pending"),
  chatgptRotate: key => ipcRenderer.invoke("easyread:web-rotate", key),
  updateState: () => ipcRenderer.invoke("easyread:update-state"),
  downloadUpdate: () => ipcRenderer.invoke("easyread:update-download"),
  installUpdate: () => ipcRenderer.invoke("easyread:update-install"),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("easyread:update-state", listener);
    return () => ipcRenderer.removeListener("easyread:update-state", listener);
  },
  /* 退出软件前来一下：页面写完回一声，主进程才停后端（见 main.cjs） */
  onBeforeQuit: (callback) => {
    const listener = async () => {
      try { await callback(); } finally { ipcRenderer.send("easyread:page-saved"); }
    };
    ipcRenderer.on("easyread:before-quit", listener);
    return () => ipcRenderer.removeListener("easyread:before-quit", listener);
  },
});
