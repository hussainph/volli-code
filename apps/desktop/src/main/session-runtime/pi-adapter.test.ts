import { describe, expect, it } from "vite-plus/test";

import type {
  ModelSelectionOutcome,
  AgentRuntime,
  DeliveryOutcome,
  RuntimeAttachmentHandle,
  RuntimeObservation,
  SessionRuntimeSpec,
} from "@volli/agent-runtime";
import type {
  BindingHandle,
  HarnessObservation,
  NativeAttachmentSpec,
  ObservationSink,
} from "@volli/session-engine";
import { NativeAttachmentError } from "@volli/session-engine";
import { ACTIVITY_METADATA_KEY, type ModelAccessSnapshot } from "@volli/shared";
import type { UIMessage } from "ai";

import {
  createPiNativeAdapter,
  createPiRuntimeHost,
  piRootThreadId,
  PI_ADAPTER_ID,
  type PiAdapterOptions,
  type PiRuntimeContext,
} from "./pi-adapter";

const SESSION_ID = "session-1";
const ATTACHMENT_ID = "attachment-1";

const context: PiRuntimeContext = {
  role: "ticket",
  projectId: "project-1",
  ticketId: "ticket-1",
  rootThreadId: piRootThreadId(SESSION_ID),
  brief: "VC-12: Host the Pi runtime",
  model: {
    providerId: "openai-codex",
    modelId: "gpt-5.6-sol",
    reasoningLevel: "high",
  },
};

function attachmentSpec(overrides: Partial<NativeAttachmentSpec> = {}): NativeAttachmentSpec {
  return {
    sessionId: SESSION_ID,
    attachmentId: ATTACHMENT_ID,
    profileId: "native",
    directory: "/work/volli/.worktrees/VC-12",
    continuity: "fresh",
    native: null,
    ...overrides,
  };
}

function userMessage(text: string, id = "message-1"): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

class RecordingSink implements ObservationSink {
  readonly observations: HarnessObservation[] = [];
  #nextFailure: Error | null = null;

  failNext(): void {
    this.#nextFailure = new Error("sink unavailable");
  }

  async emit(observation: HarnessObservation): Promise<void> {
    const failure = this.#nextFailure;
    this.#nextFailure = null;
    if (failure !== null) throw failure;
    this.observations.push(observation);
  }

  kinds(): string[] {
    return this.observations.map((observation) => observation.kind);
  }

  of<Kind extends HarnessObservation["kind"]>(
    kind: Kind,
  ): Extract<HarnessObservation, { kind: Kind }>[] {
    return this.observations.filter(
      (observation): observation is Extract<HarnessObservation, { kind: Kind }> =>
        observation.kind === kind,
    );
  }
}

/** A runtime that records what it was asked to do and hands its observer back to the test. */
class FakeRuntime implements AgentRuntime {
  readonly modelAccessInputs: Array<{ refresh?: boolean; signal?: AbortSignal } | undefined> = [];
  readonly specs: SessionRuntimeSpec[] = [];
  readonly submissions: string[] = [];
  readonly deliveries: Array<Parameters<RuntimeAttachmentHandle["submitUserMessage"]>[1]> = [];
  readonly submissionCommandIds: Array<
    Parameters<RuntimeAttachmentHandle["submitUserMessage"]>[2]
  > = [];
  readonly outcomes: DeliveryOutcome[] = [];
  readonly modelSelections: SessionRuntimeSpec["model"][] = [];
  readonly modelSelectionOutcomes: ModelSelectionOutcome[] = [];
  modelSelectionFailure: unknown = null;
  interrupts = 0;
  retries = 0;
  closes = 0;
  startFailure: unknown = null;
  submitFailure: unknown = null;
  reconciliationCursor: string | null = null;
  readonly reconciliationObservations: RuntimeObservation[] = [];
  readonly reconciliationReceipts: Array<{ commandId: string; acceptedAt: number }> = [];
  readonly reconciledFrom: Array<string | null> = [];
  recovery: RuntimeAttachmentHandle["recovery"] = {
    runtime: "pi",
    sessionId: "pi-session-9",
    sessionFilePath: "/data/pi-sessions/pi-session-9.jsonl",
  };
  #observe: SessionRuntimeSpec["observer"] | null = null;

  async inspectModelAccess(input?: {
    refresh?: boolean;
    signal?: AbortSignal;
  }): Promise<ModelAccessSnapshot> {
    this.modelAccessInputs.push(input);
    return { observedAt: 0, providers: [], models: [] };
  }

  async startSession(spec: SessionRuntimeSpec): Promise<RuntimeAttachmentHandle> {
    this.specs.push(spec);
    this.#observe = spec.observer;
    if (this.startFailure !== null) throw this.startFailure;
    return {
      submitUserMessage: async (text, delivery, commandId): Promise<DeliveryOutcome> => {
        this.submissions.push(text);
        this.deliveries.push(delivery);
        this.submissionCommandIds.push(commandId);
        if (this.submitFailure !== null) throw this.submitFailure;
        return this.outcomes.shift() ?? { kind: "delivered", delivery: "prompt" };
      },
      selectModel: async (selection): Promise<ModelSelectionOutcome> => {
        this.modelSelections.push(selection);
        if (this.modelSelectionFailure !== null) throw this.modelSelectionFailure;
        return this.modelSelectionOutcomes.shift() ?? { kind: "selected" };
      },
      interrupt: async (): Promise<void> => {
        this.interrupts += 1;
      },
      retry: async (commandId): Promise<DeliveryOutcome> => {
        this.retries += 1;
        this.submissionCommandIds.push(commandId);
        if (this.submitFailure !== null) throw this.submitFailure;
        return this.outcomes.shift() ?? { kind: "delivered", delivery: "retry" };
      },
      close: async (): Promise<void> => {
        this.closes += 1;
      },
      reconcile: async (cursor) => {
        this.reconciledFrom.push(cursor);
        return {
          cursor: this.reconciliationCursor ?? cursor,
          observations: [...this.reconciliationObservations],
          receipts: [...this.reconciliationReceipts],
        };
      },
      recovery: this.recovery,
    };
  }

