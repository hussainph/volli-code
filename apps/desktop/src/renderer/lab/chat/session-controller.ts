import * as React from "react";
import { type SessionStreamOverlay } from "@volli/session-engine";
import type {
  RuntimeCatalogChoices,
  RuntimeSelection,
  SessionAttentionProjection,
  SessionInteraction,
  SessionInteractionResolution,
  SessionProjection,
} from "@volli/shared";
import type { RpcDiagnosticEntry } from "@volli/session-rpc";
import type { UIMessage } from "ai";

import { resolveRuntimeSelection } from "@renderer/chat/session-model";
import {
  appendFrames,
  EMPTY_TRANSCRIPT,
  movesProjection,
  type ChatSessionFrame,
  type ChatTranscriptState,
} from "@renderer/chat/transcript";
import {
  chatSessionFrame,
  chatSessionOverlay,
  rejectedReceipt,
  startFailure,
} from "@renderer/chat/wire";
import { useRuntimeCatalogClient } from "@renderer/lib/runtime-catalog-client";
import { useUiStore } from "@renderer/stores/ui";

import { LAB_SCENARIO_ADAPTER_ID } from "../../../lab-scenarios";
import { LAB_SESSION_PROJECT_ID, LAB_SESSION_TICKET_ID } from "../../../lab-session-rpc-path";
import { createSessionRpcClient, type SessionRpcClient } from "../session-rpc-client";

const DIAGNOSTIC_LIMIT = 100;
const EMPTY_SELECTION: RuntimeSelection = {
  providerId: "",
  modelId: "",
  variant: "",
  agent: "",
};
const EMPTY_CATALOG: RuntimeCatalogChoices = { providers: [], models: [], agents: [] };
/** A Session with no projection yet is not a Session with something to recover from. */
const EMPTY_ATTENTION: SessionAttentionProjection = { active: [], primary: null };

export type SessionLifecycle = "idle" | "starting" | "ready" | "working" | "error";
export type MessageDelivery = "queue" | "steer" | "replace";

/**
 * Whether the runtime catalog has answered yet.
 *
 * `loading` and `empty` are different facts and were being conflated: the
 * catalog starts as `EMPTY_CATALOG` and resolves over IPC, so a surface reading
 * `models.length === 0` as "nothing is configured" tells the user to go choose
 * models for as long as that round trip takes — and then contradicts itself.
 * Only `empty` is a blocked state, and only it earns a recovery action.
 */
export type CatalogState = "loading" | "ready" | "empty" | "error";

