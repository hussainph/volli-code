import * as React from "react";
import type {
  RuntimeCatalogChoices,
  RuntimeSelection,
  SessionAttentionProjection,
  SessionEvent,
  SessionInteraction,
  SessionInteractionResolution,
  SessionProjection,
} from "@volli/shared";
import type { RpcDiagnosticEntry } from "@volli/session-rpc";
import type { UIMessage } from "ai";

import { useRuntimeCatalogClient } from "@renderer/lib/runtime-catalog-client";
import { useUiStore } from "@renderer/stores/ui";

import { LAB_SCENARIO_ADAPTER_ID } from "../../../lab-scenarios";
import { LAB_SESSION_PROJECT_ID, LAB_SESSION_TICKET_ID } from "../../../lab-session-rpc-path";
import { createSessionRpcClient, type SessionRpcClient } from "../session-rpc-client";
import { indexOpenedInteractions } from "./interaction";
import { projectTranscriptMessages } from "./message-projection";
import { resolveRuntimeSelection } from "./session-model";

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

export interface LabSessionFrame {
  sessionId: string;
  sequence: number;
  event: SessionEvent;
  transcript: { message: UIMessage } | null;
}

/**
 * What the stream alone can say, kept between batches.
 *
 * Every fact this surface needs about a live turn is already in the frames it
 * is subscribed to, so this is folded forward as they arrive rather than
 * re-derived from the whole transcript on every render: `turnActive` used to be
 * a scan of all frames in the render body, and the ordered list used to be a
 * copy-and-sort of a Map per animation frame. All of it is now linear in the
 * batch.
 *
 * `messages` and `openedInteractions` joined it for the same reason and after
 * the same measurement mistake. Both were memoized on the frame list, and that
 * list is rebuilt on every batch — so the memo missed every time, and each miss
 * re-read *every frame the Session has ever committed*. Frames outgrow messages
 * badly: a streamed reply commits a transcript snapshot per chunk, several per
 * animation frame, and every one of them made both scans longer for the rest of
 * the Session. Folded, a batch costs the batch.
 */
interface LabTranscriptState {
  frames: readonly LabSessionFrame[];
  throughSequence: number;
  turnActive: boolean;
  /** Latest shape per message id, in the order the ids first spoke. */
  messages: readonly UIMessage[];
  /** Every interaction this Session has opened, for the receipts they leave. */
  openedInteractions: ReadonlyMap<string, SessionInteraction>;
}

const EMPTY_INTERACTION_INDEX: ReadonlyMap<string, SessionInteraction> = new Map();
const EMPTY_TRANSCRIPT: LabTranscriptState = {
  frames: [],
  throughSequence: 0,
  turnActive: false,
  messages: [],
  openedInteractions: EMPTY_INTERACTION_INDEX,
};