  get spec(): SessionRuntimeSpec {
    const spec = this.specs.at(-1);
    if (!spec) throw new Error("The runtime was never started");
    return spec;
  }

  observe(observation: RuntimeObservation): Promise<void> {
    if (!this.#observe) throw new Error("The runtime was never started");
    return this.#observe(observation);
  }
}

function composition(overrides: Partial<PiAdapterOptions> = {}): {
  adapter: ReturnType<typeof createPiNativeAdapter>;
  runtime: FakeRuntime;
} {
  const runtime = new FakeRuntime();
  let clock = 1_000;
  const adapter = createPiNativeAdapter({
    sessionDataDir: "/data/pi-sessions",
    resolveRuntimeContext: async () => context,
    createRuntime: () => runtime,
    now: () => clock++,
    ...overrides,
  });
  return { adapter, runtime };
}

async function attached(
  overrides: Partial<PiAdapterOptions> = {},
  spec = attachmentSpec(),
): Promise<{ binding: BindingHandle; runtime: FakeRuntime; sink: RecordingSink }> {
  const { adapter, runtime } = composition(overrides);
  const sink = new RecordingSink();
  const binding = await adapter.attach(spec, sink);
  return { binding, runtime, sink };
}

describe("Pi native adapter manifest", () => {
  it("declares one id and exactly one native profile", () => {
    const { adapter } = composition();
    expect(adapter.manifest.id).toBe(PI_ADAPTER_ID);
    expect(adapter.manifest.profiles).toEqual([
      { id: "native", label: "Native", transport: "native" },
    ]);
  });
});

describe("Pi runtime host", () => {
  it("owns Model Access and attachment through one runtime instance", async () => {
    const runtime = new FakeRuntime();
    let creations = 0;
    const host = createPiRuntimeHost({
      sessionDataDir: "/data/pi-sessions",
      resolveRuntimeContext: async () => context,
      createRuntime: () => {
        creations += 1;
        return runtime;
      },
    });

    await host.inspectModelAccess({ refresh: true });
    await host.adapter.attach(attachmentSpec(), new RecordingSink());

    expect(creations).toBe(1);
    expect(runtime.modelAccessInputs).toEqual([{ refresh: true }]);
    expect(runtime.specs).toHaveLength(1);
  });
});

describe("Pi native adapter probe", () => {
  it("reports the pinned runtime and the features the engine gates delivery on", async () => {
    const { adapter } = composition();

    const result = await adapter.probe(
      { profileId: "native", directory: "/work" },
      new AbortController().signal,
    );

    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.runtime.version).toBe("0.84.1");
    expect(
      result.capabilities.features
        .filter((feature) => feature.state === "available")
        .map((f) => f.id),
    ).toEqual(["message.submit", "executor.interrupt"]);
    // The adapter has no model of its own to declare, and what a probe declares
    // becomes a durable `capabilities.updated` fact — so it declares nothing
    // rather than a literal the running Session may not match.
    expect(result.capabilities.catalog).toEqual([]);
  });

  it("refuses a profile it does not have", async () => {
    const { adapter } = composition();

    const result = await adapter.probe(
      { profileId: "terminal", directory: "/work" },
      new AbortController().signal,
    );

    expect(result).toEqual({
      status: "unavailable",
      runtime: null,
      reason: "Unknown Pi profile terminal",
    });
  });
});

