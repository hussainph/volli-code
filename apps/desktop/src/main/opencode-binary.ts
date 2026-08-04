import { realpath } from "node:fs/promises";

import { resolveOnPath } from "./agent-tools";
import { loginShellPath } from "./login-path";

export interface OpenCodeBinaryResolverDeps {
  loginShellPath(): Promise<string | null>;
  resolveOnPath(pathValue: string, command: string): Promise<string | null>;
  realpath(path: string): Promise<string>;
}

const processDeps: OpenCodeBinaryResolverDeps = { loginShellPath, resolveOnPath, realpath };

/**
 * Resolves an OpenCode executable through the user's login shell, not
 * Electron's Finder/Dock environment. Call this only from the adapter's lazy
 * binary-resolution hook: asking a login shell is not a boot-time operation.
 */
export async function resolveOpenCodeBinary(
  command: string,
  deps: OpenCodeBinaryResolverDeps = processDeps,
): Promise<string> {
  const pathValue = await deps.loginShellPath();
  if (pathValue === null) {
    throw new Error("Could not read the login-shell PATH to find OpenCode");
  }
  const binaryPath = await deps.resolveOnPath(pathValue, command);
  if (binaryPath === null) {
    throw new Error(`OpenCode executable ${command} was not found on the login-shell PATH`);
  }
  // Hash and spawn the same canonical target. Keeping a PATH symlink here
  // would reintroduce a swap window between fingerprinting and launch.
  return deps.realpath(binaryPath);
}
