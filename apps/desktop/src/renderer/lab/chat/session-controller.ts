import * as React from "react";
import type {
  RuntimeCatalogChoices,
  RuntimeSelection,
  SessionEvent,
  SessionProjection,
} from "@volli/shared";
import type { RpcDiagnosticEntry } from "@volli/session-rpc";
import type { UIMessage } from "ai";

import { useRuntimeCatalogClient } from "@renderer/lib/runtime-catalog-client";
import { useUiStore } from "@renderer/stores/ui";

import { LAB_SESSION_PROJECT_ID, LAB_SESSION_TICKET_ID } from "../../../lab-session-rpc-path";
import { createSessionRpcClient, type SessionRpcClient } from "../session-rpc-client";
import { resolveRuntimeSelection } from "./session-model";

const DIAGNOSTIC_LIMIT = 100;
const EMPTY_SELECTION: RuntimeSelection = {
  providerId: "",
  modelId: "",
  variant: "",
  agent: "",
};
const EMPTY_CATALOG: RuntimeCatalogChoices = { providers: [], models: [], agents: [] };

export type SessionLifecycle = "idle" | "starting" | "ready" | "working" | "error";
export type MessageDelivery = "queue" | "steer" | "replace";

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
  status: string;
  selection: RuntimeSelection;
  setSelection(next: RuntimeSelection): void;
  catalog: RuntimeCatalogChoices;
  liveAttachmentId: string | null;
  start(): Promise<void>;
  submit(text: string, delivery: MessageDelivery): Promise<boolean>;
  interrupt(): Promise<void>;
  refreshCapabilities(): Promise<void>;
  reconcile(): Promise<void>;
  release(): Promise<void>;
}

export function useLabSessionController(): LabSessionController {
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
  const [status, setStatus] = React.useState("Ready to start in a disposable workspace");
  const [selection, setSelection] = React.useState<RuntimeSelection>(EMPTY_SELECTION);
  const [catalog, setCatalog] = React.useState<RuntimeCatalogChoices>(EMPTY_CATALOG);

  React.useEffect(() => {
    if (!runtimeCatalog) return;
    let active = true;
    void runtimeCatalog
      .resolve({ adapterId: "opencode" })
      .then((resolved) => {
        if (!active) return;
        setCatalog(resolved.catalog);
        setSelection((current) =>
          resolveRuntimeSelection(resolved.catalog, current.modelId ? current : resolved.selection),
        );
      })
      .catch((error: unknown) => {
        if (active) reportError("runtime catalog", error);
      });
    return () => {
      active = false;
    };
  }, [runtimeCatalog, settingsOpen]);

  React.useEffect(() => {
    const rpc = createSessionRpcClient();
    client.current = rpc;
    let active = true;
    const mergeDiagnostics = (entries: readonly RpcDiagnosticEntry[]) => {
      if (!active) return;
      setDiagnostics((current) => appendDiagnostics(current, entries));
    };
    void rpc.labDiagnostics.list
      .query({ limit: DIAGNOSTIC_LIMIT })
      .then(mergeDiagnostics)
      .catch((error: unknown) => {
        if (active) reportError("diagnostics", error);
      });
    const subscription = rpc.labDiagnostics.subscribe.subscribe(
      {},
      {
        onData: (entry) => mergeDiagnostics([entry.data]),
        onError: (error) => {
          if (active) reportError("diagnostics", error);
        },
      },
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
  const messages = React.useMemo(
    () => frames.flatMap((frame) => (frame.transcript ? [frame.transcript.message] : [])),
    [frames],
  );
  const liveAttachmentId = projection?.liveExecutor?.id ?? null;
  const working = liveAttachmentId !== null && latestTurnIsActive(frames);

  React.useEffect(() => {
    if (!sessionId || lifecycle === "starting" || lifecycle === "error") return;
    setLifecycle(working ? "working" : "ready");
    setStatus(
      working
        ? "OpenCode is working"
        : liveAttachmentId
          ? "Ready for your next instruction"
          : "OpenCode is not attached",
    );
  }, [lifecycle, liveAttachmentId, sessionId, working]);

  const run = React.useCallback(
    async (
      label: string,
      action: (rpc: SessionRpcClient, activeSessionId: string) => Promise<unknown>,
    ) => {
      const rpc = client.current;
      if (!rpc || !sessionId) return;
      setStatus(`${label}…`);
      try {
        const result = await action(rpc, sessionId);
        setStatus(`${label}: ${receiptStatus(result)}`);
      } catch (error) {
        setLifecycle("error");
        setStatus(`${label}: ${errorMessage(error)}`);
      }
    },
    [sessionId],
  );

  const start = React.useCallback(async () => {
    const rpc = client.current;
    if (!rpc || lifecycle === "starting") return;
    setLifecycle("starting");
    setStatus("Creating durable Session…");
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
      setStatus("Attaching OpenCode…");
      const attached = await rpc.session.command.mutate({
        commandId: nextId(),
        sessionId: created.sessionId,
        command: {
          kind: "adapter.attach",
          adapterId: "opencode",
          profileId: "native",
          continuity: "fresh",
        },
      });
      setLifecycle("ready");
      setStatus(`OpenCode attached: ${receiptStatus(attached)}`);
    } catch (error) {
      setLifecycle("error");
      setStatus(`Start failed: ${errorMessage(error)}`);
    }
  }, [lifecycle]);

  const submit = React.useCallback(
    async (text: string, delivery: MessageDelivery): Promise<boolean> => {
      const rpc = client.current;
      if (!rpc || !sessionId || !liveAttachmentId || !selection.modelId || !text.trim()) {
        return false;
      }
      setStatus(delivery === "steer" ? "Steering active turn…" : "Submitting instruction…");
      try {
        const result = await rpc.session.command.mutate({
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
        setStatus(`Instruction ${receiptStatus(result)}`);
        return true;
      } catch (error) {
        setLifecycle("error");
        setStatus(`Submit failed: ${errorMessage(error)}`);
        return false;
      }
    },
    [liveAttachmentId, selection, sessionId],
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

  function setConnectionError(error: unknown) {
    setLifecycle("error");
    setStatus(`Session stream: ${errorMessage(error)}`);
  }

  return {
    sessionId,
    projection,
    frames,
    messages,
    diagnostics,
    lifecycle,
    status,
    selection,
    setSelection,
    catalog,
    liveAttachmentId,
    start,
    submit,
    interrupt,
    refreshCapabilities,
    reconcile,
    release,
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

function receiptStatus(result: unknown): string {
  if (!isRecord(result) || !isRecord(result.receipt)) return "completed";
  const status = typeof result.receipt.status === "string" ? result.receipt.status : "unknown";
  const code = typeof result.receipt.code === "string" ? result.receipt.code : null;
  return code ? `${status} (${code})` : status;
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