describe("Pi native adapter attach", () => {
  it("starts a ticket session in the prepared directory with the pinned model and brief", async () => {
    const { runtime, binding } = await attached();

    const spec = runtime.spec;
    expect(spec.identity).toEqual({
      role: "ticket",
      sessionId: SESSION_ID,
      rootThreadId: piRootThreadId(SESSION_ID),
      attachmentId: ATTACHMENT_ID,
      projectId: "project-1",
      ticketId: "ticket-1",
    });
    expect(spec.venue).toBe("local");
    expect(spec.workspacePath).toBe("/work/volli/.worktrees/VC-12");
    expect(spec.model).toEqual(context.model);
    expect(spec.authority).toEqual({ mode: "auto" });
    expect(spec.tools).toEqual({ tools: ["read", "edit", "write", "execute"] });
    expect(spec.brief).toEqual({ text: "VC-12: Host the Pi runtime" });
    expect(spec.signal?.aborted).toBe(false);
    // Session 4 reopens the sidecar from exactly these three fields.
    expect(binding.native).toEqual({
      id: "pi-session-9",
      detail: {
        runtime: "pi",
        sessionId: "pi-session-9",
        sessionFilePath: "/data/pi-sessions/pi-session-9.jsonl",
      },
    });
  });

  it("passes the injected model collection and session directory to the runtime factory", async () => {
    const seen: { sessionDataDir: string; models: unknown }[] = [];
    const models = { getModel: () => undefined } as unknown as NonNullable<
      PiAdapterOptions["models"]
    >;
    const adapter = createPiNativeAdapter({
      sessionDataDir: "/data/pi-sessions",
      resolveRuntimeContext: async () => context,
      models,
      createRuntime: (options) => {
        seen.push({ sessionDataDir: options.sessionDataDir, models: options.models });
        return new FakeRuntime();
      },
    });

    expect(adapter.manifest.id).toBe(PI_ADAPTER_ID);
    expect(seen).toEqual([{ sessionDataDir: "/data/pi-sessions", models }]);
  });

  it("starts a ticketless project Session in the project root under the project Role", async () => {
    const { runtime } = await attached(
      {
        resolveRuntimeContext: async () => ({
          role: "project",
          projectId: "project-1",
          ticketId: null,
          rootThreadId: piRootThreadId(SESSION_ID),
          brief: "A project-scoped chat Session.",
          model: context.model,
        }),
      },
      attachmentSpec({ directory: "/work/volli" }),
    );

    const spec = runtime.spec;
    expect(spec.identity).toEqual({
      role: "project",
      sessionId: SESSION_ID,
      rootThreadId: piRootThreadId(SESSION_ID),
      attachmentId: ATTACHMENT_ID,
      projectId: "project-1",
      ticketId: null,
    });
    expect(spec.workspacePath).toBe("/work/volli");
    expect(spec.brief).toEqual({ text: "A project-scoped chat Session." });
    expect(spec.model).toEqual(context.model);
    expect(spec.tools).toEqual({ tools: ["read", "edit", "write", "execute"] });
  });

  it("fails a Session that lacks its runtime context", async () => {
    const { adapter, runtime } = composition({ resolveRuntimeContext: async () => null });

    await expect(adapter.attach(attachmentSpec(), new RecordingSink())).rejects.toThrow(
      /Session with a selected model and Runtime Brief/,
    );
    expect(runtime.specs).toHaveLength(0);
  });

  it("passes a persisted Pi recovery reference into the runtime", async () => {
    const { adapter, runtime } = composition();
    const recovery = {
      runtime: "pi" as const,
      sessionId: "pi-session-previous",
      sessionFilePath: "/data/pi-sessions/pi-session-previous.jsonl",
    };

    await adapter.attach(
      attachmentSpec({
        continuity: "native_resume",
        native: { id: recovery.sessionId, detail: recovery },
      }),
      new RecordingSink(),
    );

    expect(runtime.spec.recovery).toEqual(recovery);
  });

  it.each([null, "not-an-object", []])(
    "classifies missing or non-object Pi recovery detail as unrecoverable (%s)",
    async (detail) => {
      const { adapter, runtime } = composition();

      const rejection = adapter.attach(
        attachmentSpec({
          continuity: "native_resume",
          native: { id: "pi-session-previous", detail },
        }),
        new RecordingSink(),
      );

      const error: unknown = await rejection.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NativeAttachmentError);
      expect(error).toMatchObject({
        code: "PI_RECOVERY_FAILED",
        attentionKind: "adapter_unrecoverable",
      });
      expect(runtime.specs).toHaveLength(0);
    },
  );

  it("classifies a Pi native id and recovery session id mismatch as unrecoverable", async () => {
    const { adapter, runtime } = composition();

    const rejection = adapter.attach(
      attachmentSpec({
        continuity: "native_resume",
        native: {
          id: "pi-session-native",
          detail: {
            runtime: "pi",
            sessionId: "pi-session-detail",
            sessionFilePath: "/data/pi-sessions/pi-session-detail.jsonl",
          },
        },
      }),
      new RecordingSink(),
    );

    const error: unknown = await rejection.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NativeAttachmentError);
    expect(error).toMatchObject({
      code: "PI_RECOVERY_FAILED",
      attentionKind: "adapter_unrecoverable",
    });
    expect(runtime.specs).toHaveLength(0);
  });

  it("refuses a profile it does not have", async () => {
    const { adapter } = composition();

    await expect(
      adapter.attach(attachmentSpec({ profileId: "terminal" }), new RecordingSink()),
    ).rejects.toThrow("Unknown Pi profile terminal");
  });

  it("says nothing to the Session about the attachment the engine records itself", async () => {
    const { runtime, sink } = await attached();

    await runtime.observe({ kind: "attachment", state: "started" });

    expect(sink.observations).toEqual([]);
  });

  it("leaves a binding with no recovery reference addressable by nothing", async () => {
    const runtime = new FakeRuntime();
    runtime.recovery = undefined;
    const adapter = createPiNativeAdapter({
      sessionDataDir: "/data/pi-sessions",
      resolveRuntimeContext: async () => context,
      createRuntime: () => runtime,
    });

    const binding = await adapter.attach(attachmentSpec(), new RecordingSink());

    expect(binding.native).toEqual({ id: null, detail: null });
  });
});

