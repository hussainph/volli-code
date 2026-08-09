/**
 * A deliberately plain inspection surface for the native Session seam.
 *
 * This is not product UI. It is the shortest browser loop for checking that
 * the real HTTP/SSE tRPC boundary produces one ordered local ledger and an
 * honest projection. The client is created from an effect, rather than module
 * scope, because the lab shell eagerly imports every scratch for its picker.
 */
import * as React from "react";
import type {
  SessionAttention,
  SessionCapabilitySnapshot,
  SessionInteraction,
  SessionPresentationProjection,
} from "@volli/shared";
import type { RpcDiagnosticEntry } from "@volli/session-rpc";

import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";

import { LAB_SCENARIOS, LAB_SCENARIO_ADAPTER_ID } from "../../../lab-scenarios";
import { SessionMessageList, type SessionMessageFrame } from "../session-message-list";
import { createSessionRpcClient, type SessionRpcClient } from "../session-rpc-client";

export const title = "Session tracer";
export const note = "Real Session RPC over HTTP + SSE; inspection only";

const DIAGNOSTIC_LIMIT = 100;

type CommandAction = (client: SessionRpcClient, sessionId: string) => Promise<unknown>;

interface ModelCatalogEntry {
  id: string;
  label: string;
  state: "available" | "unavailable" | "unknown";
  providerId: string;
  modelId: string;
  variants: readonly string[];
}

interface AgentCatalogEntry {
  id: string;
  label: string;
  state: "available" | "unavailable" | "unknown";
}

/**
 * The RPC boundary serializes AI SDK message parts. Keep the inspection view
 * structural so it cannot inherit a second package's generic UIMessage type.
 */
interface LabSessionStreamFrame extends SessionMessageFrame {
  sessionId: string;
  event: unknown;
}

function nextCommandId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `lab-command-${Date.now()}-${Math.random()}`;
}

function frameMap(frames: readonly unknown[]): Map<number, LabSessionStreamFrame> {
  return new Map(
    frames.flatMap((frame) => {
      const normalized = sessionFrame(frame);
      return normalized ? [[normalized.sequence, normalized] as const] : [];
    }),
  );
}

function orderedFrames(
  frames: ReadonlyMap<number, LabSessionStreamFrame>,
): LabSessionStreamFrame[] {
  return [...frames.values()].toSorted((left, right) => left.sequence - right.sequence);
}

function appendDiagnostics(
  current: readonly RpcDiagnosticEntry[],
  entries: readonly RpcDiagnosticEntry[],
): RpcDiagnosticEntry[] {
  const merged = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of entries) merged.set(entry.id, entry);
  return [...merged.values()]
    .toSorted((left, right) => left.id - right.id)
    .slice(-DIAGNOSTIC_LIMIT);
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function latestCapabilities(
  capabilities: readonly SessionCapabilitySnapshot[],
  attachmentId: string | undefined,
): SessionCapabilitySnapshot | null {
  return (
    capabilities
      .filter(
        (capability) =>
          (capability.expiresAt === null || capability.expiresAt > Date.now()) &&
          (!attachmentId || capability.attachmentId === attachmentId),
      )
      .toSorted(
        (left, right) => left.observedAt - right.observedAt || left.revision - right.revision,
      )
      .at(-1) ?? null
  );
}

function catalogModels(snapshot: SessionCapabilitySnapshot | null): ModelCatalogEntry[] {
  if (!snapshot) return [];
  return snapshot.catalog.flatMap((item) => {
    if (item.kind !== "model" || !isRecord(item.detail)) return [];
    const providerId = recordString(item.detail, "providerId");
    const modelId = recordString(item.detail, "modelId");
    if (!providerId || !modelId) return [];
    return [
      {
        id: item.id,
        label: item.label,
        state: item.state,
        providerId,
        modelId,
        variants: recordStrings(item.detail, "variants"),
      },
    ];
  });
}