export interface LabSessionController {
  sessionId: string;
  projection: SessionProjection | null;
  frames: readonly LabSessionFrame[];
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
  const [transcript, setTranscript] = React.useState<LabTranscriptState>(EMPTY_TRANSCRIPT);
  const [diagnostics, setDiagnostics] = React.useState<readonly RpcDiagnosticEntry[]>([]);
  const [lifecycle, setLifecycle] = React.useState<SessionLifecycle>("idle");
  const [sessionError, setError] = React.useState<string | null>(null);
  const [diagnosticsError, setDiagnosticsError] = React.useState<string | null>(null);
  const [catalogError, setCatalogError] = React.useState<string | null>(null);
  const [selection, setSelection] = React.useState<RuntimeSelection>(EMPTY_SELECTION);
  const [catalog, setCatalog] = React.useState<RuntimeCatalogChoices>(EMPTY_CATALOG);
  const [catalogState, setCatalogState] = React.useState<CatalogState>("loading");

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
    const pendingFrames = new Map<number, LabSessionFrame>();
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
            const normalized = labSessionFrame(frame);
            return normalized ? [normalized] : [];
          }),
        ),
      );
      subscription = rpc.session.subscribe.subscribe(
        { sessionId, afterSequence: snapshot.throughSequence },
        {
          onData: (trackedFrame) => {
            if (!active) return;
            const frame = labSessionFrame(trackedFrame.data);
            if (!frame) return;
            pendingFrames.set(frame.sequence, frame);
            if (frameFlush !== null) return;
            // Native adapters may emit several transcript/tool frames in one
            // paint. Commit them as one renderer update and one projection
            // refresh so shell motion never competes with an event-by-event
            // React/render/query loop.
            frameFlush = window.requestAnimationFrame(() => {
              frameFlush = null;
              if (!active) return;
              const batch = [...pendingFrames.values()];
              pendingFrames.clear();
              setTranscript((current) => appendFrames(current, batch));
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
      subscription?.unsubscribe();
    };
  }, [sessionId]);

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
      const created = await rpc.session.command.mutate({
        commandId: nextId(),
        command: {
          kind: "session.create",
          projectId: LAB_SESSION_PROJECT_ID,
          ticketId: LAB_SESSION_TICKET_ID,
          title: "LAB-14 · OpenCode chat prototype",
        },
      });
      setSessionId(created.sessionId);
      await rpc.session.command.mutate({
        commandId: nextId(),
        sessionId: created.sessionId,
        command: {
          kind: "adapter.attach",
          adapterId: scenarioId ? LAB_SCENARIO_ADAPTER_ID : "opencode",
          // A scenario is a harness profile of the scripted adapter, so the
          // pick rides the attach the runtime already validates.
          profileId: scenarioId ?? "native",
          continuity: "fresh",
        },
      });
      setLifecycle("ready");
      return true;
    } catch (failure) {
      setLifecycle("error");
      setError(`Could not start OpenCode: ${errorMessage(failure)}`);
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
   * One button, and which one is not the user's problem to work out.
   *
   * A dropped stream and a Session that never started need opposite answers:
   * reconciling a Session that does not exist does nothing, and starting a new
   * one to recover a live stream throws away the transcript. The controller is
   * the only place that knows which happened, so it decides here rather than
   * offering two buttons and making the reader diagnose their own transport.
   */
  const recover = React.useCallback(
    () => (liveAttachmentId ? reconcile() : start()),
    [liveAttachmentId, reconcile, start],
  );

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

/**
 * Adds one batch of frames and carries everything derived from them across it.
 *
 * Frames arrive in strict sequence order — the subscription drains its cursor
 * one step at a time, and the snapshot that seeds it is ordered too — so this
 * appends rather than merges, and drops anything at or below the cursor so a
 * replayed frame cannot double-count a turn boundary.
 *
 * Exported for its tests: this is where the transcript's whole per-frame budget
 * now lives, and a fold is only worth having if it says exactly what the scan
 * it replaced said.
 */
export function appendFrames(
  state: LabTranscriptState,
  batch: readonly LabSessionFrame[],
): LabTranscriptState {
  const fresh = batch.filter((frame) => frame.sequence > state.throughSequence);
  const last = fresh.at(-1);
  if (!last) return state;
  let turnActive = state.turnActive;
  for (const frame of fresh) {
    if (frame.event.payload.kind === "turn.started") turnActive = true;
    else if (frame.event.payload.kind === "turn.completed") turnActive = false;
  }
  // Both of these keep their previous identity when the batch had nothing for
  // them, which is the other half of the point: a batch of pure tool traffic
  // must not hand the plane a new message list to re-group and re-segment.
  const opened = indexOpenedInteractions(fresh);
  return {
    frames: [...state.frames, ...fresh],
    throughSequence: last.sequence,
    turnActive,
    messages: mergeTranscriptMessages(state.messages, projectTranscriptMessages(fresh)),
    openedInteractions:
      opened.size === 0
        ? state.openedInteractions
        : new Map([...state.openedInteractions, ...opened]),
  };
}

/**
 * One batch of projected messages, folded into the ones already on screen.
 *
 * The rule is {@link projectTranscriptMessages}'s own, held across batches
 * rather than re-derived from the start: transcript events are immutable
 * snapshots, so a message id keeps the position it first spoke at and shows its
 * latest shape. Searching from the tail because that is where a streaming
 * snapshot always lands — a re-emitted message from further back costs the walk
 * it would have cost anyway.
 */
export function mergeTranscriptMessages(
  current: readonly UIMessage[],
  projected: readonly UIMessage[],
): readonly UIMessage[] {
  if (projected.length === 0) return current;
  const merged = [...current];
  for (const message of projected) {
    const at = merged.findLastIndex((held) => held.id === message.id);
    if (at < 0) merged.push(message);
    else merged[at] = message;
  }
  return merged;
}

/**
 * Whether a frame can move what this surface reads off the projection.
 *
 * Everything except a transcript reference: those are the flood — one per
 * stream snapshot, several per animation frame — and they carry a message this
 * surface already has in `frames`. Every other fact is rare and changes
 * something read off the projection (the live executor, an open interaction,
 * an attention, a turn boundary), so it earns its round trip.
 */
function movesProjection(frame: LabSessionFrame): boolean {
  return frame.event.payload.kind !== "transcript.referenced";
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

/**
 * The refusal a resolved mutation can still be carrying.
 *
 * A command that reaches a harness earns a delivery receipt, and `rejected` is
 * one of its arms: the round trip succeeded and the harness said no. Read
 * structurally because this crosses the RPC edge as JSON and because only some
 * of the commands sent here carry a receipt at all — a shape without one is not
 * a refusal. Null means nothing refused it.
 */
function rejectedReceipt(result: unknown): string | null {
  if (!isRecord(result) || !isRecord(result.receipt)) return null;
  const receipt = result.receipt;
  if (receipt.status !== "rejected") return null;
  if (typeof receipt.detail === "string" && receipt.detail.length > 0) return receipt.detail;
  return typeof receipt.code === "string" ? receipt.code : "rejected";
}

function reportError(scope: string, error: unknown): void {
  console.error(`[chat-ui:${scope}]`, error);
}

function labSessionFrame(value: unknown): LabSessionFrame | null {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== "string" ||
    typeof value.sequence !== "number" ||
    !isRecord(value.event) ||
    !isRecord(value.event.payload)
  ) {
    return null;
  }
  const transcript = labTranscript(value.transcript);
  if (transcript === undefined) return null;
  return {
    sessionId: value.sessionId,
    sequence: value.sequence,
    event: value.event as unknown as SessionEvent,
    transcript,
  };
}

function labTranscript(value: unknown): LabSessionFrame["transcript"] | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isRecord(value.message)) return undefined;
  const message = value.message;
  if (
    typeof message.id !== "string" ||
    (message.role !== "user" && message.role !== "assistant" && message.role !== "system") ||
    !Array.isArray(message.parts)
  ) {
    return undefined;
  }
  return { message: message as unknown as UIMessage };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
