import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type Context,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import type { RuntimeObservation, TicketRuntimeSpec } from "../contracts";
import { toPiToolNames } from "./tools";
import { createPiAgentRuntime } from "./runtime";

const MODEL_ID = "claude-haiku-4-5";
const PROVIDER_ID = "anthropic";

let credentialedRuntime: ModelRuntime;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "volli-pi-runtime-"));
  credentialedRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
  });
  await credentialedRuntime.setRuntimeApiKey(PROVIDER_ID, "test-key");
});

// --- scripted model stream -------------------------------------------------
//
// The Pi loop, its tools, and its session persistence all run for real; only
// the provider call is scripted. Each entry in the script answers one provider
// request, in order.

type ScriptStep = (
  emit: EmitApi,
  context: Context,
  signal: AbortSignal | undefined,
) => Promise<void> | void;

interface EmitApi {
  thinking(delta: string): void;
  text(delta: string): void;
  toolCall(name: string, args: Record<string, unknown>): void;
  finish(): void;
  fail(message: string): void;
  cancel(): void;
}

function baseMessage(model: Model<string>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function scriptedStream(steps: ScriptStep[]): StreamFn {
  let call = 0;
  return (model, context, options) => {
    const step = steps[call++];
    const stream = createAssistantMessageEventStream();
    const message = baseMessage(model as Model<string>);
    let index = 0;

    const emit: EmitApi = {
      thinking(delta) {
        message.content.push({ type: "thinking", thinking: delta });
        stream.push({ type: "thinking_start", contentIndex: index, partial: message });
        stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: message });
        stream.push({
          type: "thinking_end",
          contentIndex: index,
          content: delta,
          partial: message,
        });
        index += 1;
      },
      text(delta) {
        message.content.push({ type: "text", text: delta });
        stream.push({ type: "text_start", contentIndex: index, partial: message });
        stream.push({ type: "text_delta", contentIndex: index, delta, partial: message });
        stream.push({ type: "text_end", contentIndex: index, content: delta, partial: message });
        index += 1;
      },
      toolCall(name, args) {
        const requested: ToolCall = { type: "toolCall", id: `tc-${index}`, name, arguments: args };
        message.content.push(requested);
        message.stopReason = "toolUse";
        stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
        stream.push({
          type: "toolcall_end",
          contentIndex: index,
          toolCall: requested,
          partial: message,
        });
        index += 1;
      },
      finish() {
        const reason = message.stopReason === "toolUse" ? "toolUse" : "stop";
        stream.push({ type: "done", reason, message });
        stream.end(message);
      },
      fail(detail) {
        message.stopReason = "error";
        message.errorMessage = detail;
        stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
      },
      cancel() {
        message.stopReason = "aborted";
        message.errorMessage = "Aborted";
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end(message);
      },
    };

    void (async () => {
      stream.push({ type: "start", partial: message });
      await step(emit, context, options?.signal);
    })();
    return stream;
  };
}

