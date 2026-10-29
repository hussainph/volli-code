/** A local launch registers only when a move needs it; no cloud job runner is connected. */
import type { MacRunner } from "../cloud-runner";
import type { AccountService } from "../account/service";

const noop = () => {};

export function moveIdentity(options: {
  account: Pick<AccountService, "snapshot">;
  runner(userId: string): Promise<MacRunner | null>;
  registrationOnly: boolean;
}) {
  let runner: MacRunner | null = null;
  let runnerOwner: string | null = null;
  let stopping = Promise.resolve();
  let epoch = 0;
  let lifetimeOwner = new AbortController();
  const release = (): Promise<void> => {
    epoch += 1;
    const closing = runner;
    runner = null;
    runnerOwner = null;
    lifetimeOwner.abort();
    lifetimeOwner = new AbortController();
    const closed =
      options.registrationOnly && closing !== null ? closing.stop() : Promise.resolve();
    stopping = Promise.all([stopping, closed]).then(() => undefined);
    return stopping;
  };
  return {
    async current(signal?: AbortSignal): Promise<{ userId: string; runnerId: string } | null> {
      const before = options.account.snapshot();
      const userId = before.state === "signed-in" ? before.account?.userId : null;
      if (userId == null) return null;
      await stopping;
      signal?.throwIfAborted();
      if (runner !== null && runnerOwner !== userId) await release();
      const mine = epoch;
      const ownerSignal = lifetimeOwner.signal;
      if (runner === null) {
        const created = await options.runner(userId);
        // An idle release or shutdown can win while the lazy factory imports.
        // Never start its stale runner, nor reuse a MacRunner after stop (terminal).
        if (mine !== epoch) {
          if (options.registrationOnly) await created?.stop();
          return null;
        }
        runner = created;
        runnerOwner = userId;
      }
      const live = runner;
      if (live === null) return null;
      live.start();
      const lifetime = AbortSignal.any([
        ownerSignal,
        AbortSignal.timeout(20_000),
        ...(signal === undefined ? [] : [signal]),
      ]);
      let off = noop;
      let aborted = noop;
      try {
        const runnerId = await new Promise<string | null>((resolve) => {
          aborted = () => resolve(null);
          lifetime.addEventListener("abort", aborted, { once: true });
          off = live.subscribe((snapshot) => {
            if (
              snapshot.runnerId !== null &&
              snapshot.state !== "removed" &&
              snapshot.state !== "failed"
            )
              resolve(snapshot.runnerId);
            else if (snapshot.state === "removed" || snapshot.state === "failed") resolve(null);
          });
          if (lifetime.aborted) resolve(null);
        });
        signal?.throwIfAborted();
        const after = options.account.snapshot();
        return runnerId !== null &&
          mine === epoch &&
          after.state === "signed-in" &&
          after.account?.userId === userId
          ? { userId, runnerId }
          : null;
      } finally {
        off();
        lifetime.removeEventListener("abort", aborted);
      }
    },
    release,
  };
}
