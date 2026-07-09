import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { promises as fs } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { compareDirEntries } from "@volli/shared";
import type {
  DirEntry,
  ListDirectoryResult,
  PickFolderResult,
  RevealResult,
  VolliIpcChannel,
} from "@volli/shared";

// Absolute project roots the renderer has registered. Filesystem handlers
// only operate inside these. Defense-in-depth for a compromised renderer,
// not a hard boundary — the registry itself is renderer-fed.
const projectRoots = new Set<string>();

function isWithinRoots(absPath: string): boolean {
  for (const root of projectRoots) {
    if (absPath === root || absPath.startsWith(root + sep)) {
      return true;
    }
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Failures travel back as typed result objects, never as rejections —
// ipcMain.handle rejections serialize into useless "Error invoking remote
// method" strings, and every failure must be surfaceable in the UI.
export function registerIpcHandlers(): void {
  ipcMain.handle(
    "volli:pick-project-folder" satisfies VolliIpcChannel,
    async (event): Promise<PickFolderResult> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.OpenDialogOptions = {
        properties: ["openDirectory", "createDirectory"],
      };
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      const path = result.filePaths[0];
      if (result.canceled || path === undefined) {
        return { canceled: true };
      }
      // basename computed here: the renderer never does path math.
      return { canceled: false, path, defaultName: basename(path) };
    },
  );

  ipcMain.handle("volli:sync-project-roots" satisfies VolliIpcChannel, (_event, paths: unknown) => {
    projectRoots.clear();
    if (Array.isArray(paths)) {
      for (const path of paths) {
        if (typeof path === "string") {
          projectRoots.add(resolve(path));
        }
      }
    }
  });

  ipcMain.handle(
    "volli:list-directory" satisfies VolliIpcChannel,
    async (_event, absPath: unknown): Promise<ListDirectoryResult> => {
      if (typeof absPath !== "string") {
        return { ok: false, error: "Invalid path" };
      }
      const resolved = resolve(absPath);
      if (!isWithinRoots(resolved)) {
        return { ok: false, error: "Path is outside known projects" };
      }
      try {
        const dirents = await fs.readdir(resolved, { withFileTypes: true });
        const entries: DirEntry[] = dirents
          // .git is noise in a file browser; other dotfiles (.env, .github…)
          // are exactly what developers come looking for.
          .filter((dirent) => dirent.name !== ".git")
          // Symlinks are typed as files and never traversed — cheap closure
          // of the symlink-escape hatch out of the project root.
          .map((dirent) => ({ name: dirent.name, kind: dirent.isDirectory() ? "dir" : "file" }));
        entries.sort(compareDirEntries);
        return { ok: true, entries };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:reveal-in-finder" satisfies VolliIpcChannel,
    (_event, absPath: unknown): RevealResult => {
      if (typeof absPath !== "string") {
        return { ok: false, error: "Invalid path" };
      }
      const resolved = resolve(absPath);
      if (!isWithinRoots(resolved)) {
        return { ok: false, error: "Path is outside known projects" };
      }
      shell.showItemInFolder(resolved);
      return { ok: true };
    },
  );
}
