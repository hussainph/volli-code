import { promises as fs } from "node:fs";
import os from "node:os";
import { basename, join, relative } from "node:path";
import type {
  ListDirectoryResult,
  PickFolderResult,
  RevealResult,
  VolliIpcChannel,
} from "@volli/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The electron mock factory is hoisted above module evaluation, so anything
// it captures into must be hoisted alongside it.
const { handlers, showOpenDialog, showItemInFolder, fromWebContents } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  showOpenDialog: vi.fn(),
  showItemInFolder: vi.fn(),
  fromWebContents: vi.fn(),
}));

// Never vi.importActual("electron"): under plain node the electron package
// resolves to the path of its binary, not the API surface.
vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
  },
  dialog: { showOpenDialog },
  shell: { showItemInFolder },
  BrowserWindow: { fromWebContents },
}));

import { isWithinRoots, registerIpcHandlers } from "./ipc";

/** Fake IPC event; `sender` only matters to the mocked BrowserWindow lookup. */
const fakeEvent = { sender: {} };

/** Invokes a captured handler the way `ipcMain.handle` dispatch would. */
function invoke<T>(channel: VolliIpcChannel, ...args: unknown[]): T {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
  return (handler as (...callArgs: unknown[]) => T)(fakeEvent, ...args);
}

const syncRoots = (paths: unknown) => invoke<void>("volli:sync-project-roots", paths);
const listDirectory = (path: unknown) =>
  invoke<Promise<ListDirectoryResult>>("volli:list-directory", path);
const pickProjectFolder = () => invoke<Promise<PickFolderResult>>("volli:pick-project-folder");
const windowIsFullscreen = () => invoke<boolean>("volli:window-is-fullscreen");
const revealInFinder = (path: unknown) => invoke<RevealResult>("volli:reveal-in-finder", path);

const dialogOptions = { properties: ["openDirectory", "createDirectory"] };

let root: string;
let outside: string;

beforeAll(async () => {
  registerIpcHandlers();

  // realpath is mandatory on macOS: os.tmpdir() lives under /var, a symlink
  // to /private/var — the handlers resolve() incoming paths, which does not
  // canonicalize symlinks, so a non-canonical fixture root would never match.
  root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "volli-ipc-")));
  outside = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "volli-ipc-outside-")));

  // "Banana" vs "apple" and "Zebra" vs "sub" order differently under
  // case-sensitive byte order — the listing pins case-insensitive order.
  await fs.mkdir(join(root, "listing", "Zebra"), { recursive: true });
  await fs.mkdir(join(root, "listing", "sub"));
  await fs.writeFile(join(root, "listing", "apple.txt"), "");
  await fs.writeFile(join(root, "listing", "Banana.txt"), "");

  await fs.mkdir(join(root, "dotfiles", ".git"), { recursive: true });
  await fs.mkdir(join(root, "dotfiles", "src"));
  await fs.writeFile(join(root, "dotfiles", ".env"), "");

  await fs.mkdir(join(root, "links", "real-dir"), { recursive: true });
  await fs.symlink(outside, join(root, "links", "linked"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the module-private roots Set through its own public channel — no
  // vi.resetModules, so the same module instance persists across tests.
  syncRoots([]);
});

describe("isWithinRoots", () => {
  it("accepts an exact root match", () => {
    expect(isWithinRoots(new Set(["/a/b"]), "/a/b")).toBe(true);
  });

  it("accepts a nested child of a root", () => {
    expect(isWithinRoots(new Set(["/a/b"]), "/a/b/c/d")).toBe(true);
  });

  it("rejects a sibling that shares the root as a string prefix", () => {
    // "/a/b-x".startsWith("/a/b") — only the `+ sep` boundary rejects this.
    expect(isWithinRoots(new Set(["/a/b"]), "/a/b-x")).toBe(false);
  });

  it("rejects an unrelated path", () => {
    expect(isWithinRoots(new Set(["/a/b"]), "/z")).toBe(false);
  });

  it("rejects everything against an empty set", () => {
    expect(isWithinRoots(new Set<string>(), "/a/b")).toBe(false);
  });

  it("accepts a child of any root in a multi-root set", () => {
    expect(isWithinRoots(new Set(["/a", "/b"]), "/b/c")).toBe(true);
  });
});

describe("volli:sync-project-roots", () => {
  it("replaces the previous roots wholesale on re-sync", async () => {
    syncRoots([root]);
    await expect(listDirectory(root)).resolves.toMatchObject({ ok: true });

    syncRoots([outside]);
    await expect(listDirectory(root)).resolves.toEqual({
      ok: false,
      error: "Path is outside known projects",
    });
  });

  it("resolves relative entries to absolute roots", async () => {
    syncRoots([relative(process.cwd(), root)]);
    await expect(listDirectory(root)).resolves.toMatchObject({ ok: true });
  });

  it("clears the roots on a non-array payload and skips non-string entries", async () => {
    syncRoots([root]);
    syncRoots("nonsense");
    await expect(listDirectory(root)).resolves.toEqual({
      ok: false,
      error: "Path is outside known projects",
    });

    syncRoots([42, null, root]);
    await expect(listDirectory(root)).resolves.toMatchObject({ ok: true });
  });
});

