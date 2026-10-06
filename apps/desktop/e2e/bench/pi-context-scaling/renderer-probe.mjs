/**
 * VC-445 probes that run in the app's own renderer, through `page.evaluate`.
 *
 * Like `main-probe.mjs`, every export is serialized, so each is
 * self-contained and reaches the app only through the preload bridge
 * (`window.api`) — the same door every real renderer request uses.
 *
 * Two closed-loop samplers run concurrently with main's loop-delay window:
 *
 * - **echo**: `window.api.window.isFullScreen()`, a preload `invoke` whose main
 *   handler does no I/O. Its round trip is what any renderer→main request waits
 *   on a busy loop — the VC-355 finding this ticket builds on.
 * - **rpc**: a `modelAccess.defaults` query through the Session RPC transport
 *   (`window.api.sessionRpc.request`, the pattern of
 *   `bench/performance/session-rpc-round-trip.mjs`), which adds the tRPC edge
 *   and one small `app_state` read.
 *
 * The echo loop pauses 5 ms between samples by default and the RPC loop 25 ms,
 * so the probes cost main well under a millisecond of work per 10 ms while
 * still landing samples inside a hydration window that lasts tens of ms.
 *
 * Each sample is `[startEpochMs, latencyMs, ok]`. Epoch time comes from
 * `performance.timeOrigin + performance.now()` so it can be lined up against
 * main's tick gaps in 100 ms bins.
 */

/* oxlint-disable unicorn/consistent-function-scoping -- every export is serialized into the renderer by Playwright, so its helpers must live inside it. */

export function startRendererSampler({ echoPauseMs, rpcPauseMs }) {
  if (window.VOLLI_VC445_SAMPLER !== undefined) throw new Error("sampler already running");
  const state = { running: true, echo: [], rpc: [], done: null };
  const epoch = () => performance.timeOrigin + performance.now();
  const round = (value) => Math.round(value * 1000) / 1000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const loop = async (series, pauseMs, call) => {
    while (state.running) {
      const at = epoch();
      const started = performance.now();
      let ok = 1;
      try {
        await call();
      } catch {
        ok = 0;
      }
      series.push([Math.round(at * 100) / 100, round(performance.now() - started), ok]);
      await sleep(pauseMs);
    }
  };
  state.done = Promise.all([
    loop(state.echo, echoPauseMs, () => window.api.window.isFullScreen()),
    loop(state.rpc, rpcPauseMs, async () => {
      const response = await window.api.sessionRpc.request({
        path: "modelAccess.defaults",
        type: "query",
        input: undefined,
      });
      if (response?.ok !== true) throw new Error("modelAccess.defaults failed");
    }),
  ]);
  window.VOLLI_VC445_SAMPLER = state;
  return true;
}

export async function stopRendererSampler() {
  const state = window.VOLLI_VC445_SAMPLER;
  if (state === undefined) throw new Error("sampler is not running");
  state.running = false;
  await state.done;
  window.VOLLI_VC445_SAMPLER = undefined;
  return { echo: state.echo, rpc: state.rpc };
}

/** A burst of echoes, discarded: warms the IPC path before anything is measured. */
export async function warmIpc({ count }) {
  for (let index = 0; index < count; index += 1) {
    await window.api.window.isFullScreen();
    await window.api.sessionRpc.request({
      path: "modelAccess.defaults",
      type: "query",
      input: undefined,
    });
  }
  return count;
}

/**
 * Bind each Session's Pi runtime in main, one at a time, over the product path.
 *
 * `model.select` re-selecting the Session's own model is a real command a
 * person can issue from the composer, it reaches the runtime without a turn or
 * a provider request, and — like the next message after a relaunch — it makes
 * the Session runtime rehydrate the attachment's binding from its Pi sidecar
 * first (`#bindingForCommand` in session-runtime.ts). The selection being
 * accepted or refused afterwards does not change that the binding now exists;
 * the bench proves binding separately, from the listing's live flag.
 */
export async function hydrateSessions({ sessionIds, selection }) {
  const results = [];
  for (const sessionId of sessionIds) {
    const startedEpochMs = performance.timeOrigin + performance.now();
    const started = performance.now();
    const response = await window.api.sessionRpc.request({
      path: "session.command",
      type: "mutation",
      input: {
        commandId: crypto.randomUUID(),
        sessionId,
        command: { kind: "model.select", selection },
      },
    });
    results.push({
      sessionId,
      startedEpochMs,
      ms: Math.round((performance.now() - started) * 1000) / 1000,
      ok: response?.ok === true,
      receipt: response?.ok === true ? (response.data?.receipt?.status ?? null) : null,
      error:
        response?.ok === true ? null : JSON.stringify(response?.error ?? response).slice(0, 400),
    });
  }
  return results;
}

/**
 * The binding census, from two sources that must NOT be confused.
 *
 * `durableOpen` counts Sessions whose projection names an open structured
 * attachment (`projection.liveExecutor`, which despite its name is folded from
 * the ledger) — what VC-403's reader and the VC-366 profile counts saw, and NOT
 * evidence of a loaded runtime. `live` is the listing row's `live` flag, which
 * main computes from `SessionRuntime.openNativeBindings()` (`data-ipc.ts` →
 * `listing-row.ts` → `chat-attachment.ts`): the in-memory binding map of this
 * process. Only the second proves a Pi context is loaded in main.
 */
export async function bindingCensus({ projectId }) {
  const listed = await window.api.sessions.list({ projectId });
  if (!listed.ok) throw new Error(`sessions.list failed: ${listed.error}`);
  const chats = listed.sessions.filter((row) => row.kind === "chat");
  const liveIds = chats
    .filter((row) => row.record.live === true)
    .map((row) => row.record.sessionId);
  let durableOpen = 0;
  for (const row of chats) {
    const projected = await window.api.sessionRpc.request({
      path: "session.projection",
      type: "query",
      input: { sessionId: row.record.sessionId },
    });
    if (!projected.ok) throw new Error(`session.projection failed for ${row.record.sessionId}`);
    if (projected.data.projection.liveExecutor != null) durableOpen += 1;
  }
  return { sessions: chats.length, durableOpen, live: liveIds.length, liveIds };
}
