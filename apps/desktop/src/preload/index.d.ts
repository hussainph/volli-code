import type { ListDirectoryResult, PickFolderResult, RevealResult } from "@volli/shared";

export interface Api {
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  projects: {
    /** Native folder picker; resolves canceled or with the chosen path + basename. */
    pickFolder: () => Promise<PickFolderResult>;
    /** Registers the set of project roots the fs handlers may operate inside. */
    syncRoots: (paths: string[]) => Promise<void>;
  };
  fs: {
    /** Lists one directory level (dirs-first, `.git` hidden, symlinks as files). */
    listDirectory: (absPath: string) => Promise<ListDirectoryResult>;
    /** Reveals the path in Finder. */
    revealInFinder: (absPath: string) => Promise<RevealResult>;
  };
  window: {
    /** Whether the window is currently in macOS fullscreen. */
    isFullScreen: () => Promise<boolean>;
    /** Subscribes to fullscreen enter/leave; returns the unsubscribe function. */
    onFullScreenChange: (callback: (isFullScreen: boolean) => void) => () => void;
  };
}

declare global {
  interface Window {
    api: Api;
  }
}
