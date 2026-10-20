/** Exactly one requesting WebContents, adapted to a host-owned stream (VC-556). */
import type { WebContents } from "electron";
import type { HostClientEventSink } from "@volli/host-core/ports";
import type { VolliIpcEvent } from "../ipc/contract";
import { onDocumentGone } from "./document-lifetime";

export function clientEventSink(contents: WebContents): HostClientEventSink {
  return {
    id: String(contents.id),
    isClosed: () => contents.isDestroyed(),
    onceClosed: (listener) => {
      contents.once("destroyed", listener);
    },
    removeCloseListener: (listener) => {
      contents.removeListener("destroyed", listener);
    },
    publish(topic, payload) {
      contents.send(`volli:${topic}` satisfies VolliIpcEvent, payload);
    },
  };
}

/**
 * Each WebContents' pending page-scoped close hooks: listener to the disposers
 * of its registrations, so {@link pageClientEventSink}'s `removeCloseListener`
 * finds a hook whichever sink for that WebContents registered it — the same
 * reach `removeListener` has on the plain sink.
 */
const pageCloseHooks = new WeakMap<WebContents, Map<() => void, Array<() => void>>>();

/**
 * The same stream, but closed for its subscriptions when the PAGE that opened
 * them goes away — a reload or a renderer crash as well as the window's
 * destruction (VC-831; the rule is `document-lifetime.ts`).
 *
 * For file, folder and worktree watches: a reloaded page re-watches what it
 * still shows, so a hold kept from the old page would leave its refcount one
 * too high and its `fs.watch` handle open while the window lives. `isClosed`
 * still means the window is gone; a page that has reloaded is a live client.
 *
 * Not for terminals: a reload must not end a person's shells (VC-425).
 */
export function pageClientEventSink(contents: WebContents): HostClientEventSink {
  const hooksOf = (): Map<() => void, Array<() => void>> => {
    let hooks = pageCloseHooks.get(contents);
    if (hooks === undefined) {
      hooks = new Map();
      pageCloseHooks.set(contents, hooks);
    }
    return hooks;
  };
  const forget = (listener: () => void, dispose: () => void): void => {
    const hooks = hooksOf();
    const disposers = hooks.get(listener);
    if (disposers === undefined) return;
    const index = disposers.indexOf(dispose);
    if (index !== -1) disposers.splice(index, 1);
    if (disposers.length === 0) hooks.delete(listener);
  };
  return {
    ...clientEventSink(contents),
    onceClosed: (listener) => {
      const dispose = onDocumentGone(contents, () => {
        forget(listener, dispose);
        listener();
      });
      const hooks = hooksOf();
      hooks.set(listener, [...(hooks.get(listener) ?? []), dispose]);
    },
    removeCloseListener: (listener) => {
      const dispose = hooksOf().get(listener)?.[0];
      if (dispose === undefined) return;
      forget(listener, dispose);
      dispose();
    },
  };
}
