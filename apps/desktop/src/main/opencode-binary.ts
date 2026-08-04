import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { resolveOnPath } from "./agent-tools";
import { loginShellPath } from "./login-path";

export interface OpenCodeBinaryResolverDeps {
  loginShellPath(): Promise<string | null>;
  resolveOnPath(pathValue: string, command: string): Promise<string | null>;
  isExecutable(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
}

async function isExecutable(path: string): Promise<boolean> {
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
  const binaryPath = isPath(command)
    ? await verifiedPath(command, deps)
    : await resolvedOnLoginShellPath(command, deps);
  // Hash and spawn the same canonical target, whichever route named it. Keeping
  // a symlink here would reintroduce a swap window between fingerprinting and
  // launch.
  return deps.realpath(binaryPath);
}

async function verifiedPath(command: string, deps: OpenCodeBinaryResolverDeps): Promise<string> {
  if (!(await deps.isExecutable(command))) {
    throw new Error(`OpenCode executable ${command} is not an executable file`);
  }
  return command;
}

async function resolvedOnLoginShellPath(
  command: string,
  deps: OpenCodeBinaryResolverDeps,
): Promise<string> {
  const pathValue = await deps.loginShellPath();
  if (pathValue === null) {
    throw new Error("Could not read the login-shell PATH to find OpenCode");
  }
  const binaryPath = await deps.resolveOnPath(pathValue, command);
  if (binaryPath === null) {
    throw new Error(`OpenCode executable ${command} was not found on the login-shell PATH`);
  }
  return binaryPath;
}
