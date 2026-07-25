/**
 * The first place Volli ever writes a terminal config file — and the guard
 * that makes writing the WRONG one impossible.
 *
 * Decision #67: the user's own `~/.config/ghostty/config` is a read-only base.
 * Volli owns overlay files under `<userData>/volli/ghostty/`, in ghostty's own
 * `key = value` format, layered on top. If Volli ever wrote the real config,
 * clicking a swatch in Volli would silently restyle **Ghostty.app and cmux** —
 * so {@link writeTerminalOverlay} refuses, by construction, to write any path
 * outside the overlay root. Every write in this module goes through it; there
 * is no unguarded door.
 *
 * Writes are atomic: content lands in a temp file **in the same directory**
 * (rename is only atomic within one filesystem) and is then renamed over the
 * target, so a crash mid-write leaves the previous overlay intact rather than
 * a half-written config that would fail ghostty's parse on the next reload.
 *
 * All string/path logic lives in `@volli/shared`
 * (`theme/ghostty-overlay.ts` — path builders + {@link applyOverlayEdits});
 * this module supplies only the filesystem, through injected deps, exactly
 * like `ghostty-config.ts`'s `GhosttyConfigDeps`. Results are typed unions,
 * never thrown errors: a failed overlay write must be surfaceable in the UI
 * like any other failed mutation.
 */

import {
  applyOverlayEdits,
  errorMessage,
  globalGhosttyOverlayPath,
  projectGhosttyOverlayPath,
  volliGhosttyOverlayDir,
} from "@volli/shared";
import type { OverlayEdits } from "@volli/shared";
import type { FsDeps } from "./fs-deps";

/**
 * The write path's slice of {@link FsDeps} (`defaultFsDeps` supplies the real
 * one), so the guard below is provable against a fake root — see `trippedDeps`
 * in the tests.
 *
 * The omissions are the point. `exists`, `env` and `homeDir` are NOT in this
 * slice, so nothing on the write path can probe for — let alone resolve — the
 * user's own `~/.config/ghostty/config`. Decision #67 is enforced twice over:
 * once by {@link isVolliOverlayPath} at runtime, and once here by a type that
 * never hands this module the means to find the file it must not touch.
 */
export type ThemeOverlayDeps = Pick<
  FsDeps,
  "userDataDir" | "readFile" | "ensureDir" | "writeFile" | "rename" | "tempName"
>;

/** Collapses `.`/`..` segments so a traversal cannot hide from the containment check below. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `/${out.join("/")}`;
}

/**
 * Whether `absPath` names a file strictly INSIDE Volli's overlay root. The
 * whole point of decision #67 in one predicate: normalized first (so
 * `…/volli/ghostty/../../../.config/ghostty/config` cannot slip through), and
 * strict — the root directory itself is not a writable target.
 */
export function isVolliOverlayPath(userDataDir: string, absPath: string): boolean {
  const root = normalize(volliGhosttyOverlayDir(userDataDir));
  return normalize(absPath).startsWith(`${root}/`);
}

/** Result of an overlay write: the path written, or a typed error. */
export type OverlayWriteResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Applies `edits` to the overlay at `absPath`: guard → read → merge → atomic
 * replace. The guard runs BEFORE any filesystem call, so a rejected path is a
 * path nothing was ever attempted against.
 */
export function writeTerminalOverlay(
  deps: ThemeOverlayDeps,
  absPath: string,
  edits: OverlayEdits,
): OverlayWriteResult {
  if (!isVolliOverlayPath(deps.userDataDir, absPath)) {
    return {
      ok: false,
      error: `Refusing to write a terminal config outside Volli's overlay directory: ${absPath}`,
    };
  }
  try {
    const text = applyOverlayEdits(deps.readFile(absPath), edits);
    const tempPath = deps.tempName(absPath);
    deps.ensureDir(absPath.slice(0, absPath.lastIndexOf("/")));
    deps.writeFile(tempPath, text);
    deps.rename(tempPath, absPath);
    return { ok: true, path: absPath };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Applies `edits` to the global overlay — the layer above the user's real ghostty config. */
export function writeGlobalTerminalOverlay(
  deps: ThemeOverlayDeps,
  edits: OverlayEdits,
): OverlayWriteResult {
  return writeTerminalOverlay(deps, globalGhosttyOverlayPath(deps.userDataDir), edits);
}

/**
 * Applies `edits` to one project's overlay — the last layer (#69). An invalid
 * ticket prefix is rejected here rather than turned into a path: the path
 * builder throws, and this returns that as a typed error.
 */
export function writeProjectTerminalOverlay(
  deps: ThemeOverlayDeps,
  ticketPrefix: string,
  edits: OverlayEdits,
): OverlayWriteResult {
  let path: string;
  try {
    path = projectGhosttyOverlayPath(deps.userDataDir, ticketPrefix);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
  return writeTerminalOverlay(deps, path, edits);
}

/** Both Volli overlay texts for a resolution pass; `null` for an overlay that doesn't exist (the common case). */
export interface TerminalOverlayTexts {
  global: string | null;
  project: string | null;
}

/**
 * Reads the two Volli overlay layers. `ticketPrefix` null (no project in
 * scope) — or unusable — yields no project layer: this runs on the terminal
 * appearance hot path, where a bad prefix must degrade to "inherits" rather
 * than take the whole payload down.
 */
export function readTerminalOverlays(
  deps: ThemeOverlayDeps,
  ticketPrefix: string | null,
): TerminalOverlayTexts {
  const global = deps.readFile(globalGhosttyOverlayPath(deps.userDataDir));
  if (ticketPrefix === null) return { global, project: null };
  try {
    return {
      global,
      project: deps.readFile(projectGhosttyOverlayPath(deps.userDataDir, ticketPrefix)),
    };
  } catch {
    return { global, project: null };
  }
}