export interface LabSessionController {
  sessionId: string;
  projection: SessionProjection | null;
  frames: readonly ChatSessionFrame[];
  messages: readonly UIMessage[];
  diagnostics: readonly RpcDiagnosticEntry[];
  lifecycle: SessionLifecycle;
  /**
   * The one thing about a Session's plumbing a person needs told.
   *
   * There is no `status` beside it any more. Attachment ids, receipt codes and
   * "OpenCode is working" were state the surface computed and nothing displayed,
   * because a chat has no honest home for them — the tab's dot already says
   * live, and someone opening a Session wants to type, not to be briefed on a
   * transport. A failure is the exception: it stops the typing, so it gets said.
   */
  error: string | null;
  /**
   * The debug pane's own transport, kept off `error`.
   *
   * Diagnostics ride the same tRPC edge the Session does, so a failure here is
   * worth saying — but it stops nothing, and while it sat on `error` it
   * outranked `attention.primary` and could hide an `auth_required` card behind
   * a debug-pane hiccup. Its own field, read last, is what surfaces it without
   * letting it mask a state the user has to recover from.
   */
  diagnosticsError: string | null;
  selection: RuntimeSelection;
  setSelection(next: RuntimeSelection): void;
  catalog: RuntimeCatalogChoices;
  catalogState: CatalogState;
  /**
   * Why the model list could not be refreshed, kept off `error` for the reason
   * `diagnosticsError` is.
   *
   * A catalog that failed to answer is a fact about what a person can pick, not
   * about the Session's transport — and while it shared `error` with the
   * Session's own failures the two overwrote each other in whichever order they
   * happened to arrive, so a lost stream could be replaced by a stale model list
   * and the Retry beside it pointed at the wrong thing. The last known catalog
   * stays on screen either way.
   */
  catalogError: string | null;
  /** Open interactions, so a gated transcript row can find the one it belongs to. */
  interactions: readonly SessionInteraction[];
  /**
   * Every interaction this Session has opened, so a resolution message in
   * scrollback can name what it answered. Folded across the stream rather than
   * re-read from it — see {@link appendFrames}.
   */
  openedInteractions: ReadonlyMap<string, SessionInteraction>;
  /**
   * Structured attention, so a blocked composer can name what stopped it.
   *
   * `error` above is this surface's own transport failing. This is the harness
   * stating a state the user has to recover from — an expired token, a rate
   * limit, an overflowed context — and the two are different facts with
   * different answers, so they arrive on different fields.
   */
  attention: SessionAttentionProjection;
  liveAttachmentId: string | null;
  // Every command answers the same question: did it land? A caller that sends a
  // second act on the back of the first — a redirection after the refusal it
  // belongs to — cannot read that off `error`, which is state and not a result.
  // So each of these resolves `false` for a command that failed *and* for one
  // that was never sent, and the surface decides what to do with the words it
  // was still holding.
  start(): Promise<boolean>;
  submit(text: string, delivery: MessageDelivery): Promise<boolean>;
  resolveInteraction(
    interactionId: string,
    resolution: SessionInteractionResolution,
  ): Promise<boolean>;
  /** Withdraws a decision nobody is going to make, so the card stops blocking. */
  cancelInteraction(interactionId: string): Promise<boolean>;
  interrupt(): Promise<boolean>;
  refreshCapabilities(): Promise<boolean>;
  reconcile(): Promise<boolean>;
  release(): Promise<boolean>;
  /** The single action an error row offers; which one it is depends on what broke. */
  recover(): Promise<boolean>;
}

/** The observable result of creating one durable Session and attaching its first executor. */
export interface LabSessionStartResult {
  sessionId: string;
  lifecycle: "ready" | "error";
  error: string | null;
}

/**
 * Starts a Lab Session through the same RPC boundary the controller uses.
 *
 * The Session is durable the moment `session.create` resolves, and the attach
 * that follows can fail two different ways: a refusal, which is a completed
 * round-trip carrying a rejected receipt, and a transport failure, which is an
 * exception. Neither un-creates the Session, so both leave here as the same
 * result and both carry the id — a thrown attach used to take it with it, which
 * left a Session in the ledger that no surface could name. Only the `create`
 * itself throws out of this function: there is no id yet to lose.
 */
export async function startLabSession(
  rpc: Pick<SessionRpcClient, "session">,
  scenarioId: string | null,
): Promise<LabSessionStartResult> {
  const created = await rpc.session.command.mutate({
    commandId: nextId(),
    command: {
      kind: "session.create",
      projectId: LAB_SESSION_PROJECT_ID,
      ticketId: LAB_SESSION_TICKET_ID,
      title: "LAB-14 · OpenCode chat prototype",
    },
  });
  return attachLabExecutor(rpc, created.sessionId, scenarioId);
}

/**
 * One attachment attempt on a durable Session that already exists.
 *
 * Split out of {@link startLabSession} because a failed attach does not
 * un-create the Session, so trying again must not create one either: the retry
 * addresses the id it was given and records another attempt on that Session's
 * own history. The engine referees the case this surface cannot see — a
 * Session that already has a live executor answers with a refusal, never a
 * second binding.
 */
