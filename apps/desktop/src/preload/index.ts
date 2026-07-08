import { contextBridge } from "electron";

// Minimal typed API surface exposed to the renderer. No PTY/terminal API yet
// — that lands with the terminal spike (see docs/CONCEPT.md).
const api = {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error (define in dts) — only reachable if contextIsolation is disabled
  window.api = api;
}
