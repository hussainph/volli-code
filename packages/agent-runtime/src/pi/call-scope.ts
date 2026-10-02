/**
 * The scope a Code Mode program lends each call it makes (VC-471), carried to
 * the tool through async context rather than through Pi's `execute` signature,
 * which has no room for it.
 *
 * Only a program sets one. A call the model made directly runs with none, and
 * every port then behaves exactly as it did before Code Mode existed.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeCallScope } from "@volli/shared";

const current = new AsyncLocalStorage<RuntimeCallScope>();

/** Run `work` with `scope` as the scope of every call made inside it. */
export function withCallScope<T>(scope: RuntimeCallScope, work: () => Promise<T>): Promise<T> {
  return current.run(scope, work);
}

/** The scope of the call running now, if a program made it. */
export function currentCallScope(): RuntimeCallScope | undefined {
  return current.getStore();
}
