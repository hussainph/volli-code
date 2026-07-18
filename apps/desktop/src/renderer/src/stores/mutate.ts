/**
 * Shared write-through for store mutations. Every async store action followed
 * the same shape — call the preload gateway, `catch` a rejected IPC, check the
 * typed `{ ok: false }`, and `toast.error` the failure (CLAUDE.md: never
 * silently swallow a failed mutation) — copy-pasted across board.ts and
 * projects.ts. `writeThrough` is that shape, once.
 *
 * Beyond removing the duplication, it enforces the fix behind PR #20's store
 * races: it returns the settled result only AFTER the await, so callers must
 * reconcile against FRESH store state (a re-read `get()`) rather than a
 * snapshot captured before the await — which a concurrent mutation landing
 * mid-flight would have invalidated (a dropped project, a resurrected slice).
 */
import { errorMessage } from "@volli/shared";

import { toastError } from "@renderer/lib/toast";

type Ok = { ok: true };
type Err = { ok: false; error: string };

/**
 * Runs `call`; on a thrown/rejected IPC or a typed `{ ok: false }`, toasts
 * `Could not ${verb}: <reason>` and resolves `null`. On success, resolves the
 * ok-variant of the result (narrowed, so `.project`/`.ticket`/… are typed).
 */
export async function writeThrough<R extends Ok | Err>(
  verb: string,
  call: () => Promise<R>,
): Promise<Extract<R, Ok> | null> {
  let result: R;
  try {
    result = await call();
  } catch (error) {
    toastError(`Could not ${verb}: ${errorMessage(error)}`);
    return null;
  }
  if (!result.ok) {
    toastError(`Could not ${verb}: ${result.error}`);
    return null;
  }
  return result as Extract<R, Ok>;
}
