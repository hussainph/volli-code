import { describe, expect, it } from "vite-plus/test";

import type { BindingHandle, NativeAttachmentSpec, ObservationSink } from "@volli/session-engine";
import { NativeAttachmentError, sessionRootThreadId } from "@volli/session-engine";
import {
  BUILTIN_RULE_PACK_HASH,
  BUILTIN_RULE_PACK_ID,
  type AgentRuntime,
  type DeliveryOutcome,
  type ModelAccessSnapshot,
  type ModelSelectionOutcome,
  type RuntimeAttachmentHandle,
  type RuntimeObservation,
  type SessionRuntimeSpec,
} from "@volli/shared";
import type { UIMessage } from "ai";

import {
  createPiNativeAdapter,
  createPiRuntimeHost,
  PI_ADAPTER_ID,
  type PiAdapterOptions,
  type PiRuntimeContext,
} from "./pi-adapter";

const SESSION_ID = "session-1";
const ATTACHMENT_ID = "attachment-1";

const context: PiRuntimeContext = {
  role: "ticket",
  location: "worktree",
  projectId: "project-1",
  ticketId: "ticket-1",
  rootThreadId: sessionRootThreadId(SESSION_ID),
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
    directory: "/work/volli/.worktrees/VC-12",
    continuity: "fresh",
    native: null,
    ...overrides,
  };
}

function userMessage(text: string, id = "message-1"): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

/** Records what the binding forwards; translating it is the Session Engine's job. */
class RecordingSink implements ObservationSink {
  readonly observations: RuntimeObservation[] = [];

  async emit(observation: RuntimeObservation): Promise<void> {
    this.observations.push(observation);
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
  readonly startupObservations: RuntimeObservation[] = [];
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
    // Reported while `startSession` is still running, which is the only window
    // in which the binding has no handle yet.
    for (const observation of this.startupObservations) await spec.observer(observation);
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

describe("Pi native adapter identity", () => {
  it("declares the one adapter id and the pinned runtime identity", () => {
    const { adapter } = composition();
    expect(adapter.id).toBe(PI_ADAPTER_ID);
    expect(adapter.adapterVersion).toBe("0.0.1");
    // Recorded in every durable binding envelope, so these three strings are
    // frozen: a change re-stamps history that past builds already wrote.
    expect(adapter.runtime).toEqual({
      path: "@earendil-works/pi-agent-core",
      version: "0.84.1",
      fingerprint: "npm:@earendil-works/pi-agent-core@0.84.1",
    });
  });

  /**
   * Spelled out here because this is the one link that fails silently.
   * `observation-translation.test.ts` asserts the ids this namespace prefixes,
   * but it supplies its own `"pi"`, so only this catches a change to the value
   * the Engine is actually handed — which would not error, it would write a
   * second copy of every fact in every Session's history.
   */
  it("declares the frozen namespace every durable id derived from Pi is minted under", () => {
    expect(composition().adapter.durableIdNamespace).toBe("pi");
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

describe("Pi native adapter attach", () => {
  it("starts a ticket session in the prepared directory with the pinned model and brief", async () => {
    const { runtime, binding } = await attached();

    const spec = runtime.spec;
    expect(spec.identity).toEqual({
      role: "ticket",
      sessionId: SESSION_ID,
      rootThreadId: sessionRootThreadId(SESSION_ID),
      attachmentId: ATTACHMENT_ID,
      projectId: "project-1",
      ticketId: "ticket-1",
    });
    expect(spec.venue).toBe("local");
    expect(spec.workspacePath).toBe("/work/volli/.worktrees/VC-12");
    expect(spec.model).toEqual(context.model);
    expect(spec.authority).toEqual({
      mode: "auto",
      location: "worktree",
      tools: ["read", "edit", "write", "execute"],
      rulePackId: BUILTIN_RULE_PACK_ID,
      rulePackHash: BUILTIN_RULE_PACK_HASH,
      classifierModel: null,
      fallback: { consecutiveDenials: 3, sessionDenials: 20 },
    });
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

    expect(adapter.id).toBe(PI_ADAPTER_ID);
    expect(seen).toEqual([{ sessionDataDir: "/data/pi-sessions", models }]);
  });

  it("starts a ticketless project Session in the project root under the project Role", async () => {
    const { runtime } = await attached(
      {
        resolveRuntimeContext: async () => ({
          role: "project",
          location: "main-checkout",
          projectId: "project-1",
          ticketId: null,
          rootThreadId: sessionRootThreadId(SESSION_ID),
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
      rootThreadId: sessionRootThreadId(SESSION_ID),
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

  it("says nothing about an attachment the binding does not hold yet", async () => {
    const runtime = new FakeRuntime();
    runtime.startupObservations.push(
      { kind: "attachment", state: "started" },
      { kind: "attachment", state: "failed", failure: { reason: "auth", message: "no" } },
    );
    const adapter = createPiNativeAdapter({
      sessionDataDir: "/data/pi-sessions",
      resolveRuntimeContext: async () => context,
      createRuntime: () => runtime,
    });
    const sink = new RecordingSink();

    await adapter.attach(attachmentSpec(), sink);

    // `started` is the Session Engine's own `attachment.opened` said twice, and
    // a pre-handle `failed` is the rejection `attach` throws.
    expect(sink.observations).toEqual([]);
  });

  it("forwards an attachment fact the binding does hold, for the Engine to interpret", async () => {
    const { runtime, sink } = await attached();

    await runtime.observe({ kind: "attachment", state: "started" });
    await runtime.observe({ kind: "attachment", state: "closed" });

    expect(sink.observations).toEqual([
      { kind: "attachment", state: "started" },
      { kind: "attachment", state: "closed" },
    ]);
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

  /**
   * Which of these become Session facts, and under what ids, is the Engine's
   * replay translation to decide — pinned in `observation-translation.test.ts`.
   * What this binding owes is to hand them over unchanged, and to map only the
   * two things it does own: the sidecar cursor, and Pi's delivery evidence.
   */
  it("hands Pi's own history back untranslated, mapping only the cursor and receipts", async () => {
    const { binding, runtime } = await attached();
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
        kind: "turn",
        state: "completed",
        turnId: "turn-1",
        occurredAt: 103,
        recoveryCursor: "marker-3",
      },
    ];
    runtime.reconciliationObservations.push(...durable);
    runtime.reconciliationCursor = "marker-3";
    runtime.reconciliationReceipts.push({ commandId: "command-crashed", acceptedAt: 456 });

    const replay = await binding.reconcile(null);

    expect(runtime.reconciledFrom).toEqual([null]);
    expect(replay).toEqual({
      cursor: { entryId: "marker-3" },
      observations: durable,
      receipts: [
        {
          commandId: "command-crashed",
          status: "accepted",
          acceptedAt: 456,
          native: binding.native,
        },
      ],
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
