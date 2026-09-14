const { contextBridge, ipcRenderer } = require("electron");

const epochNow = () => performance.timeOrigin + performance.now();

contextBridge.exposeInMainWorld("sessionRpcBench", {
  roundTrip: async (payload) => {
    const preloadIn = epochNow();
    const preloadSend = epochNow();
    const response = await ipcRenderer.invoke("volli-bench:session-rpc", {
      payload,
      preloadSend,
    });
    const preloadOut = epochNow();
    return { ...response, preloadIn, preloadSend, preloadOut };
  },
  startSqliteScan: (databasePath) => ipcRenderer.invoke("volli-bench:session-sqlite", databasePath),
  startPush: (options) => ipcRenderer.invoke("volli-bench:session-push", options),
  onPush: (listener) => {
    const handler = (_event, frame) => listener(frame);
    ipcRenderer.on("volli-bench:session-push-frame", handler);
    return () => ipcRenderer.removeListener("volli-bench:session-push-frame", handler);
  },
});