export async function attachLabExecutor(
  rpc: Pick<SessionRpcClient, "session">,
  sessionId: string,
  scenarioId: string | null,
): Promise<LabSessionStartResult> {
  try {
    const attached = await rpc.session.command.mutate({
      commandId: nextId(),
      sessionId,
      command: {
        kind: "adapter.attach",
        adapterId: scenarioId ? LAB_SCENARIO_ADAPTER_ID : "opencode",
        // A scenario is a harness profile of the scripted adapter, so the
        // pick rides the attach the runtime already validates.
        profileId: scenarioId ?? "native",
        continuity: "fresh",
      },
    });
    const refusal = rejectedReceipt(attached);
    return refusal === null
      ? { sessionId, lifecycle: "ready", error: null }
      : { sessionId, lifecycle: "error", error: startFailure(refusal) };
  } catch (failure) {
    return { sessionId, lifecycle: "error", error: startFailure(errorMessage(failure)) };
  }
}

/**
 * Drives one lab Session.
 *
 * `scenarioId` names a scripted harness profile to attach instead of the live
 * one — the lab's only way to reach a state OpenCode raises when it feels like
 * it. It is a profile, not a mode: everything below is unchanged, because a
 * scenario is delivered by an adapter and the whole point is that this surface
 * cannot tell. Null is the live harness, which is what a Session opened without
 * a pick gets.
 */
