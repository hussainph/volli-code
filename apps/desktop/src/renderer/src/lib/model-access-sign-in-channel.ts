/**
 * One listener over every live sign-in, demultiplexed by attempt id.
 *
 * The same shape — and for the same reason — as the Session RPC link's frame
 * router: **main mints the attempt id, and the first message routinely beats
 * the id back to the renderer.** An api-key login proves it every time. The
 * `invoke` handler calls `Models.login`, the provider's flow asks for the key
 * in that same synchronous stretch, and the prompt is queued to this process
 * before the handler has returned the id it would be filed under. A listener
 * registered per attempt, after the await, could not exist early enough to
 * catch it.
 *
 * So updates for an unclaimed id are held rather than dropped, and replayed in
 * arrival order the moment a caller claims it. The buffer needs no eviction of
 * its own: main mints an attempt id only once it has accepted the request, so a
 * refused `beginSignIn` — an unknown provider, an unoffered method, a provider
 * already signing in — never starts a flow and never publishes anything under
 * an id. What can accumulate here is therefore only the pre-claim updates of
 * attempts this window actually began, each entry cleared by the claim that
 * follows it a microtask later.
 */

import type { ModelAccessSignInUpdate } from "@volli/shared";

type UpdateListener = (update: ModelAccessSignInUpdate) => void;

const listeners = new Map<string, UpdateListener>();
const unclaimed = new Map<string, ModelAccessSignInUpdate[]>();
let detach: (() => void) | null = null;

/**
 * Starts routing, once per renderer.
 *
 * Called before the `invoke` that mints an id rather than after it resolves,
 * which is the whole point: by the time the id is known, its first message may
 * already have arrived.
 */
export function listenForSignInUpdates(): void {
  if (detach !== null) return;
  detach = window.api.modelAccess.onSignInUpdate((update) => {
    const listener = listeners.get(update.attemptId);
    if (listener !== undefined) {
      listener(update);
      return;
    }
    const held = unclaimed.get(update.attemptId);
    if (held === undefined) unclaimed.set(update.attemptId, [update]);
    else held.push(update);
  });
  // Vite replaces this module on edit; the old closure would otherwise keep a
  // listener on the bridge and every update would be delivered twice.
  import.meta.hot?.dispose(() => {
    detach?.();
    detach = null;
    listeners.clear();
    unclaimed.clear();
  });
}

/**
 * Routes one attempt's updates, replaying whatever arrived before the claim.
 *
 * The replay is synchronous and in arrival order, so a caller that claims an id
 * whose flow already prompted, withdrew and settled sees those three in the
 * order they happened rather than only the last one.
 */
export function claimSignInUpdates(attemptId: string, listener: UpdateListener): () => void {
  listeners.set(attemptId, listener);
  const held = unclaimed.get(attemptId);
  unclaimed.delete(attemptId);
  for (const update of held ?? []) listener(update);
  return () => {
    if (listeners.get(attemptId) === listener) listeners.delete(attemptId);
  };
}
