/**
 * A user-supplied harness binary override, answered as a typed result.
 *
 * The search itself lives in `binary-location.ts` and is shared; what this file
 * adds is the report a Settings row can draw — which refusal, and in words that
 * name the command the user typed rather than throwing at them.
 */
import { errorMessage } from "@volli/shared";
import type { HarnessCommandFailureReason } from "@volli/shared";

import { locateBinary, processDeps } from "./binary-location";
import type { BinaryResolverDeps } from "./binary-location";

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
  deps: BinaryResolverDeps = processDeps,
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
