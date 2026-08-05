/**
 * The harness-generic half of binary resolution: any harness's user-supplied
 * override, validated the same way `opencode-binary.ts`'s
 * `resolveOpenCodeBinary` treats OpenCode's own launch path, but reported as
 * a typed result instead of a throw. OpenCode-specific resolution (naming
 * "OpenCode" in its errors, throwing rather than returning) stays where it
 * is — this file holds only what every harness override shares.
 */
import { errorMessage } from "@volli/shared";
import type { HarnessCommandFailureReason } from "@volli/shared";

import { locateBinary, processDeps } from "./opencode-binary";
import type { OpenCodeBinaryResolverDeps } from "./opencode-binary";

/** Outcome of {@link validateHarnessBinary}. */
export type HarnessBinaryValidation =
  | { ok: true; resolvedPath: string }
  | { ok: false; reason: HarnessCommandFailureReason; error: string };

/**
 * Validates an arbitrary harness binary override candidate — the same search
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
    if (located.reason === "not-executable") {
      return { ok: false, reason: "not-executable", error: `${command} is not an executable file` };
    }
    // A PATH main could not read at all says nothing about `command` itself —
    // the honest recovery is retry, not retype, so this stays distinct from a
    // genuine miss on a PATH that was read.
    return located.reason === "path-unreadable"
      ? {
          ok: false,
          reason: "path-unavailable",
          error: `Could not read the login-shell PATH to find ${command}`,
        }
      : {
          ok: false,
          reason: "not-found",
          error: `${command} was not found on the login-shell PATH`,
        };
  }
  try {
    return { ok: true, resolvedPath: await deps.realpath(located.path) };
  } catch (error) {
    return { ok: false, reason: "not-resolvable", error: errorMessage(error) };
  }
}
