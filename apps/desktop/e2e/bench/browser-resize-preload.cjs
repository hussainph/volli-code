const { contextBridge, ipcRenderer } = require("electron");

// This bridge is deliberately benchmark-local. It models the Browser plane's
// asynchronous renderer -> main placement IPC without importing the app.
contextBridge.exposeInMainWorld("vc363Bench", {
  setBounds: (input) => ipcRenderer.invoke("vc363:set-bounds", input),
  emit: (message) => ipcRenderer.send("vc363:message", message),
});