function catalogAgents(snapshot: SessionCapabilitySnapshot | null): AgentCatalogEntry[] {
  return (snapshot?.catalog ?? []).flatMap((item) =>
    item.kind === "agent" ? [{ id: item.id, label: item.label, state: item.state }] : [],
  );
}

function receiptStatus(result: unknown): string {
  if (!isRecord(result) || !isRecord(result.receipt)) return "completed";
  const status = recordString(result.receipt, "status") ?? "unknown";
  const code = recordString(result.receipt, "code");
  return code ? `${status} (${code})` : status;
}

function ProjectionList({
  label,
  values,
  render,
}: {
  label: string;
  values: readonly unknown[];
  render: (value: unknown) => React.ReactNode;
}) {
  return (
    <section className="border border-border bg-card p-3">
      <h2 className="mb-2 font-mono text-label uppercase text-muted-foreground">{label}</h2>
      {values.length === 0 ? (
        <p className="text-ui text-muted-foreground">None</p>
      ) : (
        <div className="space-y-2">{values.map(render)}</div>
      )}
    </section>
  );
}

function AttentionList({ attention }: { attention: readonly SessionAttention[] }) {
  return (
    <ProjectionList
      label="Attention"
      values={attention}
      render={(value) => {
        const item = value as SessionAttention;
        return (
          <pre
            key={item.id}
            className="overflow-x-auto whitespace-pre-wrap text-label text-foreground"
          >
            {formatJson(item)}
          </pre>
        );
      }}
    />
  );
}

function CapabilityList({ capabilities }: { capabilities: readonly SessionCapabilitySnapshot[] }) {
  return (
    <ProjectionList
      label="Capabilities"
      values={capabilities}
      render={(value) => {
        const capability = value as SessionCapabilitySnapshot;
        return (
          <pre
            key={capability.id}
            className="overflow-x-auto whitespace-pre-wrap text-label text-foreground"
          >
            {formatJson(capability)}
          </pre>
        );
      }}
    />
  );
}

function InteractionResolution({
  interaction,
  onResolve,
}: {
  interaction: SessionInteraction;
  onResolve: (interactionId: string, optionIds: readonly string[], response: string) => void;
}) {
  const [response, setResponse] = React.useState("");
  const [selected, setSelected] = React.useState<readonly string[]>(
    interaction.options.length === 0 ? [] : [interaction.options[0]!.id],
  );

  return (
    <form
      className="space-y-2 border border-border p-2"
      onSubmit={(event) => {
        event.preventDefault();
        onResolve(interaction.id, selected, response);
      }}
    >
      <p className="text-ui text-foreground">
        {interaction.kind}: {interaction.title}
      </p>
      {interaction.detail ? (
        <p className="text-label text-muted-foreground">{interaction.detail}</p>
      ) : null}
      {interaction.options.map((option) => (
        <label key={option.id} className="flex items-center gap-2 text-ui text-foreground">
          <input
            type={interaction.multiple ? "checkbox" : "radio"}
            name={interaction.id}
            checked={selected.includes(option.id)}
            onChange={(event) => {
              setSelected((current) => {
                if (!interaction.multiple) return event.target.checked ? [option.id] : [];
                return event.target.checked
                  ? [...current, option.id]
                  : current.filter((optionId) => optionId !== option.id);
              });
            }}
          />
          {option.label}
        </label>
      ))}
      <Input
        value={response}
        onChange={(event) => setResponse(event.target.value)}
        placeholder="Optional response"
      />
      <Button type="submit" size="xs">
        Resolve
      </Button>
    </form>
  );
}

