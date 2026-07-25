import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_THEME, THEME_CHANNELS } from "@volli/shared";
import type {
  ProjectThemeOverride,
  ThemeDefinition,
  ThemeSetProjectResult,
  ThemeStateResult,
  TerminalOverlayWriteResult,
  VolliIpcChannel,
} from "@volli/shared";

// Hoisted above module evaluation so the electron mock factory can capture
// into it — the same shape data-ipc.test.ts and ghostty-config.test.ts use.
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { registerThemeIpcHandlers } from "./theme-ipc";
import { defaultFsDeps } from "./fs-deps";
import { getGlobalTheme } from "./db/theme-repo";
import { insertProject } from "./db/projects-repo";
import { openTestDb, testProject } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";

let ctx: TestDb;
let userDataDir: string;

beforeEach(() => {
  handlers.clear();
  ctx = openTestDb();
  userDataDir = mkdtempSync(join(tmpdir(), "volli-theme-ipc-"));
});

afterEach(() => {
  ctx.cleanup();
  rmSync(userDataDir, { recursive: true, force: true });
});

/**
 * Registers the surface against the temp db + temp userData dir, and seeds one
 * project. The ghostty layer is pointed at a fake home inside the temp dir so
 * the suite never reads (or could ever write) the developer's real config.
 */
function setup(db: Database.Database = ctx.db): { projectId: string } {
  const project = testProject({ ticketPrefix: "VC" });
  insertProject(ctx.db, project);
  const deps = { fs: defaultFsDeps(userDataDir), now: Date.now };
  registerThemeIpcHandlers(
    { ok: true, db },
    { ...deps, fs: { ...deps.fs, homeDir: join(userDataDir, "fake-home"), env: {} } },
  );
  return { projectId: project.id };
}

/** `Reflect.get`, keeping native better-sqlite3 methods bound to the real object behind a Proxy. */
function boundMember(target: object, prop: string | symbol): unknown {
  const value = Reflect.get(target, prop) as unknown;
  return typeof value === "function" ? value.bind(target) : value;
}

/**
 * `ctx.db`, but a project row is found exactly ONCE.
 *
 * `volli:theme-set-project` looks a project up twice — the override write
 * returns the authoritative row, then the state re-read resolves the payload —
 * and the guard between them is all that stands between a project that
 * disappeared in between and a half-built response. Nothing else is
 * intercepted: every other statement runs against the real db.
 */
function dbLosingTheProjectAfterOneLookup(db: Database.Database): Database.Database {
  const PROJECT_LOOKUP = "SELECT * FROM projects WHERE id = ?";
  let lookups = 0;
  const prepare = (sql: string): Database.Statement => {
    const statement = db.prepare(sql);
    if (sql !== PROJECT_LOOKUP) return statement;
    return new Proxy(statement, {
      get: (target, prop) =>
        prop === "get"
          ? (...args: unknown[]) => (++lookups === 1 ? target.get(...args) : undefined)
          : boundMember(target, prop),
    });
  };
  return new Proxy(db, {
    get: (target, prop) => (prop === "prepare" ? prepare : boundMember(target, prop)),
  });
}

function invoke<R>(channel: VolliIpcChannel, ...args: unknown[]): R {
  const handler = handlers.get(channel) as ((...a: unknown[]) => R) | undefined;
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
  return handler({ sender: {} }, ...args);
}

/** The user's real ghostty config, written into the fake home this suite points at. */
function writeGhosttyConfig(text: string): void {
  const dir = join(userDataDir, "fake-home/.config/ghostty");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config"), text, "utf8");
}

describe("registerThemeIpcHandlers", () => {
  it("registers every theme channel", () => {
    setup();
    for (const channel of THEME_CHANNELS) expect(handlers.has(channel)).toBe(true);
  });

  it("answers every channel with a typed error when the db failed to open", () => {
    registerThemeIpcHandlers(
      { ok: false, error: "disk is on fire" },
      { fs: defaultFsDeps(userDataDir), now: Date.now },
    );

    for (const channel of THEME_CHANNELS) {
      expect(invoke<ThemeStateResult>(channel, {})).toEqual({
        ok: false,
        error: "disk is on fire",
      });
    }
  });
});