describe("Pi native adapter observation translation", () => {
  it("opens and closes a turn", async () => {
    const { runtime, sink } = await attached();

    await runtime.observe({ kind: "turn", state: "started", turnId: "turn-1" });
    await runtime.observe({ kind: "turn", state: "completed", turnId: "turn-1" });

    expect(sink.observations).toEqual([
      { id: "pi:turn:turn-1:started", kind: "turn.started", occurredAt: 1000, turnId: "turn-1" },
      {
        id: "pi:turn:turn-1:completed",
        kind: "turn.completed",
        occurredAt: 1001,
        turnId: "turn-1",
      },
    ]);
  });

  it("records an interrupted turn without pretending it completed", async () => {
    const { runtime, sink } = await attached();

    await runtime.observe({ kind: "turn", state: "interrupted", turnId: "turn-1" });

    expect(sink.kinds()).toEqual(["turn.interrupted"]);
  });

  it("opens a streamed message with a reset and grows it with appends", async () => {
    const { runtime, sink } = await attached();

    await runtime.observe({ kind: "turn", state: "started", turnId: "turn-1" });
    await runtime.observe({ kind: "delta", turnId: "turn-1", channel: "text", text: "He" });
    await runtime.observe({ kind: "delta", turnId: "turn-1", channel: "text", text: "llo" });

    const deltas = sink.of("transcript.delta");
    const messageId = `pi:${ATTACHMENT_ID}:turn-1:0`;
    expect(deltas.map((delta) => delta.messageId)).toEqual([messageId, messageId, messageId]);
    expect(deltas.map((delta) => delta.delta)).toEqual([
      { op: "reset", message: { id: messageId, role: "assistant", parts: [] } },
      {
        op: "part.upsert",
        key: "text",
        index: 0,
        part: { type: "text", text: "He", state: "streaming" },
      },
      { op: "part.append", key: "text", text: "llo" },
    ]);
    expect(deltas[0].threadId).toBe(piRootThreadId(SESSION_ID));
    expect(deltas[0].branchId).toBe(`branch:${SESSION_ID}:main`);
    expect(deltas[0].attemptId).toBe(`attempt:${messageId}`);
  });

  it("carries a reasoning delta as the overlay's own reasoning part, ahead of the text", async () => {
    const { runtime, sink } = await attached();

    await runtime.observe({ kind: "turn", state: "started", turnId: "turn-1" });
    await runtime.observe({ kind: "delta", turnId: "turn-1", channel: "reasoning", text: "think" });
    await runtime.observe({ kind: "delta", turnId: "turn-1", channel: "reasoning", text: "ing" });
    await runtime.observe({ kind: "delta", turnId: "turn-1", channel: "text", text: "done" });

    expect(sink.of("transcript.delta").map((delta) => delta.delta)).toEqual([
      {
        op: "reset",
        message: { id: `pi:${ATTACHMENT_ID}:turn-1:0`, role: "assistant", parts: [] },
      },
      {
        op: "part.upsert",
        key: "reasoning",
        index: 0,
        part: { type: "reasoning", text: "think", state: "streaming" },
      },
      { op: "part.append", key: "reasoning", text: "ing" },
      {
        op: "part.upsert",
        key: "text",
        index: 1,
        part: { type: "text", text: "done", state: "streaming" },
      },
    ]);
  });

  it("projects execute lifecycle into a generic stamped tool and durable result", async () => {
    const { runtime, sink } = await attached();

    await runtime.observe({ kind: "turn", state: "started", turnId: "turn-1" });
    await runtime.observe({
      kind: "delta",
      turnId: "turn-1",
      channel: "reasoning",
      text: "checking",
    });
    await runtime.observe({
      kind: "activity",
      turnId: "turn-1",
      activityId: "call-7",
      state: "started",
      descriptor: {
        kind: "run-command",
        nativeToolName: "bash",
        subject: { label: "vp test", path: null, lineRange: null },
        outcome: null,
        startedAt: 10,
        endedAt: null,
      },
      input: { command: "vp test" },
      output: null,
    });
    await runtime.observe({
      kind: "activity",
      turnId: "turn-1",
      activityId: "call-7",
      state: "progress",
      descriptor: {
        kind: "run-command",
        nativeToolName: "bash",
        subject: { label: "vp test", path: null, lineRange: null },
        outcome: null,
        startedAt: 10,
        endedAt: null,
      },
      input: { command: "vp test" },
      output: { content: "partial" },
    });
    await runtime.observe({
      kind: "activity",
      turnId: "turn-1",
      activityId: "call-7",
      state: "completed",
      descriptor: {
        kind: "run-command",
        nativeToolName: "bash",
        subject: { label: "vp test", path: null, lineRange: null },
        outcome: {
          exitCode: 0,
          matchCount: null,
          fileCount: null,
          lineCount: 1,
          bytes: 7,
          addedLines: null,
          removedLines: null,
          diff: null,
          summary: "partial",
        },
        startedAt: 10,
        endedAt: 20,
      },
      input: { command: "vp test" },
      output: { content: "complete" },
    });
    await runtime.observe({ kind: "delta", turnId: "turn-1", channel: "text", text: "Done." });

    const activityMessageId = `pi:${ATTACHMENT_ID}:turn-1:activity:call-7`;
    const activityDeltas = sink
      .of("transcript.delta")
      .filter((observation) => observation.messageId === activityMessageId);
    expect(activityDeltas.map((observation) => observation.delta)).toEqual([
      { op: "reset", message: { id: activityMessageId, role: "assistant", parts: [] } },
      expect.objectContaining({
        op: "part.upsert",
        key: "activity:call-7",
        index: 0,
        part: expect.objectContaining({
          type: "dynamic-tool",
          toolName: "volli.activity",
          toolCallId: "call-7",
          state: "input-available",
          input: { command: "vp test" },
        }),
      }),
      expect.objectContaining({
        op: "part.upsert",
        key: "activity:call-7",
        index: 0,
        part: expect.objectContaining({
          type: "dynamic-tool",
          toolName: "volli.activity",
          toolCallId: "call-7",
          state: "output-available",
          input: { command: "vp test" },
          output: { content: "partial" },
          preliminary: true,
        }),
      }),
    ]);

    const [settled] = sink.of("transcript.message");
    expect(settled).toMatchObject({
      id: `pi:activity:${ATTACHMENT_ID}:turn-1:call-7:completed`,
      threadId: piRootThreadId(SESSION_ID),
      branchId: `branch:${SESSION_ID}:main`,
      attemptId: `attempt:${activityMessageId}`,
      turnId: "turn-1",
      message: {
        id: activityMessageId,
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "volli.activity",
            toolCallId: "call-7",
            state: "output-available",
            input: { command: "vp test" },
            output: { content: "complete" },
            toolMetadata: {
              [ACTIVITY_METADATA_KEY]: expect.objectContaining({
                kind: "run-command",
                nativeToolName: "bash",
              }),
            },
          },
        ],
      },
    });
    expect(settled.cursor).toBeUndefined();
    expect(
      sink.of("transcript.delta").map((observation) => [observation.messageId, observation.delta]),
    ).toContainEqual([
      `pi:${ATTACHMENT_ID}:turn-1:0`,
      {
        op: "part.upsert",
        key: "text",
        index: 1,
        part: { type: "text", text: "Done.", state: "streaming" },
      },
    ]);
  });

  it("settles failed activity as a durable generic tool error", async () => {
    const { runtime, sink } = await attached();

    await runtime.observe({
      kind: "activity",
      turnId: "turn-1",
      activityId: "call-8",
      state: "failed",
      descriptor: {
        kind: "other",
        nativeToolName: "custom_reader",
        subject: { label: "config", path: null, lineRange: null },
        outcome: null,
        startedAt: 10,
        endedAt: 20,
      },
      input: { file: "config" },
      output: { message: "denied" },
      error: "The file could not be read.",
    });

    const [settled] = sink.of("transcript.message");
    expect(settled.id).toBe(`pi:activity:${ATTACHMENT_ID}:turn-1:call-8:failed`);
    expect(settled.cursor).toBeUndefined();
    expect(settled.message).toEqual({
      id: `pi:${ATTACHMENT_ID}:turn-1:activity:call-8`,
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "volli.activity",
          toolCallId: "call-8",
          state: "output-error",
          input: { file: "config" },
          errorText: "The file could not be read.",
          toolMetadata: {
            [ACTIVITY_METADATA_KEY]: {
              kind: "other",
              nativeToolName: "custom_reader",
              subject: { label: "config", path: null, lineRange: null },
              outcome: null,
              startedAt: 10,
              endedAt: 20,
            },
          },
        },
      ],
    });
  });

  it("withdraws activity overlays a completed or interrupted turn cannot settle", async () => {
    const { runtime, sink } = await attached();

    await runtime.observe({ kind: "turn", state: "started", turnId: "turn-1" });
    await runtime.observe({
      kind: "activity",
      turnId: "turn-1",
      activityId: "call-active",
      state: "started",
      descriptor: {
        kind: "search",
        nativeToolName: "grep",
        subject: { label: "needle", path: null, lineRange: null },
        outcome: null,
        startedAt: 10,
        endedAt: null,
      },
      input: { pattern: "needle" },
      output: null,
    });
    await runtime.observe({ kind: "turn", state: "interrupted", turnId: "turn-1" });
    await runtime.observe({ kind: "turn", state: "started", turnId: "turn-2" });
    await runtime.observe({
      kind: "activity",
      turnId: "turn-2",
      activityId: "call-complete",
      state: "started",
      descriptor: {
        kind: "search",
        nativeToolName: "grep",
        subject: { label: "other", path: null, lineRange: null },
        outcome: null,
        startedAt: 20,
        endedAt: null,
      },
      input: { pattern: "other" },
      output: null,
    });
    await runtime.observe({ kind: "turn", state: "completed", turnId: "turn-2" });

    expect(sink.of("transcript.message")).toEqual([]);
    expect(
      sink
        .of("transcript.delta")
        .filter((observation) => observation.delta.op === "message.remove")
        .map((observation) => observation.messageId),
    ).toEqual([
      `pi:${ATTACHMENT_ID}:turn-1:activity:call-active`,
      `pi:${ATTACHMENT_ID}:turn-2:activity:call-complete`,
    ]);
  });

  it("keeps an activity overlay tracked until its reset, settlement, or removal reaches the Session", async () => {
    const { runtime, sink } = await attached();
    const started = {
      kind: "activity" as const,
      turnId: "turn-1",
      activityId: "call-retry",
      state: "started" as const,
      descriptor: {
        kind: "read-file" as const,
        nativeToolName: "read",
        subject: { label: "src/retry.ts", path: "src/retry.ts", lineRange: null },
        outcome: null,
        startedAt: 10,
        endedAt: null,
      },
      input: { path: "src/retry.ts" },
      output: null,
    };

    sink.failNext();
    await expect(runtime.observe(started)).rejects.toThrow("sink unavailable");
    await runtime.observe(started);

    const activityMessageId = `pi:${ATTACHMENT_ID}:turn-1:activity:call-retry`;
    expect(sink.of("transcript.delta").map((observation) => observation.delta.op)).toEqual([
      "reset",
      "part.upsert",
    ]);

    sink.failNext();
    await expect(
      runtime.observe({
        ...started,
        state: "completed",
        descriptor: { ...started.descriptor, endedAt: 20 },
        output: { content: "complete" },
      }),
    ).rejects.toThrow("sink unavailable");
    await runtime.observe({ kind: "turn", state: "completed", turnId: "turn-1" });

    expect(sink.of("transcript.delta").at(-1)).toMatchObject({
      messageId: activityMessageId,
      delta: { op: "message.remove" },
    });
  });

  it("retries a failed closed-turn activity removal on the next turn without repeating it", async () => {
    const { runtime, sink } = await attached();
    const activityMessageId = `pi:${ATTACHMENT_ID}:turn-1:activity:call-retry-later`;

    await runtime.observe({ kind: "turn", state: "started", turnId: "turn-1" });
    await runtime.observe({
      kind: "activity",
      turnId: "turn-1",
      activityId: "call-retry-later",
      state: "started",
      descriptor: {
        kind: "read-file",
        nativeToolName: "read",
        subject: { label: "src/retry.ts", path: "src/retry.ts", lineRange: null },
        outcome: null,
        startedAt: 10,
        endedAt: null,
      },
      input: { path: "src/retry.ts" },
      output: null,
    });

    sink.failNext();
    await expect(
      runtime.observe({ kind: "turn", state: "completed", turnId: "turn-1" }),
    ).rejects.toThrow("sink unavailable");

    await runtime.observe({ kind: "turn", state: "started", turnId: "turn-2" });
    await runtime.observe({ kind: "turn", state: "started", turnId: "turn-3" });

    expect(
      sink
        .of("transcript.delta")
        .filter((observation) => observation.delta.op === "message.remove")
        .map((observation) => observation.messageId),
    ).toEqual([activityMessageId]);
  });

  it("retires the provisional overlay before settling under the stable Pi entry id", async () => {
    const { runtime, sink } = await attached();

    await runtime.observe({ kind: "turn", state: "started", turnId: "turn-1" });
    await runtime.observe({ kind: "delta", turnId: "turn-1", channel: "text", text: "Hello" });
    await runtime.observe({
      kind: "message-settled",
      turnId: "turn-1",
      message: {
        entryId: "entry-7",
        role: "assistant",
        text: "Hello",
        reasoning: "thinking",
        model: { providerId: "openai-codex", modelId: "gpt-5.6-terra" },
        usage: { inputTokens: 11, outputTokens: 3, costUsd: 0.5 },
      },
      occurredAt: 42,
      recoveryCursor: "marker-7",
    });

    const [settled] = sink.of("transcript.message");
    const provisionalId = `pi:${ATTACHMENT_ID}:turn-1:0`;
    const messageId = `pi:${ATTACHMENT_ID}:entry:entry-7`;
    expect(settled.id).toBe("pi:message:entry-7");
    expect(settled.message.id).toBe(messageId);
    expect(sink.of("transcript.delta").at(-1)).toMatchObject({
      messageId: provisionalId,
      delta: { op: "message.remove" },
    });
    expect(settled.threadId).toBe(piRootThreadId(SESSION_ID));
    expect(settled.branchId).toBe(`branch:${SESSION_ID}:main`);
    expect(settled.attemptId).toBe(`attempt:${messageId}`);
    expect(settled.turnId).toBe("turn-1");
    expect(settled.cursor).toEqual({ entryId: "marker-7" });
    expect(settled.message.parts).toEqual([
      { type: "reasoning", text: "thinking", state: "done" },
      { type: "text", text: "Hello", state: "done" },
    ]);
    expect(settled.message.metadata).toEqual({
      providerId: "openai-codex",
      modelId: "gpt-5.6-terra",
      cost: 0.5,
      tokens: { input: 11, output: 3, reasoning: null, cacheRead: null, cacheWrite: null },
    });
  });

  it("gives each message of a turn its own id, and starts over on the next turn", async () => {
    const { runtime, sink } = await attached();

    await runtime.observe({ kind: "turn", state: "started", turnId: "turn-1" });
    await runtime.observe({ kind: "delta", turnId: "turn-1", channel: "text", text: "one" });
    await runtime.observe({
      kind: "message-settled",
      turnId: "turn-1",
      message: { entryId: "entry-1", role: "assistant", text: "one" },
    });
    await runtime.observe({ kind: "delta", turnId: "turn-1", channel: "text", text: "two" });
    await runtime.observe({
      kind: "message-settled",
      turnId: "turn-1",
      message: { entryId: "entry-2", role: "assistant", text: "two" },
    });
    await runtime.observe({ kind: "turn", state: "started", turnId: "turn-2" });
    await runtime.observe({
      kind: "message-settled",
      turnId: "turn-2",
      message: { entryId: "entry-3", role: "assistant", text: "three" },
    });

    expect(sink.of("transcript.message").map((message) => message.message.id)).toEqual([
      `pi:${ATTACHMENT_ID}:entry:entry-1`,
      `pi:${ATTACHMENT_ID}:entry:entry-2`,
      `pi:${ATTACHMENT_ID}:entry:entry-3`,
    ]);
  });

  it("omits metadata a settled message has nothing to say about", async () => {
    const { runtime, sink } = await attached();

    await runtime.observe({
      kind: "message-settled",
      turnId: "turn-1",
      message: { entryId: "entry-1", role: "assistant", text: "bare" },
    });

    const [settled] = sink.of("transcript.message");
    expect(settled.message.metadata).toBeUndefined();
    expect(settled.message.parts).toEqual([{ type: "text", text: "bare", state: "done" }]);
  });

  it("withdraws a transient claim a settled message has nothing durable to replace", async () => {
    const { runtime, sink } = await attached();

    await runtime.observe({ kind: "delta", turnId: "turn-1", channel: "text", text: "..." });
    await runtime.observe({
      kind: "message-settled",
      turnId: "turn-1",
      message: { entryId: "entry-1", role: "assistant", text: "" },
    });

    expect(sink.of("transcript.message")).toEqual([]);
    expect(sink.of("transcript.delta").at(-1)?.delta).toEqual({ op: "message.remove" });
  });

  it("withdraws an in-flight message no turn is left to finish", async () => {
    const { runtime, sink } = await attached();

    await runtime.observe({ kind: "turn", state: "started", turnId: "turn-1" });
    await runtime.observe({ kind: "delta", turnId: "turn-1", channel: "text", text: "half" });
    await runtime.observe({ kind: "turn", state: "interrupted", turnId: "turn-1" });

    expect(sink.kinds()).toEqual([
      "turn.started",
      "transcript.delta",
      "transcript.delta",
      "transcript.delta",
      "turn.interrupted",
    ]);
    expect(sink.of("transcript.delta").at(-1)?.delta).toEqual({ op: "message.remove" });
  });

  it("raises and clears attention under one id per reason", async () => {
    const { runtime, sink } = await attached();

    await runtime.observe({
      kind: "attention",
      state: "raised",
      reason: "auth",
      message: "Log in to openai-codex to continue.",
    });
    await runtime.observe({ kind: "attention", state: "cleared", reason: "auth", message: "" });

    const attentionId = `pi:attention:${ATTACHMENT_ID}:auth`;
    expect(sink.of("attention.raised")[0].attention).toEqual({
      id: attentionId,
      kind: "auth_required",
      detail: "Log in to openai-codex to continue.",
      diagnostic: null,
    });
    expect(sink.of("attention.cleared")[0].attentionId).toBe(attentionId);
  });

  it("maps every runtime attention reason onto product vocabulary", async () => {
    const { runtime, sink } = await attached();

    for (const reason of [
      "auth",
      "configuration",
      "context",
      "runtime-failure",
      "partial-turn",
    ] as const) {
      await runtime.observe({ kind: "attention", state: "raised", reason, message: reason });
    }

    expect(sink.of("attention.raised").map((raised) => raised.attention.kind)).toEqual([
      "auth_required",
      "configuration_invalid",
      "context_limit_reached",
      "adapter_unrecoverable",
      "partial_turn_interrupted",
    ]);
  });

  it("reports a runtime failure that lands after the attachment opened", async () => {
    const { runtime, sink } = await attached();

    await runtime.observe({
      kind: "attachment",
      state: "failed",
      failure: { reason: "model", message: "Model is unavailable." },
    });

    expect(sink.of("attachment.failed")[0].detail).toBe("Model is unavailable.");
  });

  it("reports a close the Session did not ask for", async () => {
    const { runtime, sink } = await attached();

    await runtime.observe({ kind: "attachment", state: "closed" });

    expect(sink.of("attachment.closed")[0].outcome).toBe("completed");
  });

  it("ignores a recovery it did not perform", async () => {
    const { runtime, sink } = await attached();

    await runtime.observe({ kind: "attachment", state: "recovered" });

    expect(sink.observations).toEqual([]);
  });
});