export default function SessionTracerScratch() {
  const client = React.useRef<SessionRpcClient | null>(null);
  const [projectId, setProjectId] = React.useState("lab-project");
  const [titleValue, setTitleValue] = React.useState("Native Session trace");
  const [sessionId, setSessionId] = React.useState("");
  const [prompt, setPrompt] = React.useState("Explain the current Session state.");
  const [projection, setProjection] = React.useState<SessionPresentationProjection | null>(null);
  const [capabilities, setCapabilities] = React.useState<readonly SessionCapabilitySnapshot[]>([]);
  const [frames, setFrames] = React.useState<ReadonlyMap<number, LabSessionStreamFrame>>(new Map());
  const [diagnostics, setDiagnostics] = React.useState<readonly RpcDiagnosticEntry[]>([]);
  const [status, setStatus] = React.useState("Idle");
  const [providerId, setProviderId] = React.useState("");
  const [modelId, setModelId] = React.useState("");
  const [variant, setVariant] = React.useState("");
  const [agent, setAgent] = React.useState("");

  React.useEffect(() => {
    const rpc = createSessionRpcClient();
    client.current = rpc;
    let active = true;
    const setDiagnosticEntries = (entries: readonly RpcDiagnosticEntry[]) => {
      if (active) setDiagnostics((current) => appendDiagnostics(current, entries));
    };

    void rpc.labDiagnostics.list
      .query({ limit: DIAGNOSTIC_LIMIT })
      .then(setDiagnosticEntries)
      .catch((error) => {
        if (active) setStatus(`Diagnostics stream: ${errorMessage(error)}`);
        reportError(error);
      });
    const subscription = rpc.labDiagnostics.subscribe.subscribe(
      {},
      {
        onData: (entry) => {
          const normalized = diagnosticEntry(entry.data);
          if (normalized) setDiagnosticEntries([normalized]);
        },
        onError: (error) => {
          if (active) setStatus(`Diagnostics stream: ${errorMessage(error)}`);
          reportError(error);
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
      setCapabilities([]);
      setFrames(new Map());
      return;
    }
    const rpc = client.current;
    let active = true;
    let subscription: { unsubscribe(): void } | null = null;
    let refreshInFlight: Promise<void> | null = null;
    let refreshQueued = false;
    const refreshProjection = () => {
      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }
      refreshInFlight = rpc.session.snapshot
        .query({ sessionId })
        .then((snapshot) => {
          if (!active) return;
          setProjection(snapshot.projection);
        })
        .catch((error) => {
          if (active) setStatus(`Session stream: ${errorMessage(error)}`);
          reportError(error);
        })
        .finally(() => {
          refreshInFlight = null;
          if (active && refreshQueued) {
            refreshQueued = false;
            refreshProjection();
          }
        });
    };
    const refresh = async () => {
      const snapshot = await rpc.session.snapshot.query({ sessionId });
      if (!active) return;
      setProjection(snapshot.projection);
      setFrames(frameMap(snapshot.frames));
      subscription = rpc.session.subscribe.subscribe(
        { sessionId, afterSequence: snapshot.throughSequence },
        {
          onData: (frame) => {
            if (!active) return;
            const normalized = sessionFrame(frame.data);
            if (!normalized) return;
            setFrames((current) => new Map(current).set(normalized.sequence, normalized));
            refreshProjection();
          },
          onError: (error) => {
            if (active) setStatus(`Session stream: ${errorMessage(error)}`);
            reportError(error);
          },
        },
      );
    };
    void refresh().catch((error) => {
      if (active) setStatus(`Session stream: ${errorMessage(error)}`);
      reportError(error);
    });
    return () => {
      active = false;
      subscription?.unsubscribe();
    };
  }, [sessionId]);

  const run = React.useCallback(
    async (label: string, action: CommandAction) => {
      const rpc = client.current;
      if (!rpc || !sessionId) return;
      setStatus(`${label}…`);
      try {
        const result = await action(rpc, sessionId);
        setStatus(`${label}: ${receiptStatus(result)}`);
      } catch (error) {
        setStatus(`${label}: ${errorMessage(error)}`);
      }
    },
    [sessionId],
  );

  const createSession = async () => {
    const rpc = client.current;
    if (!rpc) return;
    setStatus("Creating session…");
    try {
      const result = await rpc.session.command.mutate({
        commandId: nextCommandId(),
        command: { kind: "session.create", projectId, ticketId: null, title: titleValue || null },
      });
      setSessionId(result.sessionId);
      setStatus(`Created ${result.sessionId}: ${receiptStatus(result)}`);
    } catch (error) {
      setStatus(`Create: ${errorMessage(error)}`);
    }
  };

  const resolveInteraction = (
    interactionId: string,
    optionIds: readonly string[],
    response: string,
  ) => {
    void run("Resolve", async (rpc, activeSessionId) => {
      return rpc.session.command.mutate({
        commandId: nextCommandId(),
        sessionId: activeSessionId,
        command: {
          kind: "interaction.resolve",
          interactionId,
          resolution: {
            optionIds: [...optionIds],
            response: response || null,
          },
        },
      });
    });
  };

  const frameList = orderedFrames(frames);
  const liveAttachmentId = projection?.liveExecutor?.id;
  const capabilitySnapshot = latestCapabilities(capabilities, liveAttachmentId);
  const models = React.useMemo(() => catalogModels(capabilitySnapshot), [capabilitySnapshot]);
  const providers = React.useMemo(
    () => [...new Set(models.map((model) => model.providerId))],
    [models],
  );
  const providerModels = React.useMemo(
    () => models.filter((model) => model.providerId === providerId),
    [models, providerId],
  );
  const selectedModel = React.useMemo(
    () => providerModels.find((model) => model.modelId === modelId) ?? null,
    [modelId, providerModels],
  );
  const agents = React.useMemo(() => catalogAgents(capabilitySnapshot), [capabilitySnapshot]);

  React.useEffect(() => {
    setProviderId((current) => (providers.includes(current) ? current : (providers[0] ?? "")));
  }, [providers]);

  React.useEffect(() => {
    setModelId((current) =>
      providerModels.some((model) => model.modelId === current)
        ? current
        : (providerModels.find((model) => model.state === "available")?.modelId ??
          providerModels[0]?.modelId ??
          ""),
    );
  }, [providerModels]);

  React.useEffect(() => {
    setVariant((current) =>
      selectedModel?.variants.includes(current) ? current : (selectedModel?.variants[0] ?? ""),
    );
  }, [selectedModel]);

  React.useEffect(() => {
    setAgent((current) => (agents.some((entry) => entry.id === current) ? current : ""));
  }, [agents]);

  const selectedModelUnavailable = selectedModel?.state !== "available";

  return (
    <div className="space-y-4 font-mono text-label">
      <section className="grid gap-2 border border-border bg-card p-3 md:grid-cols-[1fr_1fr_auto]">
        <Input
          aria-label="Project ID"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          placeholder="Project ID"
        />
        <Input
          aria-label="Session title"
          value={titleValue}
          onChange={(event) => setTitleValue(event.target.value)}
          placeholder="Session title"
        />
        <Button type="button" onClick={() => void createSession()}>
          Create session
        </Button>
        <Input
          className="md:col-span-2"
          aria-label="Session ID"
          value={sessionId}
          onChange={(event) => setSessionId(event.target.value)}
          placeholder="Session ID"
        />
        <Button
          type="button"
          disabled={!sessionId}
          onClick={() =>
            void run("Attach scenario", (rpc, activeSessionId) =>
              rpc.session.command.mutate({
                commandId: nextCommandId(),
                sessionId: activeSessionId,
                command: {
                  kind: "adapter.attach",
                  adapterId: LAB_SCENARIO_ADAPTER_ID,
                  profileId: LAB_SCENARIOS[0].id,
                  continuity: "fresh",
                },
              }),
            )
          }
        >
          Attach scenario
        </Button>
      </section>

      <section className="grid gap-2 border border-border bg-card p-3 md:grid-cols-[1fr_12rem_12rem_10rem_10rem_auto_auto_auto_auto_auto]">
        <Input
          aria-label="Prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Prompt"
        />
        <select
          aria-label="Provider"
          className="h-8 border border-input bg-background px-2 text-ui text-foreground"
          disabled={providers.length === 0}
          value={providerId}
          onChange={(event) => setProviderId(event.target.value)}
        >
          {providers.length === 0 ? <option value="">No reported providers</option> : null}
          {providers.map((provider) => (
            <option key={provider} value={provider}>
              {provider}
            </option>
          ))}
        </select>
        <select
          aria-label="Model"
          className="h-8 border border-input bg-background px-2 text-ui text-foreground"
          disabled={providerModels.length === 0}
          value={modelId}
          onChange={(event) => setModelId(event.target.value)}
        >
          {providerModels.length === 0 ? <option value="">No reported models</option> : null}
          {providerModels.map((model) => (
            <option key={model.id} value={model.modelId} disabled={model.state !== "available"}>
              {model.label} {model.state === "available" ? "" : `(${model.state})`}
            </option>
          ))}
        </select>
        <select
          aria-label="Variant"
          className="h-8 border border-input bg-background px-2 text-ui text-foreground"
          disabled={!selectedModel}
          value={variant}
          onChange={(event) => setVariant(event.target.value)}
        >
          <option value="">Reported default</option>
          {selectedModel?.variants.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
        <select
          aria-label="Agent"
          className="h-8 border border-input bg-background px-2 text-ui text-foreground"
          value={agent}
          onChange={(event) => setAgent(event.target.value)}
        >
          <option value="">Reported default</option>
          {agents.map((entry) => (
            <option key={entry.id} value={entry.id} disabled={entry.state !== "available"}>
              {entry.label} {entry.state === "available" ? "" : `(${entry.state})`}
            </option>
          ))}
        </select>
        <Button
          type="button"
          disabled={!sessionId || !prompt || !selectedModel || selectedModelUnavailable}
          onClick={() =>
            void run("Submit", async (rpc, activeSessionId) => {
              return rpc.session.command.mutate({
                commandId: nextCommandId(),
                sessionId: activeSessionId,
                command: {
                  kind: "message.submit",
                  message: {
                    id: nextCommandId(),
                    role: "user",
                    parts: [{ type: "text", text: prompt }],
                  },
                  model: { providerId, modelId },
                  variant: variant || null,
                  agent: agent || null,
                },
              });
            })
          }
        >
          Submit prompt
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!sessionId}
          onClick={() =>
            void run("Interrupt", async (rpc, activeSessionId) => {
              return rpc.session.command.mutate({
                commandId: nextCommandId(),
                sessionId: activeSessionId,
                command: { kind: "executor.interrupt", attachmentId: liveAttachmentId },
              });
            })
          }
        >
          Interrupt
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!sessionId || !liveAttachmentId}
          onClick={() =>
            liveAttachmentId &&
            void run("Refresh capabilities", (rpc, activeSessionId) =>
              rpc.session.refreshCapabilities
                .mutate({ sessionId: activeSessionId, attachmentId: liveAttachmentId })
                .then((snapshot) => setCapabilities((current) => [...current, snapshot])),
            )
          }
        >
          Refresh caps
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!sessionId || !liveAttachmentId}
          onClick={() =>
            liveAttachmentId &&
            void run("Reconcile", (rpc, activeSessionId) =>
              rpc.session.reconcile.mutate({
                sessionId: activeSessionId,
                attachmentId: liveAttachmentId,
              }),
            )
          }
        >
          Reconcile
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={!sessionId || !liveAttachmentId}
          onClick={() =>
            liveAttachmentId &&
            void run("Release", async (rpc, activeSessionId) => {
              return rpc.session.command.mutate({
                commandId: nextCommandId(),
                sessionId: activeSessionId,
                command: { kind: "adapter.release", attachmentId: liveAttachmentId },
              });
            })
          }
        >
          Release
        </Button>
      </section>

      <p className="border border-border bg-muted px-3 py-2 text-muted-foreground">{status}</p>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="border border-border bg-card p-3">
          <h2 className="mb-2 font-mono text-label uppercase text-muted-foreground">Projection</h2>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-label text-foreground">
            {projection ? formatJson(projection) : "No session selected"}
          </pre>
        </section>
        <section className="border border-border bg-card p-3">
          <h2 className="mb-2 font-mono text-label uppercase text-muted-foreground">Messages</h2>
          <SessionMessageList frames={frameList} />
        </section>
        <AttentionList attention={projection?.attention.active ?? []} />
        <CapabilityList capabilities={capabilities} />
        <section className="border border-border bg-card p-3">
          <h2 className="mb-2 font-mono text-label uppercase text-muted-foreground">
            Active interactions
          </h2>
          <div className="space-y-2">
            {projection?.interactions.active.map((interaction) => (
              <InteractionResolution
                key={interaction.id}
                interaction={interaction}
                onResolve={resolveInteraction}
              />
            ))}
            {projection?.interactions.active.length ? null : (
              <p className="text-ui text-muted-foreground">None</p>
            )}
          </div>
        </section>
        <section className="border border-border bg-card p-3">
          <h2 className="mb-2 font-mono text-label uppercase text-muted-foreground">
            Ordered session events
          </h2>
          <div className="max-h-96 space-y-2 overflow-auto">
            {frameList.map((frame) => (
              <pre key={frame.sequence} className="whitespace-pre-wrap text-label text-foreground">
                {String(frame.sequence).padStart(4, "0")} {formatJson(frame.event)}
              </pre>
            ))}
            {frameList.length === 0 ? (
              <p className="text-ui text-muted-foreground">No events</p>
            ) : null}
          </div>
        </section>
      </div>

      <section className="border border-border bg-card p-3">
        <h2 className="mb-2 font-mono text-label uppercase text-muted-foreground">
          Sanitized tRPC diagnostics · last {DIAGNOSTIC_LIMIT}
        </h2>
        <div className="max-h-72 space-y-1 overflow-auto">
          {diagnostics.map((entry) => (
            <pre key={entry.id} className="whitespace-pre-wrap text-label text-foreground">
              {formatJson(entry)}
            </pre>
          ))}
          {diagnostics.length === 0 ? (
            <p className="text-ui text-muted-foreground">No diagnostics</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportError(error: unknown): void {
  console.error("[session-tracer]", error);
}

function sessionFrame(value: unknown): LabSessionStreamFrame | null {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== "string" ||
    typeof value.sequence !== "number"
  ) {
    return null;
  }
  const transcript = transcriptFrame(value.transcript);
  if (transcript === undefined) return null;
  return { sessionId: value.sessionId, sequence: value.sequence, event: value.event, transcript };
}

function transcriptFrame(value: unknown): LabSessionStreamFrame["transcript"] | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !isRecord(value.message) ||
    typeof value.message.role !== "string" ||
    !Array.isArray(value.message.parts)
  ) {
    return undefined;
  }
  return { message: { role: value.message.role, parts: value.message.parts } };
}

function diagnosticEntry(value: unknown): RpcDiagnosticEntry | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    typeof value.timestamp !== "number" ||
    typeof value.procedure !== "string" ||
    (value.phase !== "start" && value.phase !== "success" && value.phase !== "error") ||
    (value.transport !== "electron-ipc" &&
      value.transport !== "lab-http" &&
      value.transport !== "unknown") ||
    (value.code !== null && typeof value.code !== "string") ||
    (value.message !== null && typeof value.message !== "string")
  ) {
    return null;
  }
  return {
    id: value.id,
    timestamp: value.timestamp,
    procedure: value.procedure,
    phase: value.phase,
    transport: value.transport,
    code: value.code,
    message: value.message,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function recordString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function recordStrings(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
