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
  selection: RuntimeSelection;
  setSelection(next: RuntimeSelection): void;
  catalog: RuntimeCatalogChoices;
  catalogState: CatalogState;
  /** Open interactions, so a gated transcript row can find the one it belongs to. */
  interactions: readonly SessionInteraction[];
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
  start(): Promise<void>;
  submit(text: string, delivery: MessageDelivery): Promise<boolean>;
  resolveInteraction(
    interactionId: string,
    resolution: SessionInteractionResolution,
  ): Promise<void>;
  interrupt(): Promise<void>;
  refreshCapabilities(): Promise<void>;
  reconcile(): Promise<void>;
  release(): Promise<void>;
  /** The single action an error row offers; which one it is depends on what broke. */
  recover(): Promise<void>;
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
  const [framesBySequence, setFramesBySequence] = React.useState<
    ReadonlyMap<number, LabSessionFrame>
  >(new Map());
  const [diagnostics, setDiagnostics] = React.useState<readonly RpcDiagnosticEntry[]>([]);
  const [lifecycle, setLifecycle] = React.useState<SessionLifecycle>("idle");
  const [sessionError, setError] = React.useState<string | null>(null);
  const [selection, setSelection] = React.useState<RuntimeSelection>(EMPTY_SELECTION);
  const [catalog, setCatalog] = React.useState<RuntimeCatalogChoices>(EMPTY_CATALOG);
  const [catalogState, setCatalogState] = React.useState<CatalogState>("loading");

  React.useEffect(() => {
    const rpc = createSessionRpcClient();
    client.current = rpc;
    let active = true;
    const mergeDiagnostics = (entries: readonly RpcDiagnosticEntry[]) => {
      if (!active) return;
      setDiagnostics((current) => appendDiagnostics(current, entries));
    };
    // Diagnostics ride the same tRPC transport the Session does, so this
    // failing is evidence about the connection and not only about the debug
    // pane. It used to be `console.error` alone — the one path here that did
    // not say anything on screen, while the runtime catalog beside it already
    // did — which left the surface silently detached from its own edge.
    const failDiagnostics = (error: unknown) => {
      if (!active) return;
      reportError("diagnostics", error);
      setError(`Diagnostics unavailable: ${errorMessage(error)}`);
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
      setFramesBySequence(new Map());
      return;
    }
    const rpc = client.current;
    let active = true;
    let subscription: { unsubscribe(): void } | null = null;
    let projectionRefresh: Promise<void> | null = null;
    let projectionRefreshQueued = false;
    let frameFlush: number | null = null;
    const pendingFrames = new Map<number, LabSessionFrame>();
    const refreshProjection = () => {
      if (projectionRefresh) {
        projectionRefreshQueued = true;
        return;
      }
      projectionRefresh = rpc.session.snapshot
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
      const snapshot = await rpc.session.snapshot.query({ sessionId });
      if (!active) return;
      setProjection(snapshot.projection);
      setFramesBySequence(
        new Map(
          snapshot.frames.flatMap((frame) => {
            const normalized = labSessionFrame(frame);
            return normalized ? [[normalized.sequence, normalized] as const] : [];
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
              setFramesBySequence((current) => {
                const next = new Map(current);
                for (const entry of batch) next.set(entry.sequence, entry);
                return next;
              });
              refreshProjection();
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

  const frames = React.useMemo(
    () => [...framesBySequence.values()].toSorted((left, right) => left.sequence - right.sequence),
    [framesBySequence],
  );
  const messages = React.useMemo(() => projectTranscriptMessages(frames), [frames]);
  const liveAttachmentId = projection?.liveExecutor?.id ?? null;
  const working = liveAttachmentId !== null && latestTurnIsActive(frames);

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
        setError(`Models unavailable: ${errorMessage(unresolved)}`);
      });
    return () => {
      active = false;
    };
  }, [liveAttachmentId, runtimeCatalog, settingsOpen]);

  React.useEffect(() => {
    if (!sessionId || lifecycle === "starting" || lifecycle === "error") return;
    setLifecycle(working ? "working" : "ready");
  }, [lifecycle, sessionId, working]);

  const run = React.useCallback(
    async (
      label: string,
      action: (rpc: SessionRpcClient, activeSessionId: string) => Promise<unknown>,
    ) => {
      const rpc = client.current;
      if (!rpc || !sessionId) return;
      try {
        await action(rpc, sessionId);
        setError(null);
      } catch (failure) {
        setLifecycle("error");
        setError(`${label}: ${errorMessage(failure)}`);
      }
    },
    [sessionId],
  );

  const start = React.useCallback(async () => {
    const rpc = client.current;
    if (!rpc || lifecycle === "starting") return;
    setLifecycle("starting");
    setError(null);
    setSessionId("");
    setProjection(null);
    setFramesBySequence(new Map());
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
    } catch (failure) {
      setLifecycle("error");
      setError(`Could not start OpenCode: ${errorMessage(failure)}`);
    }
  }, [lifecycle, scenarioId]);

  const submit = React.useCallback(
    async (text: string, delivery: MessageDelivery): Promise<boolean> => {
      const rpc = client.current;
      if (!rpc || !sessionId || !liveAttachmentId || !selection.modelId || !text.trim()) {
        return false;
      }
      try {
        await rpc.session.command.mutate({
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
        setLifecycle("working");
        setError(null);
        return true;
      } catch (failure) {
        setLifecycle("error");
        setError(`Message not delivered: ${errorMessage(failure)}`);
        return false;
      }
    },
    [liveAttachmentId, selection, sessionId],
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
  const refreshCapabilities = React.useCallback(
    () =>
      run("Capabilities", async (rpc, activeSessionId) => {
        if (!liveAttachmentId) return;
        await rpc.session.refreshCapabilities.mutate({
          sessionId: activeSessionId,
          attachmentId: liveAttachmentId,
        });
      }),
    [liveAttachmentId, run],
  );
  const reconcile = React.useCallback(
    () =>
      run("Reconcile", (rpc, activeSessionId) =>
        liveAttachmentId
          ? rpc.session.reconcile.mutate({
              sessionId: activeSessionId,
              attachmentId: liveAttachmentId,
            })
          : Promise.resolve(),
      ),
    [liveAttachmentId, run],
  );
  const release = React.useCallback(
    () =>
      run("Release", (rpc, activeSessionId) =>
        liveAttachmentId
          ? rpc.session.command.mutate({
              commandId: nextId(),
              sessionId: activeSessionId,
              command: { kind: "adapter.release", attachmentId: liveAttachmentId },
            })
          : Promise.resolve(),
      ),
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
    selection,
    setSelection,
    catalog,
    catalogState,
    interactions: projection?.interactions.active ?? [],
    attention: projection?.attention ?? EMPTY_ATTENTION,
    liveAttachmentId,
    start,
    submit,
    resolveInteraction,
    interrupt,
    refreshCapabilities,
    reconcile,
    release,
    recover,
  };
}

function latestTurnIsActive(frames: readonly LabSessionFrame[]): boolean {
  let active = false;
  for (const frame of frames) {
    if (frame.event.payload.kind === "turn.started") active = true;
    else if (frame.event.payload.kind === "turn.completed") active = false;
  }
  return active;
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
