/**
 * When the page a window's renderer is showing has gone, rather than the
 * window itself (VC-831).
 *
 * A reload — View → Reload, Force Reload, or the only recovery from a crashed
 * renderer — keeps the same `WebContents`. Anything main holds on behalf of the
 * page and releases only on `destroyed` therefore outlives the page that asked
 * for it: a sign-in parked on a question nobody can see keeps its provider's one
 * attempt slot and its loopback port, and a watch the new page never re-opens
 * keeps its `fs.watch` handle for as long as the window lives.
 *
 * The page is gone when any of three things happens:
 *
 * - `did-navigate`: a main-frame navigation committed. Not `did-start-navigation`:
 *   that fires before main's `will-navigate` can refuse the navigation, and a
 *   refused navigation leaves the running page in place — releasing its
 *   resources then would strand a live page instead. Electron does not emit
 *   `did-navigate` for in-page navigations, so a hash change or a history push
 *   releases nothing. It arrives at commit, before the new document's scripts
 *   run, so it cannot sweep anything the fresh page has asked for.
 * - `render-process-gone`: a crashed renderer commits nothing, so nothing else
 *   would ever say the page is gone.
 * - `destroyed`: the window itself went away.
 *
 * `browser/plane-reset.ts` reads the same two page events for the same reason.
 *
 * Only owners whose resources belong to the page use this. Terminals do not:
 * a reload must not end a person's shells (VC-425).
 */

/** The `webContents` events this reads, as Electron declares them. */
export interface DocumentLifetimeEvents {
  on(event: "did-navigate" | "render-process-gone", listener: () => void): unknown;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(
    event: "did-navigate" | "render-process-gone" | "destroyed",
    listener: () => void,
  ): unknown;
}

/**
 * Calls `listener` once, the first time the current page goes away, and
 * returns the call that stops listening. Both detach all three hooks, so a
 * listener never outlives the page it was registered for.
 */
export function onDocumentGone(contents: DocumentLifetimeEvents, listener: () => void): () => void {
  let done = false;
  const dispose = (): void => {
    if (done) return;
    done = true;
    contents.removeListener("did-navigate", gone);
    contents.removeListener("render-process-gone", gone);
    contents.removeListener("destroyed", gone);
  };
  const gone = (): void => {
    if (done) return;
    dispose();
    listener();
  };
  contents.on("did-navigate", gone);
  contents.on("render-process-gone", gone);
  contents.once("destroyed", gone);
  return dispose;
}
