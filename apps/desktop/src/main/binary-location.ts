/**
 * Where a harness's executable actually is, asked the way a shell would ask.
 *
 * Electron launched from Finder or the Dock inherits neither the user's PATH
 * nor their toolchain, so "is this command runnable" cannot be answered against
 * this process's environment — every answer here goes through the login shell's
 * PATH instead. The search has one shape and two reports: {@link locateBinary}
 * finds the candidate, and the caller turns the outcome into whatever its
 * surface needs (`validateHarnessBinary` in `harness-binary.ts` returns a typed
 * refusal a settings row can draw).
 */
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { resolveOnPath } from "./agent-tools";
import { loginShellPath } from "./login-path";

export interface BinaryResolverDeps {
  loginShellPath(): Promise<string | null>;
  resolveOnPath(pathValue: string, command: string): Promise<string | null>;
  isExecutable(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
}

/**
 * Whether `path` names a FILE this process can execute — both halves, because
 * `access(X_OK)` alone answers yes for a directory.
 *
 * A directory's +x bit means "searchable", not "runnable", so the probe on its
 * own passes `/usr/bin` and `/opt/homebrew/bin`. That answer travels: {@link
 * verifiedPath} reports the directory located, `validateHarnessBinary`
 * canonicalizes it, and the Settings Binary row draws the canonical path as a
 * successful save — with the "Not an executable file" refusal this surface
 * exists to show never reached. The user then finds out at attach time, as a
 * spawn EACCES/EISDIR raised nowhere near the setting that caused it.
 *
 * `stat` and not `lstat`: it follows symlinks on purpose. A binary reached
 * through a link is still a binary — every Homebrew install is one — and the
 * question here is what would run, not what the last path component happens to
 * be. A throw (nothing there, an unreadable parent) folds into the same `false`
 * an X_OK refusal gives, because there is nothing useful to tell apart: {@link
 * verifiedPath} reports every one of them as `not-executable`, and the recovery
 * — name a file that can actually be run — is the same either way.
 */
export async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The default, non-test dependencies — the real filesystem and the user's login shell. */
export const processDeps: BinaryResolverDeps = {
  loginShellPath,
  resolveOnPath,
  isExecutable,
  realpath,
};

/** A path the caller already named, as opposed to a name PATH has to answer. */
function isPath(command: string): boolean {
  return isAbsolute(command) || command.includes("/");
}

/**
 * One candidate located on disk, or why the search for one refused to produce
 * one — the shared outcome of both search strategies below, so a caller can
 * report it however its own surface needs to without either strategy knowing
 * which.
 */
export type BinaryLocation =
  | { ok: true; path: string }
  | { ok: false; reason: "not-executable" }
  | { ok: false; reason: "path-unreadable" | "not-on-path" };

/** The isPath branch: `command` is taken at its word and must already be executable. */
export async function verifiedPath(
  command: string,
  deps: BinaryResolverDeps,
): Promise<BinaryLocation> {
  return (await deps.isExecutable(command))
    ? { ok: true, path: command }
    : { ok: false, reason: "not-executable" };
}

/** The bare-name branch: `command` is walked down the login-shell PATH. */
async function resolvedOnLoginShellPath(
  command: string,
  deps: BinaryResolverDeps,
): Promise<BinaryLocation> {
  const pathValue = await deps.loginShellPath();
  if (pathValue === null) return { ok: false, reason: "path-unreadable" };
  const binaryPath = await deps.resolveOnPath(pathValue, command);
  return binaryPath === null
    ? { ok: false, reason: "not-on-path" }
    : { ok: true, path: binaryPath };
}

/**
 * The one search a candidate binary goes through, however it will be reported.
 *
 * `command` is what `spawn` itself accepts — a bare name a shell would look up,
 * or a path to the executable. A path is taken at its word and never walked:
 * PATH lookup joins the name onto each entry, so `/opt/custom/codex` would
 * resolve to `/usr/bin/opt/custom/codex` — a file nobody named, missing, and
 * reported as "not found on PATH" for a binary sitting exactly where the user
 * said it was.
 */
export async function locateBinary(
  command: string,
  deps: BinaryResolverDeps,
): Promise<BinaryLocation> {
  return isPath(command) ? verifiedPath(command, deps) : resolvedOnLoginShellPath(command, deps);
}