describe("Pi native adapter dispatch", () => {
  it("delivers the message text and accepts it", async () => {
    const { binding, runtime } = await attached();

    const receipt = await binding.dispatch({
      kind: "message.submit",
      commandId: "command-1",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      message: userMessage("Ship the facade"),
      delivery: "queue",
      // Ignored: the picker that named this is still OpenCode's.
      model: { providerId: "anthropic", modelId: "claude-haiku-4-5" },
      agent: "build",
      variant: "fast",
    });

    expect(runtime.submissions).toEqual(["Ship the facade"]);
    expect(runtime.submissionCommandIds).toEqual(["command-1"]);
    expect(receipt).toEqual({
      commandId: "command-1",
      status: "accepted",
      acceptedAt: 1000,
      native: binding.native,
    });
  });

  it("joins every text part a message carries", async () => {
    const { binding, runtime } = await attached();

    await binding.dispatch({
      kind: "message.submit",
      commandId: "command-1",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      message: {
        id: "message-1",
        role: "user",
        parts: [
          { type: "text", text: "first" },
          { type: "reasoning", text: "ignored" },
          { type: "text", text: "second" },
        ],
      },
      delivery: "queue",
      model: null,
      agent: null,
      variant: null,
    });

    expect(runtime.submissions).toEqual(["first\n\nsecond"]);
  });

  it("forwards queue and steer delivery to the runtime without conflating them", async () => {
    const { binding, runtime } = await attached();

    await binding.dispatch({
      kind: "message.submit",
      commandId: "command-queue",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      message: userMessage("later"),
      delivery: "queue",
      model: null,
      agent: null,
      variant: null,
    });
    await binding.dispatch({
      kind: "message.submit",
      commandId: "command-steer",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      message: userMessage("now"),
      delivery: "steer",
      model: null,
      agent: null,
      variant: null,
    });

    expect(runtime.deliveries).toEqual(["queue", "steer"]);
  });

  it("rejects a message with nothing in it to send", async () => {
    const { binding, runtime } = await attached();

    const receipt = await binding.dispatch({
      kind: "message.submit",
      commandId: "command-1",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      message: userMessage("   "),
      delivery: "queue",
      model: null,
      agent: null,
      variant: null,
    });

    expect(receipt.status).toBe("rejected");
    expect(receipt).toMatchObject({ code: "PI_EMPTY_MESSAGE" });
    expect(runtime.submissions).toEqual([]);
  });

  it("rejects replace delivery without sending anything to Pi", async () => {
    const { binding, runtime } = await attached();

    const receipt = await binding.dispatch({
      kind: "message.submit",
      commandId: "command-replace",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      message: userMessage("replace the current work"),
      delivery: "replace",
      model: null,
      agent: null,
      variant: null,
    });

    expect(receipt).toEqual({
      commandId: "command-replace",
      status: "rejected",
      code: "PI_REPLACE_UNSUPPORTED",
      detail: "Pi does not support replacing the active turn.",
      native: binding.native,
    });
    expect(runtime.submissions).toEqual([]);
  });

  it("passes a runtime rejection through as the receipt's own code", async () => {
    const { binding, runtime } = await attached();
    runtime.outcomes.push({
      kind: "rejected",
      reason: "busy-unsupported",
      message: "The agent is still working on the previous message.",
    });

    const receipt = await binding.dispatch({
      kind: "message.submit",
      commandId: "command-1",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      message: userMessage("again"),
      delivery: "queue",
      model: null,
      agent: null,
      variant: null,
    });

    expect(receipt).toEqual({
      commandId: "command-1",
      status: "rejected",
      code: "PI_BUSY",
      detail: "The agent is still working on the previous message.",
      native: binding.native,
    });
  });

  it("reports an unknown outcome when delivery threw after the prompt reached Pi", async () => {
    const { binding, runtime } = await attached();
    runtime.submitFailure = new Error("the ledger write failed");

    const receipt = await binding.dispatch({
      kind: "message.submit",
      commandId: "command-1",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      message: userMessage("go"),
      delivery: "queue",
      model: null,
      agent: null,
      variant: null,
    });

    expect(receipt).toEqual({
      commandId: "command-1",
      status: "unknown",
      detail: "the ledger write failed",
      native: binding.native,
    });
  });

  it("interrupts the running turn without ending the attachment", async () => {
    const { binding, runtime } = await attached();

    const receipt = await binding.dispatch({
      kind: "executor.interrupt",
      commandId: "command-2",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
    });

    expect(runtime.interrupts).toBe(1);
    expect(receipt.status).toBe("accepted");
    // The abort signal is what release pulls; an interrupted turn leaves the
    // attachment able to take the next message.
    expect(runtime.spec.signal?.aborted).toBe(false);
    expect(runtime.closes).toBe(0);
  });

  it("applies a product model selection through the bound runtime handle", async () => {
    const { binding, runtime } = await attached();
    const selection = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high" as const,
    };

    const receipt = await binding.dispatch({
      kind: "model.select",
      commandId: "command-model",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      selection,
    });

    expect(runtime.modelSelections).toEqual([selection]);
    expect(receipt).toMatchObject({ commandId: "command-model", status: "accepted" });
  });

  it("sanitizes a runtime model-selection rejection", async () => {
    const { binding, runtime } = await attached();
    runtime.modelSelectionOutcomes.push({
      kind: "rejected",
      reason: "model-unavailable",
      message: "The selected model is not currently available.",
    });

    const receipt = await binding.dispatch({
      kind: "model.select",
      commandId: "command-model-rejected",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      selection: {
        providerId: "openai-codex",
        modelId: "missing",
        reasoningLevel: "off",
      },
    });

    expect(receipt).toMatchObject({
      status: "rejected",
      code: "PI_MODEL_UNAVAILABLE",
      detail: "The selected model is not currently available.",
    });
  });

  it("does not persist secret-bearing model-selection exceptions", async () => {
    const { binding, runtime } = await attached();
    runtime.modelSelectionFailure = new Error("credential token sk-secret-model");

    const receipt = await binding.dispatch({
      kind: "model.select",
      commandId: "command-model-failed",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      selection: {
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "high",
      },
    });

    expect(receipt).toMatchObject({
      status: "rejected",
      code: "PI_MODEL_SELECTION_FAILED",
      detail: "The model policy could not be applied. Retry.",
    });
    expect(JSON.stringify(receipt)).not.toContain("sk-secret-model");
  });

  it("retries the failed Pi run without resubmitting its user message", async () => {
    const { binding, runtime } = await attached();

    const receipt = await binding.dispatch({
      kind: "executor.retry",
      commandId: "command-retry",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
    });

    expect(runtime.retries).toBe(1);
    expect(runtime.submissions).toEqual([]);
    expect(runtime.submissionCommandIds).toEqual(["command-retry"]);
    expect(receipt.status).toBe("accepted");
  });

  it("rejects an interaction resolution, because Pi raises none to resolve", async () => {
    const { binding } = await attached();

    const receipt = await binding.dispatch({
      kind: "interaction.resolve",
      commandId: "command-3",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      interaction: {
        id: "interaction-1",
        attachmentId: ATTACHMENT_ID,
        kind: "permission",
        title: "Allow?",
        detail: null,
        options: [],
        multiple: false,
        native: { id: null, detail: null },
      },
      resolution: { optionIds: ["once"], response: null },
    });

    expect(receipt).toMatchObject({ status: "rejected", code: "PI_INTERACTION_UNSUPPORTED" });
  });

  it("refuses every command once released", async () => {
    const { binding } = await attached();
    await binding.release("requested");

    const receipt = await binding.dispatch({
      kind: "executor.interrupt",
      commandId: "command-4",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
    });

    expect(receipt).toMatchObject({ status: "rejected", code: "PI_ATTACHMENT_CLOSED" });
  });
});

