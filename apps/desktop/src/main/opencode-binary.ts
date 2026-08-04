import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { errorMessage } from "@volli/shared";
import type { HarnessCommandFailureReason } from "@volli/shared";

import { resolveOnPath } from "./agent-tools";
import { loginShellPath } from "./login-path";

export interface OpenCodeBinaryResolverDeps {
  loginShellPath(): Promise<string | null>;
  resolveOnPath(pathValue: string, command: string): Promise<string | null>;
  isExecutable(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
}

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const processDeps: OpenCodeBinaryResolverDeps = {
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
 * One candidate located on disk, or why the search for one refused to
 * produce one — the shared outcome of both search strategies below, so a
 * caller can turn it into a thrown `Error` (`resolveOpenCodeBinary`) or a
 * typed result ({@link validateHarnessBinary}) without either strategy
 * needing to know which.
 */
type BinaryLocation =
  | { ok: true; path: string }
  | { ok: false; reason: "not-executable" }
  | { ok: false; reason: "path-unreadable" | "not-on-path" };

/** The isPath branch: `command` is taken at its word and must already be executable. */
export async function verifiedPath(
  command: string,
  deps: OpenCodeBinaryResolverDeps,
): Promise<BinaryLocation> {
  return (await deps.isExecutable(command))
    ? { ok: true, path: command }
    : { ok: false, reason: "not-executable" };
}

/** The bare-name branch: `command` is walked down the login-shell PATH. */
async function resolvedOnLoginShellPath(
  command: string,
  deps: OpenCodeBinaryResolverDeps,
): Promise<BinaryLocation> {
  const pathValue = await deps.loginShellPath();
  if (pathValue === null) return { ok: false, reason: "path-unreadable" };
  const binaryPath = await deps.resolveOnPath(pathValue, command);
  return binaryPath === null
    ? { ok: false, reason: "not-on-path" }
    : { ok: true, path: binaryPath };
}

/** The one search a candidate binary goes through, however it will be reported. */
async function locateBinary(
  command: string,
  deps: OpenCodeBinaryResolverDeps,
): Promise<BinaryLocation> {
  return isPath(command) ? verifiedPath(command, deps) : resolvedOnLoginShellPath(command, deps);
}

/**
 * Resolves an OpenCode executable through the user's login shell, not
 * Electron's Finder/Dock environment. Call this only from the adapter's lazy
 * binary-resolution hook: asking a login shell is not a boot-time operation.
 *
 * `command` is what `spawn` itself accepts — a bare name a shell would look up,
 * or a path to the executable. A path is taken at its word and never walked:
 * PATH lookup joins the name onto each entry, so `/opt/custom/opencode` would
 * resolve to `/usr/bin/opt/custom/opencode` — a file nobody named, missing, and
 * reported as "not found on PATH" for a binary that is sitting exactly where the
 * user said it was.
 */
export async function resolveOpenCodeBinary(
  command: string,
  deps: OpenCodeBinaryResolverDeps = processDeps,
): Promise<string> {
  const located = await locateBinary(command, deps);
  if (!located.ok) {
    throw new Error(
      located.reason === "not-executable"
        ? `OpenCode executable ${command} is not an executable file`
        : located.reason === "path-unreadable"
          ? "Could not read the login-shell PATH to find OpenCode"
          : `OpenCode executable ${command} was not found on the login-shell PATH`,
    );
  }
  // Hash and spawn the same canonical target, whichever route named it. Keeping
  // a symlink here would reintroduce a swap window between fingerprinting and
  // launch.
  return deps.realpath(located.path);
}

/** Outcome of {@link validateHarnessBinary}. */
export type HarnessBinaryValidation =
  | { ok: true; resolvedPath: string }
  | { ok: false; reason: HarnessCommandFailureReason; error: string };

/**
 * Validates an arbitrary harness binary override candidate the same way
 * {@link resolveOpenCodeBinary} treats OpenCode's — the same search
 * ({@link locateBinary}), reused rather than re-walked, reported as a typed
 * result instead of a throw so a settings write can surface exactly why a
 * candidate was refused. The winning candidate is canonicalized with
 * `realpath` before being accepted, same as the launch path: a symlink swap
 * between validation and use must not slip through here either.
 */
export async function validateHarnessBinary(
  command: string,
  deps: OpenCodeBinaryResolverDeps = processDeps,
): Promise<HarnessBinaryValidation> {
  const located = await locateBinary(command, deps);
  if (!located.ok) {
    return located.reason === "not-executable"
      ? { ok: false, reason: "not-executable", error: `${command} is not an executable file` }
      : {
          ok: false,
          reason: "not-found",
          error:
            located.reason === "path-unreadable"
              ? `Could not read the login-shell PATH to find ${command}`
              : `${command} was not found on the login-shell PATH`,
        };
  }
  try {
    return { ok: true, resolvedPath: await deps.realpath(located.path) };
  } catch (error) {
    return { ok: false, reason: "not-resolvable", error: errorMessage(error) };
  }
}
