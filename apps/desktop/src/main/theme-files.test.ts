import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_THEME } from "@volli/shared";
import type { ThemeDefinition } from "@volli/shared";

import { defaultFsDeps } from "./fs-deps";
import {
  deleteCustomTheme,
  listCustomThemes,
  readCustomTheme,
  writeCustomTheme,
} from "./theme-files";
import type { ThemeFileDeps } from "./theme-files";

let dir: string | null = null;

afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** A real temp `userData` dir plus the real fs deps — this module's whole job is touching disk. */
function realDeps(): ThemeFileDeps {
  dir = mkdtempSync(join(tmpdir(), "volli-theme-files-test-"));
  return defaultFsDeps(dir);
}

function theme(overrides: Partial<ThemeDefinition> = {}): ThemeDefinition {
  return { ...DEFAULT_THEME, name: "Sunset", slug: "sunset", ...overrides };
}

/** Every fs op in {@link trippedDeps} — a call is a test failure by construction. */
function boom(): never {
  throw new Error("filesystem was touched");
}

/** Deps whose every fs op throws, so a rejected slug is provably a slug nothing was attempted against. */
function trippedDeps(): ThemeFileDeps {
  return {
    userDataDir: "/Users/u/Library/Application Support/Volli Code",
    readFile: boom,
    readDir: boom,
    ensureDir: boom,
    writeFile: boom,
    rename: boom,
    removeFile: boom,
    tempName: boom,
  };
}

/** Slugs that must never become a path: traversal, absolute, separators, empty. */
const REFUSED_SLUGS = ["..", "../evil", "/etc/passwd", "..\\evil", "themes/../../x", ""];

describe("the slug guard", () => {
  // The whole security boundary of this module: a slug that could name a file
  // outside `<userData>/volli/themes` must be refused BEFORE a path is built,
  // let alone touched — same stance as theme-overlay.ts's write guard.
  it("refuses to write a theme whose slug escapes the themes directory", () => {
    for (const slug of REFUSED_SLUGS) {
      const result = writeCustomTheme(trippedDeps(), theme({ slug }));

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/invalid theme slug/i);
    }
  });
});

describe("writeCustomTheme + listCustomThemes", () => {
  it("lists a theme that was just written", () => {
    const deps = realDeps();
    const sunset = theme();

    expect(writeCustomTheme(deps, sunset).ok).toBe(true);

    expect(listCustomThemes(deps)).toEqual([sunset]);
  });

  // The themes directory is a place the user is invited to open, edit and drop
  // files into (#71). One broken file must cost exactly itself — a picker that
  // renders nothing because of a stray `.DS_Store` would be the worse bug.
  it("skips a file that isn't a readable theme rather than failing the whole catalog", () => {
    const deps = realDeps();
    writeCustomTheme(deps, theme());
    const themesDir = join(deps.userDataDir, "volli/themes");
    writeFileSync(join(themesDir, "broken.json"), "{ not json");
    writeFileSync(join(themesDir, "not-a-theme.json"), JSON.stringify({ name: "X" }));
    writeFileSync(join(themesDir, "notes.txt"), JSON.stringify(theme({ slug: "notes" })));
    writeFileSync(join(themesDir, ".DS_Store"), "");

    expect(listCustomThemes(deps).map((entry) => entry.slug)).toEqual(["sunset"]);
  });

  it("takes the file name as the theme's identity, so a hand-copied file is a second theme", () => {
    const deps = realDeps();
    writeCustomTheme(deps, theme());
    const themesDir = join(deps.userDataDir, "volli/themes");
    writeFileSync(join(themesDir, "my-sunset.json"), readFileSync(join(themesDir, "sunset.json")));

    expect(
      listCustomThemes(deps)
        .map((entry) => entry.slug)
        .toSorted(),
    ).toEqual(["my-sunset", "sunset"]);
  });

  it("lists themes by display name, so the picker's order never depends on readdir", () => {
    const deps = realDeps();
    writeCustomTheme(deps, theme({ name: "Zinc", slug: "zinc" }));
    writeCustomTheme(deps, theme({ name: "Aurora", slug: "aurora" }));

    expect(listCustomThemes(deps).map((entry) => entry.name)).toEqual(["Aurora", "Zinc"]);
  });

  it("is an empty catalog when the themes directory doesn't exist yet", () => {
    expect(listCustomThemes(realDeps())).toEqual([]);
  });

  it("writes via a temp file in the same directory, then renames it into place", () => {
    const deps = realDeps();
    const renames: Array<[string, string]> = [];
    const spied: ThemeFileDeps = {
      ...deps,
      rename: (from, to) => {
        renames.push([from, to]);
        deps.rename(from, to);
      },
    };

    writeCustomTheme(spied, theme());

    const [[from, to]] = renames;
    expect(to).toBe(join(deps.userDataDir, "volli/themes/sunset.json"));
    expect(from).not.toBe(to);
    // Same filesystem, or the rename is not atomic.
    expect(from.slice(0, from.lastIndexOf("/"))).toBe(to.slice(0, to.lastIndexOf("/")));
  });

  // The point of the temp-file + rename dance: a write that dies partway
  // through must leave the theme the user already had, not a truncated file
  // the catalog would then silently skip.
  it("leaves the previous theme intact when a write fails partway through", () => {
    const deps = realDeps();
    writeCustomTheme(deps, theme({ name: "Sunset" }));
    const failing: ThemeFileDeps = {
      ...deps,
      rename: () => {
        throw new Error("EIO: i/o error");
      },
    };

    const result = writeCustomTheme(failing, theme({ name: "Sunrise" }));

    expect(result).toEqual({ ok: false, error: "EIO: i/o error" });
    expect(listCustomThemes(deps)).toEqual([theme({ name: "Sunset" })]);
  });

  it("leaves no temp file behind", () => {
    const deps = realDeps();
    writeCustomTheme(deps, theme());

    expect(readdirSync(join(deps.userDataDir, "volli/themes"))).toEqual(["sunset.json"]);
  });
});

