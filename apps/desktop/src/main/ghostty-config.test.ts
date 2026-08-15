import type { VolliIpcChannel, VolliIpcEvent } from "../ipc/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Hoisted above module evaluation, like pty.test.ts, so the electron/node:fs
// mock factories can capture into them.
const { handlers, readFileSyncMock, existsSyncMock, mkdirSyncMock, watchMock, getAllWindows } =
  vi.hoisted(() => ({
    handlers: new Map<string, (...args: never[]) => unknown>(),
    readFileSyncMock: vi.fn(),
    existsSyncMock: vi.fn(),
    mkdirSyncMock: vi.fn(),
    watchMock: vi.fn(),
    getAllWindows: vi.fn(),
  }));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
  },
  BrowserWindow: { getAllWindows },
}));

// This module reaches node:fs/node:os only through the injected slice, except
// for the one genuinely untestable call — the raw fs.watch — which is why the
// mock exists at all. These are plain sync Node builtins (unlike pty.ts's lazy
// node-pty import), mocked the same way ipc.test.ts avoids vi.importActual for
// a package whose real form doesn't suit plain-node tests.
//
// Only the verbs a GhosttyConfigDeps slice can reach are mocked. `writeFile`
// and `rename` are deliberately absent: they are not in that slice, so a read
// path that ever grew a write would fail here loudly rather than pass quietly.
vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  watch: watchMock,
}));
vi.mock("node:os", () => ({ homedir: () => "/Users/test" }));

import {
  readGhosttyAppearance as readGhosttyAppearanceFor,
  registerGhosttyConfigIpc as registerGhosttyConfigIpcWith,
  type GhosttyConfigDeps,
} from "./ghostty-config";
import type {
  GhosttyAppearancePayload,
  GhosttyConfigResult,
  ResolvedAppearance,
} from "@volli/shared";

/**
 * The two entry points with the resolved mode named once.
 *
 * Neither takes a default any more — a `theme = light:X,dark:Y` pair resolves to
 * a different half in each mode, and the parser used to assume `dark` for
 * callers that could not name one. Cases that are not ABOUT that resolution say
 * nothing about the mode; the ones that are pass it explicitly.
 */
const readGhosttyAppearance = (
  deps: GhosttyConfigDeps,
  ticketPrefix: string | null = null,
  appearance: ResolvedAppearance = "dark",
): GhosttyAppearancePayload => readGhosttyAppearanceFor(deps, appearance, ticketPrefix);

const registerGhosttyConfigIpc = (
  deps: GhosttyConfigDeps,
  appearance: () => ResolvedAppearance = () => "dark",
): void => registerGhosttyConfigIpcWith(deps, appearance);

/** Builds deterministic injected deps from a path→text map and a set of existing paths. */
function makeDeps(
  files: Record<string, string>,
  existing: Iterable<string> = [],
  env: Record<string, string | undefined> = {},
): GhosttyConfigDeps {
  const existingSet = new Set(existing);
  return {
    readFile: (path) => (Object.hasOwn(files, path) ? files[path] : null),
    exists: (path) => existingSet.has(path),
    ensureDir: () => undefined,
    env,
    homeDir: "/home/u",
    userDataDir: USER_DATA,
  };
}

const USER_DATA = "/home/u/Library/Application Support/Volli Code";
const GLOBAL_OVERLAY = `${USER_DATA}/volli/ghostty/config`;
const PROJECT_OVERLAY = `${USER_DATA}/volli/ghostty/projects/VC.config`;

const XDG_ENTRY = "/home/u/.config/ghostty/config";
const APP_SUPPORT_DIR = "/home/u/Library/Application Support/com.mitchellh.ghostty";
const APP_SUPPORT_ENTRY = `${APP_SUPPORT_DIR}/config`;

