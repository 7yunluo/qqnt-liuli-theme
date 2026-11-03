// 琉璃主题插件 · preload：给界面开主进程接口
// preload 每页可能跑两次，重复 expose 会报错，先查一下
const { contextBridge, ipcRenderer } = require("electron");

const api = {
    selfUid: () => ipcRenderer.invoke("LiteLoader.liuli.selfUid"),
    openExternal: url => ipcRenderer.invoke("LiteLoader.liuli.openExternal", url),
    // 数据目录被整个删掉后的一次性重置标记（wipe=true → 渲染进程先清 localStorage）
    resetPending: () => ipcRenderer.invoke("LiteLoader.liuli.resetPending"),
    // 诊断包（契约 installer/DIAG-COVERAGE.md 3.1）
    diagExport: payload => ipcRenderer.invoke("LiteLoader.liuli.diagExport", payload),
    diagLog: entry => ipcRenderer.send("LiteLoader.liuli.diagLog", entry),
    diagOpenPath: path => ipcRenderer.invoke("LiteLoader.liuli.diagOpenPath", path),
};

const exists = contextBridge.executeInMainWorld({ func: key => key in globalThis, args: ["liuli_api"] });
if (!exists) contextBridge.exposeInMainWorld("liuli_api", api);