describe("Pi native adapter reconcile and release", () => {
  it("reconciles to nothing, leaving the caller's cursor where it was", async () => {
    const { binding } = await attached();

    expect(await binding.reconcile({ entryId: "entry-7" })).toEqual({
      cursor: { entryId: "entry-7" },
      observations: [],
      receipts: [],
    });
  });

  it("maps durable Pi delivery evidence to an accepted Session receipt", async () => {
    const { binding, runtime } = await attached();
    runtime.reconciliationReceipts.push({ commandId: "command-crash-window", acceptedAt: 456 });

    expect(await binding.reconcile({ entryId: "after-turn-completed" })).toEqual({
      cursor: { entryId: "after-turn-completed" },
      observations: [],
      receipts: [
        {
          commandId: "command-crash-window",
          status: "accepted",
          acceptedAt: 456,
          native: binding.native,
        },
      ],
    });
  });

  it("maps a cold replay to byte-stable durable Session observations", async () => {
    const { binding, runtime, sink } = await attached();
    const durable: RuntimeObservation[] = [
      {
        kind: "turn",
        state: "started",
        turnId: "turn-1",
        occurredAt: 101,
        recoveryCursor: "marker-1",
      },
      {
        kind: "message-settled",
        turnId: "turn-1",
        message: { entryId: "message-1", role: "assistant", text: "Remember me" },
        occurredAt: 102,
        recoveryCursor: "marker-2",
      },
      {
        kind: "activity",
        state: "completed",
        turnId: "turn-1",
        activityId: "tool-1",
        descriptor: {
          kind: "read-file",
          nativeToolName: "read",
          subject: { label: "README.md", path: "README.md", lineRange: null },
          outcome: null,
          startedAt: 90,
          endedAt: 100,
        },
        input: { path: "README.md" },
        output: "contents",
        occurredAt: 103,
        recoveryCursor: "marker-3",
      },
      {
        kind: "turn",
        state: "completed",
        turnId: "turn-1",
        occurredAt: 104,
        recoveryCursor: "marker-4",
      },
    ];
    for (const observation of durable) await runtime.observe(observation);
    const live = [...sink.observations];
    runtime.reconciliationObservations.push(...durable);
    runtime.reconciliationCursor = "marker-4";

    const replay = await binding.reconcile(null);

    expect(runtime.reconciledFrom).toEqual([null]);
    expect(replay).toEqual({
      cursor: { entryId: "marker-4" },
      observations: live,
      receipts: [],
    });
  });

  it("aborts the runtime signal and disposes the attachment", async () => {
    const { binding, runtime } = await attached();

    await binding.release("requested");

    expect(runtime.spec.signal?.aborted).toBe(true);
    expect(runtime.closes).toBe(1);
  });

  it("stays released, so a repeat disposes nothing twice", async () => {
    const { binding, runtime } = await attached();

    await binding.release("requested");
    await binding.release("shutdown");

    expect(runtime.closes).toBe(1);
  });

  it("says nothing to the Session after release, including Pi's own close", async () => {
    const { binding, runtime, sink } = await attached();

    await binding.release("requested");
    await runtime.observe({ kind: "attachment", state: "closed" });
    await runtime.observe({ kind: "delta", turnId: "turn-1", channel: "text", text: "late" });

    // The Session Engine writes `attachment.closed` itself once release resolves.
    expect(sink.observations).toEqual([]);
  });
});
