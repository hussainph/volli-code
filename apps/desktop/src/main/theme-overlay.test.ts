import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { OVERLAY_HEADER } from "@volli/shared";

import { defaultFsDeps } from "./fs-deps";
import {
  readTerminalOverlays,
  writeGlobalTerminalOverlay,
  writeProjectTerminalOverlay,
  writeTerminalOverlay,
} from "./theme-overlay";
import type { ThemeOverlayDeps } from "./theme-overlay";

let dir: string | null = null;

afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** A real temp `userData` dir plus the real fs deps — this module's whole job is touching disk. */
function realDeps(): ThemeOverlayDeps {
  dir = mkdtempSync(join(tmpdir(), "volli-overlay-test-"));
  return defaultFsDeps(dir);
}

/** Every fs op in {@link trippedDeps} — a call is a test failure by construction. */
function boom(): never {
  throw new Error("filesystem was touched");
}

/** Deps whose every fs op throws, so a rejected write is provably a write that never happened. */
function trippedDeps(userDataDir: string): ThemeOverlayDeps {
  return {
    userDataDir,
    readFile: boom,
    ensureDir: boom,
    writeFile: boom,
    rename: boom,
    tempName: boom,
  };
}

describe("the write guard", () => {
  // Decision #67, the invariant the whole overlay design exists to protect:
  // Volli must never write the user's own ghostty config. Enforced by
  // construction here, not by every call site remembering to.
  it("refuses to write the user's own ghostty config", () => {
    const deps = trippedDeps("/Users/u/Library/Application Support/Volli Code");
    const result = writeTerminalOverlay(deps, "/Users/u/.config/ghostty/config", { theme: "Nord" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/outside/i);
  });

  it("refuses a path that escapes the overlay root by traversal", () => {
    const userDataDir = "/Users/u/Library/Application Support/Volli Code";
    const deps = trippedDeps(userDataDir);
    const escaped = `${userDataDir}/volli/ghostty/../../../.config/ghostty/config`;

    expect(writeTerminalOverlay(deps, escaped, { theme: "Nord" }).ok).toBe(false);
  });

  it("refuses the overlay root directory itself", () => {
    const userDataDir = "/Users/u/Library/Application Support/Volli Code";
    const deps = trippedDeps(userDataDir);

    expect(writeTerminalOverlay(deps, `${userDataDir}/volli/ghostty`, { theme: "Nord" }).ok).toBe(
      false,
    );
  });
});

describe("writeGlobalTerminalOverlay", () => {
  it("creates the overlay, its parent directories, and returns the path written", () => {
    const deps = realDeps();
    const result = writeGlobalTerminalOverlay(deps, { theme: "Catppuccin Mocha" });

    expect(result.ok).toBe(true);
    const path = result.ok ? result.path : "";
    expect(path).toBe(join(deps.userDataDir, "volli/ghostty/config"));
    const text = readFileSync(path, "utf8");
    expect(text.startsWith(OVERLAY_HEADER)).toBe(true);
    expect(text).toContain("theme = Catppuccin Mocha\n");
  });

  it("preserves hand-written keys across a rewrite", () => {
    const deps = realDeps();
    writeGlobalTerminalOverlay(deps, { theme: "Nord" });
    const path = join(deps.userDataDir, "volli/ghostty/config");
    writeFileSync(path, `${readFileSync(path, "utf8")}cursor-style = block\n`);

    writeGlobalTerminalOverlay(deps, { theme: "Ayu" });

    const text = readFileSync(path, "utf8");
    expect(text).toContain("theme = Ayu\n");
    expect(text).toContain("cursor-style = block\n");
  });

  it("leaves no temp file behind", () => {
    const deps = realDeps();
    writeGlobalTerminalOverlay(deps, { theme: "Nord" });

    expect(readdirSync(join(deps.userDataDir, "volli/ghostty"))).toEqual(["config"]);
  });

  it("writes via a temp file in the same directory, then renames it into place", () => {
    const deps = realDeps();
    const renames: Array<[string, string]> = [];
    const spied: ThemeOverlayDeps = {
      ...deps,
      rename: (from, to) => {
        renames.push([from, to]);
        deps.rename(from, to);
      },
    };

    writeGlobalTerminalOverlay(spied, { theme: "Nord" });

    const [[from, to]] = renames;
    expect(to).toBe(join(deps.userDataDir, "volli/ghostty/config"));
    expect(from).not.toBe(to);
    // Same filesystem, or the rename is not atomic.
    expect(from.slice(0, from.lastIndexOf("/"))).toBe(to.slice(0, to.lastIndexOf("/")));
  });

  it("surfaces a failed write as a typed error instead of throwing", () => {
    const deps = realDeps();
    const failing: ThemeOverlayDeps = {
      ...deps,
      writeFile: () => {
        throw new Error("ENOSPC: no space left on device");
      },
    };

    const result = writeGlobalTerminalOverlay(failing, { theme: "Nord" });
    expect(result).toEqual({ ok: false, error: "ENOSPC: no space left on device" });
  });
});

describe("writeProjectTerminalOverlay", () => {
  it("writes the project's own overlay under projects/<prefix>.config", () => {
    const deps = realDeps();
    const result = writeProjectTerminalOverlay(deps, "VC", { theme: "Nord" });

    expect(result.ok).toBe(true);
    expect(
      readFileSync(join(deps.userDataDir, "volli/ghostty/projects/VC.config"), "utf8"),
    ).toContain("theme = Nord\n");
  });

  it("refuses an invalid ticket prefix rather than building a path from it", () => {
    const deps = trippedDeps("/Users/u/Library/Application Support/Volli Code");

    expect(writeProjectTerminalOverlay(deps, "../evil", { theme: "Nord" }).ok).toBe(false);
  });

  it("never touches another project's overlay", () => {
    const deps = realDeps();
    writeProjectTerminalOverlay(deps, "VC", { theme: "Nord" });
    writeProjectTerminalOverlay(deps, "ACME", { theme: "Ayu" });

    expect(
      readFileSync(join(deps.userDataDir, "volli/ghostty/projects/VC.config"), "utf8"),
    ).toContain("theme = Nord\n");
  });
});

describe("readTerminalOverlays", () => {
  it("reads both overlay texts, null when absent", () => {
    const deps = realDeps();
    expect(readTerminalOverlays(deps, null)).toEqual({ global: null, project: null });

    writeGlobalTerminalOverlay(deps, { theme: "Nord" });
    writeProjectTerminalOverlay(deps, "VC", { "font-size": "15" });

    const overlays = readTerminalOverlays(deps, "VC");
    expect(overlays.global).toContain("theme = Nord\n");
    expect(overlays.project).toContain("font-size = 15\n");
  });

  // A read is on the terminal-appearance hot path (every boot, every live
  // reload) — an unusable prefix must degrade to "no project overlay", never
  // take the whole appearance payload down with it.
  it("reports a project overlay as absent for an invalid prefix rather than throwing", () => {
    const deps = realDeps();
    expect(readTerminalOverlays(deps, "../evil")).toEqual({ global: null, project: null });
  });
});
