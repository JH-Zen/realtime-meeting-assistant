import { contextBridge, ipcRenderer } from "electron";

// Fixed operations only. The renderer gets neither ipcRenderer, paths to arbitrary files, nor shell APIs.
contextBridge.exposeInMainWorld("rccDesktop", {
  getStartupState: () => ipcRenderer.invoke("desktop:startup-state"),
  openLogs: () => ipcRenderer.invoke("desktop:open-logs"),
  exit: () => ipcRenderer.send("desktop:exit"),
  setCaptureActive: (active: boolean) => { if (typeof active === "boolean") ipcRenderer.send("desktop:capture-active", active); },
  onStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on("desktop:status", listener);
    return () => ipcRenderer.removeListener("desktop:status", listener);
  },
  onPrepareQuit: (callback: () => void | Promise<void>) => {
    const listener = () => { void Promise.resolve().then(callback).finally(() => ipcRenderer.send("desktop:prepared")); };
    ipcRenderer.on("desktop:prepare-quit", listener);
    return () => ipcRenderer.removeListener("desktop:prepare-quit", listener);
  },
});
