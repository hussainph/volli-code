/**
 * The one injected filesystem seam the main process's CONFIG surfaces pull
 * from — ghostty config resolution (`ghostty-config.ts`), Volli's terminal
 * overlay writer (`theme-overlay.ts`), and the theming IPC that drives both
 * (`theme-ipc.ts`).
 *
 * Those three grew parallel dep bags — two `readFile` implementations that
 * were byte-identical, two `userData` roots, and one directory-creator spelled
 * `ensureDir` in one module and `mkdirp` in the other. Two copies of a seam
 * are two things to keep honest: the moment one grows a behavior (a retry, an
 * encoding, a guard) the other silently doesn't have it, and nothing fails.
 * So the seam is declared ONCE here and every real binding comes from
 * {@link defaultFsDeps}.
 *
 * Modules do NOT take a whole {@link FsDeps}. Each declares exactly the slice
 * it is allowed to use, as a `Pick`, and that narrowing is load-bearing rather
 * than tidy: `ThemeOverlayDeps` omits `exists`/`env`/`homeDir` so the write
 * path cannot go looking for the user's own config, and `GhosttyConfigDeps`
 * omits `writeFile`/`rename` so the read path structurally cannot write
 * anything at all (decision #67). A single `FsDeps` value satisfies every
 * slice, so callers and tests build one object and pass it everywhere.
 *
 * Deliberately SYNCHRONOUS and deliberately small. This is the config-file
 * seam: whole small text files, read on the terminal-appearance hot path and
 * during window creation, where an await would buy nothing and cost ordering
 * guarantees. The async, artifact/repo-file surface is `volli-fs.ts`'s and
 * shares nothing with this.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Synchronous filesystem + environment access, injected so every consumer is
 * testable without touching disk — and so the overlay write guard is provable
 * against a fake root rather than the developer's real `~`.
 */
export interface FsDeps {
  /**
   * Electron's `userData` dir. `src/main/index.ts` is the single call site
   * that resolves `app.getPath("userData")` — the same injection stance as
   * `db/index.ts`'s `dbPath` and `attachment-store.ts`'s root.
   */
  userDataDir: string;
  homeDir: string;
  env: Record<string, string | undefined>;
  /** Sync file reader; null on ANY error (missing file, permission, …) — a missing config is normal, not a failure. */
  readFile(absPath: string): string | null;
  /** File existence probe, used for ghostty theme resolution. */
  exists(absPath: string): boolean;
  /** `mkdir -p`. */
  ensureDir(dir: string): void;
  writeFile(absPath: string, text: string): void;
  rename(from: string, to: string): void;
  /** Names the same-directory temp file an atomic write lands in before its rename. */
  tempName(targetPath: string): string;
}

function defaultReadFile(absPath: string): string | null {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

/** The real filesystem and environment, bound to one `userData` root. */
export function defaultFsDeps(userDataDir: string): FsDeps {
  return {
    userDataDir,
    homeDir: homedir(),
    env: process.env,
    readFile: defaultReadFile,
    exists: existsSync,
    ensureDir: (dir) => {
      mkdirSync(dir, { recursive: true });
    },
    writeFile: (absPath, text) => {
      writeFileSync(absPath, text, "utf8");
    },
    rename: renameSync,
    // Dot-prefixed and uniquely suffixed: a crashed write leaves an inert
    // hidden file rather than something ghostty's directory watch or a
    // curious user would mistake for a real overlay.
    tempName: (targetPath) =>
      join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.tmp`),
  };
}
