import type { VolliIpcChannel, VolliIpcEvent } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Hoisted above module evaluation, like pty.test.ts, so the electron/node:fs
// mock factories can capture into them.
const { handlers, readFileSyncMock, existsSyncMock, watchMock, getAllWindows } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  readFileSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
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

// defaultDeps() reads node:fs/node:os directly (unlike pty.ts's lazy
// node-pty import, these are plain sync Node builtins) — mocked the same way
// ipc.test.ts avoids vi.importActual for a package whose real form doesn't
// suit plain-node tests.
vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
  existsSync: existsSyncMock,
  watch: watchMock,
}));
vi.mock("node:os", () => ({ homedir: () => "/Users/test" }));

import {
  readGhosttyAppearance,
  registerGhosttyConfigIpc,
  type GhosttyConfigDeps,
} from "./ghostty-config";
import type { GhosttyAppearancePayload, GhosttyConfigResult } from "@volli/shared";

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
    env,
    homeDir: "/home/u",
  };
}

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
    });
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

describe("registerGhosttyConfigIpc", () => {
  let originalXdg: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    // Deterministic across dev/CI hosts: readGhosttyAppearance's default deps
    // read process.env directly, so the ambient XDG_CONFIG_HOME must not leak in.
    originalXdg = process.env["XDG_CONFIG_HOME"];
    delete process.env["XDG_CONFIG_HOME"];
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    existsSyncMock.mockReturnValue(false);
    watchMock.mockReturnValue(undefined);
    getAllWindows.mockReturnValue([]);
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = originalXdg;
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

    registerGhosttyConfigIpc();
    const result = invokeGet();

    expect(result).toEqual({
      ok: true,
      value: {
        prefs: expect.objectContaining({ fontSize: 16 }) as unknown,
        configText: "font-size = 16",
        themeSource: null,
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

    registerGhosttyConfigIpc();
    const result = invokeGet();

    expect(result).toEqual({ ok: false, error: "EACCES: permission denied" });
  });

  it("watches both entry config paths' parent directories", () => {
    registerGhosttyConfigIpc();

    const watchedDirs = watchMock.mock.calls.map((call) => call[0]);
    expect(watchedDirs).toEqual([
      "/Users/test/.config/ghostty",
      "/Users/test/Library/Application Support/com.mitchellh.ghostty",
    ]);
  });

  it("logs a warning and keeps watching the other directory when one fs.watch call throws", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    watchMock.mockImplementationOnce(() => {
      throw new Error("ENOENT: no such directory");
    });

    expect(() => registerGhosttyConfigIpc()).not.toThrow();
    expect(watchMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ghostty-config] could not watch"),
    );
    warnSpy.mockRestore();
  });

  describe("live reload", () => {
    function fireWatch(dirIndex: 0 | 1, filename: string | null): void {
      const cb = watchMock.mock.calls[dirIndex]?.[1] as
        | ((event: string, filename: string | null) => void)
        | undefined;
      cb?.("rename", filename);
    }

    it("ignores changes to files other than config", () => {
      vi.useFakeTimers();
      registerGhosttyConfigIpc();
      const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
      getAllWindows.mockReturnValue([win]);

      fireWatch(0, "not-config");
      vi.advanceTimersByTime(250);

      expect(win.webContents.send).not.toHaveBeenCalled();
    });

    it("debounces bursts across both watchers into a single reload + broadcast", () => {
      vi.useFakeTimers();
      readFileSyncMock.mockImplementation((path: string) => {
        if (path === "/Users/test/.config/ghostty/config") return "font-size = 22";
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      registerGhosttyConfigIpc();
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