describe("volli:theme-state", () => {
  it("falls back to the shipped default before anything has been chosen", () => {
    setup();
    const result = invoke<ThemeStateResult>("volli:theme-state", {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.theme).toEqual(DEFAULT_THEME);
    expect(result.value.projectOverride).toBeNull();
    expect(result.value.projectId).toBeNull();
  });

  it("resolves the project's override and its terminal overlay path", () => {
    const { projectId } = setup();
    invoke("volli:theme-set-project", {
      projectId,
      override: {
        appThemeSlug: null,
        terminalThemeName: "Nord",
        editorThemeId: null,
        seed: null,
      } satisfies ProjectThemeOverride,
    });

    const result = invoke<ThemeStateResult>("volli:theme-state", { projectId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projectId).toBe(projectId);
    expect(result.value.projectOverride?.terminalThemeName).toBe("Nord");
    expect(result.value.terminal.overlayPaths.project).toBe(
      join(userDataDir, "volli/ghostty/projects/VC.config"),
    );
  });

  it("rejects an unknown project instead of silently resolving the global scope", () => {
    setup();
    expect(invoke<ThemeStateResult>("volli:theme-state", { projectId: "nope" })).toEqual({
      ok: false,
      error: "Unknown project",
    });
  });
});

describe("volli:theme-set-global", () => {
  it("persists the authored definition and resolves with the fresh state", () => {
    setup();
    const theme: ThemeDefinition = { ...DEFAULT_THEME, name: "Sea", slug: "sea", seed: "#3a7d9a" };

    const result = invoke<ThemeStateResult>("volli:theme-set-global", { theme });

    expect(result.ok && result.value.theme).toEqual(theme);
    expect(getGlobalTheme(ctx.db)).toEqual(theme);
  });
});

describe("volli:theme-set-project", () => {
  it("persists the override and resolves with the authoritative project row", () => {
    const { projectId } = setup();

    const result = invoke<ThemeSetProjectResult>("volli:theme-set-project", {
      projectId,
      override: {
        appThemeSlug: "sea",
        terminalThemeName: null,
        editorThemeId: null,
        seed: "#3a7d9a",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.themeOverride?.appThemeSlug).toBe("sea");
    expect(result.value.projectOverride?.seed).toBe("#3a7d9a");
  });

  it("clears back to inheriting on a null override", () => {
    const { projectId } = setup();
    invoke("volli:theme-set-project", {
      projectId,
      override: { appThemeSlug: "sea", terminalThemeName: null, editorThemeId: null, seed: null },
    });

    const result = invoke<ThemeSetProjectResult>("volli:theme-set-project", {
      projectId,
      override: null,
    });

    expect(result.ok && result.project.themeOverride).toBeNull();
  });

  it("rejects an unknown project", () => {
    setup();
    expect(
      invoke<ThemeSetProjectResult>("volli:theme-set-project", {
        projectId: "nope",
        override: null,
      }),
    ).toEqual({ ok: false, error: "Unknown project" });
  });

  it("surfaces the state re-read's own failure rather than answering with a half-built payload", () => {
    const { projectId } = setup(dbLosingTheProjectAfterOneLookup(ctx.db));

    const result = invoke<ThemeSetProjectResult>("volli:theme-set-project", {
      projectId,
      override: { appThemeSlug: "sea", terminalThemeName: null, editorThemeId: null, seed: null },
    });

    expect(result).toEqual({ ok: false, error: "Unknown project" });
  });
});

describe("volli:theme-terminal-overlay-write", () => {
  it("writes the global overlay and resolves with the re-read appearance", () => {
    setup();

    const result = invoke<TerminalOverlayWriteResult>("volli:theme-terminal-overlay-write", {
      scope: "global",
      edits: { theme: "Catppuccin Mocha" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(join(userDataDir, "volli/ghostty/config"));
    expect(readFileSync(result.path, "utf8")).toContain("theme = Catppuccin Mocha\n");
    expect(result.terminal.prefs.themeName).toBe("Catppuccin Mocha");
    expect(result.terminal.provenance["theme"]).toBe("volli-global");
  });

  it("writes a project's overlay under its ticket prefix", () => {
    const { projectId } = setup();

    const result = invoke<TerminalOverlayWriteResult>("volli:theme-terminal-overlay-write", {
      scope: "project",
      projectId,
      edits: { "font-size": "15" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(join(userDataDir, "volli/ghostty/projects/VC.config"));
    expect(result.terminal.prefs.fontSize).toBe(15);
    expect(result.terminal.provenance["font-size"]).toBe("volli-project");
  });

  // Decision #67, end to end: the user's real config is a read-only base, so
  // an overlay write must change what the terminal resolves WITHOUT the real
  // file changing on disk.
  it("never modifies the user's own ghostty config", () => {
    setup();
    writeGhosttyConfig("theme = Nord\ncursor-style = block\n");
    const realConfig = join(userDataDir, "fake-home/.config/ghostty/config");
    const before = readFileSync(realConfig, "utf8");

    const result = invoke<TerminalOverlayWriteResult>("volli:theme-terminal-overlay-write", {
      scope: "global",
      edits: { theme: "Ayu" },
    });

    expect(readFileSync(realConfig, "utf8")).toBe(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.terminal.prefs.themeName).toBe("Ayu");
    // The hand-written key still resolves, and is still attributed to ghostty.
    expect(result.terminal.provenance["cursor-style"]).toBe("ghostty");
  });

  // A failed overlay write is a failed mutation like any other: it comes back
  // typed so the renderer can surface it, and no appearance is re-read (and
  // published as if it had changed) on top of a write that never landed.
  it("returns the write failure instead of a fresh appearance when the overlay cannot be written", () => {
    setup();
    // A plain FILE where the overlay root's parent directory belongs, so the
    // atomic write's `mkdir -p` fails ENOTDIR before anything is written.
    writeFileSync(join(userDataDir, "volli"), "not a directory", "utf8");

    const result = invoke<TerminalOverlayWriteResult>("volli:theme-terminal-overlay-write", {
      scope: "global",
      edits: { theme: "Nord" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ENOTDIR");
  });

  it("rejects a project-scoped write for an unknown project", () => {
    setup();
    expect(
      invoke<TerminalOverlayWriteResult>("volli:theme-terminal-overlay-write", {
        scope: "project",
        projectId: "nope",
        edits: { theme: "Nord" },
      }),
    ).toEqual({ ok: false, error: "Unknown project" });
  });
});