describe("readGhosttyAppearance", () => {
  it("returns null configText and default prefs when neither config file exists", () => {
    const result = readGhosttyAppearance(makeDeps({}));
    expect(result).toEqual({
      prefs: {
        fontFamilies: [],
        fontSize: null,
        themeName: null,
        ligatures: null,
        scrollbackLimitBytes: null,
        mouseReporting: null,
        macosOptionAsAlt: null,
      },
      configText: null,
      themeSource: null,
      provenance: {},
      overlayPaths: { global: GLOBAL_OVERLAY, project: null },
      // No config exists yet, so "Open Ghostty config" points at ghostty's
      // canonical location rather than nothing.
      ghosttyConfigPath: XDG_ENTRY,
    });
  });

  it("reports the config file it actually loaded, so Settings can open it", () => {
    const result = readGhosttyAppearance(makeDeps({ [APP_SUPPORT_ENTRY]: "font-size = 12" }));
    expect(result.ghosttyConfigPath).toBe(APP_SUPPORT_ENTRY);
  });

  it("reads the XDG config alone", () => {
    const result = readGhosttyAppearance(makeDeps({ [XDG_ENTRY]: "font-size = 12" }));
    expect(result.configText).toBe("font-size = 12");
    expect(result.prefs.fontSize).toBe(12);
  });

  it("reads the Application Support config alone", () => {
    const result = readGhosttyAppearance(makeDeps({ [APP_SUPPORT_ENTRY]: "font-size = 18" }));
    expect(result.configText).toBe("font-size = 18");
    expect(result.prefs.fontSize).toBe(18);
  });

  it("has the Application Support config override the XDG config on scalar conflict", () => {
    const result = readGhosttyAppearance(
      makeDeps({
        [XDG_ENTRY]: "font-size = 10\ntheme = FromXdg",
        [APP_SUPPORT_ENTRY]: "font-size = 20",
      }),
    );
    // Last-wins parse of the merged (XDG-then-AppSupport) text: AppSupport's
    // font-size wins, XDG's theme (untouched by AppSupport) survives.
    expect(result.prefs.fontSize).toBe(20);
    expect(result.prefs.themeName).toBe("FromXdg");
    expect(result.configText).toBe("font-size = 10\ntheme = FromXdg\nfont-size = 20");
  });

  it("resolves XDG_CONFIG_HOME when set instead of the ~/.config default", () => {
    const result = readGhosttyAppearance(
      makeDeps({ "/custom/xdg/ghostty/config": "font-size = 30" }, [], {
        XDG_CONFIG_HOME: "/custom/xdg",
      }),
    );
    expect(result.configText).toBe("font-size = 30");
  });

  it("logs config-file include warnings without failing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = readGhosttyAppearance(
      makeDeps({ [XDG_ENTRY]: "config-file = missing.conf\nfont-size = 5" }),
    );
    expect(result.prefs.fontSize).toBe(5);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ghostty-config] config-file not found"),
    );
    warnSpy.mockRestore();
  });

  describe("theme resolution", () => {
    it("reads an absolute theme path directly, bypassing the probe order", () => {
      const result = readGhosttyAppearance(
        makeDeps({
          [XDG_ENTRY]: 'theme = "/custom/theme/path"',
          "/custom/theme/path": "palette = 0=#000000",
        }),
      );
      expect(result.themeSource).toBe("palette = 0=#000000");
    });

    it("probes the XDG themes directory first", () => {
      const xdgThemePath = "/home/u/.config/ghostty/themes/Nice Theme";
      const result = readGhosttyAppearance(
        makeDeps({ [XDG_ENTRY]: "theme = Nice Theme", [xdgThemePath]: "xdg theme text" }, [
          xdgThemePath,
        ]),
      );
      expect(result.themeSource).toBe("xdg theme text");
    });

    it("falls back to the Application Support themes directory", () => {
      const appSupportThemePath = `${APP_SUPPORT_DIR}/themes/Nice Theme`;
      const result = readGhosttyAppearance(
        makeDeps(
          { [XDG_ENTRY]: "theme = Nice Theme", [appSupportThemePath]: "app support theme text" },
          [appSupportThemePath],
        ),
      );
      expect(result.themeSource).toBe("app support theme text");
    });

    it("falls back to Ghostty's bundled themes directory last", () => {
      const bundledThemePath =
        "/Applications/Ghostty.app/Contents/Resources/ghostty/themes/Nice Theme";
      const result = readGhosttyAppearance(
        makeDeps({ [XDG_ENTRY]: "theme = Nice Theme", [bundledThemePath]: "bundled theme text" }, [
          bundledThemePath,
        ]),
      );
      expect(result.themeSource).toBe("bundled theme text");
    });

    it("returns null when no probe location has the named theme (restty's builtin catalog)", () => {
      const result = readGhosttyAppearance(makeDeps({ [XDG_ENTRY]: "theme = Some Builtin" }));
      expect(result.themeSource).toBeNull();
    });

    it("returns null when the resolved theme file exists but fails to read", () => {
      const themePath = "/home/u/.config/ghostty/themes/Broken";
      const result = readGhosttyAppearance(
        // No entry in `files` for themePath — the fake readFile returns null,
        // modeling a read failure (e.g. permission denied) on an existing path.
        makeDeps({ [XDG_ENTRY]: "theme = Broken" }, [themePath]),
      );
      expect(result.themeSource).toBeNull();
    });
  });
});

const IPC_USER_DATA = "/Users/test/Library/Application Support/Volli Code";