export function useLabSessionController(scenarioId: string | null = null): LabSessionController {
  const runtimeCatalog = useRuntimeCatalogClient();
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const client = React.useRef<SessionRpcClient | null>(null);
  const [sessionId, setSessionId] = React.useState("");
  const [projection, setProjection] = React.useState<SessionProjection | null>(null);
  const [transcript, setTranscript] = React.useState<ChatTranscriptState>(EMPTY_TRANSCRIPT);
  const [diagnostics, setDiagnostics] = React.useState<readonly RpcDiagnosticEntry[]>([]);
  const [lifecycle, setLifecycle] = React.useState<SessionLifecycle>("idle");
  const [sessionError, setError] = React.useState<string | null>(null);
  const [diagnosticsError, setDiagnosticsError] = React.useState<string | null>(null);
  const [catalogError, setCatalogError] = React.useState<string | null>(null);
  const [selection, setSelection] = React.useState<RuntimeSelection>(EMPTY_SELECTION);
  const [catalog, setCatalog] = React.useState<RuntimeCatalogChoices>(EMPTY_CATALOG);
  const [catalogState, setCatalogState] = React.useState<CatalogState>("loading");
  // Bumped to run the connect effect again for the same Session id. A retry on
  // a Session whose snapshot failed has nothing else to change: the id is
  // right, the stream is what never opened.
  const [connectEpoch, setConnectEpoch] = React.useState(0);

  React.useEffect(() => {
    const rpc = createSessionRpcClient();
    client.current = rpc;
    let active = true;
    const mergeDiagnostics = (entries: readonly RpcDiagnosticEntry[]) => {
      if (!active) return;
      setDiagnosticsError(null);
      setDiagnostics((current) => appendDiagnostics(current, entries));
    };
    // Diagnostics ride the same tRPC transport the Session does, so this
    // failing is evidence about the connection and not only about the debug
    // pane. It used to be `console.error` alone — the one path here that did
    // not say anything on screen, while the runtime catalog beside it already
    // did — which left the surface silently detached from its own edge. It is
    // not `setError` either: a debug pane that fell over blocks nothing, and on
    // that field it outranked the harness's own attention.
    const failDiagnostics = (error: unknown) => {
      if (!active) return;
      reportError("diagnostics", error);
      setDiagnosticsError(errorMessage(error));
    };
    void rpc.labDiagnostics.list
      .query({ limit: DIAGNOSTIC_LIMIT })
      .then(mergeDiagnostics)
      .catch(failDiagnostics);
    const subscription = rpc.labDiagnostics.subscribe.subscribe(
      {},
      { onData: (entry) => mergeDiagnostics([entry.data]), onError: failDiagnostics },
    );
    return () => {
      active = false;
      subscription.unsubscribe();
      client.current = null;
    };
  }, []);

  React.useEffect(() => {
    if (!sessionId || !client.current) {
      setProjection(null);
      setTranscript(EMPTY_TRANSCRIPT);
      return;
    }
    const rpc = client.current;
    let active = true;
    let subscription: { unsubscribe(): void } | null = null;
    let projectionRefresh: Promise<void> | null = null;
    let projectionRefreshQueued = false;
    let frameFlush: number | null = null;
    const pendingFrames = new Map<number, ChatSessionFrame>();
    // Overlays batch in an ordered array and never in the map above. Every
    // overlay in one paint carries the same `throughSequence` — the latest
    // durable sequence, which does not move while a message streams — so a
    // sequence-keyed map would keep one of them and drop the rest. And
    // `part.append` is not idempotent: the deltas it drops are not a stale
    // snapshot superseded by a fresher one, they are the missing middle of a
    // sentence, and the text arrives silently truncated.
    const pendingOverlays: SessionStreamOverlay[] = [];
    // Session state only, and only when a frame could have moved it. This used
    // to be the frames-carrying snapshot on every animation frame: the whole
    // transcript re-read, re-projected and cloned across the process boundary
    // ~30 times a second, for a `projection` field the surface then kept and
    // frames it threw away.
    const refreshProjection = () => {
      if (projectionRefresh) {
        projectionRefreshQueued = true;
        return;
      }
      projectionRefresh = rpc.session.projection
        .query({ sessionId })
        .then((snapshot) => {
          if (active) setProjection(snapshot.projection);
        })
        .catch((error: unknown) => {
          if (active) setConnectionError(error);
        })
        .finally(() => {
          projectionRefresh = null;
          if (active && projectionRefreshQueued) {
            projectionRefreshQueued = false;
            refreshProjection();
          }
        });
    };
    const connect = async () => {
      // The one read that genuinely wants frames: a surface opening on a
      // Session that already has history has no other way to get it.
      const snapshot = await rpc.session.snapshot.query({ sessionId });
      if (!active) return;
      setProjection(snapshot.projection);
      setTranscript(
        appendFrames(
          EMPTY_TRANSCRIPT,
          snapshot.frames.flatMap((frame) => {
            const normalized = chatSessionFrame(frame);
            return normalized ? [normalized] : [];
          }),
        ),
      );
      subscription = rpc.session.subscribe.subscribe(
        { sessionId, afterSequence: snapshot.throughSequence },
        {
          onData: (emission) => {
            if (!active) return;
            const overlay = chatSessionOverlay(emission.data);
            if (overlay) pendingOverlays.push(overlay);
            else {
              const frame = chatSessionFrame(emission.data);
              if (!frame) return;
              pendingFrames.set(frame.sequence, frame);
            }
            if (frameFlush !== null) return;
            // Native adapters may emit several transcript/tool frames in one
            // paint, and a streaming message emits far more overlays than that.
            // Commit them as one renderer update and one projection refresh so
            // shell motion never competes with an event-by-event
            // React/render/query loop.
            frameFlush = window.requestAnimationFrame(() => {
              frameFlush = null;
              if (!active) return;
              const batch = [...pendingFrames.values()];
              const overlays = [...pendingOverlays];
              pendingFrames.clear();
              pendingOverlays.length = 0;
              setTranscript((current) => appendFrames(current, batch, overlays));
              if (batch.some(movesProjection)) refreshProjection();
            });
          },
          onError: (error) => {
            if (active) setConnectionError(error);
          },
        },
      );
    };
    void connect().catch((error: unknown) => {
      if (active) setConnectionError(error);
    });
    return () => {
      active = false;
      if (frameFlush !== null) window.cancelAnimationFrame(frameFlush);
      pendingFrames.clear();
      pendingOverlays.length = 0;
      subscription?.unsubscribe();
    };
  }, [connectEpoch, sessionId]);

  const frames = transcript.frames;
  const messages = transcript.messages;
  const liveAttachmentId = projection?.liveExecutor?.id ?? null;
  const working = liveAttachmentId !== null && transcript.turnActive;

  /**
   * Which models exist is a question only a running harness can answer.
   *
   * This used to ask once on mount and again whenever Settings closed, which
   * was survivable while a person pressed Start themselves — by the time they
   * did, OpenCode was up. Opening the Session now starts it, so the first ask
   * races the attach and loses, and an empty answer arrives as the confident
   * claim that nothing is configured. Re-asking when an executor appears is
   * what makes `empty` mean empty.
   */
  React.useEffect(() => {
    if (!runtimeCatalog) return;
    let active = true;
    void runtimeCatalog
      .resolve({ adapterId: "opencode" })
      .then((resolved) => {
        if (!active) return;
        setCatalog(resolved.catalog);
        setCatalogError(null);
        setCatalogState(resolved.catalog.models.length > 0 ? "ready" : "empty");
        setSelection((current) =>
          resolveRuntimeSelection(resolved.catalog, current.modelId ? current : resolved.selection),
        );
      })
      .catch((unresolved: unknown) => {
        if (!active) return;
        // The last known catalog stays on screen. A refresh that fails is not
        // evidence that the models a person already picked have gone away, and
        // blanking the picker would take away the one control they could still
        // use while the failure is on screen.
        reportError("runtime catalog", unresolved);
        setCatalogState("error");
        setCatalogError(errorMessage(unresolved));
      });
    return () => {
      active = false;
    };
  }, [liveAttachmentId, runtimeCatalog, settingsOpen]);

  React.useEffect(() => {
    if (!sessionId || lifecycle === "starting" || lifecycle === "error") return;
    setLifecycle(working ? "working" : "ready");
  }, [lifecycle, sessionId, working]);

  /**
   * The latch a failed command set, released by the next one that lands.
   *
   * `error` is a lifecycle here, not only a string: while it stands, the effect
   * above stops deriving the Session's state from its stream. So a failure that
   * cleared only the *message* left `working` false for the rest of the
   * Session — the live turn never animated again and the composer's queue
   * drained into a turn this surface read as idle. Only the error state is
   * touched: what replaces it is the stream's answer, which the effect settles
   * on the very next render.
   */
  const clearFailure = React.useCallback(() => {
    setError(null);
    setLifecycle((current) => (current === "error" ? "ready" : current));
  }, []);

  /**
   * One command, and whether it landed.
   *
   * The boolean is the point. This used to catch and resolve, so a caller
   * chaining a second act onto the first could not tell a delivered command
   * from a failed one — or from one that was never sent, which is what the
   * early return is. `error` says what broke; only the result says whether
   * anything happened.
   *
   * A resolved round trip is not the same as a delivered command: a harness
   * that will not serve one answers with a rejected receipt rather than by
   * throwing, and that receipt is the failure. Reading it is what keeps a
   * refusal from being reported as success.
   */
  const run = React.useCallback(
    async (
      label: string,
      action: (rpc: SessionRpcClient, activeSessionId: string) => Promise<unknown>,
    ): Promise<boolean> => {
      const rpc = client.current;
      if (!rpc || !sessionId) return false;
      try {
        const refusal = rejectedReceipt(await action(rpc, sessionId));
        if (refusal !== null) {
          setLifecycle("error");
          setError(`${label}: ${refusal}`);
          return false;
        }
        clearFailure();
        return true;
      } catch (failure) {
        setLifecycle("error");
        setError(`${label}: ${errorMessage(failure)}`);
        return false;
      }
    },
    [clearFailure, sessionId],
  );

  const start = React.useCallback(async (): Promise<boolean> => {
    const rpc = client.current;
    if (!rpc || lifecycle === "starting") return false;
    setLifecycle("starting");
    setError(null);
    setSessionId("");
    setProjection(null);
    setTranscript(EMPTY_TRANSCRIPT);
    try {
      const started = await startLabSession(rpc, scenarioId);
      setSessionId(started.sessionId);
      setLifecycle(started.lifecycle);
      setError(started.error);
      return started.lifecycle === "ready";
    } catch (failure) {
      setLifecycle("error");
      setError(startFailure(errorMessage(failure)));
      return false;
    }
  }, [lifecycle, scenarioId]);

  const submit = React.useCallback(
    async (text: string, delivery: MessageDelivery): Promise<boolean> => {
      const rpc = client.current;
      if (!rpc || !sessionId || !liveAttachmentId || !selection.modelId || !text.trim()) {
        return false;
      }
      try {
        const delivered = await rpc.session.command.mutate({
          commandId: nextId(),
          sessionId,
          command: {
            kind: "message.submit",
            message: { id: nextId(), role: "user", parts: [{ type: "text", text: text.trim() }] },
            delivery,
            model: { providerId: selection.providerId, modelId: selection.modelId },
            variant: selection.variant || null,
            agent: selection.agent || null,
          },
        });
        // A harness that cannot take a message says so in its receipt, and the
        // words are still in the composer until this returns true.
        const refusal = rejectedReceipt(delivered);
        if (refusal !== null) {
          setLifecycle("error");
          setError(`Message not delivered: ${refusal}`);
          return false;
        }
        clearFailure();
        setLifecycle("working");
        return true;
      } catch (failure) {
        setLifecycle("error");
        setError(`Message not delivered: ${errorMessage(failure)}`);
        return false;
      }
    },
    [clearFailure, liveAttachmentId, selection, sessionId],
  );

  const resolveInteraction = React.useCallback(
    (interactionId: string, resolution: SessionInteractionResolution) =>
      run("Decision not delivered", (rpc, activeSessionId) =>
        rpc.session.command.mutate({
          commandId: nextId(),
          sessionId: activeSessionId,
          command: {
            kind: "interaction.resolve",
            interactionId,
            // The wire schema owns its own arrays; the projection's are readonly.
            // `answers` is spread rather than assigned: it is optional, and a key
            // that arrives explicitly `undefined` is a key that is present and
            // unserialisable once Electron's structured clone has kept what JSON
            // would have dropped. Absent and explicitly absent say the same
            // thing; only one of them may leave the renderer.
            resolution: {
              optionIds: [...resolution.optionIds],
              response: resolution.response,
              ...(resolution.answers
                ? {
                    answers: resolution.answers.map((answer) => ({
                      promptId: answer.promptId,
                      optionIds: [...answer.optionIds],
                      response: answer.response,
                    })),
                  }
                : {}),
            },
          },
        }),
      ),
    [run],
  );

  /**
   * The exit from a decision nobody is going to make.
   *
   * Interrupting stops the turn; it does not answer the question, and an
   * interaction leaves the projection only when it is resolved or cancelled —
   * so without this the card outlives the turn it belonged to and the composer
   * it displaced never comes back.
   */
  const cancelInteraction = React.useCallback(
    (interactionId: string) =>
      run("Decision not cancelled", (rpc, activeSessionId) =>
        rpc.session.cancelInteraction.mutate({ sessionId: activeSessionId, interactionId }),
      ),
    [run],
  );

  const interrupt = React.useCallback(
    () =>
      run("Interrupt", (rpc, activeSessionId) =>
        rpc.session.command.mutate({
          commandId: nextId(),
          sessionId: activeSessionId,
          command: { kind: "executor.interrupt", attachmentId: liveAttachmentId ?? undefined },
        }),
      ),
    [liveAttachmentId, run],
  );
  // No attachment is not a success. These three are addressed to one, so they
  // report the same `false` a failed round trip does rather than resolving as
  // though something had been asked of a harness that is not there.
  const refreshCapabilities = React.useCallback(
    () =>
      liveAttachmentId
        ? run("Capabilities", (rpc, activeSessionId) =>
            rpc.session.refreshCapabilities.mutate({
              sessionId: activeSessionId,
              attachmentId: liveAttachmentId,
            }),
          )
        : Promise.resolve(false),
    [liveAttachmentId, run],
  );
  const reconcile = React.useCallback(
    () =>
      liveAttachmentId
        ? run("Reconcile", (rpc, activeSessionId) =>
            rpc.session.reconcile.mutate({
              sessionId: activeSessionId,
              attachmentId: liveAttachmentId,
            }),
          )
        : Promise.resolve(false),
    [liveAttachmentId, run],
  );
  const release = React.useCallback(
    () =>
      liveAttachmentId
        ? run("Release", (rpc, activeSessionId) =>
            rpc.session.command.mutate({
              commandId: nextId(),
              sessionId: activeSessionId,
              command: { kind: "adapter.release", attachmentId: liveAttachmentId },
            }),
          )
        : Promise.resolve(false),
    [liveAttachmentId, run],
  );

  /**
   * Another attachment attempt on the Session this surface already has.
   *
   * `start()` is not a retry: it mints a durable Session, so reaching for it
   * after a failed attach filed a new ledger row per press of Retry and walked
   * away from the history the first Session already holds. The id is fine —
   * only the executor is missing — so the retry addresses the id, and reopens
   * the stream alongside: a snapshot that failed to load left this surface
   * blind to the very projection that says whether an executor is live, and
   * the engine's refusal of a second binding is only useful next to a
   * projection that can name the first.
   */
  const retryAttach = React.useCallback(async (): Promise<boolean> => {
    const rpc = client.current;
    if (!rpc || !sessionId || lifecycle === "starting") return false;
    setLifecycle("starting");
    setError(null);
    setConnectEpoch((epoch) => epoch + 1);
    const attached = await attachLabExecutor(rpc, sessionId, scenarioId);
    setLifecycle(attached.lifecycle);
    setError(attached.error);
    return attached.lifecycle === "ready";
  }, [lifecycle, scenarioId, sessionId]);

  /**
   * One button, and which one is not the user's problem to work out.
   *
   * A dropped stream, a failed attach and a Session that never got created
   * need three different answers: reconciling recovers a live attachment,
   * re-attaching serves a durable Session that has none, and starting over is
   * only for the case where there is no Session to serve — anywhere else it
   * duplicates one. The controller is the only place that knows which
   * happened, so it decides here rather than offering three buttons and
   * making the reader diagnose their own transport.
   */
  const recover = React.useCallback(() => {
    if (liveAttachmentId) return reconcile();
    return sessionId ? retryAttach() : start();
  }, [liveAttachmentId, reconcile, retryAttach, sessionId, start]);

  // Opening a Session starts it. There was a button here, and it asked a person
  // who had just opened a chat to confirm that they wanted a chat — the answer
  // is always yes, and the wait is the same either way. `started` latches so a
  // failure stops at the error row with its own Retry instead of relaunching in
  // a loop, and so StrictMode's double mount attaches once.
  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, [start]);

  function setConnectionError(failure: unknown) {
    setLifecycle("error");
    setError(`Lost the Session stream: ${errorMessage(failure)}`);
  }

  return {
    sessionId,
    projection,
    frames,
    messages,
    diagnostics,
    lifecycle,
    error: sessionError,
    diagnosticsError,
    selection,
    setSelection,
    catalog,
    catalogState,
    catalogError,
    interactions: projection?.interactions.active ?? [],
    openedInteractions: transcript.openedInteractions,
    attention: projection?.attention ?? EMPTY_ATTENTION,
    liveAttachmentId,
    start,
    submit,
    resolveInteraction,
    cancelInteraction,
    interrupt,
    refreshCapabilities,
    reconcile,
    release,
    recover,
  };
}

function appendDiagnostics(
  current: readonly RpcDiagnosticEntry[],
  entries: readonly RpcDiagnosticEntry[],
): readonly RpcDiagnosticEntry[] {
  const merged = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of entries) merged.set(entry.id, entry);
  return [...merged.values()]
    .toSorted((left, right) => left.id - right.id)
    .slice(-DIAGNOSTIC_LIMIT);
}

function nextId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `lab-${Date.now()}-${Math.random()}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportError(scope: string, error: unknown): void {
  console.error(`[chat-ui:${scope}]`, error);
}