/** A step that streams one delta, then settles as aborted once the run is cancelled. */
function haltOnAbort(delta: string, onStreaming: () => void): ScriptStep {
  return async (emit, _context, signal) => {
    emit.text(delta);
    onStreaming();
    await new Promise<void>((resolve) => {
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    emit.cancel();
  };
}

// --- fixtures --------------------------------------------------------------

interface Attachment {
  spec: TicketRuntimeSpec;
  observations: RuntimeObservation[];
  worktreePath: string;
  sessionDataDir: string;
}

function fixture(overrides: Partial<TicketRuntimeSpec> = {}): Attachment {
  const root = mkdtempSync(join(tmpdir(), "volli-ticket-"));
  const worktreePath = join(root, "worktree");
  const sessionDataDir = join(root, "sessions");
  mkdirSync(worktreePath, { recursive: true });
  mkdirSync(sessionDataDir, { recursive: true });
  writeFileSync(join(worktreePath, "MARKER.txt"), "volli-marker-42\n");

  const observations: RuntimeObservation[] = [];
  return {
    observations,
    worktreePath,
    sessionDataDir,
    spec: {
      identity: {
        sessionId: "session-1",
        rootThreadId: "thread-1",
        attachmentId: "attachment-1",
        projectId: "project-1",
        ticketId: "ticket-1",
      },
      role: "ticket",
      worktreePath,
      venue: "local",
      model: { providerId: PROVIDER_ID, modelId: MODEL_ID, reasoningLevel: "off" },
      authority: { mode: "auto" },
      brief: { text: "VC-12 — read the marker." },
      tools: { tools: ["read"] },
      observer: (observation) => observations.push(observation),
      ...overrides,
    },
  };
}

function kinds(observations: RuntimeObservation[]): string[] {
  return observations.map((observation) =>
    observation.kind === "turn" || observation.kind === "attachment"
      ? `${observation.kind}:${observation.state}`
      : observation.kind,
  );
}

// --- tests -----------------------------------------------------------------

describe("tool mapping", () => {
  it("names every product tool the way Pi does", () => {
    expect(
      toPiToolNames({ tools: ["read", "edit", "write", "execute", "grep", "find", "list"] }),
    ).toEqual(["read", "edit", "write", "bash", "grep", "find", "ls"]);
  });
});

describe("startTicketSession", () => {
  it("runs the real Pi loop against the worktree and settles durable history", async () => {
    const { spec, observations, sessionDataDir } = fixture();
    let secondCallContext: Context | undefined;

    const runtime = createPiAgentRuntime({
      sessionDataDir,
      modelRuntime: credentialedRuntime,
      modelStream: scriptedStream([
        (emit) => {
          emit.thinking("check the marker");
          emit.text("Reading the file.");
          emit.toolCall("read", { path: "MARKER.txt" });
          emit.finish();
        },
        (emit, context) => {
          secondCallContext = context;
          emit.text("The token is volli-marker-42.");
          emit.finish();
        },
      ]),
    });

    const handle = await runtime.startTicketSession(spec);
    const outcome = await handle.submitUserMessage("Read MARKER.txt and report the token.");

    expect(outcome).toEqual({ kind: "delivered", delivery: "prompt" });
    expect(kinds(observations)).toEqual([
      "attachment:started",
      "turn:started",
      "delta",
      "delta",
      "delta",
      "message-settled",
      "message-settled",
      "turn:completed",
    ]);

    // The read tool really executed against the worktree file.
    expect(JSON.stringify(secondCallContext?.messages)).toContain("volli-marker-42");

    const started = observations[0];
    expect(started).toMatchObject({
      kind: "attachment",
      state: "started",
      recovery: { runtime: "pi", sessionId: expect.any(String) },
    });

    const deltas = observations.filter((observation) => observation.kind === "delta");
    expect(deltas).toEqual([
      { kind: "delta", turnId: expect.any(String), channel: "reasoning", text: "check the marker" },
      { kind: "delta", turnId: expect.any(String), channel: "text", text: "Reading the file." },
      {
        kind: "delta",
        turnId: expect.any(String),
        channel: "text",
        text: "The token is volli-marker-42.",
      },
    ]);

    const settled = observations.filter((observation) => observation.kind === "message-settled");
    expect(settled[0]?.message).toMatchObject({
      role: "assistant",
      text: "Reading the file.",
      reasoning: "check the marker",
      model: { providerId: PROVIDER_ID, modelId: MODEL_ID },
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.003 },
    });
    expect(settled[1]?.message.text).toBe("The token is volli-marker-42.");

    // One prompt() run is one Volli turn, whatever Pi did inside it.
    const turnIds = new Set(
      observations.flatMap((observation) =>
        observation.kind === "turn" ? [observation.turnId] : [],
      ),
    );
    expect(turnIds.size).toBe(1);

    // The JSONL sidecar lives under the host's session directory, and the entry
    // ids the product settled survive a reopen.
    const files = readdirSync(sessionDataDir);
    expect(files).toHaveLength(1);
    const ref = handle.recovery;
    expect(ref?.sessionFilePath).toBe(join(sessionDataDir, files[0] as string));
    expect(existsSync(ref?.sessionFilePath as string)).toBe(true);

    await handle.close();

    const reopened = SessionManager.open(ref?.sessionFilePath as string, sessionDataDir);
    const reopenedIds = reopened.getEntries().map((entry) => entry.id);
    for (const observation of settled) {
      expect(reopenedIds).toContain(observation.message.entryId);
    }
  });

  it("delivers the brief once and plain text afterwards", async () => {
    const { spec, sessionDataDir } = fixture();
    const seen: Context["messages"][] = [];
    const reply: ScriptStep = (emit, context) => {
      seen.push([...context.messages]);
      emit.text("ok");
      emit.finish();
    };

    const runtime = createPiAgentRuntime({
      sessionDataDir,
      modelRuntime: credentialedRuntime,
      modelStream: scriptedStream([reply, reply]),
    });
    const handle = await runtime.startTicketSession(spec);

    await handle.submitUserMessage("first");
    await handle.submitUserMessage("second");
    await handle.close();

    expect(JSON.stringify(seen[0])).toContain("BEGIN TICKET BRIEF");
    const secondUserMessages = JSON.stringify(seen[1]?.slice(2));
    expect(secondUserMessages).toContain("second");
    expect(secondUserMessages).not.toContain("BEGIN TICKET BRIEF");
  });

  it("rejects a second message while the agent is still working", async () => {
    const { spec, sessionDataDir } = fixture();
    const streaming = Promise.withResolvers<void>();

    const runtime = createPiAgentRuntime({
      sessionDataDir,
      modelRuntime: credentialedRuntime,
      modelStream: scriptedStream([haltOnAbort("working", streaming.resolve)]),
    });
    const handle = await runtime.startTicketSession(spec);

    const first = handle.submitUserMessage("go");
    await streaming.promise;
    expect(await handle.submitUserMessage("and also")).toEqual({
      kind: "rejected",
      reason: "busy-unsupported",
      message: "The agent is still working on the previous message.",
    });

    await handle.interrupt();
    await first;
    await handle.close();
  });

  it("interrupts without settling the aborted tail", async () => {
    const { spec, observations, sessionDataDir } = fixture();
    const streaming = Promise.withResolvers<void>();

    const runtime = createPiAgentRuntime({
      sessionDataDir,
      modelRuntime: credentialedRuntime,
      modelStream: scriptedStream([haltOnAbort("half a thought", streaming.resolve)]),
    });
    const handle = await runtime.startTicketSession(spec);

    const delivery = handle.submitUserMessage("go");
    await streaming.promise;
    await handle.interrupt();
    await delivery;

    expect(kinds(observations)).toEqual([
      "attachment:started",
      "turn:started",
      "delta",
      "turn:interrupted",
    ]);

    await handle.close();
    expect(kinds(observations)).toContain("attachment:closed");
  });

  it("interrupts when the caller's abort signal fires", async () => {
    const { spec, observations, sessionDataDir } = fixture();
    const controller = new AbortController();
    const streaming = Promise.withResolvers<void>();

    const runtime = createPiAgentRuntime({
      sessionDataDir,
      modelRuntime: credentialedRuntime,
      modelStream: scriptedStream([haltOnAbort("half a thought", streaming.resolve)]),
    });
    const handle = await runtime.startTicketSession({ ...spec, signal: controller.signal });

    const delivery = handle.submitUserMessage("go");
    await streaming.promise;
    controller.abort();
    await delivery;

    expect(kinds(observations)).toContain("turn:interrupted");
    await handle.close();
  });

  it("rejects delivery after close and closes idempotently", async () => {
    const { spec, observations, sessionDataDir } = fixture();
    const runtime = createPiAgentRuntime({
      sessionDataDir,
      modelRuntime: credentialedRuntime,
      modelStream: scriptedStream([]),
    });
    const handle = await runtime.startTicketSession(spec);

    await handle.close();
    await handle.close();

    expect(kinds(observations)).toEqual(["attachment:started", "attachment:closed"]);
    expect(await handle.submitUserMessage("too late")).toEqual({
      kind: "rejected",
      reason: "closed",
      message: "This attachment is closed.",
    });
  });

  it("fails attachment when the model is not in the runtime catalog", async () => {
    const { spec, observations, sessionDataDir } = fixture({
      model: { providerId: PROVIDER_ID, modelId: "claude-not-a-model", reasoningLevel: "medium" },
    });
    const runtime = createPiAgentRuntime({
      sessionDataDir,
      modelRuntime: credentialedRuntime,
      modelStream: scriptedStream([]),
    });

    await expect(runtime.startTicketSession(spec)).rejects.toThrow(
      "Model anthropic/claude-not-a-model is not available.",
    );
    expect(observations).toEqual([
      {
        kind: "attachment",
        state: "failed",
        failure: {
          reason: "configuration",
          message: "Model anthropic/claude-not-a-model is not available.",
        },
      },
    ]);
  });

  it("reopens a recovered session without re-sending the brief", async () => {
    const { spec, sessionDataDir } = fixture();
    const seen: Context["messages"][] = [];
    const reply: ScriptStep = (emit, context) => {
      seen.push([...context.messages]);
      emit.text("ok");
      emit.finish();
    };

    const runtime = createPiAgentRuntime({
      sessionDataDir,
      modelRuntime: credentialedRuntime,
      modelStream: scriptedStream([reply, reply]),
    });
    const first = await runtime.startTicketSession(spec);
    await first.submitUserMessage("first");
    const ref = first.recovery;
    await first.close();

    const resumedObservations: RuntimeObservation[] = [];
    const resumed = await runtime.startTicketSession({
      ...spec,
      recovery: ref,
      observer: (observation) => resumedObservations.push(observation),
    });

    expect(kinds(resumedObservations)).toEqual(["attachment:recovered"]);
    expect(resumed.recovery).toEqual(ref);

    await resumed.submitUserMessage("second");
    await resumed.close();

    // Two prior messages were replayed from durable history, so only the new
    // plain-text message was appended — the brief did not ride along again.
    expect(seen[1]).toHaveLength(3);
    expect(JSON.stringify(seen[1]?.slice(2))).not.toContain("BEGIN TICKET BRIEF");
    expect(kinds(resumedObservations)).toEqual([
      "attachment:recovered",
      "turn:started",
      "delta",
      "message-settled",
      "turn:completed",
      "attachment:closed",
    ]);
  });

  it("raises auth attention when the provider rejects the credentials", async () => {
    const { spec, observations, sessionDataDir } = fixture();
    const runtime = createPiAgentRuntime({
      sessionDataDir,
      modelRuntime: credentialedRuntime,
      modelStream: scriptedStream([
        (emit) => emit.fail("invalid x-api-key sk-ant-0123456789abcdef"),
      ]),
    });
    const handle = await runtime.startTicketSession(spec);

    await handle.submitUserMessage("go");

    expect(kinds(observations)).toEqual([
      "attachment:started",
      "turn:started",
      "attention",
      "turn:interrupted",
    ]);
    expect(observations[2]).toEqual({
      kind: "attention",
      state: "raised",
      reason: "auth",
      message: "invalid x-api-key [redacted]",
    });
    await handle.close();
  });

  it("raises runtime attention for a non-auth stream failure", async () => {
    const { spec, observations, sessionDataDir } = fixture();
    const runtime = createPiAgentRuntime({
      sessionDataDir,
      modelRuntime: credentialedRuntime,
      modelStream: scriptedStream([(emit) => emit.fail("malformed provider payload")]),
    });
    const handle = await runtime.startTicketSession(spec);

    await handle.submitUserMessage("go");

    expect(observations.filter((observation) => observation.kind === "attention")).toEqual([
      {
        kind: "attention",
        state: "raised",
        reason: "runtime-failure",
        message: "malformed provider payload",
      },
    ]);
    await handle.close();
  });

  it("raises attention and rejects when Pi refuses the prompt outright", async () => {
    // No injected runtime and no scripted stream: this is the production wiring,
    // running against the hermetic empty agent dir, so Pi has no credentials.
    const { spec, observations, sessionDataDir } = fixture();
    const runtime = createPiAgentRuntime({ sessionDataDir });
    const handle = await runtime.startTicketSession(spec);

    await expect(handle.submitUserMessage("go")).rejects.toThrow(/anthropic/);

    expect(observations.filter((observation) => observation.kind === "attention")).toEqual([
      { kind: "attention", state: "raised", reason: "auth", message: expect.any(String) },
    ]);
    await handle.close();
  });
});