describe("readCustomTheme", () => {
  it("reads one theme back by slug", () => {
    const deps = realDeps();
    writeCustomTheme(deps, theme());

    expect(readCustomTheme(deps, "sunset")).toEqual({ ok: true, theme: theme() });
  });

  it("refuses a slug that escapes the themes directory before touching disk", () => {
    for (const slug of REFUSED_SLUGS) {
      expect(readCustomTheme(trippedDeps(), slug).ok).toBe(false);
    }
  });

  it("reports a theme that isn't there", () => {
    const result = readCustomTheme(realDeps(), "sunset");

    expect(result).toEqual({ ok: false, error: "Theme was not found" });
  });

  // A theme file is meant to be hand-edited, so a hand-edit that breaks it is
  // an expected outcome, not an exceptional one: it degrades to a typed error
  // the UI can show, never a throw across IPC.
  it("degrades a hand-broken theme file to a typed error", () => {
    const deps = realDeps();
    writeCustomTheme(deps, theme());
    writeFileSync(join(deps.userDataDir, "volli/themes/sunset.json"), '{ "name": "Sunset" }');

    const result = readCustomTheme(deps, "sunset");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/could not be read/i);
  });
});

describe("deleteCustomTheme", () => {
  it("removes the theme's file", () => {
    const deps = realDeps();
    writeCustomTheme(deps, theme());

    expect(deleteCustomTheme(deps, "sunset")).toEqual({ ok: true });
    expect(listCustomThemes(deps)).toEqual([]);
  });

  it("refuses a slug that escapes the themes directory before touching disk", () => {
    for (const slug of REFUSED_SLUGS) {
      expect(deleteCustomTheme(trippedDeps(), slug).ok).toBe(false);
    }
  });

  // The user asked for it not to be there, and it isn't. Failing a delete
  // against a file a hand-edit already removed would be noise, not information.
  it("succeeds when the theme is already gone", () => {
    expect(deleteCustomTheme(realDeps(), "sunset")).toEqual({ ok: true });
  });

  it("surfaces a failed delete as a typed error instead of throwing", () => {
    const deps = realDeps();
    writeCustomTheme(deps, theme());
    const failing: ThemeFileDeps = {
      ...deps,
      removeFile: () => {
        throw new Error("EPERM: operation not permitted");
      },
    };

    expect(deleteCustomTheme(failing, "sunset")).toEqual({
      ok: false,
      error: "EPERM: operation not permitted",
    });
  });
});
