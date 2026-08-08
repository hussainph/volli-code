import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  fauxProvider,
  type AssistantMessage,
  type Context,
  type Model,
  type Models,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vite-plus/test";
import type { RuntimeObservation, TicketRuntimeSpec } from "../contracts";
import { ScopedExecutionEnv, type TicketExecutionEnv } from "./scoped-execution-env";
import { createPiTools } from "./tools";
import { createPiAgentRuntime } from "./runtime";

const MODEL_ID = "claude-haiku-4-5";
const PROVIDER_ID = "anthropic";

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
      if (step === undefined) {
        throw new Error(`scriptedStream: no step for provider call ${call}`);
      }
      await step(emit, context, options?.signal);
    })().catch((error: unknown) => {
      emit.fail(error instanceof Error ? error.message : String(error));
    });
    return stream;
  };
}

function modelsWithStream(stream: StreamFn): Models {
  const faux = fauxProvider({
    api: "anthropic-messages",
    provider: PROVIDER_ID,
    models: [{ id: MODEL_ID, reasoning: true }],
  });
  const models = createModels();
  models.setProvider({
    ...faux.provider,
    streamSimple: stream as typeof faux.provider.streamSimple,
  });
  return models;
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
      observer: async (observation) => {
        observations.push(observation);
      },
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

function jsonlFiles(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(".jsonl"));
}

// --- tests -----------------------------------------------------------------

describe("tool mapping", () => {
  it("binds only the declared contained coding tools from the product bundle", async () => {
    const { worktreePath } = fixture();
    const env = await ScopedExecutionEnv.create(worktreePath);

    expect(
      createPiTools({ tools: ["read", "edit", "write", "execute"] }, env).map((tool) => tool.name),
    ).toEqual(["read", "edit", "write", "bash"]);

    await env.cleanup();
  });
});