describe("volli:list-directory", () => {
  it("rejects a non-string path", async () => {
    await expect(listDirectory(42)).resolves.toEqual({ ok: false, error: "Invalid path" });
  });

  it("rejects paths outside the synced roots", async () => {
    syncRoots([root]);
    await expect(listDirectory(outside)).resolves.toEqual({
      ok: false,
      error: "Path is outside known projects",
    });
  });

  it("rejects a ../ traversal that escapes a root, post-resolve", async () => {
    syncRoots([root]);
    const sneaky = `${root}/../${basename(outside)}`;
    // The raw string IS prefixed by the root — only resolving before the
    // containment check rejects it.
    expect(sneaky.startsWith(`${root}/`)).toBe(true);
    await expect(listDirectory(sneaky)).resolves.toEqual({
      ok: false,
      error: "Path is outside known projects",
    });
  });

  it("lists directories before files, each group ordered case-insensitively", async () => {
    syncRoots([root]);
    await expect(listDirectory(join(root, "listing"))).resolves.toEqual({
      ok: true,
      entries: [
        { name: "sub", kind: "dir" },
        { name: "Zebra", kind: "dir" },
        { name: "apple.txt", kind: "file" },
        { name: "Banana.txt", kind: "file" },
      ],
    });
  });

  it("filters .git but keeps other dotfiles", async () => {
    syncRoots([root]);
    await expect(listDirectory(join(root, "dotfiles"))).resolves.toEqual({
      ok: true,
      entries: [
        { name: "src", kind: "dir" },
        { name: ".env", kind: "file" },
      ],
    });
  });

  it("types a symlinked directory as a file so it is never traversed", async () => {
    syncRoots([root]);
    await expect(listDirectory(join(root, "links"))).resolves.toEqual({
      ok: true,
      entries: [
        { name: "real-dir", kind: "dir" },
        { name: "linked", kind: "file" },
      ],
    });
  });

  it("returns a typed error instead of throwing for a missing dir inside a root", async () => {
    syncRoots([root]);
    await expect(listDirectory(join(root, "missing"))).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("ENOENT"),
    });
  });
});

describe("volli:pick-project-folder", () => {
  it("returns canceled when the dialog is canceled", async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(pickProjectFolder()).resolves.toEqual({ canceled: true });
  });

  it("returns canceled when the dialog yields no paths", async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
    await expect(pickProjectFolder()).resolves.toEqual({ canceled: true });
  });

  it("returns the picked path with its basename as defaultName", async () => {
    showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/Users/dev/My Project"],
    });
    await expect(pickProjectFolder()).resolves.toEqual({
      canceled: false,
      path: "/Users/dev/My Project",
      defaultName: "My Project",
    });
  });

  it("attaches the dialog to the sender's window when one exists", async () => {
    const fakeWin = { isFullScreen: () => false };
    fromWebContents.mockReturnValueOnce(fakeWin);
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });

    await pickProjectFolder();

    expect(showOpenDialog).toHaveBeenCalledWith(fakeWin, dialogOptions);
  });

  it("opens a windowless dialog when the sender has no window", async () => {
    fromWebContents.mockReturnValueOnce(undefined);
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });

    await pickProjectFolder();

    expect(showOpenDialog).toHaveBeenCalledWith(dialogOptions);
  });
});

describe("volli:window-is-fullscreen", () => {
  it("reports the sender window's fullscreen state", () => {
    fromWebContents.mockReturnValueOnce({ isFullScreen: () => true });
    expect(windowIsFullscreen()).toBe(true);
  });

  it("defaults to false when the sender has no window", () => {
    fromWebContents.mockReturnValueOnce(undefined);
    expect(windowIsFullscreen()).toBe(false);
  });
});

describe("volli:reveal-in-finder", () => {
  it("rejects a non-string path without touching the shell", () => {
    expect(revealInFinder(42)).toEqual({ ok: false, error: "Invalid path" });
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it("rejects paths outside the synced roots without touching the shell", () => {
    syncRoots([root]);
    expect(revealInFinder(outside)).toEqual({
      ok: false,
      error: "Path is outside known projects",
    });
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it("reveals a path inside a root, resolved first", () => {
    syncRoots([root]);
    expect(revealInFinder(`${root}/links/../listing`)).toEqual({ ok: true });
    expect(showItemInFolder).toHaveBeenCalledWith(join(root, "listing"));
  });
});
