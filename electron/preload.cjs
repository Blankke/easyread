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
});