describe("startTicketSession", () => {
  it("fails attachment before advertising bash when contained execution cannot prepare", async () => {
    const attachment = fixture({ tools: { tools: ["execute"] } });
    const cleanup = vi.fn(async () => undefined);
    const unavailableEnv = {
      cwd: attachment.worktreePath,
      prepareProcessExecution: async () => ({
        ok: false as const,
        error: new Error("host-specific sandbox failure"),
      }),
      cleanup,
    } as unknown as TicketExecutionEnv;
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
      executionEnvFactory: async () => unavailableEnv,
    });

    await expect(runtime.startTicketSession(attachment.spec)).rejects.toThrow(
      "Contained process execution is unavailable.",
    );
    expect(attachment.observations).toEqual([
      {
        kind: "attachment",
        state: "failed",
        failure: {
          reason: "configuration",
          message: "Contained process execution is unavailable.",
        },
      },
    ]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(jsonlFiles(attachment.sessionDataDir)).toEqual([]);
  });

  it("sanitizes a contained-environment factory rejection before Pi starts", async () => {
    const attachment = fixture({ tools: { tools: ["execute"] } });
    const stream = vi.fn(scriptedStream([]));
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(stream),
      executionEnvFactory: async () => {
        throw new Error("host secret must not reach the attachment observer");
      },
    });

    await expect(runtime.startTicketSession(attachment.spec)).rejects.toThrow(
      "Contained process execution is unavailable.",
    );
    expect(attachment.observations).toEqual([
      {
        kind: "attachment",
        state: "failed",
        failure: {
          reason: "configuration",
          message: "Contained process execution is unavailable.",
        },
      },
    ]);
    expect(jsonlFiles(attachment.sessionDataDir)).toEqual([]);
    expect(stream).not.toHaveBeenCalled();
  });

  it("sanitizes a thrown containment preflight and still cleans the partial attachment", async () => {
    const attachment = fixture({ tools: { tools: ["execute"] } });
    const cleanup = vi.fn(async () => undefined);
    const prepareProcessExecution = vi.fn(async () => {
      throw new Error("host sandbox implementation detail");
    });
    const containedEnv = {
      cwd: attachment.worktreePath,
      prepareProcessExecution,
      cleanup,
    } as unknown as TicketExecutionEnv;
    const stream = vi.fn(scriptedStream([]));
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(stream),
      executionEnvFactory: async () => containedEnv,
    });

    await expect(runtime.startTicketSession(attachment.spec)).rejects.toThrow(
      "Contained process execution is unavailable.",
    );
    expect(prepareProcessExecution).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(attachment.observations).toEqual([
      {
        kind: "attachment",
        state: "failed",
        failure: {
          reason: "configuration",
          message: "Contained process execution is unavailable.",
        },
      },
    ]);
    expect(jsonlFiles(attachment.sessionDataDir)).toEqual([]);
    expect(stream).not.toHaveBeenCalled();
  });

  it("cleans a partial contained attachment when its failure observation rejects", async () => {
    const attachment = fixture({ tools: { tools: ["execute"] } });
    const cleanup = vi.fn(async () => undefined);
    const containedEnv = {
      cwd: attachment.worktreePath,
      prepareProcessExecution: async () => {
        throw new Error("host sandbox implementation detail");
      },
      cleanup,
    } as unknown as TicketExecutionEnv;
    const stream = vi.fn(scriptedStream([]));
    attachment.spec.observer = async (observation) => {
      attachment.observations.push(observation);
      throw new Error("attachment failure persistence rejected");
    };
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(stream),
      executionEnvFactory: async () => containedEnv,
    });

    await expect(runtime.startTicketSession(attachment.spec)).rejects.toThrow(
      "attachment failure persistence rejected",
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(attachment.observations).toEqual([
      {
        kind: "attachment",
        state: "failed",
        failure: {
          reason: "configuration",
          message: "Contained process execution is unavailable.",
        },
      },
    ]);
    expect(jsonlFiles(attachment.sessionDataDir)).toEqual([]);
    expect(stream).not.toHaveBeenCalled();
  });

  it("does not replace an attachment-start failure with contained cleanup failure", async () => {
    const attachment = fixture();
    const cleanup = vi.fn(async () => {
      throw new Error("contained cleanup failed");
    });
    const containedEnv = {
      cwd: attachment.worktreePath,
      prepareProcessExecution: vi.fn(async () => ({ ok: true as const, value: undefined })),
      cleanup,
    } as unknown as TicketExecutionEnv;
    attachment.spec.observer = async (observation) => {
      attachment.observations.push(observation);
      if (observation.kind === "attachment" && observation.state === "started") {
        throw new Error("durable attachment start failed");
      }
    };
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
      executionEnvFactory: async () => containedEnv,
    });

    await expect(runtime.startTicketSession(attachment.spec)).rejects.toThrow(
      "durable attachment start failed",
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(jsonlFiles(attachment.sessionDataDir)).toEqual([]);
  });

  it("runs Pi bash through the prepared contained environment and maps its lifecycle", async () => {
    const attachment = fixture({ tools: { tools: ["execute"] } });
    const cleanup = vi.fn(async () => undefined);
    const exec = vi.fn(
      async (_command: string, options: { onStdout?: (chunk: string) => void }) => {
        options.onStdout?.("execution-marker");
        return {
          ok: true as const,
          value: { stdout: "execution-marker", stderr: "", exitCode: 0 },
        };
      },
    );
    const containedEnv = {
      cwd: attachment.worktreePath,
      prepareProcessExecution: vi.fn(async () => ({ ok: true as const, value: undefined })),
      exec,
      cleanup,
    } as unknown as TicketExecutionEnv;
    let secondCallContext: Context | undefined;
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      executionEnvFactory: async () => containedEnv,
      models: modelsWithStream(
        scriptedStream([
          (emit) => {
            emit.toolCall("bash", { command: "printf execution-marker" });
            emit.finish();
          },
          (emit, context) => {
            secondCallContext = context;
            emit.text("Execution completed.");
            emit.finish();
          },
        ]),
      ),
    });

    const handle = await runtime.startTicketSession(attachment.spec);
    await expect(handle.submitUserMessage("Run the marker command.")).resolves.toEqual({
      kind: "delivered",
      delivery: "prompt",
    });

    expect(containedEnv.prepareProcessExecution).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith(
      "printf execution-marker",
      expect.objectContaining({ cwd: attachment.worktreePath, inheritEnv: true }),
    );
    expect(JSON.stringify(secondCallContext?.messages)).toContain("execution-marker");
    expect(
      attachment.observations.filter((observation) => observation.kind === "activity"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "started",
          input: { command: "printf execution-marker" },
          descriptor: expect.objectContaining({ kind: "run-command", nativeToolName: "bash" }),
        }),
        expect.objectContaining({
          state: "progress",
          input: { command: "printf execution-marker" },
          descriptor: expect.objectContaining({ kind: "run-command", nativeToolName: "bash" }),
        }),
        expect.objectContaining({
          state: "completed",
          input: { command: "printf execution-marker" },
          output: expect.objectContaining({
            content: [{ type: "text", text: "execution-marker" }],
          }),
          descriptor: expect.objectContaining({
            kind: "run-command",
            nativeToolName: "bash",
            outcome: expect.objectContaining({ exitCode: null, summary: "execution-marker" }),
          }),
        }),
      ]),
    );
    expect(attachment.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "message-settled",
          message: expect.objectContaining({ text: "Execution completed." }),
        }),
      ]),
    );

    await handle.close();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("runs the real Pi loop against the worktree and settles durable history", async () => {
    const { spec, observations, sessionDataDir } = fixture();
    let secondCallContext: Context | undefined;

    const runtime = createPiAgentRuntime({
      sessionDataDir,
      models: modelsWithStream(
        scriptedStream([
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
      ),
    });

    const handle = await runtime.startTicketSession(spec);
    const outcome = await handle.submitUserMessage("Read MARKER.txt and report the token.");

    expect(outcome).toEqual({ kind: "delivered", delivery: "prompt" });
    expect(kinds(observations)).toEqual([
      "attachment:started",
      "turn:started",
      "delta",
      "delta",
      "message-settled",
      "activity",
      "activity",
      "delta",
      "message-settled",
      "turn:completed",
    ]);

    expect(
      observations.flatMap((observation) => {
        if (observation.kind === "delta") return [`${observation.channel}:${observation.text}`];
        if (observation.kind === "activity") return [`activity:${observation.state}`];
        return [];
      }),
    ).toEqual([
      "reasoning:check the marker",
      "text:Reading the file.",
      "activity:started",
      "activity:completed",
      "text:The token is volli-marker-42.",
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

    const activities = observations.filter((observation) => observation.kind === "activity");
    expect(activities).toEqual([
      expect.objectContaining({
        kind: "activity",
        state: "started",
        turnId: expect.any(String),
        activityId: expect.any(String),
        input: { path: "MARKER.txt" },
        output: null,
        descriptor: {
          kind: "read-file",
          nativeToolName: "read",
          subject: { label: "MARKER.txt", path: "MARKER.txt", lineRange: null },
          outcome: null,
          startedAt: expect.any(Number),
          endedAt: null,
        },
      }),
      expect.objectContaining({
        kind: "activity",
        state: "completed",
        turnId: expect.any(String),
        activityId: expect.any(String),
        input: { path: "MARKER.txt" },
        output: expect.objectContaining({
          content: [{ type: "text", text: "volli-marker-42\n" }],
        }),
        descriptor: expect.objectContaining({
          kind: "read-file",
          nativeToolName: "read",
          subject: { label: "MARKER.txt", path: "MARKER.txt", lineRange: null },
          outcome: expect.objectContaining({ summary: "volli-marker-42" }),
          startedAt: expect.any(Number),
          endedAt: expect.any(Number),
        }),
      }),
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
    expect(new Set(activities.map((observation) => observation.turnId))).toEqual(turnIds);

    // The JSONL sidecar lives under the host's session directory, and the entry
    // ids the product settled survive a reopen.
    const ref = handle.recovery;
    expect(existsSync(ref?.sessionFilePath as string)).toBe(true);

    await handle.close();

    const sidecar = readFileSync(ref?.sessionFilePath as string, "utf8");
    for (const observation of settled) {
      expect(sidecar).toContain(observation.message.entryId);
    }
  });

  it("keeps an actual Pi read turn inside the Ticket worktree", async () => {
    const { spec, observations, worktreePath, sessionDataDir } = fixture();
    const outsidePath = join(worktreePath, "..", "SECRET.txt");
    writeFileSync(outsidePath, "outside-secret-value\n");
    let toolResultContext: Context | undefined;

    const runtime = createPiAgentRuntime({
      sessionDataDir,
      models: modelsWithStream(
        scriptedStream([
          (emit) => {
            emit.toolCall("read", { path: outsidePath });
            emit.finish();
          },
          (emit, context) => {
            toolResultContext = context;
            emit.text("The read was refused.");
            emit.finish();
          },
        ]),
      ),
    });
    const handle = await runtime.startTicketSession(spec);

    await handle.submitUserMessage("Read the file outside this worktree.");
    await handle.close();

    const serialized = JSON.stringify(toolResultContext?.messages);
    expect(serialized).toContain("outside the Ticket worktree");
    expect(serialized).not.toContain("outside-secret-value");
    expect(observations.filter((observation) => observation.kind === "message-settled")).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ text: "The read was refused." }),
      }),
    ]);
  });

  it("does not complete delivery before durable observation commits", async () => {
    const committed = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    const attachment = fixture();
    attachment.spec.observer = async (observation) => {
      attachment.observations.push(observation);
      if (observation.kind === "message-settled") {
        observed.resolve();
        await committed.promise;
      }
    };
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(
        scriptedStream([
          (emit) => {
            emit.text("durable answer");
            emit.finish();
          },
        ]),
      ),
    });
    const handle = await runtime.startTicketSession(attachment.spec);
    let delivered = false;

    const delivery = handle.submitUserMessage("go").then((outcome) => {
      delivered = true;
      return outcome;
    });
    await observed.promise;
    await Promise.resolve();
    expect(delivered).toBe(false);

    committed.resolve();
    await expect(delivery).resolves.toEqual({ kind: "delivered", delivery: "prompt" });
    expect(kinds(attachment.observations)).toContain("turn:completed");
    await handle.close();
  });

  it("propagates a durable observation failure without poisoning the next delivery", async () => {
    const attachment = fixture();
    let shouldFail = true;
    attachment.spec.observer = async (observation) => {
      attachment.observations.push(observation);
      if (observation.kind === "message-settled" && shouldFail) {
        shouldFail = false;
        throw new Error("durable commit failed");
      }
    };
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(
        scriptedStream(
          ["first answer", "second answer"].map(
            (answer): ScriptStep =>
              (emit) => {
                emit.text(answer);
                emit.finish();
              },
          ),
        ),
      ),
    });
    const handle = await runtime.startTicketSession(attachment.spec);

    await expect(handle.submitUserMessage("go")).rejects.toThrow("durable commit failed");
    await expect(handle.submitUserMessage("retry after repair")).resolves.toEqual({
      kind: "delivered",
      delivery: "prompt",
    });
    await handle.close();
  });

  it("turns scripted model exhaustion and rejected steps into settled failures", async () => {
    for (const steps of [
      [],
      [async () => Promise.reject(new Error("scripted provider rejected"))],
    ] satisfies ScriptStep[][]) {
      const attachment = fixture();
      const runtime = createPiAgentRuntime({
        sessionDataDir: attachment.sessionDataDir,
        models: modelsWithStream(scriptedStream(steps)),
      });
      const handle = await runtime.startTicketSession(attachment.spec);

      await expect(handle.submitUserMessage("go")).resolves.toEqual({
        kind: "delivered",
        delivery: "prompt",
      });
      expect(kinds(attachment.observations)).toContain("attention");
      await handle.close();
    }
  });

  it("cleans partial sidecars when attachment initialization fails", async () => {
    const unusableHost = fixture();
    const sessionDataFile = join(unusableHost.worktreePath, "not-a-directory");
    writeFileSync(sessionDataFile, "blocked\n");
    const unusableRuntime = createPiAgentRuntime({
      sessionDataDir: sessionDataFile,
      models: modelsWithStream(scriptedStream([])),
    });

    await expect(unusableRuntime.startTicketSession(unusableHost.spec)).rejects.toThrow();

    const missingWorktree = fixture();
    missingWorktree.spec.worktreePath = join(missingWorktree.worktreePath, "missing");
    const missingRuntime = createPiAgentRuntime({
      sessionDataDir: missingWorktree.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
    });

    await expect(missingRuntime.startTicketSession(missingWorktree.spec)).rejects.toThrow();
    expect(jsonlFiles(missingWorktree.sessionDataDir)).toEqual([]);

    const rejectedObserver = fixture();
    rejectedObserver.spec.observer = async (observation) => {
      if (observation.kind === "attachment" && observation.state === "started") {
        throw new Error("attachment commit failed");
      }
    };
    const observerRuntime = createPiAgentRuntime({
      sessionDataDir: rejectedObserver.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
    });

    await expect(observerRuntime.startTicketSession(rejectedObserver.spec)).rejects.toThrow(
      "attachment commit failed",
    );
    expect(jsonlFiles(rejectedObserver.sessionDataDir)).toEqual([]);
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
      models: modelsWithStream(scriptedStream([reply, reply])),
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
      models: modelsWithStream(scriptedStream([haltOnAbort("working", streaming.resolve)])),
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
      models: modelsWithStream(scriptedStream([haltOnAbort("half a thought", streaming.resolve)])),
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
      models: modelsWithStream(scriptedStream([haltOnAbort("half a thought", streaming.resolve)])),
    });
    const handle = await runtime.startTicketSession({ ...spec, signal: controller.signal });

    const delivery = handle.submitUserMessage("go");
    await streaming.promise;
    controller.abort();
    await delivery;

    expect(kinds(observations)).toContain("turn:interrupted");
    expect(await handle.submitUserMessage("too late")).toEqual({
      kind: "rejected",
      reason: "closed",
      message: "This attachment is closed.",
    });
    await handle.close();
  });

  it("fails before allocating resources when its signal is already aborted", async () => {
    const attachment = fixture();
    const controller = new AbortController();
    controller.abort();
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
    });

    await expect(
      runtime.startTicketSession({ ...attachment.spec, signal: controller.signal }),
    ).rejects.toThrow("Runtime attachment was cancelled before it started.");
    expect(attachment.observations).toEqual([
      {
        kind: "attachment",
        state: "failed",
        failure: {
          reason: "aborted",
          message: "Runtime attachment was cancelled before it started.",
        },
      },
    ]);
    expect(jsonlFiles(attachment.sessionDataDir)).toEqual([]);
  });

  it("catches cancellation that races attachment initialization", async () => {
    let checks = 0;
    const racingSignal = {
      get aborted() {
        checks += 1;
        return checks > 1;
      },
      reason: undefined,
      onabort: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
      throwIfAborted: () => undefined,
    } as unknown as AbortSignal;
    const attachment = fixture({ signal: racingSignal });
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
    });
    const handle = await runtime.startTicketSession(attachment.spec);

    expect(await handle.submitUserMessage("too late")).toEqual({
      kind: "rejected",
      reason: "closed",
      message: "This attachment is closed.",
    });
    await handle.close();
  });

  it("rejects delivery after close and closes idempotently", async () => {
    const { spec, observations, sessionDataDir } = fixture();
    const runtime = createPiAgentRuntime({
      sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
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
      models: modelsWithStream(scriptedStream([])),
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

  it("raises auth attention when the provider rejects the credentials", async () => {
    const { spec, observations, sessionDataDir } = fixture();
    const runtime = createPiAgentRuntime({
      sessionDataDir,
      models: modelsWithStream(
        scriptedStream([(emit) => emit.fail("invalid x-api-key sk-ant-0123456789abcdef")]),
      ),
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
      models: modelsWithStream(scriptedStream([(emit) => emit.fail("malformed provider payload")])),
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

  it("raises attention when production provider wiring has no credentials", async () => {
    // No injected model collection: this is the production wiring. The Pi
    // Agent represents provider refusal as a failed assistant turn.
    const { spec, observations, sessionDataDir } = fixture();
    const runtime = createPiAgentRuntime({ sessionDataDir });
    const handle = await runtime.startTicketSession(spec);

    await expect(handle.submitUserMessage("go")).resolves.toEqual({
      kind: "delivered",
      delivery: "prompt",
    });

    expect(observations.filter((observation) => observation.kind === "attention")).toEqual([
      { kind: "attention", state: "raised", reason: "auth", message: expect.any(String) },
    ]);
    await handle.close();
  });
});
