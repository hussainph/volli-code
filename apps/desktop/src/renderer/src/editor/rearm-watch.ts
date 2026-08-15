import { errorMessage } from "@volli/shared";
import type { Result } from "../../../ipc/contract";

interface WatchApi<Input> {
  watch(input: Input): Promise<Result>;
  unwatch(input: Input): Promise<Result>;
}

/**
 * Re-arms a watch main has just torn down (an event flagged `final`, issue
 * #134). The stale hold goes back first so main's refCount stays balanced —
 * releasing a subscription that is already gone is a documented no-op, and the
 * failure is never separately actionable, so only the re-arm speaks. A rejected
 * IPC call comes back as a typed failure rather than an unhandled rejection: a
 * caller that cannot re-arm has to be able to say so.
 */
export async function rearmWatch<Input>(api: WatchApi<Input>, input: Input): Promise<Result> {
  await api.unwatch(input).catch(() => undefined);
  try {
    return await api.watch(input);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
