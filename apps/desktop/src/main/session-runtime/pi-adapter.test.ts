import { describe, expect, it } from "vite-plus/test";

import type {
  BindingHandle,
  HarnessCommand,
  NativeAttachmentSpec,
  ObservationSink,
} from "@volli/session-engine";
import { NativeAttachmentError, sessionRootThreadId } from "@volli/session-engine";
import {
  BUILTIN_RULE_PACK_HASH,
  BUILTIN_RULE_PACK_ID,
  DEFAULT_AUTHORITY_POLICY,
  errorMessage,
  promptResourceBlock,
  resolveAuthorityPolicy,
  sessionToolIds,
  skillResourcePart,
  type AgentRuntime,
  type CompactionRequestOutcome,
  type DeliveryOutcome,
  type ModelAccessSnapshot,
  type ModelSelectionOutcome,
  type RuntimeAskRequest,
  type RuntimeAskUserRequest,
  type RuntimeAttachmentHandle,
  type RuntimeObservation,
  type SessionInteractionResolution,
  type SessionRuntimeSpec,
  type UtilityCompletion,
  type UtilityCompletionResult,
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
  // The built-in defaults, which is what a project that has recorded no
  // departure resolves to — `enforcement: "observe"`, so the Snapshot is pinned
  // and the runtime is handed none.
  authorityPolicy: DEFAULT_AUTHORITY_POLICY,
  priorAuthorityDenials: 0,
  projectId: "project-1",
  ticketId: "ticket-1",
  rootThreadId: sessionRootThreadId(SESSION_ID),
  brief: "VC-12: Host the Pi runtime",
  model: {
    providerId: "openai-codex",
    modelId: "gpt-5.6-sol",
    reasoningLevel: "high",
  },
  toolSurface: ["read", "edit", "write", "execute", "ask_user"],
  promptResources: [],
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
  /** A Session write that will not commit — set to fail every emit from here on. */
  emitFailure: unknown = null;
  /**
   * Runs while a fact is committing, which is the only place an ordering claim
   * can be read: "before" and "after" are the same tick once the emit resolves.
   */
  beforeEmit: ((observation: RuntimeObservation) => Promise<void>) | null = null;

  async emit(observation: RuntimeObservation): Promise<void> {
    this.observations.push(observation);
    await this.beforeEmit?.(observation);
    if (this.emitFailure !== null) throw this.emitFailure;
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
  readonly compactions: Array<string | undefined> = [];
  readonly utilityCompletions: UtilityCompletion[] = [];
  readonly utilityReplies: string[] = [];
  readonly compactionOutcomes: CompactionRequestOutcome[] = [];
  compactionFailure: unknown = null;
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

  async completeUtility(input: UtilityCompletion): Promise<UtilityCompletionResult> {
    this.utilityCompletions.push(input);
    return { text: this.utilityReplies.shift() ?? "utility answer", usage: null };
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
      compact: async (instructions): Promise<CompactionRequestOutcome> => {
        this.compactions.push(instructions);
        if (this.compactionFailure !== null) throw this.compactionFailure;
        return this.compactionOutcomes.shift() ?? { kind: "compacted" };
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

/** The interaction id the request below is asked under, spelled out because it is durable. */
const ASK_INTERACTION_ID = "ask:call-7";

const ASK_REASON = "`git reset --hard` discards uncommitted work in this checkout.";

function askRequest(overrides: Partial<RuntimeAskRequest> = {}): RuntimeAskRequest {
  return {
    cause: "command.git-discards-work",
    tool: "execute",
    toolCallId: "call-7",
    turnId: "turn-1",
    reason: ASK_REASON,
    trip: "consecutive",
    overridable: true,
    ...overrides,
  };
}

/** How one ask ended. */
type AskOutcome = { answered: string } | { failed: string };

/**
 * Escalate the way the runtime does, and read the result the way it reads it.
 *
 * Both settlements are captured eagerly and on purpose. A withdrawal rejects on
 * a microtask no test has reached yet, and a rejection nobody is holding is an
 * unhandled rejection — so the promise is folded into a value here, which is
 * also exactly what the runtime does with it: an answer is honoured, and any
 * failure at all means the host could not obtain one.
 */
function ask(
  runtime: FakeRuntime,
  overrides: Partial<RuntimeAskRequest> = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<AskOutcome> {
  const port = runtime.spec.ask;
  if (port === undefined) throw new Error("The binding wired no ask port");
  return port(askRequest(overrides), signal).then(
    (answered): AskOutcome => ({ answered }),
    (error: unknown): AskOutcome => ({ failed: errorMessage(error) }),
  );
}

/**
 * The interaction id a model's own question is asked under, spelled out because
 * it is durable — and deliberately sharing a tool call id with the escalation
 * above, which is the collision the two prefixes exist to prevent.
 */
const ASK_USER_INTERACTION_ID = "ask-user:call-7";

const ASK_USER_QUESTION = "Spike it, or migrate the whole thing?";

function askUserRequest(overrides: Partial<RuntimeAskUserRequest> = {}): RuntimeAskUserRequest {
  return { toolCallId: "call-7", question: ASK_USER_QUESTION, ...overrides };
}

/** How one model question ended. */
type AskUserOutcome = { answered: SessionInteractionResolution } | { failed: string };

/** Ask the way the ask tool does, folding both settlements exactly as it does. */
function askUser(
  runtime: FakeRuntime,
  overrides: Partial<RuntimeAskUserRequest> = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<AskUserOutcome> {
  const port = runtime.spec.askUser;
  if (port === undefined) throw new Error("The binding wired no ask-user port");
  return port(askUserRequest(overrides), signal).then(
    (answered): AskUserOutcome => ({ answered }),
    (error: unknown): AskUserOutcome => ({ failed: errorMessage(error) }),
  );
}

/** What a withdrawn question settles as, whoever stopped asking it. */
const WITHDRAWN: AskOutcome = { failed: "The question was withdrawn before anyone answered it." };

/** Runs the microtask queue out, so a question the runtime asked has actually parked. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * The answering command as the Session Engine sends it.
 *
 * Everything but the interaction id and the option ids is filler, and that is
 * the point: the binding answers against the request the *runtime* made, so the
 * record the Engine hands back needs to carry nothing the binding trusts.
 */
function answerCommand(
  interactionId: string,
  optionIds: readonly string[],
  commandId = "command-answer",
  response: string | null = null,
): HarnessCommand {
  return {
    kind: "interaction.resolve",
    commandId,
    sessionId: SESSION_ID,
    attachmentId: ATTACHMENT_ID,
    interaction: {
      id: interactionId,
      attachmentId: ATTACHMENT_ID,
      kind: "permission",
      title: "Allow this execute call?",
      detail: null,
      options: [],
      multiple: false,
      native: { id: null, detail: null },
    },
    resolution: { optionIds, response },
  };
}

/** The `interaction.cancelled` observation a withdrawal announces. */
function cancelled(occurredAt: number, interactionId = ASK_INTERACTION_ID): RuntimeObservation {
  return {
    kind: "interaction",
    state: "cancelled",
    occurredAt,
    interactionId,
    reason: "withdrawn",
  };
}

const unusedExecutionEnvFactory: NonNullable<
  PiAdapterOptions["executionEnvFactory"]
> = async () => {
  throw new Error("never called by this test");
};

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

/**
 * VC-44's acceptance, held here because this is the one product caller that
 * constructs an Authority Snapshot.
 */
describe("Pi native adapter authority snapshot", () => {
  const policy = (over: Parameters<typeof resolveAuthorityPolicy>[0]) =>
    ({
      resolveRuntimeContext: async () => ({
        ...context,
        authorityPolicy: resolveAuthorityPolicy(over),
      }),
    }) satisfies Partial<PiAdapterOptions>;

  it("pins a Snapshot the Session Engine can record, naming the pack it ran under", async () => {
    const { binding } = await attached();

    // The whole point of the ticket: `rulePackId`/`rulePackHash` finally have
    // something durable to be pinned on, so an `authority.denied` event — which
    // carries this attachment's id — resolves to the exact pack that refused.
    expect(binding.authority).toMatchObject({
      mode: "auto",
      location: "worktree",
      rulePackId: BUILTIN_RULE_PACK_ID,
      rulePackHash: BUILTIN_RULE_PACK_HASH,
    });
  });

  it("records the Agent Tool Surface the Session actually holds, interaction tools included", async () => {
    // VC-3's guarantee, held in the product rather than only in tests: the
    // Snapshot is the Session's FROZEN tool surface, and `runtimeSpec` asserts
    // the array Pi resolves against re-derives to that same list. So it cannot
    // under-report by the three tools that used to trip `tool.not-bundled`.
    const { binding, runtime } = await attached({
      resolveRuntimeContext: async () => ({
        ...context,
        toolSurface: ["read", "edit", "write", "execute", "ask_user", "web_fetch", "web_search"],
      }),
      resolveWebPorts: () => ({
        webFetch: async () => {
          throw new Error("unused");
        },
        webSearch: async () => {
          throw new Error("unused");
        },
      }),
    });

    expect(binding.authority?.tools).toEqual([
      "read",
      "edit",
      "write",
      "execute",
      "ask_user",
      "web_fetch",
      "web_search",
    ]);
    expect(binding.authority?.tools).toEqual(sessionToolIds(runtime.spec));
  });

  it("omits a web tool from the Snapshot when the Session's surface never named one", async () => {
    // A tool the Session was never offered must not appear in the durable record
    // of what it was allowed to do. The frozen surface is what decides that, so
    // resolving no port cannot add one and could not silently drop one either.
    const { binding } = await attached({ resolveWebPorts: () => ({}) });

    expect(binding.authority?.tools).toEqual(["read", "edit", "write", "execute", "ask_user"]);
  });

  it("observes by default: the Snapshot is pinned and the runtime is handed none", async () => {
    const { binding, runtime } = await attached(policy(null));

    expect(binding.authority?.enforcement).toBe("observe");
    // Absent, not present-and-permissive: Pi installs `beforeToolCall` on this
    // field's presence, so absence is what keeps the pack dormant.
    expect("authority" in runtime.spec).toBe(false);
  });

  it("hands the runtime the Snapshot only when the project asks it to enforce", async () => {
    const { binding, runtime } = await attached(policy({ enforcement: "enforce" }));

    expect(binding.authority?.enforcement).toBe("enforce");
    expect(runtime.spec.authority).toEqual(binding.authority);
  });

  it("pins no Snapshot at all when a project turns the gate off", async () => {
    // The explicit bypass — Codex's and Claude Code's — and what every Session
    // ran under before VC-44. Nothing to record, because nothing governed it.
    const { binding, runtime } = await attached(policy({ enforcement: "off" }));

    expect(binding.authority).toBeNull();
    expect("authority" in runtime.spec).toBe(false);
  });

  it("carries the judgment mode and thresholds the project recorded", async () => {
    const { binding } = await attached(
      policy({ judgmentMode: "auto", fallback: { consecutiveDenials: 1 } }),
    );

    expect(binding.authority?.judgmentMode).toBe("auto");
    expect(binding.authority?.fallback).toEqual({ consecutiveDenials: 1, sessionDenials: 20 });
  });

  it("seeds the runtime with the refusals history already holds", async () => {
    // The Session half of the fallback is a fact about the Session. A counter
    // that restarted at zero on every attach would never reach a threshold of
    // twenty, so the escalation it exists to trigger would never fire — a gate
    // that looks configured and silently never asks anyone anything.
    const { runtime } = await attached({
      resolveRuntimeContext: async () => ({ ...context, priorAuthorityDenials: 19 }),
    });

    expect(runtime.spec.priorAuthorityDenials).toBe(19);
  });

  it("replays a rehydrated attachment's own Snapshot instead of today's policy", async () => {
    // Pinning is a claim about the attachment's whole life, not about one
    // process. A relaunch rebuilds the binding from history, and the project's
    // policy may have changed in between; re-resolving it here would leave the
    // live gate and the durable record disagreeing about one `attachmentId` —
    // and `authority.denied` resolves through exactly that id, so the durable
    // half would be the wrong one.
    const opened = await attached();
    const pinned = opened.binding.authority;
    expect(pinned?.enforcement).toBe("observe");

    const { binding, runtime } = await attached(
      // The project turned enforcement on after this attachment opened.
      policy({ enforcement: "enforce" }),
      attachmentSpec({
        continuity: "native_resume",
        native: opened.binding.native,
        pinnedAuthority: pinned,
      }),
    );

    expect(binding.authority).toEqual(pinned);
    // And the posture rides with it: the replayed Snapshot still observes, so
    // the gate stays uninstalled for the attachment that opened without it.
    expect("authority" in runtime.spec).toBe(false);
  });

  it("keeps a rehydrated attachment ungoverned when it opened with no Snapshot", async () => {
    // `null` is a real answer, distinct from absence: the attachment opened
    // under `off` (or predates VC-44), and a policy edit made afterwards must
    // not retroactively hand it a Snapshot it never ran under.
    const opened = await attached();
    const { binding, runtime } = await attached(
      policy({ enforcement: "enforce" }),
      attachmentSpec({
        continuity: "native_resume",
        native: opened.binding.native,
        pinnedAuthority: null,
      }),
    );

    expect(binding.authority).toBeNull();
    expect("authority" in runtime.spec).toBe(false);
  });

  it("records the tree the Session runs in, so policy can tell a worktree from a Main checkout", async () => {
    const { binding } = await attached({
      resolveRuntimeContext: async () => ({
        ...context,
        role: "project",
        ticketId: null,
        location: "main-checkout",
      }),
    });

    expect(binding.authority?.location).toBe("main-checkout");
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
    // Ungated: no Snapshot means the runtime installs no gate at all, so the
    // rule pack cannot run however the resolved location reads.
    expect(spec.authority).toBeUndefined();
    expect(spec.tools).toEqual({ tools: ["read", "edit", "write", "execute"] });
    expect(spec.brief).toEqual({ text: "VC-12: Host the Pi runtime" });
    // No skills named at start — the field is absent, not an empty list.
    expect("promptResources" in spec).toBe(false);
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

  it("carries the Session's recorded skills into the spec's promptResources", async () => {
    const resources = [{ name: "svg-logo-designer", text: "# Logos\n\nDo the thing." }];
    const { runtime } = await attached({
      resolveRuntimeContext: async () => ({ ...context, promptResources: resources }),
    });

    expect(runtime.spec.promptResources).toEqual(resources);
  });

  it("offers no web tool to a Session whose profile configured none", async () => {
    const { runtime } = await attached();

    // Absent rather than present-and-refusing, exactly as `authority` is
    // omitted rather than neutered: a field the spec does not carry is a tool
    // the runtime never registers, so the model is not told the web exists.
    expect("webFetch" in runtime.spec).toBe(false);
    expect("webSearch" in runtime.spec).toBe(false);
  });

  it("offers nothing when the resolver answers with no ports", async () => {
    const { runtime } = await attached({ resolveWebPorts: () => ({}) });

    expect("webFetch" in runtime.spec).toBe(false);
    expect("webSearch" in runtime.spec).toBe(false);
  });

  it("hands a configured profile's ports to the Session, calls and all", async () => {
    const asked: unknown[] = [];
    const { runtime } = await attached({
      resolveRuntimeContext: async () => ({
        ...context,
        toolSurface: ["read", "edit", "write", "execute", "ask_user", "web_fetch", "web_search"],
      }),
      resolveWebPorts: () => ({
        webFetch: async (input) => {
          asked.push({ fetch: input.url });
          return {
            requestedUrl: input.url,
            finalUrl: input.url,
            origin: new URL(input.url).origin,
            contentType: "text",
            text: "a page",
            truncated: false,
          };
        },
        webSearch: async (input) => {
          asked.push({ search: input.query });
          return { provider: "brave", query: input.query, references: [], truncated: false };
        },
      }),
    });

    const signal = new AbortController().signal;
    await runtime.spec.webFetch?.({ url: "https://example.com/", signal });
    await runtime.spec.webSearch?.({ query: "electron safeStorage", signal });

    expect(asked).toEqual([{ fetch: "https://example.com/" }, { search: "electron safeStorage" }]);
  });

  it("resolves the ports once per attachment rather than per turn", async () => {
    let resolutions = 0;
    const { runtime } = await attached({
      resolveWebPorts: () => {
        resolutions += 1;
        return {};
      },
    });

    expect(runtime.specs).toHaveLength(1);
    expect(resolutions).toBe(1);
  });

  it("keeps the durable tool surface when Web Access is enabled before recovery reattach", async () => {
    let webEnabled = false;
    const { adapter, runtime } = composition({
      resolveWebPorts: () =>
        webEnabled
          ? {
              webFetch: async (input) => ({
                requestedUrl: input.url,
                finalUrl: input.url,
                origin: new URL(input.url).origin,
                contentType: "text" as const,
                text: "page",
                truncated: false,
              }),
              webSearch: async (input) => ({
                provider: "brave",
                query: input.query,
                references: [],
                truncated: false,
              }),
            }
          : {},
    });
    const first = await adapter.attach(attachmentSpec(), new RecordingSink());
    await first.release("requested");

    webEnabled = true;
    await adapter.attach(
      attachmentSpec({
        attachmentId: "attachment-2",
        continuity: "native_resume",
        native: first.native,
      }),
      new RecordingSink(),
    );

    expect(runtime.specs.map((spec) => sessionToolIds(spec))).toEqual([
      ["read", "edit", "write", "execute", "ask_user"],
      ["read", "edit", "write", "execute", "ask_user"],
    ]);
    expect("webFetch" in runtime.specs[1]!).toBe(false);
    expect("webSearch" in runtime.specs[1]!).toBe(false);
  });

  it("refuses recovery rather than shrinking a frozen Web Access surface", async () => {
    let webEnabled = true;
    const frozenWebContext: PiRuntimeContext = {
      ...context,
      toolSurface: ["read", "edit", "write", "execute", "ask_user", "web_fetch", "web_search"],
    };
    const { adapter, runtime } = composition({
      resolveRuntimeContext: async () => frozenWebContext,
      resolveWebPorts: () =>
        webEnabled
          ? {
              webFetch: async (input) => ({
                requestedUrl: input.url,
                finalUrl: input.url,
                origin: new URL(input.url).origin,
                contentType: "text" as const,
                text: "page",
                truncated: false,
              }),
              webSearch: async (input) => ({
                provider: "brave",
                query: input.query,
                references: [],
                truncated: false,
              }),
            }
          : {},
    });
    const first = await adapter.attach(attachmentSpec(), new RecordingSink());
    await first.release("requested");
    webEnabled = false;

    const recovery = adapter.attach(
      attachmentSpec({
        attachmentId: "attachment-2",
        continuity: "native_resume",
        native: first.native,
      }),
      new RecordingSink(),
    );

    await expect(recovery).rejects.toMatchObject({
      code: "PI_RECOVERY_FAILED",
      attentionKind: "adapter_unrecoverable",
    });
    await expect(recovery).rejects.toThrow(/Restore a working Web Access configuration/);
    expect(runtime.specs).toHaveLength(1);
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

  it("passes the injected execution environment factory to the runtime factory", async () => {
    const seen: unknown[] = [];
    createPiNativeAdapter({
      sessionDataDir: "/data/pi-sessions",
      resolveRuntimeContext: async () => context,
      executionEnvFactory: unusedExecutionEnvFactory,
      createRuntime: (options) => {
        seen.push(options.executionEnvFactory);
        return new FakeRuntime();
      },
    });

    expect(seen).toEqual([unusedExecutionEnvFactory]);
  });

  it("leaves the runtime factory's own default execution environment untouched when none is injected", async () => {
    const seen: unknown[] = [];
    createPiNativeAdapter({
      sessionDataDir: "/data/pi-sessions",
      resolveRuntimeContext: async () => context,
      createRuntime: (options) => {
        seen.push(options.executionEnvFactory);
        return new FakeRuntime();
      },
    });

    expect(seen).toEqual([undefined]);
  });

  it("starts a ticketless project Session in the project root under the project Role", async () => {
    const { runtime } = await attached(
      {
        resolveRuntimeContext: async () => ({
          role: "project",
          location: "main-checkout",
          authorityPolicy: DEFAULT_AUTHORITY_POLICY,
          priorAuthorityDenials: 0,
          projectId: "project-1",
          ticketId: null,
          rootThreadId: sessionRootThreadId(SESSION_ID),
          brief: "A project-scoped chat Session.",
          model: context.model,
          toolSurface: context.toolSurface,
          promptResources: [],
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

  // VC-156: the party that can run the install is the one told about it.
  it("measures the prepared workspace and carries its package state into the spec", async () => {
    const measured: string[] = [];
    const { runtime } = await attached({
      readWorkspaceEnvironment: (workspacePath) => {
        measured.push(workspacePath);
        return { dependencies: "absent", installCommand: "pnpm install" };
      },
    });

    // The prepared directory — the worktree, never the main checkout beside it.
    expect(measured).toEqual(["/work/volli/.worktrees/VC-12"]);
    expect(runtime.spec.workspaceEnvironment).toEqual({
      dependencies: "absent",
      installCommand: "pnpm install",
    });
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

  it("appends a skill resource part as a delimited block AFTER the intact text (VC-49)", async () => {
    const { binding, runtime } = await attached();
    const resource = { name: "hussain-sol", text: "Skill directory: x/\n\n# The skill body" };

    await binding.dispatch({
      kind: "message.submit",
      commandId: "command-1",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      message: {
        id: "message-1",
        role: "user",
        parts: [
          // The repro: a mid-sentence skill reference. The sentence must reach
          // Pi exactly as typed, with the body adjacent — never spliced in.
          { type: "text", text: "can you tell me what /hussain-sol does?" },
          skillResourcePart(resource),
        ],
      },
      delivery: "queue",
      model: null,
      agent: null,
      variant: null,
    });

    expect(runtime.submissions).toEqual([
      `can you tell me what /hussain-sol does?\n\n${promptResourceBlock(resource)}`,
    ]);
  });

  it("drops a malformed skill resource part rather than delivering half a block", async () => {
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
          { type: "text", text: "just the words" },
          { type: "data-skill-resource", data: { name: "broken" } } as never,
        ],
      },
      delivery: "queue",
      model: null,
      agent: null,
      variant: null,
    });

    expect(runtime.submissions).toEqual(["just the words"]);
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

  it("compacts the context on request and carries the instructions to the runtime", async () => {
    const { binding, runtime } = await attached();

    const receipt = await binding.dispatch({
      kind: "context.compact",
      commandId: "command-compact",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      instructions: "keep the marker work",
    });

    expect(runtime.compactions).toEqual(["keep the marker work"]);
    expect(runtime.submissions).toEqual([]);
    expect(receipt.status).toBe("accepted");
  });

  it("reports a context with nothing left to summarize as a refusal, not a silence", async () => {
    const { binding, runtime } = await attached();
    runtime.compactionOutcomes.push({
      kind: "rejected",
      reason: "nothing-to-compact",
      message: "There is nothing left to summarize.",
    });

    const receipt = await binding.dispatch({
      kind: "context.compact",
      commandId: "command-compact",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      instructions: null,
    });

    // No instructions is no instructions, not an empty string the summarizer
    // would be handed as if it said something.
    expect(runtime.compactions).toEqual([undefined]);
    expect(receipt).toMatchObject({
      status: "rejected",
      code: "PI_NOTHING_TO_COMPACT",
      detail: "There is nothing left to summarize.",
    });
  });

  it("reports a summary the provider refused as a rejected receipt", async () => {
    const { binding, runtime } = await attached();
    runtime.compactionOutcomes.push({
      kind: "rejected",
      reason: "summary-failed",
      message: "the summarizer is unhappy",
    });

    const receipt = await binding.dispatch({
      kind: "context.compact",
      commandId: "command-compact",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      instructions: null,
    });

    expect(receipt).toMatchObject({
      status: "rejected",
      code: "PI_COMPACTION_FAILED",
      detail: "the summarizer is unhappy",
    });
  });

  it("reports a compaction that threw as an unknown outcome, never a refusal", async () => {
    const { binding, runtime } = await attached();
    runtime.compactionFailure = new Error("the runtime fell over");

    const receipt = await binding.dispatch({
      kind: "context.compact",
      commandId: "command-compact",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      instructions: null,
    });

    // Not `rejected`: a refusal is the runtime answering, and this is the
    // runtime failing to. The difference is what a reader needs to know.
    expect(receipt).toMatchObject({ status: "unknown", detail: "the runtime fell over" });
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

describe("Pi native adapter escalation", () => {
  it("puts a blocked call to a person, and grants exactly the call they allowed", async () => {
    const { binding, runtime, sink } = await attached();

    const answer = ask(runtime);
    await flush();

    expect(sink.observations).toEqual([
      {
        kind: "interaction",
        state: "opened",
        occurredAt: 1000,
        interaction: {
          // Spelled out rather than matched on shape. This string is durable —
          // the Engine mints `pi:interaction:<attachment>:ask:call-7:opened`
          // from it, and rederives that id from live data on every relaunch, so
          // a rename would not fail here, it would duplicate every question a
          // Session ever asked.
          id: "ask:call-7",
          kind: "permission",
          title: "Allow this execute call?",
          detail: ASK_REASON,
          // `always` is deliberately absent: there is no durable policy store to
          // write a standing grant into.
          options: [
            { id: "once", label: "Allow once", description: null },
            { id: "reject", label: "Reject", description: null },
          ],
          multiple: false,
          native: binding.native,
        },
      },
    ]);

    const receipt = await binding.dispatch(answerCommand(ASK_INTERACTION_ID, ["once"]));

    expect(receipt).toMatchObject({ commandId: "command-answer", status: "accepted" });
    expect(await answer).toEqual({ answered: "allow" });
    // The answer is announced, and it has to be: the Engine writes
    // `interaction.resolved` from THIS observation and from nowhere else. The
    // receipt above is a receipt, not a fact — `projectSession` folds it into
    // `receipts` and never reads its `result` — so a silent adapter would settle
    // the call, resume the turn, and leave the question active forever.
    expect(sink.observations[1]).toEqual({
      kind: "interaction",
      state: "resolved",
      occurredAt: 1001,
      interactionId: ASK_INTERACTION_ID,
      resolution: { optionIds: ["once"], response: null },
    });
    expect(sink.observations).toHaveLength(2);
  });

  it("records the answer before it settles the call that was waiting on it", async () => {
    const { binding, runtime, sink } = await attached();

    const answer = ask(runtime);
    await flush();
    // Read at the moment the fact commits: the ask must still be unsettled
    // there, mirroring `#ask`, which refuses to park on a question the Session
    // could not record. An answer reported as delivered before it is a fact
    // would resume the turn on a decision history has no account of.
    let settledDuringEmit: AskOutcome | "unsettled" = "unsettled";
    let resolvedDuringEmit = false;
    sink.beforeEmit = async (observation) => {
      if (observation.kind !== "interaction" || observation.state !== "resolved") return;
      resolvedDuringEmit = true;
      settledDuringEmit = await Promise.race([
        answer,
        flush().then((): "unsettled" => "unsettled"),
      ]);
    };

    await binding.dispatch(answerCommand(ASK_INTERACTION_ID, ["once"]));

    expect(resolvedDuringEmit).toBe(true);
    expect(settledDuringEmit).toBe("unsettled");
    expect(await answer).toEqual({ answered: "allow" });
  });

  it("keeps a question answerable when the answer could not be recorded", async () => {
    const { binding, runtime, sink } = await attached();

    const answer = ask(runtime);
    await flush();
    sink.emitFailure = new Error("the resolution never committed");
    const failed = await binding.dispatch(answerCommand(ASK_INTERACTION_ID, ["once"]));

    // Rejected, not accepted: the turn must not resume on a decision the Session
    // has no record of. And nothing was claimed, so the question is still parked
    // and still active — which is the whole reason the claim happens after the
    // emit. Claiming first would leave the ask unparked AND unrecorded, and the
    // retry below would meet PI_INTERACTION_UNKNOWN with the turn blocked behind
    // a card nothing could ever answer.
    expect(failed).toMatchObject({
      status: "rejected",
      code: "PI_INTERACTION_NOT_RECORDED",
      detail: expect.stringContaining("the resolution never committed"),
    });

    sink.emitFailure = null;
    const retried = await binding.dispatch(
      answerCommand(ASK_INTERACTION_ID, ["once"], "command-retry"),
    );

    expect(retried).toMatchObject({ commandId: "command-retry", status: "accepted" });
    expect(await answer).toEqual({ answered: "allow" });
  });

  it("reports an answer that reached nobody when the question was withdrawn mid-record", async () => {
    const { binding, runtime, sink } = await attached();
    const turn = new AbortController();

    const answer = ask(runtime, {}, turn.signal);
    await flush();
    // The narrow race the post-emit claim leaves open: the fact commits, and the
    // turn gives up before the parked call can be settled. History keeps the
    // resolution, which is true — a person did answer — but the runtime is no
    // longer waiting, so the receipt says the decision reached nobody.
    sink.beforeEmit = async (observation) => {
      if (observation.kind !== "interaction" || observation.state !== "resolved") return;
      turn.abort();
      await flush();
    };

    const receipt = await binding.dispatch(answerCommand(ASK_INTERACTION_ID, ["once"]));

    expect(receipt).toMatchObject({ status: "rejected", code: "PI_INTERACTION_UNKNOWN" });
    expect(await answer).toEqual(WITHDRAWN);
    // Both facts are announced, and which lands first is deliberately not
    // pinned: two independent chains reach the ledger here and the interleave is
    // unspecified. What must hold is that neither is lost — history says a
    // person answered AND that the runtime stopped waiting, which is what
    // actually happened.
    expect(
      sink.observations.map((one) => one.kind === "interaction" && one.state).toSorted(),
    ).toEqual(["cancelled", "opened", "resolved"]);
  });

  it("reads a rejected permission back as the refusal it already was", async () => {
    const { binding, runtime } = await attached();

    const answer = ask(runtime);
    await flush();
    await binding.dispatch(answerCommand(ASK_INTERACTION_ID, ["reject"]));

    expect(await answer).toEqual({ answered: "refuse" });
  });

  it("offers a refusal nobody may overrule the two things a person can still decide", async () => {
    const { binding, runtime, sink } = await attached();

    const answer = ask(runtime, {
      cause: "command.persistence",
      tool: "write",
      overridable: false,
      reason: "This command installs a login item, which outlives the Session.",
    });
    await flush();

    expect(sink.observations[0]).toMatchObject({
      state: "opened",
      interaction: {
        kind: "question",
        // A statement, not a request: neither option grants anything, so a title
        // phrased as a permission would misdescribe both controls under it.
        title: "Blocked this write call",
        options: [
          { id: "continue", label: "Keep working", description: null },
          { id: "stop", label: "Stop the turn", description: null },
        ],
      },
    });

    await binding.dispatch(answerCommand(ASK_INTERACTION_ID, ["stop"]));

    expect(await answer).toEqual({ answered: "stop" });
  });

  it("rejects an answer to a question nothing is waiting on", async () => {
    const { binding, runtime } = await attached();

    const answer = ask(runtime);
    await flush();

    const unasked = await binding.dispatch(
      answerCommand("ask:call-elsewhere", ["once"], "command-unasked"),
    );
    await binding.dispatch(answerCommand(ASK_INTERACTION_ID, ["once"]));
    const again = await binding.dispatch(
      answerCommand(ASK_INTERACTION_ID, ["reject"], "command-again"),
    );

    // A question from another attachment and a question already answered are
    // the same fact from here: nothing is parked under that id.
    expect(unasked).toMatchObject({ status: "rejected", code: "PI_INTERACTION_UNKNOWN" });
    expect(again).toMatchObject({ status: "rejected", code: "PI_INTERACTION_UNKNOWN" });
    expect(await answer).toEqual({ answered: "allow" });
  });

  it("never parks on a question the Session could not record", async () => {
    const { binding, runtime, sink } = await attached();
    sink.emitFailure = new Error("the interaction never committed");

    // Rejecting rather than waiting is the honest account: the runtime reads it
    // as "the host could not obtain an answer" and records the refusal, which is
    // what a question nobody was shown deserves.
    expect(await ask(runtime)).toEqual({ failed: "the interaction never committed" });

    sink.emitFailure = null;
    const receipt = await binding.dispatch(answerCommand(ASK_INTERACTION_ID, ["once"]));

    expect(receipt).toMatchObject({ status: "rejected", code: "PI_INTERACTION_UNKNOWN" });
  });

  it("withdraws the question when the turn it belongs to stops waiting", async () => {
    const { binding, runtime, sink } = await attached();
    const turn = new AbortController();

    const answer = ask(runtime, {}, turn.signal);
    await flush();
    turn.abort();
    await flush();

    expect(sink.observations.at(-1)).toEqual(cancelled(1001));
    expect(await answer).toEqual(WITHDRAWN);
    const late = await binding.dispatch(answerCommand(ASK_INTERACTION_ID, ["once"]));
    expect(late).toMatchObject({ status: "rejected", code: "PI_INTERACTION_UNKNOWN" });
  });

  it("withdraws a question whose turn gave up while the question was being recorded", async () => {
    const { runtime, sink } = await attached();

    const answer = ask(runtime, {}, AbortSignal.abort());

    // The `opened` fact committed before the signal could be read, so the card
    // exists and has to be closed even though nobody was ever going to answer it.
    expect(await answer).toEqual(WITHDRAWN);
    expect(sink.observations).toHaveLength(2);
    expect(sink.observations[1]).toEqual(cancelled(1001));
  });

  it("stops asking a question the Session cancelled, without recording it twice", async () => {
    const { binding, runtime, sink } = await attached();

    const answer = ask(runtime);
    await flush();
    await binding.withdrawInteraction?.(ASK_INTERACTION_ID);
    // Best-effort by contract: a question that already ended is not a failure.
    await binding.withdrawInteraction?.(ASK_INTERACTION_ID);

    expect(await answer).toEqual(WITHDRAWN);
    // The Engine wrote `interaction.cancelled` before it called this, so the
    // only observation this Session ever saw is the question itself.
    expect(sink.observations).toHaveLength(1);
    expect(sink.observations[0]).toMatchObject({ state: "opened" });
  });

  it("withdraws every parked question before release stops admitting facts", async () => {
    const { binding, runtime, sink } = await attached();

    const answer = ask(runtime);
    await flush();
    await binding.release("requested");

    // Announced, and therefore announced first: `#observe` drops everything once
    // the released flag is set, so a card cancelled a line later would stay up
    // with nothing left alive to answer it.
    expect(sink.observations.at(-1)).toEqual(cancelled(1001));
    expect(await answer).toEqual(WITHDRAWN);
    expect(runtime.closes).toBe(1);
  });

  it("refuses a command that arrives while release is still withdrawing", async () => {
    const { binding, runtime } = await attached();

    const answer = ask(runtime);
    await flush();
    // Deliberately not awaited: this is the window between the first withdrawal
    // and the released flag, which is the only moment the two flags disagree.
    const releasing = binding.release("requested");
    const receipt = await binding.dispatch({
      kind: "message.submit",
      commandId: "command-9",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      message: userMessage("Ship it anyway"),
      delivery: "queue",
      model: null,
      agent: null,
      variant: null,
    });
    await releasing;

    // Accepting here would hand back a durable receipt for a message Pi closes
    // before it ever reads — the one outcome a receipt must never claim.
    expect(receipt).toMatchObject({ status: "rejected", code: "PI_ATTACHMENT_CLOSED" });
    expect(runtime.submissions).toHaveLength(0);
    expect(await answer).toEqual(WITHDRAWN);
  });

  it("settles every parked question even when the withdrawal cannot be recorded", async () => {
    const { binding, runtime, sink } = await attached();

    const answer = ask(runtime);
    await flush();
    sink.emitFailure = new Error("the ledger is gone");
    await binding.release("requested");

    // The card is stranded either way and that is the sink's failure to report.
    // What release must never do is hang on a promise nothing will settle.
    expect(await answer).toEqual(WITHDRAWN);
    expect(runtime.closes).toBe(1);
  });
});

/**
 * The model's own question, which shares the parking machinery with an
 * escalation and shares nothing else: its options are the model's, its answer is
 * a tool result, and the two live under ids that cannot collide.
 */
describe("Pi native adapter model questions", () => {
  it("opens the model's question as a card of the model's own options", async () => {
    const { binding, runtime, sink } = await attached();

    const answer = askUser(runtime, {
      options: [
        { id: "spike", label: "Spike first" },
        { id: "migration", label: "Full migration", description: "Two more days" },
      ],
      multiple: true,
    });
    await flush();

    expect(sink.observations).toEqual([
      {
        kind: "interaction",
        state: "opened",
        occurredAt: 1000,
        interaction: {
          // Spelled out rather than matched on shape, and never the escalation's
          // `ask:` — this is a second durable derivation and the Engine mints
          // `pi:interaction:<attachment>:ask-user:call-7:opened` from it, so a
          // rename would not fail here, it would duplicate every question a
          // Session ever asked.
          id: "ask-user:call-7",
          kind: "question",
          title: ASK_USER_QUESTION,
          detail: null,
          options: [
            { id: "spike", label: "Spike first", description: null },
            { id: "migration", label: "Full migration", description: "Two more days" },
          ],
          multiple: true,
          // Declared even though the flat fields above already say the same
          // choice, because one thing has no flat home and it is the one the
          // model does not get the last word on: a person choosing between two
          // things it imagined must be able to say a third. `custom` lives on a
          // prompt, so a question without prompts would durably say otherwise.
          prompts: [
            {
              id: "prompt:0",
              label: ASK_USER_QUESTION,
              detail: null,
              options: [
                { id: "spike", label: "Spike first", description: null },
                { id: "migration", label: "Full migration", description: "Two more days" },
              ],
              multiple: true,
              custom: true,
            },
          ],
          native: binding.native,
        },
      },
    ]);

    const receipt = await binding.dispatch(
      answerCommand(ASK_USER_INTERACTION_ID, ["spike"], "command-answer", "and time-box it"),
    );

    expect(receipt).toMatchObject({ commandId: "command-answer", status: "accepted" });
    // Handed back unread. The model wrote the question and every option id in
    // it, so nothing between the card and the tool is entitled to decide what
    // one of them meant — `askChoice` is the escalation's reading, and applying
    // it here would turn an option a model happened to call `reject` into a
    // refusal of something.
    expect(await answer).toEqual({
      answered: { optionIds: ["spike"], response: "and time-box it" },
    });
  });

  it("asks for free text when the model offered nothing to choose between", async () => {
    const { runtime, sink } = await attached();

    void askUser(runtime);
    await flush();

    expect(sink.observations[0]).toMatchObject({
      state: "opened",
      interaction: {
        options: [],
        multiple: false,
        prompts: [
          {
            id: "prompt:0",
            label: ASK_USER_QUESTION,
            detail: null,
            options: [],
            multiple: false,
            custom: true,
          },
        ],
      },
    });
  });

  it("lets the model close the free-text answer when a listed option is required", async () => {
    const { runtime, sink } = await attached();

    void askUser(runtime, {
      options: [{ id: "spike", label: "Spike first" }],
      allowOther: false,
    });
    await flush();

    expect(sink.observations[0]).toMatchObject({
      state: "opened",
      interaction: { prompts: [{ custom: false }] },
    });
  });

  it("keeps free text open on a question with nothing to choose between", async () => {
    const { runtime, sink } = await attached();

    // The model's `false` is overruled here and only here: a closed question
    // offering nothing asks for an answer no press can give, so the card would
    // be one nobody could ever get past.
    void askUser(runtime, { allowOther: false });
    await flush();

    expect(sink.observations[0]).toMatchObject({
      state: "opened",
      interaction: { options: [], prompts: [{ custom: true }] },
    });
  });

  it("keeps the two kinds of question apart when one call raises both ids", async () => {
    const { binding, runtime, sink } = await attached();

    const escalation = ask(runtime);
    const question = askUser(runtime);
    await flush();

    expect(
      sink.observations.map(
        (one) => one.kind === "interaction" && one.state === "opened" && one.interaction.id,
      ),
    ).toEqual([ASK_INTERACTION_ID, ASK_USER_INTERACTION_ID]);

    await binding.dispatch(answerCommand(ASK_USER_INTERACTION_ID, ["spike"], "command-question"));
    await binding.dispatch(answerCommand(ASK_INTERACTION_ID, ["once"], "command-escalation"));

    // Both settle, and each settles as its own kind: one prefix reused for both
    // would have let the first answer end the wrong wait.
    expect(await question).toEqual({ answered: { optionIds: ["spike"], response: null } });
    expect(await escalation).toEqual({ answered: "allow" });
  });

  it("records the model's answer before it settles the call that was waiting on it", async () => {
    const { binding, runtime, sink } = await attached();

    const answer = askUser(runtime);
    await flush();
    let settledDuringEmit: AskUserOutcome | "unsettled" = "unsettled";
    let resolvedDuringEmit = false;
    sink.beforeEmit = async (observation) => {
      if (observation.kind !== "interaction" || observation.state !== "resolved") return;
      resolvedDuringEmit = true;
      settledDuringEmit = await Promise.race([
        answer,
        flush().then((): "unsettled" => "unsettled"),
      ]);
    };

    await binding.dispatch(answerCommand(ASK_USER_INTERACTION_ID, ["spike"]));

    expect(resolvedDuringEmit).toBe(true);
    expect(settledDuringEmit).toBe("unsettled");
    expect(await answer).toEqual({ answered: { optionIds: ["spike"], response: null } });
  });

  it("keeps the model's question answerable when the answer could not be recorded", async () => {
    const { binding, runtime, sink } = await attached();

    const answer = askUser(runtime);
    await flush();
    sink.emitFailure = new Error("the resolution never committed");
    const failed = await binding.dispatch(answerCommand(ASK_USER_INTERACTION_ID, ["spike"]));

    expect(failed).toMatchObject({
      status: "rejected",
      code: "PI_INTERACTION_NOT_RECORDED",
      detail: expect.stringContaining("the resolution never committed"),
    });

    sink.emitFailure = null;
    const retried = await binding.dispatch(
      answerCommand(ASK_USER_INTERACTION_ID, ["spike"], "command-retry"),
    );

    expect(retried).toMatchObject({ commandId: "command-retry", status: "accepted" });
    expect(await answer).toEqual({ answered: { optionIds: ["spike"], response: null } });
  });

  it("reports a model answer that reached nobody when the question was withdrawn mid-record", async () => {
    const { binding, runtime, sink } = await attached();
    const turn = new AbortController();

    const answer = askUser(runtime, {}, turn.signal);
    await flush();
    sink.beforeEmit = async (observation) => {
      if (observation.kind !== "interaction" || observation.state !== "resolved") return;
      turn.abort();
      await flush();
    };

    const receipt = await binding.dispatch(answerCommand(ASK_USER_INTERACTION_ID, ["spike"]));

    expect(receipt).toMatchObject({ status: "rejected", code: "PI_INTERACTION_UNKNOWN" });
    expect(await answer).toEqual(WITHDRAWN);
  });

  it("never parks the model on a question the Session could not record", async () => {
    const { binding, runtime, sink } = await attached();
    sink.emitFailure = new Error("the question never committed");

    // A rejection reaches the model as a failed tool call, which is the honest
    // account of a question nobody was shown.
    expect(await askUser(runtime)).toEqual({ failed: "the question never committed" });

    sink.emitFailure = null;
    const receipt = await binding.dispatch(answerCommand(ASK_USER_INTERACTION_ID, ["spike"]));

    expect(receipt).toMatchObject({ status: "rejected", code: "PI_INTERACTION_UNKNOWN" });
  });

  it("withdraws the model's question when the turn it belongs to stops waiting", async () => {
    const { binding, runtime, sink } = await attached();
    const turn = new AbortController();

    const answer = askUser(runtime, {}, turn.signal);
    await flush();
    turn.abort();
    await flush();

    expect(sink.observations.at(-1)).toEqual(cancelled(1001, ASK_USER_INTERACTION_ID));
    expect(await answer).toEqual(WITHDRAWN);
    const late = await binding.dispatch(answerCommand(ASK_USER_INTERACTION_ID, ["spike"]));
    expect(late).toMatchObject({ status: "rejected", code: "PI_INTERACTION_UNKNOWN" });
  });

  it("stops asking a model question the Session cancelled, without recording it twice", async () => {
    const { binding, runtime, sink } = await attached();

    const answer = askUser(runtime);
    await flush();
    await binding.withdrawInteraction?.(ASK_USER_INTERACTION_ID);
    await binding.withdrawInteraction?.(ASK_USER_INTERACTION_ID);

    expect(await answer).toEqual(WITHDRAWN);
    expect(sink.observations).toHaveLength(1);
    expect(sink.observations[0]).toMatchObject({ state: "opened" });
  });

  it("withdraws both kinds of parked question before release stops admitting facts", async () => {
    const { binding, runtime, sink } = await attached();

    const escalation = ask(runtime);
    const question = askUser(runtime);
    await flush();
    await binding.release("requested");

    // Both maps are drained, and drained before the released flag: `#observe`
    // admits nothing after it, so a card cancelled a line later would stay up
    // with nothing left alive to answer it.
    expect(
      sink.observations.map(
        (one) => one.kind === "interaction" && one.state === "cancelled" && one.interactionId,
      ),
    ).toEqual([false, false, ASK_INTERACTION_ID, ASK_USER_INTERACTION_ID]);
    expect(await escalation).toEqual(WITHDRAWN);
    expect(await question).toEqual(WITHDRAWN);
    expect(runtime.closes).toBe(1);
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