/**
 * The real-filesystem `GhosttyConfigDeps` slice, over the mocked `node:fs`
 * above — the shape `src/main/index.ts` passes in, built from the same node
 * builtins `defaultFsDeps` binds. Constructed as the SLICE rather than via
 * `defaultFsDeps` so this suite depends only on the capabilities the read path
 * is actually granted.
 */
function ipcDeps(): GhosttyConfigDeps {
  return {
    readFile: (absPath) => {
      try {
        return readFileSyncMock(absPath, "utf8") as string;
      } catch {
        return null;
      }
    },
    exists: (absPath) => existsSyncMock(absPath) as boolean,
    ensureDir: (dir) => {
      mkdirSyncMock(dir, { recursive: true });
    },
    // Empty rather than `process.env`, like `makeDeps`: entry-path resolution
    // reads XDG_CONFIG_HOME, so a developer with it set would otherwise resolve
    // a different config path than the one these assertions hardcode.
    env: {},
    homeDir: "/Users/test",
    userDataDir: IPC_USER_DATA,
  };
}

describe("registerGhosttyConfigIpc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    existsSyncMock.mockImplementation((path: string) =>
      [
        "/Users/test/.config/ghostty",
        "/Users/test/Library/Application Support/com.mitchellh.ghostty",
        `${IPC_USER_DATA}/volli/ghostty`,
        `${IPC_USER_DATA}/volli/ghostty/projects`,
      ].includes(path),
    );
    watchMock.mockReturnValue(undefined);
    getAllWindows.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const invokeGet = () =>
    (
      handlers.get("volli:ghostty-config-get" satisfies VolliIpcChannel) as (
        ...a: unknown[]
      ) => GhosttyConfigResult
    )({ sender: {} });

  it("returns ok:true with the resolved appearance", () => {
    readFileSyncMock.mockImplementation((path: string) => {
      if (path === "/Users/test/.config/ghostty/config") return "font-size = 16";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    registerGhosttyConfigIpc(ipcDeps());
    const result = invokeGet();

    expect(result).toEqual({
      ok: true,
      value: {
        prefs: expect.objectContaining({ fontSize: 16 }) as unknown,
        configText: "font-size = 16",
        themeSource: null,
        provenance: { "font-size": "ghostty" },
        overlayPaths: {
          global: `${IPC_USER_DATA}/volli/ghostty/config`,
          project: null,
        },
        ghosttyConfigPath: "/Users/test/.config/ghostty/config",
      },
    });
  });

  it("returns a typed error instead of throwing when reading the config fails unexpectedly", () => {
    readFileSyncMock.mockImplementation((path: string) => {
      if (path === "/Users/test/.config/ghostty/config") return "theme = Broken";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    existsSyncMock.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    registerGhosttyConfigIpc(ipcDeps());
    const result = invokeGet();

    expect(result).toEqual({ ok: false, error: "EACCES: permission denied" });
  });

  it("watches both entry config paths' parent directories", () => {
    registerGhosttyConfigIpc(ipcDeps());

    const watchedDirs = watchMock.mock.calls.map((call) => call[0]);
    expect(watchedDirs).toEqual([
      "/Users/test/.config/ghostty",
      "/Users/test/Library/Application Support/com.mitchellh.ghostty",
      `${IPC_USER_DATA}/volli/ghostty`,
      `${IPC_USER_DATA}/volli/ghostty/projects`,
    ]);
  });

  it("silently skips config directories that do not exist", () => {
    existsSyncMock.mockReturnValue(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    registerGhosttyConfigIpc(ipcDeps());

    expect(watchMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("logs a warning and keeps watching the other directory when one fs.watch call throws", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    watchMock.mockImplementationOnce(() => {
      throw new Error("ENOENT: no such directory");
    });

    expect(() => registerGhosttyConfigIpc(ipcDeps())).not.toThrow();
    expect(watchMock).toHaveBeenCalledTimes(4);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ghostty-config] could not watch"),
    );
    warnSpy.mockRestore();
  });

  it("logs a warning and still watches when the overlay directory cannot be created", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mkdirSyncMock.mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied");
    });

    expect(() => registerGhosttyConfigIpc(ipcDeps())).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ghostty-config] could not create"),
    );
    warnSpy.mockRestore();
  });

  describe("live reload", () => {
    function fireWatch(dirIndex: 0 | 1 | 2 | 3, filename: string | null): void {
      const cb = watchMock.mock.calls[dirIndex]?.[1] as
        | ((event: string, filename: string | null) => void)
        | undefined;
      cb?.("rename", filename);
    }

    it("ignores changes to files other than config", () => {
      vi.useFakeTimers();
      registerGhosttyConfigIpc(ipcDeps());
      const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
      getAllWindows.mockReturnValue([win]);

      fireWatch(0, "not-config");
      vi.advanceTimersByTime(250);

      expect(win.webContents.send).not.toHaveBeenCalled();
    });

    it("reloads for any hand-edited project overlay, but not for other files there", () => {
      vi.useFakeTimers();
      registerGhosttyConfigIpc(ipcDeps());
      const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
      getAllWindows.mockReturnValue([win]);

      // The projects dir holds one `<PREFIX>.config` per project, so the
      // watcher there matches on the extension rather than the exact name.
      fireWatch(3, "notes.md");
      vi.advanceTimersByTime(250);
      expect(win.webContents.send).not.toHaveBeenCalled();

      fireWatch(3, "VC.config");
      vi.advanceTimersByTime(250);
      expect(win.webContents.send).toHaveBeenCalledTimes(1);
    });

    it("debounces bursts across both watchers into a single reload + broadcast", () => {
      vi.useFakeTimers();
      readFileSyncMock.mockImplementation((path: string) => {
        if (path === "/Users/test/.config/ghostty/config") return "font-size = 22";
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      registerGhosttyConfigIpc(ipcDeps());
      const destroyedWin = { isDestroyed: () => true, webContents: { send: vi.fn() } };
      const liveWin = { isDestroyed: () => false, webContents: { send: vi.fn() } };
      getAllWindows.mockReturnValue([destroyedWin, liveWin]);

      fireWatch(0, "config");
      vi.advanceTimersByTime(100);
      fireWatch(1, "config"); // resets the debounce window
      vi.advanceTimersByTime(100);
      expect(liveWin.webContents.send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(150);

      expect(destroyedWin.webContents.send).not.toHaveBeenCalled();
      expect(liveWin.webContents.send).toHaveBeenCalledTimes(1);
      const [channel, payload] = liveWin.webContents.send.mock.calls[0] as [
        VolliIpcEvent,
        GhosttyAppearancePayload,
      ];
      expect(channel).toBe("volli:ghostty-config-changed");
      expect(payload.prefs.fontSize).toBe(22);
    });
  });
});

// Decision #67: the user's real ghostty config is a read-only BASE; Volli's
// own overlays layer on top of it with the same last-wins semantics ghostty
// already applies across its two config locations.
describe("readGhosttyAppearance — the Volli overlay chain", () => {
  it("layers the global overlay over the user's real config", () => {
    const result = readGhosttyAppearance(
      makeDeps({
        [XDG_ENTRY]: "theme = Nord\nfont-size = 12",
        [GLOBAL_OVERLAY]: "theme = Catppuccin Mocha",
      }),
    );

    expect(result.prefs.themeName).toBe("Catppuccin Mocha");
    expect(result.prefs.fontSize).toBe(12);
  });

  it("layers a project overlay over the global one", () => {
    const result = readGhosttyAppearance(
      makeDeps({
        [XDG_ENTRY]: "theme = Nord",
        [GLOBAL_OVERLAY]: "theme = Catppuccin Mocha\nfont-size = 13",
        [PROJECT_OVERLAY]: "theme = Ayu",
      }),
      "VC",
    );

    expect(result.prefs.themeName).toBe("Ayu");
    expect(result.prefs.fontSize).toBe(13);
  });

  it("ignores the project overlay when no project is in scope", () => {
    const result = readGhosttyAppearance(
      makeDeps({ [XDG_ENTRY]: "theme = Nord", [PROJECT_OVERLAY]: "theme = Ayu" }),
    );

    expect(result.prefs.themeName).toBe("Nord");
  });

  it("resolves a theme named by an overlay against ghostty's own theme directories", () => {
    const themePath = "/home/u/.config/ghostty/themes/Ayu";
    const result = readGhosttyAppearance(
      makeDeps(
        { [XDG_ENTRY]: "theme = Nord", [GLOBAL_OVERLAY]: "theme = Ayu", [themePath]: "ayu text" },
        [themePath],
      ),
    );

    expect(result.themeSource).toBe("ayu text");
  });

  // #67's Settings requirement: every value is labelled `Inherited from
  // Ghostty` or `Set by Volli`. The renderer reads that off this map rather
  // than re-parsing and diffing the layers itself.
  it("reports where every resolved key came from", () => {
    const result = readGhosttyAppearance(
      makeDeps({
        [XDG_ENTRY]: "theme = Nord\ncursor-style = block",
        [GLOBAL_OVERLAY]: "theme = Catppuccin Mocha\nfont-size = 13",
        [PROJECT_OVERLAY]: "font-size = 15",
      }),
      "VC",
    );

    expect(result.provenance).toEqual({
      theme: "volli-global",
      "cursor-style": "ghostty",
      "font-size": "volli-project",
    });
  });

  it("reports no provenance when nothing is configured anywhere", () => {
    const result = readGhosttyAppearance(makeDeps({}));
    expect(result.provenance).toEqual({});
    expect(result.configText).toBeNull();
  });

  // "Open Volli overlay" must work before the file exists — the path is where
  // it WOULD be written, not where one happens to already be.
  it("reports the overlay paths for the Settings open actions", () => {
    expect(readGhosttyAppearance(makeDeps({})).overlayPaths).toEqual({
      global: GLOBAL_OVERLAY,
      project: null,
    });
    expect(readGhosttyAppearance(makeDeps({}), "VC").overlayPaths).toEqual({
      global: GLOBAL_OVERLAY,
      project: PROJECT_OVERLAY,
    });
  });

  it("degrades to no project layer for an unusable prefix instead of throwing", () => {
    const result = readGhosttyAppearance(makeDeps({ [XDG_ENTRY]: "theme = Nord" }), "../evil");

    expect(result.prefs.themeName).toBe("Nord");
    expect(result.overlayPaths.project).toBeNull();
  });

  // OVERLAY_HEADER tells the user, in the file itself, that "any ghostty key
  // works" in an overlay. `config-file` is a ghostty key: reading an overlay
  // with a bare readFile would make it the one directive that works in
  // Ghostty.app and silently does nothing here — the exact class of surprise
  // #68 exists to prevent. Every layer goes through the same resolver.
  describe("config-file includes inside a Volli overlay", () => {
    const OVERLAY_DIR = `${USER_DATA}/volli/ghostty`;
    const PROJECTS_DIR = `${OVERLAY_DIR}/projects`;

    it("resolves a global overlay's include, with the overlay itself still winning", () => {
      const result = readGhosttyAppearance(
        makeDeps({
          [XDG_ENTRY]: "theme = Nord\nfont-size = 12",
          [GLOBAL_OVERLAY]: "config-file = shared.conf\nfont-size = 14",
          [`${OVERLAY_DIR}/shared.conf`]: "cursor-style = bar\nfont-size = 99",
        }),
      );

      // The included file's own keys land…
      expect(result.prefs.themeName).toBe("Nord");
      expect(result.configText).toContain("cursor-style = bar");
      // …but an include never overrides the file that included it (ghostty's
      // own rule), so the overlay's font-size wins over the include's.
      expect(result.prefs.fontSize).toBe(14);
    });

    it("attributes an included key to the layer that included it", () => {
      const result = readGhosttyAppearance(
        makeDeps({
          [XDG_ENTRY]: "theme = Nord",
          [GLOBAL_OVERLAY]: "config-file = shared.conf",
          [`${OVERLAY_DIR}/shared.conf`]: "cursor-style = bar",
          [PROJECT_OVERLAY]: "config-file = project-extras.conf",
          [`${PROJECTS_DIR}/project-extras.conf`]: "font-size = 15",
        }),
        "VC",
      );

      expect(result.provenance).toEqual({
        theme: "ghostty",
        "config-file": "volli-project",
        "cursor-style": "volli-global",
        "font-size": "volli-project",
      });
      expect(result.prefs.fontSize).toBe(15);
    });

    it("warns but does not throw when an overlay's include is missing", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const result = readGhosttyAppearance(
        makeDeps({
          [GLOBAL_OVERLAY]: "config-file = gone.conf\nfont-size = 14",
          [PROJECT_OVERLAY]: "config-file = also-gone.conf\ntheme = Ayu",
        }),
        "VC",
      );

      // Both layers still resolve their own keys.
      expect(result.prefs.fontSize).toBe(14);
      expect(result.prefs.themeName).toBe("Ayu");
      // Warned per layer, in the same shape the entry configs already log.
      expect(warnSpy).toHaveBeenCalledWith(
        `[ghostty-config] config-file not found: ${OVERLAY_DIR}/gone.conf`,
      );
      expect(warnSpy).toHaveBeenCalledWith(
        `[ghostty-config] config-file not found: ${PROJECTS_DIR}/also-gone.conf`,
      );
      warnSpy.mockRestore();
    });

    it("stays silent for a missing optional (?-prefixed) include", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const result = readGhosttyAppearance(
        makeDeps({ [GLOBAL_OVERLAY]: "config-file = ?optional.conf\nfont-size = 14" }),
      );

      expect(result.prefs.fontSize).toBe(14);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
