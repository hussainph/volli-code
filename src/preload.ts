import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ptyAPI", {
  spawn: (shell: string) => ipcRenderer.invoke("pty:spawn", shell),
  write: (pid: number, data: string) =>
    ipcRenderer.invoke("pty:write", pid, data),
  onData: (callback: (data: string) => void) => {
    ipcRenderer.on("pty:data", (_, data) => callback(data));
  },
});
