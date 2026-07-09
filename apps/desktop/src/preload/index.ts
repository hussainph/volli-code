import { contextBridge, ipcRenderer } from "electron";
// Type-only imports ONLY: the pack config keeps main and preload
// dependency-disjoint (see CAUTION in vite.config.ts) — a runtime import
// from @volli/shared here could split a shared chunk out of preload.cjs.
import type {
  ListDirectoryResult,
  PickFolderResult,
  RevealResult,
  VolliIpcChannel,
} from "@volli/shared";

// Minimal typed API surface exposed to the renderer. No PTY/terminal API yet
// — that lands with the terminal spike (see docs/CONCEPT.md).
const api = {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  projects: {
    pickFolder: (): Promise<PickFolderResult> =>
      ipcRenderer.invoke("volli:pick-project-folder" satisfies VolliIpcChannel),
    syncRoots: (paths: string[]): Promise<void> =>
      ipcRenderer.invoke("volli:sync-project-roots" satisfies VolliIpcChannel, paths),
  },
  fs: {
    listDirectory: (absPath: string): Promise<ListDirectoryResult> =>
      ipcRenderer.invoke("volli:list-directory" satisfies VolliIpcChannel, absPath),
    revealInFinder: (absPath: string): Promise<RevealResult> =>
      ipcRenderer.invoke("volli:reveal-in-finder" satisfies VolliIpcChannel, absPath),
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
