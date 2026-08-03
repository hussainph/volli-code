import { describe, expect, it } from "vite-plus/test";
import type { HarnessCommand, HarnessObservation, ObservationSink } from "@volli/session-engine";
import {
  ACTIVITY_METADATA_KEY,
  readActivityDescriptor,
  type ActivityKind,
  type ActivityOutcome,
  type ActivitySubject,
} from "@volli/shared";
import {
  createOpenCodeNativeAdapter,
  openCodeActivityKind,
  parseOpenCodeSse,
  OPENCODE_ACTIVITY,
  type OpenCodeChild,
  type OpenCodeHttpResponse,
  type OpenCodeNetworkPort,
  type OpenCodeProcessPort,
  type OpenCodeSseEvent,
} from "./index";

const NO_OUTCOME: ActivityOutcome = {
  exitCode: null,
  matchCount: null,
  fileCount: null,
  lineCount: null,
  bytes: null,
  addedLines: null,
  removedLines: null,
  diff: null,
  summary: null,
};

/**
 * The activity descriptor the adapter now stamps beside its `opencode`
 * namespace. Spelled out here rather than matched loosely — the descriptor is
 * the renderer's only contract, so a silent change to it must fail a test.
 */
/** Mirrors MAX_INFERRED_LABEL_LENGTH — the point past which a scalar is a body, not a name. */
const MAX_LABEL = 200;

/**
 * Every tool part's descriptor, read back through the shared contract and with
 * null outcome fields elided, so an expectation reads as the row the UI draws.
 */
function descriptors(observations: readonly HarnessObservation[]) {
  return observations.flatMap((observation) =>
    observation.kind !== "transcript.message"
      ? []
      : observation.message.parts.flatMap((part) => {
          if (part.type !== "dynamic-tool") return [];
          const descriptor = readActivityDescriptor(part.toolMetadata);
          if (!descriptor) throw new Error(`no activity descriptor on ${part.toolCallId}`);
          return [
            {
              call: part.toolCallId,
              kind: descriptor.kind,
              label: descriptor.subject.label,
              path: descriptor.subject.path,
              lineRange: descriptor.subject.lineRange,
              outcome:
                descriptor.outcome &&
                Object.fromEntries(
                  Object.entries(descriptor.outcome).filter(([, value]) => value !== null),
                ),
              startedAt: descriptor.startedAt,
              endedAt: descriptor.endedAt,
            },
          ];
        }),
  );
}

const toolPart = (tool: string, callID: string, state: Record<string, unknown>) => ({
  type: "tool",
  tool,
  callID,
  state,
});

/** Every tool row the transcript projected, in the order it projected them. */
function toolRows(observations: readonly HarnessObservation[]) {
  return observations.flatMap((observation) =>
    observation.kind !== "transcript.message"
      ? []
      : observation.message.parts.flatMap((part) => (part.type === "dynamic-tool" ? [part] : [])),
  );
}

/**
 * One assistant turn holding a running tool call, then whatever the permission
 * channel does to it. The stream never ends, so a gated row observed here is a
 * live gate rather than an artifact of the turn settling.
 */
function gatedTurn(
  tail: readonly OpenCodeSseEvent[],
  hold: Deferred<void>,
  callState: Record<string, unknown> = { status: "running", input: { path: "src/index.ts" } },
) {
  const network = new FakeNetwork();
  network.subscribe = async (input) => {
    network.subscriptions.push(input);
    return (async function* () {
      yield {
        id: "assistant",
        type: "message.updated",
        properties: {
          info: { id: "provider-assistant", sessionID: "native-session-1", role: "assistant" },
        },
      };
      yield {
        id: "call",
        type: "message.part.updated",
        properties: {
          sessionID: "native-session-1",
          part: {
            id: "p1",
            messageID: "provider-assistant",
            ...toolPart("write", "call-write", callState),
          },
        },
      };
      yield* tail;
      await hold.promise;
    })();
  };
  return network;
}

/**
 * One assistant turn that delegated to a subagent, then whatever happens while
 * that subagent runs. OpenCode states the child Session on the `task` part
 * itself, which is the only place the two ids are ever related.
 *
 * The tail waits out the snapshot coalescing window first, because a subagent
 * takes seconds to reach the call it needs answered: the `task` row has long
 * since painted by then, and anything that gates it has to say so itself. A
 * fixture that yields the tail in the same tick tests a race that never runs.
 */
function delegatedTurn(tail: readonly OpenCodeSseEvent[], hold: Deferred<void>) {
  const network = new FakeNetwork();
  network.subscribe = async (input) => {
    network.subscriptions.push(input);
    return (async function* () {
      yield {
        id: "assistant",
        type: "message.updated",
        properties: {
          info: { id: "provider-assistant", sessionID: "native-session-1", role: "assistant" },
        },
      };
      yield {
        id: "task-call",
        type: "message.part.updated",
        properties: {
          sessionID: "native-session-1",
          part: {
            id: "p1",
            messageID: "provider-assistant",
            ...toolPart("task", "call-task", {
              status: "running",
              input: { description: "Review lab task" },
              metadata: { parentSessionId: "native-session-1", sessionId: "child-session-1" },
            }),
          },
        },
      };
      await new Promise((resolve) => setTimeout(resolve, 50));
      yield* tail;
      await hold.promise;
    })();
  };
  return network;
}

/**
 * A permission raised inside a subagent: tagged with the child Session, naming
 * a call in the child's transcript. Neither id means anything to the Session
 * that has to answer it.
 */
const subagentAskedFor = (sessionID: string) => ({
  id: "asked",
  type: "permission.asked",
  properties: {
    sessionID,
    id: "per_1",
    tool: { messageID: "child-message-1", callID: "child-call-1" },
  },
});

const askedFor = (callID: string, messageID = "provider-assistant") => ({
  id: "asked",
  type: "permission.asked",
  properties: {
    sessionID: "native-session-1",
    id: "per_1",
    title: "Allow write",
    tool: { messageID, callID },
  },
});

function activity(
  kind: ActivityKind,
  nativeToolName: string,
  overrides: Partial<ActivitySubject> & {
    outcome?: Partial<ActivityOutcome>;
    startedAt?: number;
    endedAt?: number;
  } = {},
): Record<string, unknown> {
  const { outcome, startedAt, endedAt, ...subject } = overrides;
  return {
    [ACTIVITY_METADATA_KEY]: {
      kind,
      nativeToolName,
      subject: { label: null, path: null, lineRange: null, ...subject },
      outcome: outcome ? { ...NO_OUTCOME, ...outcome } : null,
      startedAt: startedAt ?? null,
      endedAt: endedAt ?? null,
    },
  };
}

class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve!: (value: T) => void;
  constructor() {
    this.promise = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }
  resolve(value: T): void {
    this.#resolve(value);
  }
}

function waitForever(): Promise<void> {
  return new Promise<void>(() => undefined);
}

class FakeProcess implements OpenCodeProcessPort {
  spawns: Array<{
    path: string;
    args: readonly string[];
    env: Readonly<Record<string, string | undefined>>;
  }> = [];
  readonly exited = new Deferred<number | null>();
  spawnFailure: Error | null = null;
  fingerprint = "sha256:trusted";
  async resolveBinary(path: string): Promise<string> {
    return path === "opencode" ? "/trusted/opencode" : path;
  }
  async version(): Promise<string> {
    return "1.17.18";
  }
  async sha256(): Promise<string> {
    return this.fingerprint;
  }
  async spawn(input: {
    path: string;
    args: readonly string[];
    env: Readonly<Record<string, string | undefined>>;
  }): Promise<OpenCodeChild> {
    if (this.spawnFailure) {
      const failure = this.spawnFailure;
      this.spawnFailure = null;
      throw failure;
    }
    this.spawns.push(input);
    return { exited: this.exited.promise, stop: async () => undefined };
  }
  async allocatePort(): Promise<number> {
    return 43123;
  }
  randomSecret(): string {
    return "never-persist-this";
  }
}

class FakeNetwork implements OpenCodeNetworkPort {
  requests: Array<{
    path: string;
    method: string;
    headers: Readonly<Record<string, string>>;
    body: unknown;
  }> = [];
  subscriptions: Parameters<OpenCodeNetworkPort["subscribe"]>[0][] = [];
  healthStatuses: number[] = [];
  messageResponse: unknown = [{ id: "history-1", role: "assistant" }];
  events: readonly OpenCodeSseEvent[] = [];
  holdEventStream = false;
  async request(input: Parameters<OpenCodeNetworkPort["request"]>[0]) {
    this.requests.push({
      path: input.path,
      method: input.method,
      headers: input.headers,
      body: input.body,
    });
    if (input.path.startsWith("/global/health"))
      return {
        status: this.healthStatuses.shift() ?? 200,
        body: { healthy: true, version: "1.17.18" },
      };
    if (
      input.path.startsWith("/session") &&
      input.method === "POST" &&
      input.path.includes("prompt_async")
    )
      return { status: 204, body: null };
    if (input.path.startsWith("/session") && input.method === "POST")
      return { status: 200, body: { id: "native-session-1" } };
    if (input.path.includes("/message")) return { status: 200, body: this.messageResponse };
    if (input.path.startsWith("/session/status"))
      return { status: 200, body: { "native-session-1": { type: "idle" } } };
    if (input.path.startsWith("/permission")) return { status: 200, body: [] };
    if (input.path.startsWith("/question")) return { status: 200, body: [] };
    if (input.path.includes("/todo")) return { status: 200, body: [] };
    return { status: 200, body: [{ id: "reported", name: "Reported" }] };
  }
  async subscribe(
    input: Parameters<OpenCodeNetworkPort["subscribe"]>[0],
  ): Promise<AsyncIterable<OpenCodeSseEvent>> {
    this.subscriptions.push(input);
    const values = this.events;
    const holdEventStream = this.holdEventStream;
    return (async function* () {
      if (holdEventStream) {
        await new Promise<void>((resolve) =>
          input.signal.addEventListener("abort", () => resolve()),
        );
        return;
      }
      for (const event of values) yield event;
    })();
  }
}

function sseBody(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function spec(directory = "/workspace/one", continuity: "fresh" | "native_resume" = "fresh") {
  return {
    sessionId: "volli-session-1",
    attachmentId: "attachment-1",
    profileId: "native",
    directory,
    continuity,
    native: continuity === "native_resume" ? { id: "native-session-1", detail: null } : null,
  } as const;
}

function messageCommand(): Extract<HarnessCommand, { kind: "message.submit" }> {
  return {
    kind: "message.submit",
    commandId: "volli-command-9",
    sessionId: "volli-session-1",
    attachmentId: "attachment-1",
    delivery: "queue",
    model: { providerId: "openai", modelId: "gpt-5" },
    agent: "build",
    variant: "high",
    message: { id: "message-9", role: "user", parts: [{ type: "text", text: "Fix the tracer" }] },
  };
}

function composition(events: readonly OpenCodeSseEvent[] = []) {
  const process = new FakeProcess();
  const network = new FakeNetwork();
  network.events = events;
  const adapter = createOpenCodeNativeAdapter({
    process,
    network,
    now: () => 1234,
  });
  return { adapter, process, network };
}

describe("OpenCodeNativeAdapter", () => {
  it("rejects an invalid deferred-event safety bound", () => {
    expect(() => createOpenCodeNativeAdapter({ maxDeferredEvents: 0 })).toThrow(
      "maxDeferredEvents must be a positive integer",
    );
    expect(() => createOpenCodeNativeAdapter({ maxDeferredEvents: 1.5 })).toThrow(
      "maxDeferredEvents must be a positive integer",
    );
  });

  it("routes every binding call through its immutable directory and keeps Basic credentials private", async () => {
    const { adapter, network, process } = composition();
    const probe = await adapter.probe(
      { profileId: "native", directory: "/workspace/one" },
      new AbortController().signal,
    );
    expect(probe).toMatchObject({
      status: "available",
      runtime: { path: "/trusted/opencode", version: "1.17.18", fingerprint: "sha256:trusted" },
    });
    const handle = await adapter.attach(spec(), { emit: async () => undefined });
    const delivered = await handle.dispatch(messageCommand());

    expect(delivered.status).toBe("accepted");
    expect(process.spawns).toHaveLength(1);
    expect(process.spawns[0]).toMatchObject({
      path: "/trusted/opencode",
      args: ["serve", "--hostname", "127.0.0.1", "--port", "43123", "--no-mdns"],
      env: {
        OPENCODE_SERVER_PASSWORD: "never-persist-this",
        OPENCODE_SERVER_USERNAME: "opencode",
      },
    });
    const scoped = network.requests.filter(({ path }) => !path.startsWith("/global/health"));
    expect(scoped.every(({ path }) => path.includes("directory=%2Fworkspace%2Fone"))).toBe(true);
    const prompt = network.requests.find(({ path }) => path.includes("prompt_async"));
    expect(prompt?.body).toEqual({
      model: { providerID: "openai", modelID: "gpt-5" },
      agent: "build",
      variant: "high",
      parts: [{ type: "text", text: "Fix the tracer" }],
    });
    expect(delivered.native).toEqual({ id: "native-session-1", detail: null });
    expect(prompt?.headers.authorization).toBe(
      `Basic ${Buffer.from("opencode:never-persist-this").toString("base64")}`,
    );
    expect(JSON.stringify(handle.native)).not.toContain("never-persist-this");
    expect(JSON.stringify(handle.native)).not.toContain("43123");
  });

  it("lets OpenCode assign its own time-ordered message IDs", async () => {
    const { adapter, network } = composition();
    const handle = await adapter.attach(spec(), { emit: async () => undefined });
    await handle.dispatch(messageCommand());

    expect(
      network.requests.find(({ path }) => path.includes("prompt_async"))?.body,
    ).not.toHaveProperty("messageID");
  });

  it("refuses a later server launch when the verified binary has changed", async () => {
    const { adapter, process } = composition();
    await adapter.probe(
      { profileId: "native", directory: "/workspace/one" },
      new AbortController().signal,
    );
    process.exited.resolve(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.fingerprint = "sha256:replaced";

    await expect(adapter.attach(spec(), { emit: async () => undefined })).rejects.toThrow(
      "changed after verification",
    );
  });

  it("reports an already-aborted health probe without launching a usable binding", async () => {
    const { adapter } = composition();
    const abort = new AbortController();
    abort.abort(new Error("probe cancelled"));

    await expect(
      adapter.probe({ profileId: "native", directory: "/workspace/one" }, abort.signal),
    ).resolves.toEqual({ status: "unavailable", runtime: null, reason: "probe cancelled" });
  });

  it("maps legacy SSE messages, turns, and interactions into durable-neutral observations", async () => {
    const { adapter } = composition([
      {
        id: "e-message",
        type: "message.updated",
        properties: {
          sessionID: "native-session-1",
          info: { id: "native-message-1", role: "assistant" },
        },
      },
      {
        id: "e-part",
        type: "message.part.updated",
        properties: {
          sessionID: "native-session-1",
          part: {
            id: "native-part-1",
            type: "text",
            messageID: "native-message-1",
            text: "hello",
          },
        },
      },
      {
        id: "e-busy",
        type: "session.status",
        properties: { sessionID: "native-session-1", status: { type: "busy" } },
      },
      { id: "e-idle", type: "session.idle", properties: { sessionID: "native-session-1" } },
      {
        id: "e-permission",
        type: "permission.asked",
        properties: { sessionID: "native-session-1", id: "permission-1", title: "Allow write" },
      },
      {
        id: "other",
        type: "message.updated",
        properties: { sessionID: "other-session", info: { id: "ignore" } },
      },
    ]);
    const observations: HarnessObservation[] = [];
    await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observations).toEqual([
      expect.objectContaining({
        id: "e-busy",
        kind: "turn.started",
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^message:native-message-1:/),
        kind: "transcript.message",
        message: {
          id: "native-message-1",
          role: "assistant",
          parts: [{ type: "text", text: "hello" }],
        },
      }),
      expect.objectContaining({ id: "e-idle", kind: "turn.completed" }),
      expect.objectContaining({
        id: "e-permission",
        kind: "interaction.opened",
        interaction: expect.objectContaining({
          id: "permission:permission-1",
          native: { id: "permission-1", detail: null },
        }),
      }),
      expect.objectContaining({
        id: "opencode:sse-disconnected:native-session-1",
        kind: "attention.raised",
        attention: expect.objectContaining({
          kind: "adapter_disconnected",
          detail: "OpenCode event stream ended",
        }),
      }),
    ]);
  });

  it("commits a first text delta before OpenCode has sent a full part snapshot", async () => {
    const network = new FakeNetwork();
    const allowIdle = new Deferred<void>();
    network.subscribe = async (input) => {
      network.subscriptions.push(input);
      return (async function* () {
        yield {
          id: "message",
          type: "message.updated",
          properties: {
            info: { id: "provider-assistant", sessionID: "native-session-1", role: "assistant" },
          },
        };
        yield {
          id: "delta",
          type: "message.part.delta",
          properties: {
            messageID: "provider-assistant",
            partID: "answer",
            field: "text",
            delta: "Stream this now",
          },
        };
        await allowIdle.promise;
        yield { id: "idle", type: "session.idle", properties: { sessionID: "native-session-1" } };
      })();
    };
    const adapter = createOpenCodeNativeAdapter({ process: new FakeProcess(), network });
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(observations).toContainEqual(
      expect.objectContaining({
        kind: "transcript.message",
        message: {
          id: "provider-assistant",
          role: "assistant",
          parts: [{ type: "text", text: "Stream this now" }],
        },
      }),
    );
    expect(observations.some((observation) => observation.kind === "turn.completed")).toBe(false);

    allowIdle.resolve(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observations.some((observation) => observation.kind === "turn.completed")).toBe(true);
    await handle.release("requested");
  });

  it("emits one turn fact per native status transition", async () => {
    const { adapter } = composition([
      {
        id: "busy-first",
        type: "session.status",
        properties: { sessionID: "native-session-1", status: { type: "busy" } },
      },
      {
        id: "busy-repeat",
        type: "session.status",
        properties: { sessionID: "native-session-1", status: { type: "busy" } },
      },
      {
        id: "idle-first",
        type: "session.status",
        properties: { sessionID: "native-session-1", status: { type: "idle" } },
      },
      {
        id: "idle-repeat",
        type: "session.idle",
        properties: { sessionID: "native-session-1" },
      },
    ]);
    const observations: HarnessObservation[] = [];
    await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      observations
        .filter(({ kind }) => kind === "turn.started" || kind === "turn.completed")
        .map(({ id, kind }) => ({ id, kind })),
    ).toEqual([
      { id: "busy-first", kind: "turn.started" },
      { id: "idle-first", kind: "turn.completed" },
    ]);
  });

  it("coalesces OpenCode tool lifecycle traffic without dropping earlier metadata", async () => {
    const { adapter } = composition([
      {
        id: "user-message",
        type: "message.updated",
        properties: {
          sessionID: "native-session-1",
          info: { id: "provider-user", role: "user" },
        },
      },
      {
        id: "user-part",
        type: "message.part.updated",
        properties: {
          sessionID: "native-session-1",
          part: {
            id: "user-text",
            messageID: "provider-user",
            type: "text",
            text: "Reply with exactly READY.",
          },
        },
      },
      {
        id: "assistant-message",
        type: "message.updated",
        properties: {
          info: {
            id: "provider-assistant",
            sessionID: "native-session-1",
            role: "assistant",
          },
        },
      },
      {
        id: "reasoning-part",
        type: "message.part.updated",
        properties: {
          sessionID: "native-session-1",
          part: {
            id: "reasoning",
            messageID: "provider-assistant",
            type: "reasoning",
          },
        },
      },
      {
        id: "reasoning-start",
        type: "message.part.delta",
        properties: {
          sessionID: "native-session-1",
          messageID: "provider-assistant",
          partID: "reasoning",
          field: "text",
          delta: "think",
        },
      },
      {
        id: "reasoning-delta",
        type: "message.part.delta",
        properties: {
          sessionID: "native-session-1",
          messageID: "provider-assistant",
          partID: "reasoning",
          field: "text",
          delta: "ing",
        },
      },
      {
        id: "reasoning-delta",
        type: "message.part.delta",
        properties: {
          sessionID: "native-session-1",
          messageID: "provider-assistant",
          partID: "reasoning",
          field: "text",
          delta: "ing",
        },
      },
      {
        id: "text-part",
        type: "message.part.updated",
        properties: {
          sessionID: "native-session-1",
          part: {
            id: "answer",
            messageID: "provider-assistant",
            type: "text",
            text: "REA",
          },
        },
      },
      {
        id: "text-delta",
        type: "message.part.delta",
        properties: {
          sessionID: "native-session-1",
          messageID: "provider-assistant",
          partID: "answer",
          field: "text",
          delta: "DY",
        },
      },
      {
        id: "tool-running",
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-part",
            sessionID: "native-session-1",
            messageID: "provider-assistant",
            type: "tool",
            tool: "read",
            callID: "call-1",
            state: {
              status: "running",
              input: { path: "src/session-runtime.ts" },
              title: "Read Session runtime",
              metadata: { source: "workspace" },
            },
          },
        },
      },
      {
        id: "tool-completed",
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-part",
            sessionID: "native-session-1",
            messageID: "provider-assistant",
            type: "tool",
            tool: "read",
            callID: "call-1",
            state: {
              status: "completed",
              output: { content: 'case "transcript.message"' },
              attachments: [{ id: "artifact-1", mime: "text/plain" }],
              time: { start: 1, end: 2 },
            },
          },
        },
      },
      {
        id: "tool-before-malformed-update",
        type: "message.part.updated",
        properties: {
          sessionID: "native-session-1",
          part: {
            id: "tool-without-final-state",
            messageID: "provider-assistant",
            type: "tool",
            tool: "read",
            callID: "call-without-final-state",
            state: { status: "running" },
          },
        },
      },
      {
        id: "tool-malformed-update",
        type: "message.part.updated",
        properties: {
          sessionID: "native-session-1",
          part: {
            id: "tool-without-final-state",
            messageID: "provider-assistant",
            type: "tool",
            tool: "read",
            callID: "call-without-final-state",
          },
        },
      },
      { id: "idle-final", type: "session.idle", properties: { sessionID: "native-session-1" } },
    ]);
    const observations: HarnessObservation[] = [];
    await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observations.filter(({ kind }) => kind === "transcript.message")).toEqual([
      expect.objectContaining({
        message: {
          id: "provider-assistant",
          role: "assistant",
          parts: [
            { type: "reasoning", text: "thinking", state: "done" },
            { type: "text", text: "READY" },
            {
              type: "dynamic-tool",
              toolName: "read",
              toolCallId: "call-1",
              state: "output-available",
              input: { path: "src/session-runtime.ts" },
              output: { content: 'case "transcript.message"' },
              title: "Read Session runtime",
              toolMetadata: {
                ...activity("read-file", "read", {
                  label: "src/session-runtime.ts",
                  path: "src/session-runtime.ts",
                  outcome: {},
                  startedAt: 1,
                  endedAt: 2,
                }),
                opencode: {
                  attachments: [{ id: "artifact-1", mime: "text/plain" }],
                  metadata: { source: "workspace" },
                  time: { start: 1, end: 2 },
                },
              },
            },
          ],
        },
      }),
    ]);
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "idle-final", kind: "turn.completed" }),
      ]),
    );
    expect(JSON.stringify(observations)).not.toContain("must-not-leak");
    expect(JSON.stringify(observations)).not.toContain("provider-user");
  });

  it("normalizes provider models, variants, MCP state, tools, and safe catalog metadata", async () => {
    const { adapter, network } = composition();
    const originalRequest = network.request.bind(network);
    network.request = async (input) => {
      if (input.path.startsWith("/provider")) {
        return {
          status: 200,
          body: {
            connected: ["openai"],
            default: { openai: "gpt-5" },
            all: [
              {
                id: "openai",
                name: "OpenAI",
                key: "must-not-leak",
                options: { apiKey: "must-not-leak" },
                models: {
                  "gpt-5": {
                    id: "gpt-5",
                    providerID: "openai",
                    name: "GPT-5",
                    family: "gpt",
                    status: "active",
                    variants: { high: { reasoningEffort: "high" } },
                    capabilities: { reasoning: true, attachment: true },
                    limit: { context: 400_000, output: 128_000 },
                    headers: { authorization: "must-not-leak" },
                    options: { apiKey: "must-not-leak" },
                  },
                },
              },
              {
                id: "offline",
                name: "Offline",
                models: { local: { id: "local", name: "Local", status: "active" } },
              },
            ],
          },
        };
      }
      if (input.path.startsWith("/agent")) {
        return {
          status: 200,
          body: [
            {
              name: "build",
              description: "Build agent",
              mode: "primary",
              prompt: "must-not-leak",
              options: { token: "must-not-leak" },
              model: { providerID: "openai", modelID: "gpt-5" },
              variant: "high",
            },
          ],
        };
      }
      if (input.path.startsWith("/command")) {
        return {
          status: 200,
          body: [
            {
              name: "review",
              description: "Review changes",
              source: "command",
              template: "must-not-leak",
              hints: ["target"],
            },
          ],
        };
      }
      if (input.path.startsWith("/mcp")) {
        return {
          status: 200,
          body: {
            github: { status: "connected" },
            linear: { status: "failed", error: "Authorization: Bearer must-not-leak" },
          },
        };
      }
      if (input.path.startsWith("/skill")) {
        return {
          status: 200,
          body: [
            {
              name: "tdd",
              description: "Test first",
              location: "/private/user/path",
              content: "must-not-leak",
            },
          ],
        };
      }
      if (input.path.startsWith("/experimental/tool/ids")) {
        return { status: 200, body: ["read", "write"] };
      }
      return originalRequest(input);
    };

    const probe = await adapter.probe(
      { profileId: "native", directory: "/workspace/one" },
      new AbortController().signal,
    );

    expect(probe.status).toBe("available");
    if (probe.status !== "available") throw new Error("OpenCode probe was not available");
    expect(probe.capabilities.catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "model",
          id: "openai/gpt-5",
          state: "available",
          detail: expect.objectContaining({
            providerId: "openai",
            modelId: "gpt-5",
            variants: ["high"],
          }),
        }),
        expect.objectContaining({ kind: "model", id: "offline/local", state: "unavailable" }),
        expect.objectContaining({ kind: "agent", id: "build" }),
        expect.objectContaining({ kind: "command", id: "review" }),
        expect.objectContaining({ kind: "mcp", id: "github", state: "available" }),
        expect.objectContaining({ kind: "mcp", id: "linear", state: "unavailable" }),
        expect.objectContaining({ kind: "skill", id: "tdd" }),
        expect.objectContaining({ kind: "tool", id: "read" }),
      ]),
    );
    expect(JSON.stringify(probe.capabilities.catalog)).not.toContain("must-not-leak");
    expect(JSON.stringify(probe.capabilities.catalog)).not.toContain("/private/user/path");
  });

  it("preserves finalized OpenCode reasoning and inspectable tool payloads", async () => {
    const { adapter } = composition([
      {
        id: "parts",
        type: "message.updated",
        properties: {
          sessionID: "native-session-1",
          info: { id: "assistant-with-parts", role: "assistant" },
          parts: [
            { type: "text", text: "Visible answer" },
            { type: "reasoning", text: "Visible reasoning" },
            {
              type: "tool",
              tool: "bash",
              callID: "call-running",
              state: {
                status: "running",
                input: { path: "src/session-runtime.ts" },
                title: "Read Session runtime",
              },
            },
            {
              type: "tool",
              tool: "search",
              callID: "call-pending",
              state: {
                status: "pending",
                input: { pattern: "transcript.message" },
                raw: "Preparing repository search",
              },
            },
            {
              type: "tool",
              tool: "read",
              callID: "call-complete",
              state: {
                status: "completed",
                input: { path: "src/session-runtime.ts", offset: 1149 },
                output: { content: 'case "transcript.message"', truncated: false },
                title: "Read transcript mapping",
                metadata: { bytes: 42 },
                time: { start: 1, end: 2 },
              },
            },
            {
              type: "tool",
              tool: "write",
              callID: "call-error",
              state: {
                status: "error",
                input: { path: "src/missing.ts" },
                error: "File not found",
                title: "Read missing file",
                metadata: { code: "ENOENT" },
                time: { start: 3, end: 4 },
              },
            },
            {
              type: "tool",
              tool: "pending-empty",
              callID: "call-pending-empty",
              state: { status: "pending" },
            },
            {
              type: "tool",
              tool: "completed-empty",
              callID: "call-completed-empty",
              state: { status: "completed" },
            },
            {
              type: "tool",
              tool: "error-empty",
              callID: "call-error-empty",
              state: { status: "error" },
            },
          ],
        },
      },
      {
        id: "reasoning-delta",
        type: "message.part.updated",
        properties: {
          sessionID: "native-session-1",
          part: { type: "reasoning", messageID: "assistant-with-parts" },
          delta: "streamed thought",
        },
      },
      {
        id: "reasoning-empty",
        type: "message.part.updated",
        properties: {
          sessionID: "native-session-1",
          part: { type: "reasoning", messageID: "assistant-with-parts" },
        },
      },
      {
        id: "tool-malformed",
        type: "message.part.updated",
        properties: { sessionID: "native-session-1", part: { type: "tool" } },
      },
      {
        id: "tool-unknown-state",
        type: "message.part.updated",
        properties: {
          sessionID: "native-session-1",
          part: {
            type: "tool",
            tool: "future-tool",
            callID: "future-call",
            state: { status: "future" },
          },
        },
      },
    ]);
    const observations: HarnessObservation[] = [];
    await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observations.filter(({ kind }) => kind === "transcript.message")).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          parts: [
            { type: "text", text: "Visible answer" },
            { type: "reasoning", text: "Visible reasoning", state: "done" },
            // A committed, executing call is input-available — the state that
            // earns a spinner. Only a call still forming its input is streaming.
            {
              type: "dynamic-tool",
              toolName: "bash",
              toolCallId: "call-running",
              state: "input-available",
              input: { path: "src/session-runtime.ts" },
              title: "Read Session runtime",
              toolMetadata: activity("run-command", "bash", { label: "src/session-runtime.ts" }),
            },
            {
              type: "dynamic-tool",
              toolName: "search",
              toolCallId: "call-pending",
              state: "input-streaming",
              input: { pattern: "transcript.message" },
              toolMetadata: {
                ...activity("search", "search", { label: "transcript.message" }),
                opencode: { raw: "Preparing repository search" },
              },
            },
            {
              type: "dynamic-tool",
              toolName: "read",
              toolCallId: "call-complete",
              state: "output-available",
              input: { path: "src/session-runtime.ts", offset: 1149 },
              output: { content: 'case "transcript.message"', truncated: false },
              title: "Read transcript mapping",
              toolMetadata: {
                ...activity("read-file", "read", {
                  label: "src/session-runtime.ts",
                  path: "src/session-runtime.ts",
                  outcome: {},
                  startedAt: 1,
                  endedAt: 2,
                }),
                opencode: { metadata: { bytes: 42 }, time: { start: 1, end: 2 } },
              },
            },
            {
              type: "dynamic-tool",
              toolName: "write",
              toolCallId: "call-error",
              state: "output-error",
              input: { path: "src/missing.ts" },
              errorText: "File not found",
              title: "Read missing file",
              toolMetadata: {
                ...activity("write-file", "write", {
                  label: "src/missing.ts",
                  path: "src/missing.ts",
                  outcome: {},
                  startedAt: 3,
                  endedAt: 4,
                }),
                opencode: { metadata: { code: "ENOENT" }, time: { start: 3, end: 4 } },
              },
            },
            {
              type: "dynamic-tool",
              toolName: "pending-empty",
              toolCallId: "call-pending-empty",
              state: "input-streaming",
              toolMetadata: activity("other", "pending-empty"),
            },
            {
              type: "dynamic-tool",
              toolName: "completed-empty",
              toolCallId: "call-completed-empty",
              state: "output-available",
              input: null,
              output: null,
              toolMetadata: activity("other", "completed-empty", { outcome: {} }),
            },
            {
              type: "dynamic-tool",
              toolName: "error-empty",
              toolCallId: "call-error-empty",
              state: "output-error",
              input: null,
              errorText: "Tool failed",
              toolMetadata: activity("other", "error-empty", { outcome: {} }),
            },
          ],
        }),
      }),
    ]);
  });

  it("does not finalize provider messages or parts removed before idle", async () => {
    const { adapter } = composition([
      {
        id: "message-kept",
        type: "message.updated",
        properties: {
          sessionID: "native-session-1",
          info: { id: "assistant-kept", role: "assistant" },
          parts: [
            { id: "part-kept", type: "text", text: "Visible" },
            { id: "part-removed", type: "text", text: "Removed part" },
          ],
        },
      },
      {
        id: "part-removed",
        type: "message.part.removed",
        properties: {
          sessionID: "native-session-1",
          messageID: "assistant-kept",
          partID: "part-removed",
        },
      },
      {
        id: "part-removal-malformed",
        type: "message.part.removed",
        properties: { sessionID: "native-session-1" },
      },
      {
        id: "part-removal-orphaned",
        type: "message.part.removed",
        properties: {
          sessionID: "native-session-1",
          messageID: "missing-message",
          partID: "missing-part",
        },
      },
      {
        id: "part-removal-unknown",
        type: "message.part.removed",
        properties: {
          sessionID: "native-session-1",
          messageID: "assistant-kept",
          partID: "missing-part",
        },
      },
      {
        id: "message-removed-update",
        type: "message.updated",
        properties: {
          sessionID: "native-session-1",
          info: { id: "assistant-removed", role: "assistant" },
          parts: [{ id: "hidden-part", type: "text", text: "Removed message" }],
        },
      },
      {
        id: "message-removed",
        type: "message.removed",
        properties: { sessionID: "native-session-1", messageID: "assistant-removed" },
      },
      {
        id: "fallback-removed-update",
        type: "message.updated",
        properties: {
          sessionID: "native-session-1",
          info: { id: "fallback-removed", role: "assistant" },
          parts: [{ id: "fallback-hidden", type: "text", text: "Fallback removed" }],
        },
      },
      {
        id: "fallback-removed",
        type: "message.removed",
        properties: { sessionID: "native-session-1", id: "fallback-removed" },
      },
      {
        id: "message-removal-malformed",
        type: "message.removed",
        properties: { sessionID: "native-session-1" },
      },
      {
        id: "idle-after-removal",
        type: "session.idle",
        properties: { sessionID: "native-session-1" },
      },
    ]);
    const observations: HarnessObservation[] = [];
    await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observations.filter(({ kind }) => kind === "transcript.message")).toEqual([
      expect.objectContaining({
        message: {
          id: "assistant-kept",
          role: "assistant",
          parts: [{ type: "text", text: "Visible" }],
        },
      }),
    ]);
  });

  it("parses OpenCode data-only SSE envelopes across CRLF and multiline chunks", async () => {
    const events: OpenCodeSseEvent[] = [];
    for await (const event of parseOpenCodeSse(
      sseBody([
        'data: {"id":"evt-1",\r\ndata: "type":"message.updated",\r\ndata: "properties":{"sessionID":"native-session-1"}}\r\n\r\n',
        'data: {"id":"evt-2","type":"session.idle","properties":{"sessionID":"native-session-1"}}\n\n',
      ]),
    ))
      events.push(event);

    expect(events).toEqual([
      { id: "evt-1", type: "message.updated", properties: { sessionID: "native-session-1" } },
      { id: "evt-2", type: "session.idle", properties: { sessionID: "native-session-1" } },
    ]);
  });

  it("rejects an unterminated SSE frame that exceeds the bounded parser buffer", async () => {
    const oversized = `data: ${"x".repeat(1_048_577)}`;
    const consume = async () => {
      for await (const event of parseOpenCodeSse(sseBody([oversized]))) {
        // The oversized input cannot produce a valid event.
        void event;
      }
    };

    await expect(consume()).rejects.toThrow("exceeded the 1 MiB safety limit");
  });

  it("waits for the shared server health endpoint before its first attach", async () => {
    const { network } = composition();
    network.healthStatuses = [503, 503, 200];
    network.holdEventStream = true;
    const delays: number[] = [];
    const retrying = createOpenCodeNativeAdapter({
      process: new FakeProcess(),
      network,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      healthRetryAttempts: 3,
      healthRetryDelayMs: 7,
    });

    await retrying.attach(spec(), { emit: async () => undefined });

    expect(network.requests.filter(({ path }) => path.startsWith("/global/health"))).toHaveLength(
      3,
    );
    expect(delays).toEqual([7, 7]);
  });

  it("gives a cold server a multi-second default startup budget", async () => {
    const process = new FakeProcess();
    const network = new FakeNetwork();
    network.holdEventStream = true;
    const request = network.request.bind(network);
    let transientFailures = 9;
    network.request = async (input) => {
      if (input.path.startsWith("/global/health") && transientFailures-- > 0) {
        throw new Error("server is still starting");
      }
      return request(input);
    };
    const delays: number[] = [];
    const adapter = createOpenCodeNativeAdapter({
      process,
      network,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await adapter.attach(spec(), { emit: async () => undefined });

    expect(delays).toEqual(Array.from({ length: 9 }, () => 100));
    expect(network.requests.filter(({ path }) => path.startsWith("/global/health"))).toHaveLength(
      1,
    );
  });

  it("uses the default health delay between cold-start probes", async () => {
    const { adapter, network } = composition();
    network.healthStatuses = [503, 200];

    await adapter.attach(spec(), { emit: async () => undefined });

    expect(network.requests.filter(({ path }) => path.startsWith("/global/health"))).toHaveLength(
      2,
    );
  });

  it("surfaces a startup failure and permits a later singleton retry", async () => {
    const { adapter, process } = composition();
    process.spawnFailure = new Error("port already in use");

    await expect(adapter.attach(spec(), { emit: async () => undefined })).rejects.toThrow(
      "port already in use",
    );
    await adapter.attach(spec(), { emit: async () => undefined });

    expect(process.spawns).toHaveLength(1);
  });

  it("does not retain a failed startup when close wins its race", async () => {
    const process = new FakeProcess();
    const resolvedPath = new Deferred<string>();
    process.resolveBinary = async () => resolvedPath.promise;
    process.spawnFailure = new Error("port already in use");
    const adapter = createOpenCodeNativeAdapter({ process, network: new FakeNetwork() });

    const attaching = adapter.attach(spec(), { emit: async () => undefined });
    const closing = adapter.close();
    resolvedPath.resolve("/trusted/opencode");

    await expect(attaching).rejects.toThrow("port already in use");
    await closing;
    await expect(adapter.attach(spec(), { emit: async () => undefined })).rejects.toThrow(
      "OpenCode native adapter is closed",
    );
  });

  it("bounds child shutdown if its exit promise never settles", async () => {
    const process = new FakeProcess();
    const network = new FakeNetwork();
    network.holdEventStream = true;
    const delays: number[] = [];
    const adapter = createOpenCodeNativeAdapter({
      process,
      network,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      stopTimeoutMs: 11,
    });
    await adapter.attach(spec(), { emit: async () => undefined });

    await adapter.close();

    expect(delays).toEqual([11]);
    process.exited.resolve(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("aborts the scoped event stream when its binding releases", async () => {
    const { adapter, network } = composition();
    const handle = await adapter.attach(spec(), { emit: async () => undefined });

    expect(network.subscriptions).toHaveLength(1);
    expect(network.subscriptions[0]?.path).toBe("/event?directory=%2Fworkspace%2Fone");
    expect(network.subscriptions[0]?.signal.aborted).toBe(false);
    await handle.release("requested");
    expect(network.subscriptions[0]?.signal.aborted).toBe(true);
  });

  it("reconciles provider state without re-emitting native ids already seen", async () => {
    const { adapter } = composition([
      {
        id: "event-history",
        type: "message.updated",
        properties: { sessionID: "native-session-1", info: { id: "history-1", role: "assistant" } },
      },
    ]);
    const sink: ObservationSink = { emit: async () => undefined };
    const handle = await adapter.attach(spec(), sink);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reconciliation = await handle.reconcile(null);

    expect(reconciliation.observations).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^reconcile:status:reconcile:native-session-1:/),
        kind: "turn.completed",
      }),
    ]);
    expect(reconciliation.cursor).toEqual({
      kind: "volli.opencode.reconciliation.v1",
      token: "reconcile:native-session-1:1",
    });
  });

  it("uses the same immutable observation identity for streamed and reconciled messages", async () => {
    const streamed = composition([
      {
        id: "stream-message",
        type: "message.updated",
        properties: {
          sessionID: "native-session-1",
          info: { id: "stable-message", role: "assistant" },
        },
      },
      {
        id: "stream-part",
        type: "message.part.updated",
        properties: {
          sessionID: "native-session-1",
          part: {
            id: "stable-part",
            messageID: "stable-message",
            type: "text",
            text: "Stable",
          },
        },
      },
      { id: "stream-idle", type: "session.idle", properties: { sessionID: "native-session-1" } },
    ]);
    const streamedObservations: HarnessObservation[] = [];
    await streamed.adapter.attach(spec(), {
      emit: async (observation) => {
        streamedObservations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const streamedMessage = streamedObservations.find(({ kind }) => kind === "transcript.message");

    const reconciled = composition();
    reconciled.network.messageResponse = {
      info: { id: "stable-message", role: "assistant" },
      parts: [{ type: "text", text: "Stable" }],
    };
    const handle = await reconciled.adapter.attach(spec(), { emit: async () => undefined });
    const reconciledMessage = (await handle.reconcile(null)).observations.find(
      ({ kind }) => kind === "transcript.message",
    );

    expect(streamedMessage?.id).toMatch(/^message:stable-message:/);
    expect(reconciledMessage?.id).toBe(streamedMessage?.id);
  });

  it("reconciles documented message responses and only native-session interactions", async () => {
    const { adapter, network } = composition();
    network.messageResponse = {
      info: { id: "history-1", role: "assistant" },
      parts: [{ type: "text", text: "Recovered" }],
    };
    const originalRequest = network.request.bind(network);
    network.request = async (input) => {
      if (input.path.startsWith("/permission"))
        return {
          status: 200,
          body: [
            { sessionID: "native-session-1", id: "permission-mine", title: "Mine" },
            { sessionID: "native-session-1", requestID: "permission-request-id" },
            { sessionID: "native-session-1" },
            { sessionID: "other-session", id: "permission-other", title: "Other" },
          ],
        };
      return originalRequest(input);
    };
    const handle = await adapter.attach(spec(), { emit: async () => undefined });
    const reconciliation = await handle.reconcile(null);

    expect(reconciliation.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "transcript.message",
          message: {
            id: "history-1",
            role: "assistant",
            parts: [{ type: "text", text: "Recovered" }],
          },
        }),
        expect.objectContaining({
          kind: "interaction.opened",
          interaction: expect.objectContaining({ id: "permission:permission-mine" }),
        }),
        expect.objectContaining({
          id: "permission:unknown",
          kind: "interaction.opened",
          interaction: expect.objectContaining({ id: "permission:permission-request-id" }),
        }),
      ]),
    );
    expect(reconciliation.observations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "interaction.opened",
          interaction: expect.objectContaining({ id: "permission:permission-other" }),
        }),
      ]),
    );
  });

  it("suppresses reconciled user echoes except during initial native history import", async () => {
    const userMessage = {
      info: { id: "provider-user-history", role: "user" },
      parts: [{ type: "text", text: "Native prompt" }],
    };
    const fresh = composition();
    fresh.network.messageResponse = userMessage;
    const freshHandle = await fresh.adapter.attach(spec(), { emit: async () => undefined });
    expect(
      (await freshHandle.reconcile(null)).observations.filter(
        ({ kind }) => kind === "transcript.message",
      ),
    ).toEqual([]);

    const resumed = composition();
    resumed.network.messageResponse = userMessage;
    const resumedHandle = await resumed.adapter.attach(spec("/workspace/one", "native_resume"), {
      emit: async () => undefined,
    });
    expect(
      (await resumedHandle.reconcile(null)).observations.filter(
        ({ kind }) => kind === "transcript.message",
      ),
    ).toEqual([
      expect.objectContaining({
        message: {
          id: "provider-user-history",
          role: "user",
          parts: [{ type: "text", text: "Native prompt" }],
        },
      }),
    ]);
  });

  it("retries native history import until the message response is successful and valid", async () => {
    const { adapter, network } = composition();
    const originalRequest = network.request.bind(network);
    const nativeHistory = {
      info: { id: "provider-user-retry", role: "user" },
      parts: [{ type: "text", text: "Recovered native prompt" }],
    };
    const messageResponses = [
      { status: 503, body: nativeHistory },
      { status: 200, body: { items: "malformed" } },
      { status: 200, body: [{}] },
      { status: 200, body: nativeHistory },
    ];
    network.request = async (input) => {
      if (input.path.includes("/message"))
        return messageResponses.shift() ?? { status: 200, body: nativeHistory };
      if (input.path.startsWith("/session/status"))
        return { status: 200, body: { type: "unknown" } };
      return originalRequest(input);
    };
    const handle = await adapter.attach(spec("/workspace/one", "native_resume"), {
      emit: async () => undefined,
    });

    expect(
      (await handle.reconcile(null)).observations.filter(
        ({ kind }) => kind === "transcript.message",
      ),
    ).toEqual([]);
    expect(
      (await handle.reconcile(null)).observations.filter(
        ({ kind }) => kind === "transcript.message",
      ),
    ).toEqual([]);
    expect(
      (await handle.reconcile(null)).observations.filter(
        ({ kind }) => kind === "transcript.message",
      ),
    ).toEqual([]);
    expect(
      (await handle.reconcile(null)).observations.filter(
        ({ kind }) => kind === "transcript.message",
      ),
    ).toEqual([
      expect.objectContaining({
        message: {
          id: "provider-user-retry",
          role: "user",
          parts: [{ type: "text", text: "Recovered native prompt" }],
        },
      }),
    ]);
  });

  it("replays the exact reconciliation batch until its returned cursor is acknowledged", async () => {
    let now = 1234;
    const network = new FakeNetwork();
    const streamGate = new Deferred<void>();
    network.subscribe = async () =>
      (async function* () {
        await streamGate.promise;
        yield* [];
      })();
    network.messageResponse = {
      info: { id: "provider-user-pending", role: "user" },
      parts: [{ type: "text", text: "Durable native prompt" }],
    };
    const adapter = createOpenCodeNativeAdapter({
      process: new FakeProcess(),
      network,
      now: () => now,
    });
    const handle = await adapter.attach(spec("/workspace/one", "native_resume"), {
      emit: async () => undefined,
    });

    await handle.acknowledgeReconciliation?.({
      kind: "volli.opencode.reconciliation.v1",
      token: "missing",
    });
    const first = await handle.reconcile(null);
    await handle.acknowledgeReconciliation?.({
      kind: "volli.opencode.reconciliation.v1",
      token: "wrong",
    });
    now = 9999;
    const retry = await handle.reconcile(null);
    expect(retry).toEqual(first);
    expect(retry.observations.find(({ kind }) => kind === "transcript.message")?.occurredAt).toBe(
      1234,
    );

    const afterAcknowledgement = await handle.reconcile(first.cursor);
    expect(
      afterAcknowledgement.observations.filter(({ kind }) => kind === "transcript.message"),
    ).toEqual([]);
    await handle.release("requested");
  });

  it("does not raise duplicate attention for an unchanged reconciled retry state", async () => {
    const { adapter, network } = composition();
    const originalRequest = network.request.bind(network);
    network.messageResponse = [];
    network.request = async (input) =>
      input.path.startsWith("/session/status")
        ? {
            status: 200,
            body: { "native-session-1": { type: "retry", attempt: 2, next: 345 } },
          }
        : originalRequest(input);
    const handle = await adapter.attach(spec(), { emit: async () => undefined });

    const first = await handle.reconcile(null);
    expect(
      first.observations.filter(
        (observation) =>
          observation.kind === "attention.raised" &&
          observation.attention.kind === "transport_retrying",
      ),
    ).toHaveLength(1);
    await handle.acknowledgeReconciliation?.(first.cursor);

    const second = await handle.reconcile(first.cursor);
    expect(
      second.observations.filter(
        (observation) =>
          observation.kind === "attention.raised" &&
          observation.attention.kind === "transport_retrying",
      ),
    ).toEqual([]);
    await handle.release("requested");
  });

  it("commits reconciliation turn state before accepting later stream transitions", async () => {
    const { adapter, network } = composition();
    const originalRequest = network.request.bind(network);
    network.messageResponse = [];
    network.request = async (input) =>
      input.path.startsWith("/session/status")
        ? { status: 200, body: { "native-session-1": { type: "busy" } } }
        : originalRequest(input);
    const handle = await adapter.attach(spec(), { emit: async () => undefined });
    const reconciliation = await handle.reconcile(null);
    expect(reconciliation.observations).toEqual([
      expect.objectContaining({ kind: "turn.started" }),
    ]);
    await handle.acknowledgeReconciliation?.(reconciliation.cursor);
    await handle.release("requested");
  });

  it("does not consume a native turn transition when its durable sink rejects it", async () => {
    const network = new FakeNetwork();
    network.events = [
      {
        id: "busy-rejected",
        type: "session.status",
        properties: { sessionID: "native-session-1", status: { type: "busy" } },
      },
    ];
    const originalRequest = network.request.bind(network);
    network.request = async (input) =>
      input.path.startsWith("/session/status")
        ? { status: 200, body: { "native-session-1": { type: "busy" } } }
        : originalRequest(input);
    const adapter = createOpenCodeNativeAdapter({
      process: new FakeProcess(),
      network,
      now: () => 1234,
      sleep: waitForever,
    });
    const handle = await adapter.attach(spec(), {
      emit: async () => {
        throw new Error("durable turn write failed");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      (await handle.reconcile(null)).observations.filter(({ kind }) => kind === "turn.started"),
    ).toEqual([expect.objectContaining({ kind: "turn.started" })]);
  });

  it("does not redeliver a reconciled transcript when its final SSE event arrives later", async () => {
    const streamGate = new Deferred<void>();
    const streamEndGate = new Deferred<void>();
    const network = new FakeNetwork();
    network.messageResponse = {
      info: { id: "reconciled-before-stream", role: "assistant" },
      parts: [{ type: "text", text: "Stable recovery" }],
    };
    network.subscribe = async () =>
      (async function* () {
        await streamGate.promise;
        yield {
          id: "late-message",
          type: "message.updated",
          properties: {
            sessionID: "native-session-1",
            info: { id: "reconciled-before-stream", role: "assistant" },
            parts: [{ id: "late-part", type: "text", text: "Stable recovery" }],
          },
        };
        yield {
          id: "late-busy",
          type: "session.status",
          properties: { sessionID: "native-session-1", status: { type: "busy" } },
        };
        yield {
          id: "late-idle",
          type: "session.idle",
          properties: { sessionID: "native-session-1" },
        };
        await streamEndGate.promise;
      })();
    const adapter = createOpenCodeNativeAdapter({
      process: new FakeProcess(),
      network,
      now: () => 1234,
    });
    const streamed: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        streamed.push(observation);
      },
    });
    const reconciliation = await handle.reconcile(null);
    streamGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(streamed.filter(({ kind }) => kind === "transcript.message")).toEqual([]);

    await handle.acknowledgeReconciliation?.(reconciliation.cursor);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(streamed.filter(({ kind }) => kind === "transcript.message")).toEqual([]);
    await handle.release("requested");
  });

  it("uses the documented legacy resolution endpoints", async () => {
    const { adapter, network } = composition();
    const handle = await adapter.attach(spec(), { emit: async () => undefined });
    const permission: Extract<HarnessCommand, { kind: "interaction.resolve" }> = {
      kind: "interaction.resolve",
      commandId: "resolve-1",
      sessionId: "volli-session-1",
      attachmentId: "attachment-1",
      interaction: {
        id: "permission:p-1",
        attachmentId: "attachment-1",
        kind: "permission",
        title: "Allow",
        detail: null,
        options: [],
        multiple: false,
        native: { id: "p-1", detail: null },
      },
      resolution: { optionIds: ["always"], response: "required" },
    };
    await handle.dispatch(permission);
    expect(network.requests.at(-1)).toMatchObject({
      path: "/permission/p-1/reply?directory=%2Fworkspace%2Fone",
      method: "POST",
      body: { reply: "always", message: "required" },
    });
  });

  it("maps provider replies to resolutions and reconstructs QuestionRequest answers", async () => {
    const { adapter, network } = composition([
      {
        id: "asked",
        type: "question.asked",
        properties: {
          sessionID: "native-session-1",
          id: "question-1",
          questions: [
            { header: "Pick a color", options: ["red", "blue"] },
            { header: "Pick a size", options: ["small", "large"] },
          ],
        },
      },
      {
        id: "replied",
        type: "question.replied",
        properties: {
          sessionID: "native-session-1",
          requestID: "question-1",
          answers: [["blue"], ["large"]],
        },
      },
      {
        id: "permission-replied",
        type: "permission.replied",
        properties: {
          sessionID: "native-session-1",
          requestID: "permission-1",
          reply: "always",
          message: "trusted",
        },
      },
    ]);
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observations.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "interaction.resolved",
          interactionId: "question:question-1",
          resolution: { optionIds: ["question:0:Ymx1ZQ", "question:1:bGFyZ2U"], response: null },
        }),
        expect.objectContaining({
          kind: "interaction.resolved",
          interactionId: "permission:permission-1",
          resolution: { optionIds: ["always"], response: "trusted" },
        }),
      ]),
    );
    const opened = observations[0];
    if (!opened || opened.kind !== "interaction.opened") throw new Error("question did not open");
    await handle.dispatch({
      kind: "interaction.resolve",
      commandId: "question-reply",
      sessionId: "volli-session-1",
      attachmentId: "attachment-1",
      interaction: { ...opened.interaction, attachmentId: "attachment-1" },
      resolution: { optionIds: ["question:0:Ymx1ZQ", "question:1:bGFyZ2U"], response: null },
    });
    expect(network.requests.at(-1)).toMatchObject({
      path: "/question/question-1/reply?directory=%2Fworkspace%2Fone",
      body: { answers: [["blue"], ["large"]] },
    });
  });

  it("round-trips documented QuestionOption objects without persisting descriptions", async () => {
    const { adapter, network } = composition([
      {
        id: "asked-object-options",
        type: "question.asked",
        properties: {
          sessionID: "native-session-1",
          id: "question-object-options",
          questions: [
            {
              header: "Pick a color",
              options: [
                { label: "red", description: "Use the warm palette" },
                { label: "blue", description: "Use the cool palette" },
              ],
            },
          ],
        },
      },
      {
        id: "replied-object-options",
        type: "question.replied",
        properties: {
          sessionID: "native-session-1",
          requestID: "question-object-options",
          answers: [["blue"]],
        },
      },
    ]);
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const opened = observations.find(
      (observation): observation is Extract<HarnessObservation, { kind: "interaction.opened" }> =>
        observation.kind === "interaction.opened",
    );
    if (!opened) throw new Error("documented question options did not open");
    expect(opened.interaction.options).toEqual([
      {
        id: "question:0:cmVk",
        label: "Pick a color: red",
        description: "Use the warm palette",
      },
      {
        id: "question:0:Ymx1ZQ",
        label: "Pick a color: blue",
        description: "Use the cool palette",
      },
    ]);
    expect(JSON.stringify(opened.interaction.native)).not.toContain("warm palette");
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "interaction.resolved",
          interactionId: "question:question-object-options",
          resolution: { optionIds: ["question:0:Ymx1ZQ"], response: null },
        }),
      ]),
    );

    await handle.dispatch({
      kind: "interaction.resolve",
      commandId: "object-question-reply",
      sessionId: "volli-session-1",
      attachmentId: "attachment-1",
      interaction: { ...opened.interaction, attachmentId: "attachment-1" },
      resolution: { optionIds: ["question:0:cmVk"], response: null },
    });
    expect(network.requests.at(-1)).toMatchObject({
      path: "/question/question-object-options/reply?directory=%2Fworkspace%2Fone",
      body: { answers: [["red"]] },
    });
  });

  it("supervises one shared child while retaining each binding directory", async () => {
    const { adapter, process, network } = composition();
    await adapter.attach(spec("/workspace/one"), { emit: async () => undefined });
    await adapter.attach(
      { ...spec("/workspace/two"), attachmentId: "attachment-2", sessionId: "volli-session-2" },
      { emit: async () => undefined },
    );

    expect(process.spawns).toHaveLength(1);
    expect(
      network.requests
        .filter(({ path }) => path.startsWith("/session?") && path.includes("directory="))
        .map(({ path }) => path),
    ).toEqual(["/session?directory=%2Fworkspace%2Fone", "/session?directory=%2Fworkspace%2Ftwo"]);
  });

  it("rejects unknown profiles and reports probe failures without throwing", async () => {
    const { adapter, process } = composition();
    await expect(
      adapter.attach({ ...spec(), profileId: "terminal" }, { emit: async () => undefined }),
    ).rejects.toThrow("Unknown OpenCode profile terminal");
    expect(
      await adapter.probe(
        { profileId: "terminal", directory: "/workspace/one" },
        new AbortController().signal,
      ),
    ).toMatchObject({ status: "unavailable", reason: "Unknown OpenCode profile terminal" });

    process.resolveBinary = async () => {
      throw "not an Error";
    };
    expect(
      await adapter.probe(
        { profileId: "native", directory: "/workspace/one" },
        new AbortController().signal,
      ),
    ).toEqual({ status: "unavailable", runtime: null, reason: "OpenCode probe failed" });
  });

  it("covers health retry failures and resume validation", async () => {
    const healthFailure = composition();
    healthFailure.network.healthStatuses = [503, 503];
    const retrying = createOpenCodeNativeAdapter({
      process: healthFailure.process,
      network: healthFailure.network,
      sleep: async () => undefined,
      healthRetryAttempts: 2,
    });
    await expect(retrying.attach(spec(), { emit: async () => undefined })).rejects.toThrow(
      "OpenCode health check returned 503",
    );

    const nonErrorHealth = composition();
    nonErrorHealth.network.request = async () => {
      throw "health unavailable";
    };
    const failedHealth = createOpenCodeNativeAdapter({
      process: nonErrorHealth.process,
      network: nonErrorHealth.network,
      healthRetryAttempts: 1,
    });
    await expect(failedHealth.attach(spec(), { emit: async () => undefined })).rejects.toThrow(
      "OpenCode health check failed",
    );

    const transportFailure = composition();
    transportFailure.network.request = async () => {
      throw new Error("offline");
    };
    const unavailableAdapter = createOpenCodeNativeAdapter({
      process: transportFailure.process,
      network: transportFailure.network,
      healthRetryAttempts: 1,
    });
    const unavailable = await unavailableAdapter.probe(
      { profileId: "native", directory: "/workspace/one" },
      new AbortController().signal,
    );
    expect(unavailable).toEqual({ status: "unavailable", runtime: null, reason: "offline" });

    const resumed = composition();
    const resumedHandle = await resumed.adapter.attach(spec("/workspace/one", "native_resume"), {
      emit: async () => undefined,
    });
    expect(resumedHandle.native).toEqual({ id: "native-session-1", detail: null });
    expect(
      resumed.network.requests.some(({ path }) => path.startsWith("/session/native-session-1?")),
    ).toBe(true);
    await expect(
      resumed.adapter.attach(
        { ...spec("/workspace/one", "native_resume"), native: null },
        { emit: async () => undefined },
      ),
    ).rejects.toThrow("requires a provider Session id");
  });

  it("rejects malformed session creation and failed resume lookups", async () => {
    const malformed = composition();
    const originalRequest = malformed.network.request.bind(malformed.network);
    malformed.network.request = async (input) => {
      if (input.path.startsWith("/session?") && input.method === "POST")
        return { status: 201, body: { id: 42 } };
      return originalRequest(input);
    };
    await expect(malformed.adapter.attach(spec(), { emit: async () => undefined })).rejects.toThrow(
      "OpenCode session creation returned 201",
    );

    const absent = composition();
    const resumeRequest = absent.network.request.bind(absent.network);
    absent.network.request = async (input) =>
      input.path.startsWith("/session/native-session-1?")
        ? { status: 404, body: null }
        : resumeRequest(input);
    await expect(
      absent.adapter.attach(spec("/workspace/one", "native_resume"), {
        emit: async () => undefined,
      }),
    ).rejects.toThrow("OpenCode resume lookup returned 404");
  });

  it("dispatches accepted, rejected, and failed messages and interruptions", async () => {
    const { adapter, network } = composition();
    const handle = await adapter.attach(spec(), { emit: async () => undefined });
    expect(
      await handle.dispatch({
        ...messageCommand(),
        model: null,
        agent: null,
        variant: null,
        message: { ...messageCommand().message, parts: [] },
      }),
    ).toMatchObject({ status: "accepted", acceptedAt: 1234 });
    const prompt = network.requests.at(-1);
    expect(prompt?.body).toEqual({
      parts: [],
    });

    const originalRequest = network.request.bind(network);
    network.request = async (input) =>
      input.path.includes("prompt_async") ? { status: 400, body: null } : originalRequest(input);
    expect(await handle.dispatch(messageCommand())).toMatchObject({
      status: "rejected",
      code: "OPENCODE_HTTP_400",
    });
    network.request = async (input) =>
      input.path.includes("/abort") ? { status: 202, body: null } : originalRequest(input);
    expect(
      await handle.dispatch({
        kind: "executor.interrupt",
        commandId: "interrupt",
        sessionId: "volli-session-1",
        attachmentId: "attachment-1",
      }),
    ).toMatchObject({ status: "accepted", acceptedAt: 1234 });
    network.request = async () => {
      throw "network lost";
    };
    expect(await handle.dispatch(messageCommand())).toEqual({
      commandId: "volli-command-9",
      status: "unknown",
      detail: "OpenCode transport failed",
      native: { id: "native-session-1", detail: null },
    });
    network.request = async () => {
      throw new Error("prompt connection closed");
    };
    expect(await handle.dispatch(messageCommand())).toMatchObject({
      commandId: "volli-command-9",
      status: "unknown",
      detail: "prompt connection closed",
    });
    network.request = async () => {
      throw "abort transport lost";
    };
    expect(
      await handle.dispatch({
        kind: "executor.interrupt",
        commandId: "interrupt-unknown",
        sessionId: "volli-session-1",
        attachmentId: "attachment-1",
      }),
    ).toMatchObject({ status: "unknown", detail: "OpenCode transport failed" });
    network.request = async () => {
      throw new Error("abort connection closed");
    };
    expect(
      await handle.dispatch({
        kind: "executor.interrupt",
        commandId: "interrupt-error",
        sessionId: "volli-session-1",
        attachmentId: "attachment-1",
      }),
    ).toMatchObject({ status: "unknown", detail: "abort connection closed" });

    network.request = originalRequest;
    expect(
      await handle.dispatch({
        ...messageCommand(),
        message: {
          id: "message-reasoning",
          role: "user",
          parts: [{ type: "reasoning", text: "do not send" }],
        },
      }),
    ).toMatchObject({ status: "accepted" });
    expect(network.requests.at(-1)?.body).toEqual({
      model: { providerID: "openai", modelID: "gpt-5" },
      agent: "build",
      variant: "high",
      parts: [],
    });
  });

  it("settles a thought once the model answers past it, mid-turn", async () => {
    const network = new FakeNetwork();
    const hold = new Deferred<void>();
    network.subscribe = async (input) => {
      network.subscriptions.push(input);
      return (async function* () {
        yield {
          id: "assistant",
          type: "message.updated",
          properties: {
            info: { id: "provider-assistant", sessionID: "native-session-1", role: "assistant" },
          },
        };
        yield {
          id: "think",
          type: "message.part.updated",
          properties: {
            sessionID: "native-session-1",
            part: {
              id: "r1",
              messageID: "provider-assistant",
              type: "reasoning",
              text: "Overtaken",
            },
          },
        };
        yield {
          id: "answer",
          type: "message.part.updated",
          properties: {
            sessionID: "native-session-1",
            part: {
              id: "t1",
              messageID: "provider-assistant",
              type: "text",
              text: "Answer so far",
            },
          },
        };
        // The turn never goes idle, so anything still "streaming" here is
        // genuinely live rather than an artifact of the stream closing.
        await hold.promise;
      })();
    };
    const adapter = createOpenCodeNativeAdapter({ process: new FakeProcess(), network });
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Text after the thought means the model moved on: the elapsed counter must
    // freeze even though the turn is still busy.
    expect(observations).toContainEqual(
      expect.objectContaining({
        kind: "transcript.message",
        message: expect.objectContaining({
          parts: [
            { type: "reasoning", text: "Overtaken", state: "done" },
            { type: "text", text: "Answer so far" },
          ],
        }),
      }),
    );
    hold.resolve(undefined);
    await handle.release("requested");
  });

  it("settles the message's last thought on OpenCode's own time.end, mid-turn", async () => {
    const network = new FakeNetwork();
    const hold = new Deferred<void>();
    network.subscribe = async (input) => {
      network.subscriptions.push(input);
      return (async function* () {
        yield {
          id: "assistant",
          type: "message.updated",
          properties: {
            info: { id: "provider-assistant", sessionID: "native-session-1", role: "assistant" },
          },
        };
        // OpenCode opens a reasoning part with an empty text and a start time,
        // then streams the body as deltas.
        yield {
          id: "think-open",
          type: "message.part.updated",
          properties: {
            sessionID: "native-session-1",
            part: {
              id: "r1",
              messageID: "provider-assistant",
              type: "reasoning",
              text: "",
              time: { start: 1 },
            },
          },
        };
        yield {
          id: "think-delta",
          type: "message.part.delta",
          properties: {
            sessionID: "native-session-1",
            messageID: "provider-assistant",
            partID: "r1",
            field: "text",
            delta: "Weighing the trade-offs",
          },
        };
        // Long enough to earn its own coalesced snapshot, so the thought is
        // observed live before anything settles it.
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield {
          id: "think-finished",
          type: "message.part.updated",
          properties: {
            sessionID: "native-session-1",
            part: {
              id: "r1",
              messageID: "provider-assistant",
              type: "reasoning",
              text: "Weighing the trade-offs",
              time: { start: 1, end: 2 },
            },
          },
        };
        await hold.promise;
      })();
    };
    const adapter = createOpenCodeNativeAdapter({ process: new FakeProcess(), network });
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The thought is the message's only part throughout, so position cannot
    // explain the settle — `time.end` is the whole signal. And the opening
    // empty snapshot never drew a part of its own.
    expect(
      observations.flatMap((observation) =>
        observation.kind === "transcript.message"
          ? observation.message.parts.flatMap((part) =>
              part.type === "reasoning" ? [{ text: part.text, state: part.state }] : [],
            )
          : [],
      ),
    ).toEqual([
      { text: "Weighing the trade-offs", state: "streaming" },
      { text: "Weighing the trade-offs", state: "done" },
    ]);
    hold.resolve(undefined);
    await handle.release("requested");
  });

  it("keeps a streaming thought when a re-hydrated snapshot serves it empty", async () => {
    const network = new FakeNetwork();
    const hold = new Deferred<void>();
    network.subscribe = async (input) => {
      network.subscriptions.push(input);
      return (async function* () {
        yield {
          id: "assistant",
          type: "message.updated",
          properties: {
            info: { id: "provider-assistant", sessionID: "native-session-1", role: "assistant" },
          },
        };
        yield {
          id: "think-open",
          type: "message.part.updated",
          properties: {
            sessionID: "native-session-1",
            part: {
              id: "r1",
              messageID: "provider-assistant",
              type: "reasoning",
              text: "",
              time: { start: 1 },
            },
          },
        };
        yield {
          id: "think-delta",
          type: "message.part.delta",
          properties: {
            sessionID: "native-session-1",
            messageID: "provider-assistant",
            partID: "r1",
            field: "text",
            delta: "Still thinking",
          },
        };
        // What a mid-stream re-hydrate serves for a live part: OpenCode never
        // projects deltas to its database, so the text comes back empty.
        yield {
          id: "think-rehydrated",
          type: "message.part.updated",
          properties: {
            sessionID: "native-session-1",
            part: {
              id: "r1",
              messageID: "provider-assistant",
              type: "reasoning",
              text: "",
              time: { start: 1 },
            },
          },
        };
        await hold.promise;
      })();
    };
    const adapter = createOpenCodeNativeAdapter({ process: new FakeProcess(), network });
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(observations).toContainEqual(
      expect.objectContaining({
        kind: "transcript.message",
        message: expect.objectContaining({
          parts: [{ type: "reasoning", text: "Still thinking", state: "streaming" }],
        }),
      }),
    );
    hold.resolve(undefined);
    await handle.release("requested");
  });

  it("draws no part for a thought that is only whitespace", async () => {
    const { adapter } = composition([
      {
        id: "assistant",
        type: "message.updated",
        properties: {
          sessionID: "native-session-1",
          info: { id: "provider-assistant", role: "assistant" },
          parts: [
            { id: "r1", type: "reasoning", text: " \n " },
            { id: "t1", type: "text", text: "Answer" },
          ],
        },
      },
    ]);
    const observations: HarnessObservation[] = [];
    await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observations.filter(({ kind }) => kind === "transcript.message")).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ parts: [{ type: "text", text: "Answer" }] }),
      }),
    ]);
  });

  it("draws no part for a text part that never got words", async () => {
    const { adapter } = composition([
      {
        id: "assistant",
        type: "message.updated",
        properties: {
          sessionID: "native-session-1",
          info: { id: "provider-assistant", role: "assistant" },
          parts: [
            // A step that ran tools and ended without prose. OpenCode opens the
            // text part regardless, and it survives to the transcript as a block
            // that draws nothing but still separates the activity around it.
            { id: "t1", type: "text", text: "" },
            { id: "tool1", type: "tool", tool: "bash", state: { status: "completed" } },
            { id: "t2", type: "text", text: " \n " },
            { id: "t3", type: "text", text: "Answer" },
          ],
        },
      },
    ]);
    const observations: HarnessObservation[] = [];
    await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const message = observations.find(({ kind }) => kind === "transcript.message");
    const parts = (message as { message: { parts: readonly { type: string }[] } }).message.parts;
    expect(parts.filter((part) => part.type === "text")).toEqual([
      { type: "text", text: "Answer" },
    ]);
  });

  it("maps every status family and ignores malformed or unrelated SSE events", async () => {
    const { adapter } = composition([
      {
        id: "delta",
        type: "message.part.delta",
        properties: { sessionID: "native-session-1", delta: "d" },
      },
      {
        id: "part-missing",
        type: "message.part.updated",
        properties: { sessionID: "native-session-1" },
      },
      {
        id: "orphan-delta",
        type: "message.part.delta",
        properties: {
          sessionID: "native-session-1",
          messageID: "missing-message",
          partID: "missing-part",
          field: "text",
          delta: "ignored",
        },
      },
      {
        id: "busy-nested",
        type: "session.status",
        properties: { sessionID: "native-session-1", status: { type: "busy" } },
      },
      { id: "idle", type: "session.idle", properties: { sessionID: "native-session-1" } },
      {
        id: "retry",
        type: "session.status",
        properties: {
          sessionID: "native-session-1",
          status: {
            type: "retry",
            attempt: 2,
            next: 345,
            message: "must-not-leak",
            action: { title: "must-not-leak", message: "must-not-leak" },
          },
        },
      },
      {
        id: "error",
        type: "session.error",
        properties: {
          sessionID: "native-session-1",
          error: {
            name: "APIError",
            data: {
              message: "must-not-leak",
              statusCode: 502,
              isRetryable: false,
              responseHeaders: { authorization: "must-not-leak" },
              responseBody: "must-not-leak",
            },
          },
        },
      },
      {
        id: "error-name-only",
        type: "session.error",
        properties: {
          sessionID: "native-session-1",
          error: { name: "MessageAbortedError" },
        },
      },
      {
        id: "error-status-only",
        type: "session.error",
        properties: {
          sessionID: "native-session-1",
          error: { name: "FutureError", data: { statusCode: 503 } },
        },
      },
      {
        id: "error-empty",
        type: "session.error",
        properties: { sessionID: "native-session-1", error: { data: {} } },
      },
      {
        id: "error-auth",
        type: "session.error",
        properties: {
          sessionID: "native-session-1",
          error: { name: "ProviderAuthError", data: { message: "must-not-leak" } },
        },
      },
      {
        id: "error-context",
        type: "session.error",
        properties: {
          sessionID: "native-session-1",
          error: { name: "ContextOverflowError" },
        },
      },
      {
        id: "error-rate-limited",
        type: "session.error",
        properties: {
          sessionID: "native-session-1",
          error: { name: "APIError", data: { statusCode: 429, isRetryable: true } },
        },
      },
      {
        id: "error-unauthorized",
        type: "session.error",
        properties: {
          sessionID: "native-session-1",
          error: { name: "APIError", data: { statusCode: 401 } },
        },
      },
      {
        id: "error-forbidden",
        type: "session.error",
        properties: {
          sessionID: "native-session-1",
          error: { name: "APIError", data: { statusCode: 403 } },
        },
      },
      {
        id: "unknown-status",
        type: "session.status",
        properties: { sessionID: "native-session-1", status: { type: "gone" } },
      },
      {
        id: "missing-request",
        type: "permission.asked",
        properties: { sessionID: "native-session-1" },
      },
      { id: "unknown-event", type: "x.unknown", properties: { sessionID: "native-session-1" } },
      { id: "wrong", type: "session.idle", properties: { sessionID: "wrong" } },
    ]);
    const observations: HarnessObservation[] = [];
    await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observations.map(({ id }) => id)).toEqual([
      "busy-nested",
      "idle",
      "retry",
      "error",
      "error-name-only",
      "error-status-only",
      "error-empty",
      "error-auth",
      "error-context",
      "error-rate-limited",
      "error-unauthorized",
      "error-forbidden",
      "opencode:sse-disconnected:native-session-1",
    ]);
    expect(observations[2]).toMatchObject({
      kind: "attention.raised",
      attention: {
        kind: "transport_retrying",
        detail: "OpenCode is retrying",
        diagnostic: { attempt: 2, next: 345 },
      },
    });
    expect(observations[3]).toMatchObject({
      kind: "attention.raised",
      attention: {
        kind: "adapter_unrecoverable",
        detail: "OpenCode APIError (status 502)",
        diagnostic: { name: "APIError", statusCode: 502, isRetryable: false },
      },
    });
    expect(observations[4]).toMatchObject({
      attention: {
        kind: "partial_turn_interrupted",
        detail: "OpenCode MessageAbortedError",
        diagnostic: { name: "MessageAbortedError" },
      },
    });
    // An unrecognized name is redacted to null, so it classifies by the same
    // rule an absent one does rather than by a string OpenCode may add later.
    expect(observations[5]).toMatchObject({
      attention: {
        kind: "adapter_unrecoverable",
        detail: "OpenCode session error (status 503)",
        diagnostic: { statusCode: 503 },
      },
    });
    expect(observations[6]).toMatchObject({
      attention: { kind: "adapter_unrecoverable", detail: null, diagnostic: null },
    });
    // Each of these used to arrive as `adapter_unrecoverable`, which is why an
    // expired token and a context overflow offered the same recovery: none.
    expect(observations[7]).toMatchObject({
      attention: { kind: "auth_required", detail: "OpenCode ProviderAuthError" },
    });
    expect(observations[8]).toMatchObject({
      attention: { kind: "context_limit_reached", detail: "OpenCode ContextOverflowError" },
    });
    // The observation carries no `retryAt`: OpenCode reports no Retry-After, and
    // a "try again at…" with no time in it is worse than a rate limit stated
    // plainly. The engine defaults the absent field to null when it commits.
    expect(observations[9]).toMatchObject({
      attention: { kind: "rate_limited", detail: "OpenCode APIError (status 429)" },
    });
    expect(observations[10]).toMatchObject({ attention: { kind: "auth_required" } });
    expect(observations[11]).toMatchObject({ attention: { kind: "auth_required" } });
  });

  it("does not repeat SSE observations and raises durable attention when the stream drops", async () => {
    const process = new FakeProcess();
    const network = new FakeNetwork();
    network.subscribe = async () =>
      (async function* () {
        yield { id: "repeat", type: "session.idle", properties: { sessionID: "native-session-1" } };
        yield { id: "repeat", type: "session.idle", properties: { sessionID: "native-session-1" } };
        throw new Error("stream closed");
      })();
    const adapter = createOpenCodeNativeAdapter({
      process,
      network,
      now: () => 1234,
      sleep: waitForever,
    });
    const observations: HarnessObservation[] = [];
    await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observations).toEqual([
      expect.objectContaining({ id: "repeat", kind: "turn.completed" }),
      expect.objectContaining({
        id: "opencode:sse-disconnected:native-session-1",
        kind: "attention.raised",
        attention: expect.objectContaining({ detail: "stream closed" }),
      }),
    ]);
  });

  it("reconnects a dropped SSE stream without failing the durable attachment", async () => {
    const process = new FakeProcess();
    const network = new FakeNetwork();
    const reconnectDelay = new Deferred<void>();
    const releaseSecondStream = new Deferred<void>();
    let subscriptions = 0;
    network.subscribe = async (input) => {
      network.subscriptions.push(input);
      subscriptions += 1;
      if (subscriptions === 1) {
        return (async function* () {
          if (input.signal.aborted) {
            yield { id: "unreachable", type: "session.idle", properties: {} };
          }
          throw new Error("temporary stream failure");
        })();
      }
      return (async function* () {
        await releaseSecondStream.promise;
        if (input.signal.aborted) {
          yield { id: "unreachable", type: "session.idle", properties: {} };
        }
      })();
    };
    const adapter = createOpenCodeNativeAdapter({
      process,
      network,
      now: () => 1234,
      sleep: () => reconnectDelay.promise,
    });
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observations).toEqual([
      expect.objectContaining({
        kind: "attention.raised",
        attention: expect.objectContaining({ detail: "temporary stream failure" }),
      }),
    ]);

    reconnectDelay.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(network.subscriptions).toHaveLength(2);
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "attention.cleared",
          attentionId: "opencode:sse-disconnected:native-session-1",
        }),
      ]),
    );
    expect(observations.some(({ kind }) => kind === "attachment.failed")).toBe(false);
    // Let the detached reconnect pump finish its post-clear continuation so
    // coverage records both branches of its connection-state guard.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await handle.release("requested");
    releaseSecondStream.resolve();
  });

  it("contains a rejected reconnect delay after recording disconnected attention", async () => {
    const network = new FakeNetwork();
    const adapter = createOpenCodeNativeAdapter({
      process: new FakeProcess(),
      network,
      now: () => 1234,
      sleep: async () => {
        throw new Error("shutdown retry loop");
      },
    });
    const observations: HarnessObservation[] = [];
    await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observations).toEqual([
      expect.objectContaining({
        kind: "attention.raised",
        attention: expect.objectContaining({ kind: "adapter_disconnected" }),
      }),
    ]);
  });

  it("contains both Error and non-Error failures while reconnecting", async () => {
    const network = new FakeNetwork();
    let subscriptions = 0;
    network.subscribe = async () => {
      subscriptions += 1;
      if (subscriptions === 1) return (async function* () {})();
      if (subscriptions === 2) throw new Error("second connection failed");
      throw "third connection failed";
    };
    let delays = 0;
    const adapter = createOpenCodeNativeAdapter({
      process: new FakeProcess(),
      network,
      now: () => 1234,
      sleep: async () => {
        delays += 1;
        if (delays === 3) throw new Error("stop retrying");
      },
    });
    await adapter.attach(spec(), { emit: async () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(subscriptions).toBe(3);
  });

  it("does not reconnect when release wins during the retry delay", async () => {
    const network = new FakeNetwork();
    const retryDelay = new Deferred<void>();
    const adapter = createOpenCodeNativeAdapter({
      process: new FakeProcess(),
      network,
      now: () => 1234,
      sleep: () => retryDelay.promise,
    });
    const handle = await adapter.attach(spec(), { emit: async () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await handle.release("requested");
    retryDelay.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(network.subscriptions).toHaveLength(1);
  });

  it("bounds deferred stream events and requires a fresh reconciliation after overflow", async () => {
    const network = new FakeNetwork();
    const eventGate = new Deferred<void>();
    const messageResponse = new Deferred<OpenCodeHttpResponse>();
    network.subscribe = async () =>
      (async function* () {
        await eventGate.promise;
        yield {
          id: "deferred-busy",
          type: "session.status",
          properties: { sessionID: "native-session-1", status: { type: "busy" } },
        };
        yield {
          id: "deferred-idle",
          type: "session.idle",
          properties: { sessionID: "native-session-1" },
        };
        await waitForever();
      })();
    const request = network.request.bind(network);
    network.request = async (input) =>
      input.path.includes("/message") ? messageResponse.promise : request(input);
    const adapter = createOpenCodeNativeAdapter({
      process: new FakeProcess(),
      network,
      now: () => 1234,
      maxDeferredEvents: 1,
      sleep: waitForever,
    });
    const handle = await adapter.attach(spec(), { emit: async () => undefined });
    const reconciling = handle.reconcile(null);
    eventGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    messageResponse.resolve({ status: 200, body: [] });
    const reconciliation = await reconciling;

    expect(reconciliation.observations).toEqual([
      expect.objectContaining({ kind: "turn.completed" }),
    ]);
    await handle.acknowledgeReconciliation?.(reconciliation.cursor);
    await handle.release("requested");
  });

  it("bounds remembered native identities while draining a long stream", async () => {
    const network = new FakeNetwork();
    const drained = new Deferred<void>();
    network.subscribe = async () =>
      (async function* () {
        for (let index = 0; index <= 10_000; index += 1) {
          yield {
            id: `error-${index}`,
            type: "session.error",
            properties: {
              sessionID: "native-session-1",
              error: { name: `ProviderError${index}` },
            },
          };
        }
        drained.resolve();
        await waitForever();
      })();
    const adapter = createOpenCodeNativeAdapter({
      process: new FakeProcess(),
      network,
      now: () => 1234,
      sleep: waitForever,
    });
    const handle = await adapter.attach(spec(), { emit: async () => undefined });
    await drained.promise;
    await handle.release("requested");
  });

  it("contains a detached pump sink failure without emitting an unhandled rejection", async () => {
    const network = new FakeNetwork();
    network.subscribe = async () =>
      (async function* () {
        yield {
          id: "sink-failure",
          type: "session.idle",
          properties: { sessionID: "native-session-1" },
        };
      })();
    const adapter = createOpenCodeNativeAdapter({
      process: new FakeProcess(),
      network,
      now: () => 1234,
      sleep: waitForever,
    });
    let emits = 0;
    const attempted: HarnessObservation[] = [];
    await adapter.attach(spec(), {
      emit: async (observation) => {
        emits += 1;
        attempted.push(observation);
        throw new Error("durable store unavailable");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A transient stream failure remains retryable even when both the source
    // event and its durable attention fail to persist.
    expect(emits).toBe(2);
    expect(attempted.map(({ kind }) => kind)).toEqual(["turn.completed", "attention.raised"]);
    expect(attempted[1]).toMatchObject({
      id: "opencode:sse-disconnected:native-session-1",
      attention: { kind: "adapter_disconnected", detail: "durable store unavailable" },
    });
  });

  it("suppresses dropped-stream attention after release and uses a safe fallback for non-Error failures", async () => {
    const releaseGate = new Deferred<void>();
    const releasedNetwork = new FakeNetwork();
    releasedNetwork.subscribe = async () =>
      (async function* () {
        await releaseGate.promise;
        yield* [];
        throw new Error("late close");
      })();
    const releasedAdapter = createOpenCodeNativeAdapter({
      process: new FakeProcess(),
      network: releasedNetwork,
      now: () => 1234,
    });
    const releasedObservations: HarnessObservation[] = [];
    const releasedHandle = await releasedAdapter.attach(spec(), {
      emit: async (observation) => {
        releasedObservations.push(observation);
      },
    });
    await releasedHandle.release("requested");
    releaseGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releasedObservations).toEqual([]);

    const stringFailure = new FakeNetwork();
    stringFailure.subscribe = async () =>
      (async function* () {
        yield* [];
        throw "stream failed";
      })();
    const stringAdapter = createOpenCodeNativeAdapter({
      process: new FakeProcess(),
      network: stringFailure,
      now: () => 1234,
      sleep: waitForever,
    });
    const stringObservations: HarnessObservation[] = [];
    await stringAdapter.attach(spec(), {
      emit: async (observation) => {
        stringObservations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stringObservations).toEqual([
      expect.objectContaining({
        kind: "attention.raised",
        attention: expect.objectContaining({ detail: "OpenCode event stream disconnected" }),
      }),
    ]);
  });

  it("waits for an in-flight durable emit before release completes", async () => {
    const emitEntered = new Deferred<void>();
    const allowEmit = new Deferred<void>();
    const network = new FakeNetwork();
    network.events = [
      {
        id: "release-message",
        type: "message.updated",
        properties: {
          sessionID: "native-session-1",
          info: { id: "release-assistant", role: "assistant" },
          parts: [{ id: "release-part", type: "text", text: "Final" }],
        },
      },
    ];
    const adapter = createOpenCodeNativeAdapter({
      process: new FakeProcess(),
      network,
      now: () => 1234,
    });
    const committed: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        emitEntered.resolve();
        await allowEmit.promise;
        committed.push(observation);
      },
    });
    await emitEntered.promise;

    let releaseCompleted = false;
    const release = handle.release("requested").then(() => {
      releaseCompleted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releaseCompleted).toBe(false);

    allowEmit.resolve();
    await release;
    expect(committed.map(({ kind }) => kind)).toEqual(["transcript.message"]);
    await handle.release("requested");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(committed.map(({ kind }) => kind)).toEqual(["transcript.message"]);
  });

  it("keeps malformed catalog responses out while reporting successful safe metadata", async () => {
    const { adapter, network } = composition();
    const originalRequest = network.request.bind(network);
    network.request = async (input) => {
      if (input.path.startsWith("/provider"))
        return { status: 200, body: { all: [{ id: "no-models" }], connected: "no" } };
      if (input.path.startsWith("/agent"))
        return { status: 200, body: { all: [{ name: "agent-only-label", label: "Visible" }, {}] } };
      if (input.path.startsWith("/command")) return { status: 500, body: null };
      if (input.path.startsWith("/mcp"))
        return { status: 200, body: { empty: {}, delayed: { status: "pending" } } };
      if (input.path.startsWith("/skill")) throw new Error("optional endpoint unavailable");
      if (input.path.startsWith("/experimental/tool/ids"))
        return { status: 200, body: { items: ["safe", 7] } };
      return originalRequest(input);
    };
    const result = await adapter.probe(
      { profileId: "native", directory: "/workspace/one" },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status: "available" });
    if (result.status !== "available") throw new Error("expected catalog probe");
    expect(result.capabilities.catalog).toEqual([
      expect.objectContaining({
        kind: "agent",
        id: "agent-only-label",
        label: "agent-only-label",
        detail: null,
      }),
      expect.objectContaining({ kind: "mcp", id: "empty", state: "unknown", detail: {} }),
      expect.objectContaining({
        kind: "mcp",
        id: "delayed",
        state: "unavailable",
        detail: { status: "pending" },
      }),
      expect.objectContaining({ kind: "tool", id: "safe" }),
    ]);
  });

  it("uses defaults without starting a process and treats close as terminal", async () => {
    expect(createOpenCodeNativeAdapter().manifest.id).toBe("opencode");

    const { adapter, process } = composition();
    await adapter.close();
    await expect(adapter.attach(spec(), { emit: async () => undefined })).rejects.toThrow(
      "OpenCode native adapter is closed",
    );
    expect(
      await adapter.probe(
        { profileId: "native", directory: "/workspace/one" },
        new AbortController().signal,
      ),
    ).toMatchObject({ status: "unavailable", reason: "OpenCode native adapter is closed" });
    expect(process.spawns).toHaveLength(0);
  });

  it("forgets an exited shared child before a later attach", async () => {
    const { adapter, process } = composition();
    await adapter.attach(spec(), { emit: async () => undefined });
    process.exited.resolve(0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await adapter.attach(spec(), { emit: async () => undefined });
    expect(process.spawns).toHaveLength(2);
  });

  it("reconciles absent optional endpoints, malformed records, and preserves a supplied cursor", async () => {
    const { adapter, network } = composition();
    const streamEvent = new Deferred<OpenCodeSseEvent>();
    network.subscribe = async () =>
      (async function* () {
        yield await streamEvent.promise;
      })();
    const originalRequest = network.request.bind(network);
    network.request = async (input) => {
      if (input.path.includes("/message"))
        return {
          status: 200,
          body: {
            items: [
              { info: {} },
              { info: { id: "missing-parts", role: "assistant" } },
              {
                info: { id: "malformed-parts", role: "tool" },
                parts: [
                  { type: "text", text: 7 },
                  { type: "reasoning", text: 7 },
                  { type: "future" },
                  { type: "tool" },
                  {
                    type: "tool",
                    tool: "future",
                    callID: "future-call",
                    state: { status: "future" },
                  },
                ],
              },
              { id: "raw-valid", role: "assistant", parts: [] },
              7,
            ],
          },
        };
      if (input.path.startsWith("/session/status"))
        return { status: 200, body: { type: "unknown" } };
      if (input.path.startsWith("/permission") || input.path.startsWith("/question"))
        throw new Error("not supported");
      return originalRequest(input);
    };
    const handle = await adapter.attach(spec(), { emit: async () => undefined });
    expect(await handle.reconcile({ eventId: "passed-cursor" })).toEqual({
      cursor: { eventId: "passed-cursor" },
      observations: [],
      receipts: [],
    });
    expect(await handle.reconcile(null)).toEqual({
      cursor: { eventId: null },
      observations: [],
      receipts: [],
    });
    await handle.release("requested");
    streamEvent.resolve({
      id: "after-release",
      type: "session.idle",
      properties: { sessionID: "native-session-1" },
    });
  });

  it("normalizes malformed messages, question labels, reply fallbacks, and safe catalog detail", async () => {
    const { adapter, network } = composition([
      {
        id: "raw-message",
        type: "message.updated",
        properties: {
          sessionID: "native-session-1",
          id: "raw",
          role: "tool",
          parts: [
            { type: "text", text: "kept" },
            { type: "text", text: 7 },
          ],
        },
      },
      {
        id: "part-id",
        type: "message.part.updated",
        properties: {
          sessionID: "native-session-1",
          messageID: "outer",
          part: { type: "text", text: "nested" },
        },
      },
      {
        id: "question-fallback",
        type: "question.asked",
        properties: {
          sessionID: "native-session-1",
          requestID: "q-fallback",
          questions: [{ options: ["ok", 7] }, { question: "Second", options: "bad" }, "bad"],
        },
      },
      {
        id: "permission-empty",
        type: "permission.replied",
        properties: { sessionID: "native-session-1", requestID: "p" },
      },
      {
        id: "question-reject",
        type: "question.rejected",
        properties: { sessionID: "native-session-1", requestID: "q-fallback" },
      },
      {
        id: "question-no-id",
        type: "question.replied",
        properties: { sessionID: "native-session-1" },
      },
    ]);
    const observations: HarnessObservation[] = [];
    await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "interaction.resolved",
          interactionId: "permission:p",
          resolution: { optionIds: [], response: null },
        }),
        expect.objectContaining({
          kind: "interaction.resolved",
          interactionId: "question:q-fallback",
          resolution: { optionIds: ["reject"], response: null },
        }),
      ]),
    );

    const originalRequest = network.request.bind(network);
    network.request = async (input) => {
      if (input.path.startsWith("/provider"))
        return {
          status: 200,
          body: {
            all: [
              {
                id: "p",
                models: {
                  named: { name: "Named", family: "f", status: "active", variants: { low: {} } },
                  bare: { id: "bare" },
                  "": {},
                },
              },
            ],
            connected: [7],
          },
        };
      if (input.path.startsWith("/agent"))
        return {
          status: 200,
          body: [
            {
              id: "a",
              description: "d",
              mode: "m",
              native: true,
              hidden: false,
              model: { providerID: "p", modelID: "named" },
              variant: "v",
            },
          ],
        };
      if (input.path.startsWith("/command"))
        return {
          status: 200,
          body: [
            {
              id: "c",
              label: "Command",
              description: "d",
              source: "s",
              agent: "a",
              model: "m",
              subtask: false,
              hints: ["h", 7],
            },
          ],
        };
      if (input.path.startsWith("/mcp")) return { status: 200, body: { bare: 7 } };
      if (input.path.startsWith("/skill")) return { status: 200, body: [{ id: "skill" }] };
      if (input.path.startsWith("/experimental/tool/ids")) return { status: 200, body: [] };
      return originalRequest(input);
    };
    const probe = await adapter.probe(
      { profileId: "native", directory: "/workspace/one" },
      new AbortController().signal,
    );
    expect(probe).toMatchObject({ status: "available" });
    if (probe.status !== "available") throw new Error("catalog unavailable");
    expect(probe.capabilities.catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "model",
          id: "p/named",
          state: "unavailable",
          detail: {
            providerId: "p",
            modelId: "named",
            family: "f",
            status: "active",
            variants: ["low"],
          },
        }),
        expect.objectContaining({
          kind: "model",
          id: "p/bare",
          label: "bare",
          detail: { providerId: "p", modelId: "bare", variants: [] },
        }),
        expect.objectContaining({
          kind: "agent",
          id: "a",
          detail: {
            description: "d",
            mode: "m",
            native: true,
            hidden: false,
            model: { providerId: "p", modelId: "named" },
            variant: "v",
          },
        }),
        expect.objectContaining({
          kind: "command",
          id: "c",
          label: "Command",
          detail: {
            description: "d",
            source: "s",
            agent: "a",
            model: "m",
            subtask: false,
            hints: ["h"],
          },
        }),
        expect.objectContaining({ kind: "mcp", id: "bare", detail: {} }),
        expect.objectContaining({ kind: "skill", id: "skill", detail: null }),
      ]),
    );
  });

  it("rejects invalid interaction input and only returns selected documented question values", async () => {
    const { adapter, network } = composition();
    const handle = await adapter.attach(spec(), { emit: async () => undefined });
    const invalidPermission: Extract<HarnessCommand, { kind: "interaction.resolve" }> = {
      kind: "interaction.resolve",
      commandId: "invalid",
      sessionId: "volli-session-1",
      attachmentId: "attachment-1",
      interaction: {
        id: "permission:none",
        attachmentId: "attachment-1",
        kind: "permission",
        title: "x",
        detail: null,
        options: [],
        multiple: false,
        native: { id: null, detail: null },
      },
      resolution: { optionIds: [], response: null },
    };
    expect(await handle.dispatch(invalidPermission)).toMatchObject({
      status: "unknown",
      detail: "OpenCode interaction has no native id",
    });
    const question: Extract<HarnessCommand, { kind: "interaction.resolve" }> = {
      ...invalidPermission,
      commandId: "question-invalid",
      interaction: {
        ...invalidPermission.interaction,
        id: "question:q",
        kind: "question",
        native: { id: "q", detail: { questions: [{ label: "Q", options: ["yes"] }] } },
      },
      resolution: {
        optionIds: ["bad", "question:0:A", "question:8:eWVz", "question:0:bm8", "question:0:eWVz"],
        response: null,
      },
    };
    expect(await handle.dispatch(question)).toMatchObject({ status: "accepted" });
    expect(network.requests.at(-1)?.body).toEqual({ answers: [["yes"]] });
    await handle.dispatch({
      ...question,
      commandId: "reject-question",
      resolution: { optionIds: ["reject"], response: null },
    });
    expect(network.requests.at(-1)?.path).toContain("/question/q/reject?");
    await handle.dispatch({
      ...invalidPermission,
      commandId: "permission-reject",
      interaction: { ...invalidPermission.interaction, native: { id: "p", detail: null } },
    });
    expect(network.requests.at(-1)?.body).toEqual({ reply: "reject" });
  });

  it("shares a pending startup and reaps its only child when close wins", async () => {
    const process = new FakeProcess();
    const spawned = new Deferred<OpenCodeChild>();
    let stops = 0;
    process.spawn = async (input) => {
      process.spawns.push(input);
      return spawned.promise;
    };
    const network = new FakeNetwork();
    const adapter = createOpenCodeNativeAdapter({
      process,
      network,
      sleep: async () => undefined,
    });
    const first = adapter.attach(spec(), { emit: async () => undefined });
    const second = adapter.attach(spec("/workspace/two"), { emit: async () => undefined });
    const closing = adapter.close();
    spawned.resolve({
      exited: process.exited.promise,
      stop: async () => {
        stops += 1;
      },
    });
    await expect(first).rejects.toThrow("OpenCode native adapter is closed");
    await expect(second).rejects.toThrow("OpenCode native adapter is closed");
    await closing;
    expect(process.spawns).toHaveLength(1);
    expect(stops).toBe(1);
  });

  it("reaps a child spawned after close during port allocation", async () => {
    const process = new FakeProcess();
    const resolvedPath = new Deferred<string>();
    const allocatedPort = new Deferred<number>();
    const allocationStarted = new Deferred<void>();
    const exited = new Deferred<number | null>();
    let stops = 0;
    process.resolveBinary = async () => resolvedPath.promise;
    process.allocatePort = async () => {
      allocationStarted.resolve();
      return allocatedPort.promise;
    };
    process.spawn = async (input) => {
      process.spawns.push(input);
      return {
        exited: exited.promise,
        stop: async () => {
          stops += 1;
        },
      };
    };
    const adapter = createOpenCodeNativeAdapter({
      process,
      network: new FakeNetwork(),
      sleep: async () => undefined,
    });

    const attaching = adapter.attach(spec(), { emit: async () => undefined });
    resolvedPath.resolve("/trusted/opencode");
    await allocationStarted.promise;
    const firstClose = adapter.close();
    expect(adapter.close()).toBe(firstClose);
    allocatedPort.resolve(43123);

    await expect(attaching).rejects.toThrow("OpenCode native adapter is closed");
    await firstClose;
    expect(process.spawns).toHaveLength(1);
    expect(stops).toBe(1);
    await expect(adapter.attach(spec(), { emit: async () => undefined })).rejects.toThrow(
      "OpenCode native adapter is closed",
    );
    exited.resolve(0);
  });

  it("reconciles questions and empty cursors, and parses malformed terminal SSE blocks safely", async () => {
    const { adapter, network } = composition();
    const originalRequest = network.request.bind(network);
    network.request = async (input) => {
      if (input.path.includes("/message")) return { status: 200, body: [] };
      if (input.path.startsWith("/session/status"))
        return { status: 200, body: { type: "missing" } };
      if (input.path.startsWith("/permission")) return { status: 200, body: [] };
      if (input.path.startsWith("/question"))
        return {
          status: 200,
          body: {
            items: [
              {
                sessionID: "native-session-1",
                id: "q",
                title: "Question",
                description: "d",
                questions: [{ label: "L", options: ["yes"] }],
              },
              { sessionID: "native-session-1" },
            ],
          },
        };
      return originalRequest(input);
    };
    const handle = await adapter.attach(spec(), { emit: async () => undefined });
    const reconciliation = await handle.reconcile(null);
    expect(reconciliation.cursor).toEqual({
      kind: "volli.opencode.reconciliation.v1",
      token: "reconcile:native-session-1:1",
    });
    expect(reconciliation.observations).toEqual([
      expect.objectContaining({
        kind: "interaction.opened",
        interaction: expect.objectContaining({ id: "question:q", title: "Question", detail: "d" }),
      }),
    ]);
    expect((await handle.reconcile(reconciliation.cursor)).observations).toEqual([]);

    const parsed: OpenCodeSseEvent[] = [];
    for await (const event of parseOpenCodeSse(
      sseBody([
        "event: ignored\n\n",
        "data: not-json\n\n",
        'data: {"id":7,"type":"x"}\n\n',
        'data: {"id":"tail","type":"x","properties":null}',
      ]),
    ))
      parsed.push(event);
    expect(parsed).toEqual([{ id: "tail", type: "x", properties: null }]);
  });

  it("preserves wire fallbacks across message, part, status, and interaction events", async () => {
    const { adapter } = composition([
      {
        id: "message-fallback",
        type: "message.updated",
        properties: { sessionID: "native-session-1", parts: "invalid" },
      },
      {
        id: "part-nested",
        type: "message.part.updated",
        properties: {
          sessionID: "native-session-1",
          part: { type: "text", messageID: "nested" },
          delta: "delta",
        },
      },
      {
        id: "part-fallback",
        type: "message.part.delta",
        properties: { sessionID: "native-session-1", type: "text" },
      },
      {
        id: "error-raw",
        type: "session.error",
        properties: { sessionID: "native-session-1", error: "plain", invalid: [() => undefined] },
      },
      {
        id: "retry-raw",
        type: "session.status",
        properties: { sessionID: "native-session-1", type: "retry" },
      },
      {
        id: "permission-default",
        type: "permission.asked",
        properties: { sessionID: "native-session-1", id: "p", pattern: "*.ts" },
      },
      {
        id: "question-answer-fallback",
        type: "question.replied",
        properties: {
          sessionID: "native-session-1",
          requestID: "uncached",
          questions: [{ label: "Q", options: ["yes"] }],
          answers: [["yes", 7], "bad"],
        },
      },
      {
        id: "question-answer-malformed",
        type: "question.replied",
        properties: { sessionID: "native-session-1", requestID: "malformed", answers: "bad" },
      },
    ]);
    const observations: HarnessObservation[] = [];
    await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "error-raw",
          attention: expect.objectContaining({ detail: null, diagnostic: null }),
        }),
        expect.objectContaining({
          id: "retry-raw",
          attention: expect.objectContaining({ detail: null }),
        }),
        expect.objectContaining({
          id: "permission-default",
          kind: "interaction.opened",
          interaction: expect.objectContaining({ title: "Permission required", detail: "*.ts" }),
        }),
        expect.objectContaining({
          id: "question-answer-fallback",
          kind: "interaction.resolved",
          resolution: { optionIds: ["question:0:eWVz"], response: null },
        }),
      ]),
    );
  });

  it("projects todo.updated into a synthetic todowrite transcript message", async () => {
    const { adapter } = composition([
      {
        id: "todos-1",
        type: "todo.updated",
        properties: {
          sessionID: "native-session-1",
          todos: [
            { content: "Inspect wiring", status: "in_progress", priority: "high" },
            { content: "Ship fix", status: "pending", priority: "medium" },
          ],
        },
      },
    ]);
    const observations: HarnessObservation[] = [];
    await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observations).toContainEqual(
      expect.objectContaining({
        kind: "transcript.message",
        message: expect.objectContaining({
          id: "opencode:todos:native-session-1",
          parts: [
            expect.objectContaining({
              type: "dynamic-tool",
              toolName: "todowrite",
              state: "output-available",
              input: {
                todos: [
                  { content: "Inspect wiring", status: "in_progress", priority: "high" },
                  { content: "Ship fix", status: "pending", priority: "medium" },
                ],
              },
            }),
          ],
        }),
      }),
    );
  });

  it("deduplicates reconciled interaction identities, normalizes primitive catalogs, and accepts unframed SSE input", async () => {
    const { adapter, network } = composition([
      { id: "question:q", type: "session.idle", properties: { sessionID: "native-session-1" } },
    ]);
    const originalRequest = network.request.bind(network);
    network.request = async (input) => {
      if (input.path.includes("/message")) return { status: 200, body: [] };
      if (input.path.startsWith("/session/status")) return { status: 200, body: {} };
      if (input.path.startsWith("/permission")) return { status: 200, body: [] };
      if (input.path.startsWith("/question"))
        return { status: 200, body: [{ sessionID: "native-session-1", id: "q" }] };
      return originalRequest(input);
    };
    const handle = await adapter.attach(spec(), { emit: async () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await handle.reconcile(null)).observations).toEqual([]);

    network.request = async (input) => {
      if (input.path.startsWith("/provider")) return { status: 200, body: {} };
      if (input.path.startsWith("/agent")) return { status: 200, body: [7] };
      if (input.path.startsWith("/command")) return { status: 200, body: [] };
      if (input.path.startsWith("/mcp")) return { status: 200, body: null };
      if (input.path.startsWith("/skill")) return { status: 200, body: [] };
      if (input.path.startsWith("/experimental/tool/ids")) return { status: 200, body: 7 };
      return originalRequest(input);
    };
    const probe = await adapter.probe(
      { profileId: "native", directory: "/workspace/one" },
      new AbortController().signal,
    );
    expect(probe).toMatchObject({ status: "available" });
    if (probe.status !== "available") throw new Error("probe failed");
    expect(probe.capabilities.catalog).toEqual([]);

    const empty: OpenCodeSseEvent[] = [];
    for await (const event of parseOpenCodeSse(sseBody(["comment only\n\n", ""])))
      empty.push(event);
    expect(empty).toEqual([]);
  });

  it.each(Object.entries(OPENCODE_ACTIVITY))("classifies the %s tool as %s", (tool, kind) => {
    expect(openCodeActivityKind(tool)).toBe(kind);
  });

  it("classifies unmapped and MCP tool names as the first-class other kind", () => {
    // MCP tools are named <server>_<tool>; no prefix rule can anticipate them.
    expect(openCodeActivityKind("linear_create_issue")).toBe("other");
    expect(openCodeActivityKind("")).toBe("other");
    expect(openCodeActivityKind("BASH")).toBe("run-command");
  });

  it("stamps a subject, a file path and measured outcomes on every tool part", async () => {
    const { adapter } = composition([
      {
        id: "assistant-activity",
        type: "message.updated",
        properties: {
          sessionID: "native-session-1",
          info: {
            id: "assistant-activity",
            role: "assistant",
            modelID: "gpt-5",
            tokens: { input: 12, output: 4 },
          },
          parts: [
            toolPart("bash", "c-bash-running", { status: "running" }),
            toolPart("bash", "c-bash", {
              status: "completed",
              input: { command: "pnpm test" },
              metadata: { exit: 1, truncated: false },
              time: { start: 10, end: 42 },
            }),
            toolPart("read", "c-read-partial", {
              status: "completed",
              input: { path: "src/index.ts", offset: 10 },
              metadata: {
                display: {
                  type: "file",
                  path: "/workspace/one/src/index.ts",
                  lineStart: 10,
                  lineEnd: 48,
                  totalLines: 210,
                  truncated: true,
                },
              },
            }),
            toolPart("read", "c-read-whole", {
              status: "completed",
              input: { path: "src/whole.ts" },
              metadata: {
                display: {
                  type: "file",
                  path: "/w/whole.ts",
                  lineStart: 1,
                  lineEnd: 12,
                  totalLines: 12,
                  truncated: false,
                },
              },
            }),
            toolPart("read", "c-read-no-start", {
              status: "completed",
              input: { file_path: "src/a.ts" },
              metadata: { display: { type: "file", lineEnd: 48, truncated: true } },
            }),
            toolPart("read", "c-read-no-end", {
              status: "completed",
              input: { file_path: "src/b.ts" },
              metadata: { display: { type: "file", lineStart: 10, truncated: true } },
            }),
            toolPart("read", "c-read-directory", {
              status: "completed",
              input: { path: "src" },
              metadata: { display: { type: "directory", path: "src", totalEntries: 12 } },
            }),
            toolPart("read", "c-read-bare", { status: "pending" }),
            toolPart("edit", "c-edit", {
              status: "completed",
              input: { filePath: "src/a.ts" },
              metadata: {
                diff: "--- a\n+++ b",
                filediff: { file: "/w/src/a.ts", additions: 49, deletions: 12 },
              },
            }),
            toolPart("write", "c-write-new", {
              status: "completed",
              input: { filePath: "src/new.ts", content: "one\ntwo\nthree" },
              metadata: { filepath: "/w/src/new.ts", exists: false },
            }),
            toolPart("write", "c-write-over", {
              status: "completed",
              input: { filePath: "src/old.ts", content: "one" },
              metadata: { exists: true },
            }),
            toolPart("write", "c-write-binary", {
              status: "completed",
              input: { filePath: "src/blob.bin", content: 7 },
              metadata: { exists: false },
            }),
            toolPart("grep", "c-grep", {
              status: "completed",
              input: { pattern: "useSession" },
              metadata: { matches: 14, truncated: false },
            }),
            toolPart("glob", "c-glob", {
              status: "completed",
              input: { glob: "**/*.ts" },
              metadata: { count: 6 },
            }),
            toolPart("webfetch", "c-fetch", {
              status: "completed",
              input: { url: "https://example.com" },
              metadata: {},
            }),
            toolPart("websearch", "c-search", {
              status: "completed",
              input: { query: "streaming seam" },
              metadata: { provider: "exa" },
            }),
            toolPart("task", "c-task", {
              status: "completed",
              input: { description: "Find the streaming seam", subagent_type: "explore" },
              metadata: { sessionId: "sub-1" },
            }),
            toolPart("linear_create_issue", "c-mcp", {
              status: "completed",
              input: { title: "VC-12 chat seam" },
            }),
            toolPart("linear_comment", "c-mcp-multiline", {
              status: "completed",
              input: { body: "line one\nline two" },
            }),
            toolPart("linear_upload", "c-mcp-long", {
              status: "completed",
              input: { blob: "x".repeat(MAX_LABEL + 1) },
            }),
            toolPart("linear_ping", "c-mcp-blank", { status: "completed", input: { note: "   " } }),
          ],
        },
      },
      { id: "idle", type: "session.idle", properties: { sessionID: "native-session-1" } },
    ]);
    const observations: HarnessObservation[] = [];
    await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observations.find(({ kind }) => kind === "transcript.message")).toMatchObject({
      message: {
        metadata: {
          providerId: null,
          modelId: "gpt-5",
          cost: null,
          tokens: { input: 12, output: 4, reasoning: null, cacheRead: null, cacheWrite: null },
        },
      },
    });
    expect(descriptors(observations)).toEqual([
      {
        call: "c-bash-running",
        kind: "run-command",
        label: null,
        path: null,
        lineRange: null,
        outcome: null,
        startedAt: null,
        endedAt: null,
      },
      {
        call: "c-bash",
        kind: "run-command",
        label: "pnpm test",
        path: null,
        lineRange: null,
        outcome: { exitCode: 1 },
        startedAt: 10,
        endedAt: 42,
      },
      {
        call: "c-read-partial",
        kind: "read-file",
        label: "src/index.ts",
        path: "/workspace/one/src/index.ts",
        lineRange: { start: 10, end: 48 },
        outcome: { lineCount: 210 },
        startedAt: null,
        endedAt: null,
      },
      {
        call: "c-read-whole",
        kind: "read-file",
        label: "src/whole.ts",
        path: "/w/whole.ts",
        lineRange: null,
        outcome: { lineCount: 12 },
        startedAt: null,
        endedAt: null,
      },
      {
        call: "c-read-no-start",
        kind: "read-file",
        label: "src/a.ts",
        path: null,
        lineRange: null,
        outcome: {},
        startedAt: null,
        endedAt: null,
      },
      {
        call: "c-read-no-end",
        kind: "read-file",
        label: "src/b.ts",
        path: null,
        lineRange: null,
        outcome: {},
        startedAt: null,
        endedAt: null,
      },
      {
        call: "c-read-directory",
        kind: "read-file",
        label: "src",
        path: "src",
        lineRange: null,
        outcome: { fileCount: 12 },
        startedAt: null,
        endedAt: null,
      },
      {
        call: "c-read-bare",
        kind: "read-file",
        label: null,
        path: null,
        lineRange: null,
        outcome: null,
        startedAt: null,
        endedAt: null,
      },
      {
        call: "c-edit",
        kind: "edit-file",
        label: "src/a.ts",
        path: "/w/src/a.ts",
        lineRange: null,
        outcome: { addedLines: 49, removedLines: 12, diff: "--- a\n+++ b" },
        startedAt: null,
        endedAt: null,
      },
      {
        call: "c-write-new",
        kind: "write-file",
        label: "src/new.ts",
        path: "/w/src/new.ts",
        lineRange: null,
        outcome: { addedLines: 3 },
        startedAt: null,
        endedAt: null,
      },
      {
        call: "c-write-over",
        kind: "write-file",
        label: "src/old.ts",
        path: "src/old.ts",
        lineRange: null,
        outcome: {},
        startedAt: null,
        endedAt: null,
      },
      {
        call: "c-write-binary",
        kind: "write-file",
        label: "src/blob.bin",
        path: "src/blob.bin",
        lineRange: null,
        outcome: {},
        startedAt: null,
        endedAt: null,
      },
      {
        call: "c-grep",
        kind: "search",
        label: "useSession",
        path: null,
        lineRange: null,
        outcome: { matchCount: 14 },
        startedAt: null,
        endedAt: null,
      },
      {
        call: "c-glob",
        kind: "search",
        label: "**/*.ts",
        path: null,
        lineRange: null,
        outcome: { fileCount: 6 },
        startedAt: null,
        endedAt: null,
      },
      {
        call: "c-fetch",
        kind: "fetch-url",
        label: "https://example.com",
        path: null,
        lineRange: null,
        outcome: {},
        startedAt: null,
        endedAt: null,
      },
      {
        call: "c-search",
        kind: "search",
        label: "streaming seam",
        path: null,
        lineRange: null,
        outcome: {},
        startedAt: null,
        endedAt: null,
      },
      // No named key matches, so the first phrase-shaped scalar names the call.
      {
        call: "c-task",
        kind: "delegate",
        label: "Find the streaming seam",
        path: null,
        lineRange: null,
        outcome: {},
        startedAt: null,
        endedAt: null,
      },
      {
        call: "c-mcp",
        kind: "other",
        label: "VC-12 chat seam",
        path: null,
        lineRange: null,
        outcome: {},
        startedAt: null,
        endedAt: null,
      },
      // A body, a blob and blank whitespace are not names. Better no label than a blob.
      {
        call: "c-mcp-multiline",
        kind: "other",
        label: null,
        path: null,
        lineRange: null,
        outcome: {},
        startedAt: null,
        endedAt: null,
      },
      {
        call: "c-mcp-long",
        kind: "other",
        label: null,
        path: null,
        lineRange: null,
        outcome: {},
        startedAt: null,
        endedAt: null,
      },
      {
        call: "c-mcp-blank",
        kind: "other",
        label: null,
        path: null,
        lineRange: null,
        outcome: {},
        startedAt: null,
        endedAt: null,
      },
    ]);
  });

  it("keeps assistant usage across snapshots and collapses all but the live thought", async () => {
    const network = new FakeNetwork();
    const hold = new Deferred<void>();
    network.subscribe = async (input) => {
      network.subscriptions.push(input);
      return (async function* () {
        yield {
          id: "assistant",
          type: "message.updated",
          properties: {
            info: {
              id: "provider-assistant",
              sessionID: "native-session-1",
              role: "assistant",
              providerID: "anthropic",
              modelID: "claude-sonnet-4-5",
              cost: 0.0123,
              tokens: {
                input: 1200,
                output: 340,
                reasoning: 96,
                cache: { read: 8000, write: 512 },
              },
            },
          },
        };
        yield {
          id: "think-1",
          type: "message.part.updated",
          properties: {
            sessionID: "native-session-1",
            part: { id: "r1", messageID: "provider-assistant", type: "reasoning", text: "First" },
          },
        };
        yield {
          id: "think-2",
          type: "message.part.updated",
          properties: {
            sessionID: "native-session-1",
            part: { id: "r2", messageID: "provider-assistant", type: "reasoning", text: "Second" },
          },
        };
        // A repeat snapshot that carries its own text simply replaces it.
        yield {
          id: "think-1-again",
          type: "message.part.updated",
          properties: {
            sessionID: "native-session-1",
            part: {
              id: "r1",
              messageID: "provider-assistant",
              type: "reasoning",
              text: "First, restated",
            },
          },
        };
        // A repeat snapshot that omits the accumulated text must not erase it.
        yield {
          id: "think-2-retype",
          type: "message.part.updated",
          properties: {
            sessionID: "native-session-1",
            part: { id: "r2", messageID: "provider-assistant", type: "reasoning" },
          },
        };
        // A later snapshot without usage must not erase what the first reported.
        yield {
          id: "assistant-partial",
          type: "message.updated",
          properties: {
            info: { id: "provider-assistant", sessionID: "native-session-1", role: "assistant" },
          },
        };
        // Neither of these earns a snapshot: one is the user's own turn, the
        // other projects to no durable part at all.
        yield {
          id: "user-turn",
          type: "message.updated",
          properties: {
            info: { id: "provider-user", sessionID: "native-session-1", role: "user" },
            parts: [{ id: "u1", type: "text", text: "Ask something" }],
          },
        };
        yield {
          id: "unprojectable",
          type: "message.updated",
          properties: {
            info: { id: "provider-empty", sessionID: "native-session-1", role: "assistant" },
            parts: [{ id: "f1", type: "file", url: "data:text/plain;base64,AA==" }],
          },
        };
        await hold.promise;
      })();
    };
    const adapter = createOpenCodeNativeAdapter({ process: new FakeProcess(), network });
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(observations).toContainEqual(
      expect.objectContaining({
        kind: "transcript.message",
        message: {
          id: "provider-assistant",
          role: "assistant",
          metadata: {
            providerId: "anthropic",
            modelId: "claude-sonnet-4-5",
            cost: 0.0123,
            tokens: { input: 1200, output: 340, reasoning: 96, cacheRead: 8000, cacheWrite: 512 },
          },
          parts: [
            { type: "reasoning", text: "First, restated", state: "done" },
            { type: "reasoning", text: "Second", state: "streaming" },
          ],
        },
      }),
    );
    expect(
      observations.flatMap((observation) =>
        observation.kind === "transcript.message" ? [observation.message.id] : [],
      ),
    ).toEqual(["provider-assistant"]);
    hold.resolve(undefined);
    await handle.release("requested");
  });

  it("carries model identity through native history reconcile even without usage", async () => {
    const { adapter, network } = composition();
    network.messageResponse = [
      {
        info: { id: "history-usage", role: "assistant", providerID: "openai", modelID: "gpt-5" },
        parts: [{ type: "text", text: "Reconciled" }],
      },
    ];
    const handle = await adapter.attach(spec(), { emit: async () => undefined });
    const { observations } = await handle.reconcile(null);

    expect(observations.find(({ kind }) => kind === "transcript.message")).toMatchObject({
      message: {
        metadata: { providerId: "openai", modelId: "gpt-5", cost: null, tokens: null },
      },
    });
  });

  it("keeps todo projection scoped to this session and survives a failed todo read", async () => {
    const { adapter, network } = composition([
      {
        id: "todo-foreign",
        type: "todo.updated",
        properties: { sessionID: "another-session", todos: [{ content: "Not ours" }] },
      },
      { id: "todo-primitive", type: "todo.updated", properties: 7 },
      {
        // Session ownership established by `info`, so the lowercase `sessionId`
        // spelling is the only scope OpenCode reported for the list itself.
        id: "todo-lowercase-foreign",
        type: "todo.updated",
        properties: {
          info: { sessionID: "native-session-1" },
          sessionId: "another-session",
          todos: [{ content: "Not ours" }],
        },
      },
      {
        id: "todo-wrapped",
        type: "todo.updated",
        properties: {
          sessionID: "native-session-1",
          todos: { items: [{ id: "t-9", content: "Wrapped", status: "pending", priority: "low" }] },
        },
      },
    ]);
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observations.filter(({ kind }) => kind === "transcript.message")).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          parts: [
            expect.objectContaining({
              input: {
                todos: [{ id: "t-9", content: "Wrapped", status: "pending", priority: "low" }],
              },
            }),
          ],
        }),
      }),
    ]);

    const originalRequest = network.request.bind(network);
    network.request = async (input) => {
      if (input.path.includes("/todo"))
        return { status: 200, body: { items: [{ id: "t-1", content: "Ship it" }, 7] } };
      return originalRequest(input);
    };
    const reconciled = await handle.reconcile(null);
    expect(reconciled.observations.find(({ kind }) => kind === "transcript.message")).toMatchObject(
      {
        message: {
          parts: [
            expect.objectContaining({
              input: { todos: [{ id: "t-1", content: "Ship it" }] },
              toolMetadata: expect.objectContaining({
                [ACTIVITY_METADATA_KEY]: expect.objectContaining({
                  kind: "plan",
                  nativeToolName: "todowrite",
                }),
              }),
            }),
          ],
        },
      },
    );

    network.request = async (input) => {
      if (input.path.includes("/todo")) throw new Error("todo unavailable");
      if (input.path.startsWith("/session/status")) return { status: 500, body: {} };
      return originalRequest(input);
    };
    // Acknowledge the pending reconciliation, or the next call replays it.
    const failed = await handle.reconcile(reconciled.cursor);
    expect(failed.observations.some(({ kind }) => kind === "transcript.message")).toBe(false);
  });

  it("ignores stream events that never established session ownership", async () => {
    const { adapter } = composition([
      { id: "untagged-snapshot", type: "message.updated", properties: { info: { id: "x" } } },
    ]);
    const observations: HarnessObservation[] = [];
    await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observations.some(({ kind }) => kind === "transcript.message")).toBe(false);
  });

  it("keeps a failing sink from escaping the coalesced snapshot timer", async () => {
    const network = new FakeNetwork();
    const hold = new Deferred<void>();
    network.subscribe = async (input) => {
      network.subscriptions.push(input);
      return (async function* () {
        yield {
          id: "assistant",
          type: "message.updated",
          properties: {
            info: { id: "provider-assistant", sessionID: "native-session-1", role: "assistant" },
            parts: [{ id: "t1", type: "text", text: "Painting" }],
          },
        };
        await hold.promise;
      })();
    };
    const adapter = createOpenCodeNativeAdapter({ process: new FakeProcess(), network });
    const handle = await adapter.attach(spec(), {
      emit: async () => {
        throw new Error("sink unavailable");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    hold.resolve(undefined);
    await expect(handle.release("requested")).resolves.toBeUndefined();
  });

  it("snapshots a settled turn and tolerates removing a message with no pending snapshot", async () => {
    const network = new FakeNetwork();
    const hold = new Deferred<void>();
    network.subscribe = async (input) => {
      network.subscriptions.push(input);
      return (async function* () {
        yield {
          id: "idle-first",
          type: "session.idle",
          properties: { sessionID: "native-session-1" },
        };
        yield {
          id: "late-assistant",
          type: "message.updated",
          properties: {
            info: { id: "late", sessionID: "native-session-1", role: "assistant" },
            parts: [{ id: "r1", type: "reasoning", text: "Late thought" }],
          },
        };
        yield {
          id: "ghost-removed",
          type: "message.removed",
          properties: { sessionID: "native-session-1", messageID: "ghost" },
        };
        await hold.promise;
      })();
    };
    const adapter = createOpenCodeNativeAdapter({ process: new FakeProcess(), network });
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The turn already settled, so nothing in the snapshot is still thinking.
    expect(observations).toContainEqual(
      expect.objectContaining({
        kind: "transcript.message",
        message: {
          id: "late",
          role: "assistant",
          parts: [{ type: "reasoning", text: "Late thought", state: "done" }],
        },
      }),
    );
    hold.resolve(undefined);
    await handle.release("requested");
  });

  it("raises an open permission on the tool row it gates, mid-turn", async () => {
    const hold = new Deferred<void>();
    const network = gatedTurn([askedFor("call-write")], hold);
    const adapter = createOpenCodeNativeAdapter({ process: new FakeProcess(), network });
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The prompt lands on the call it is about, while that call is still live.
    expect(toolRows(observations).at(-1)).toMatchObject({
      toolCallId: "call-write",
      state: "approval-requested",
      input: { path: "src/index.ts" },
      approval: { id: "per_1" },
    });
    // Additive: the parallel interaction channel the ledger reads is untouched.
    expect(observations).toContainEqual(
      expect.objectContaining({
        kind: "interaction.opened",
        interaction: expect.objectContaining({ id: "permission:per_1", kind: "permission" }),
      }),
    );
    hold.resolve(undefined);
    await handle.release("requested");
  });

  it("raises a subagent's permission on the task row that is waiting for it", async () => {
    const hold = new Deferred<void>();
    const network = delegatedTurn([subagentAskedFor("child-session-1")], hold);
    const adapter = createOpenCodeNativeAdapter({ process: new FakeProcess(), network });
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The prompt names a call in the child's transcript, which this Session does
    // not hold — so it is raised on the `task` row that is blocked on it.
    expect(toolRows(observations).at(-1)).toMatchObject({
      toolCallId: "call-task",
      state: "approval-requested",
      approval: { id: "per_1" },
    });
    expect(observations).toContainEqual(
      expect.objectContaining({
        kind: "interaction.opened",
        interaction: expect.objectContaining({ id: "permission:per_1", kind: "permission" }),
      }),
    );
    hold.resolve(undefined);
    await handle.release("requested");
  });

  it("keeps a subagent's transcript out of the Session that delegated to it", async () => {
    const hold = new Deferred<void>();
    const network = delegatedTurn(
      [
        {
          id: "child-says",
          type: "message.updated",
          properties: {
            info: { id: "child-message-1", sessionID: "child-session-1", role: "assistant" },
            parts: [{ id: "c1", type: "text", text: "I am the subagent." }],
          },
        },
      ],
      hold,
    );
    const adapter = createOpenCodeNativeAdapter({ process: new FakeProcess(), network });
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The `task` row is how a subagent appears here. Merging its prose would
    // interleave a second agent's voice into this one's transcript.
    expect(
      observations.flatMap((observation) =>
        observation.kind === "transcript.message" ? [observation.message.id] : [],
      ),
    ).not.toContain("child-message-1");
    hold.resolve(undefined);
    await handle.release("requested");
  });

  it("ignores a permission raised by a Session it never delegated to", async () => {
    const hold = new Deferred<void>();
    const network = delegatedTurn([subagentAskedFor("someone-elses-session")], hold);
    const adapter = createOpenCodeNativeAdapter({ process: new FakeProcess(), network });
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(observations.filter(({ kind }) => kind === "interaction.opened")).toEqual([]);
    expect(toolRows(observations).at(-1)).not.toHaveProperty("approval");
    hold.resolve(undefined);
    await handle.release("requested");
  });

  it("recovers a subagent's open permission when it reconciles", async () => {
    const network = new FakeNetwork();
    network.holdEventStream = true;
    network.messageResponse = [
      {
        info: { id: "provider-assistant", sessionID: "native-session-1", role: "assistant" },
        parts: [
          {
            // A task OpenCode has accepted but not yet given a Session to. It
            // names no subagent, and must not be mistaken for one.
            id: "p0",
            messageID: "provider-assistant",
            ...toolPart("task", "call-task-pending", {
              status: "pending",
              input: { description: "Not started" },
            }),
          },
          {
            id: "p1",
            messageID: "provider-assistant",
            ...toolPart("task", "call-task", {
              status: "running",
              input: { description: "Review lab task" },
              metadata: { parentSessionId: "native-session-1", sessionId: "child-session-1" },
            }),
          },
        ],
      },
    ];
    const base = network.request.bind(network);
    network.request = async (input) => {
      const response = await base(input);
      return input.path.startsWith("/permission")
        ? {
            status: 200,
            body: [
              // Belongs to no Session this one can name, so it is not this
              // Session's to answer.
              { id: "per_orphan", tool: { messageID: "m", callID: "c" } },
              {
                id: "per_1",
                sessionID: "child-session-1",
                tool: { messageID: "child-message-1", callID: "child-call-1" },
              },
            ],
          }
        : response;
    };
    const adapter = createOpenCodeNativeAdapter({ process: new FakeProcess(), network });
    const handle = await adapter.attach(spec(), { emit: async () => undefined });

    // Reconciling is the one action that looks like it should free a Session
    // stuck behind a subagent, so it has to know the same Sessions the stream
    // does — and it learns them from the `task` parts in its own history.
    const reconciliation = await handle.reconcile(null);
    expect(reconciliation.observations).toContainEqual(
      expect.objectContaining({
        kind: "interaction.opened",
        interaction: expect.objectContaining({ id: "permission:per_1", kind: "permission" }),
      }),
    );
    expect(toolRows(reconciliation.observations).at(-1)).toMatchObject({
      toolCallId: "call-task",
      state: "approval-requested",
      approval: { id: "per_1" },
    });
    expect(
      reconciliation.observations.flatMap((observation) =>
        observation.kind === "interaction.opened" ? [observation.interaction.id] : [],
      ),
    ).toEqual(["permission:per_1"]);
    await handle.release("requested");
  });

  it("gates a call whose input OpenCode has not reported", async () => {
    const hold = new Deferred<void>();
    const network = gatedTurn([askedFor("call-write")], hold, { status: "running" });
    const adapter = createOpenCodeNativeAdapter({ process: new FakeProcess(), network });
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Absent arguments are null, not a missing key: the row a human is asked to
    // approve still has to be a complete part.
    expect(toolRows(observations).at(-1)).toMatchObject({
      toolCallId: "call-write",
      state: "approval-requested",
      input: null,
      approval: { id: "per_1" },
    });
    hold.resolve(undefined);
    await handle.release("requested");
  });

  it("returns a gated row to its running state once the permission is allowed", async () => {
    const hold = new Deferred<void>();
    const network = gatedTurn(
      [
        askedFor("call-write"),
        {
          id: "allowed",
          type: "permission.replied",
          properties: { sessionID: "native-session-1", requestID: "per_1", reply: "once" },
        },
      ],
      hold,
    );
    const adapter = createOpenCodeNativeAdapter({ process: new FakeProcess(), network });
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The answer lifts the gate on its own: nothing about the call itself
    // changed, so a row still reading approval-requested here would be stuck.
    const rows = toolRows(observations);
    expect(rows.at(-1)).toMatchObject({ toolCallId: "call-write", state: "input-available" });
    expect(rows.at(-1)).not.toHaveProperty("approval");
    hold.resolve(undefined);
    await handle.release("requested");
  });

  it("lets a rejected permission settle into the failure OpenCode reports", async () => {
    const hold = new Deferred<void>();
    const network = gatedTurn(
      [
        askedFor("call-write"),
        {
          id: "rejected",
          type: "permission.replied",
          properties: { sessionID: "native-session-1", requestID: "per_1", reply: "reject" },
        },
        // OpenCode fails the call itself on a rejection, so the row settles on
        // its verdict rather than one the adapter invented.
        {
          id: "failed",
          type: "message.part.updated",
          properties: {
            sessionID: "native-session-1",
            part: {
              id: "p1",
              messageID: "provider-assistant",
              ...toolPart("write", "call-write", {
                status: "error",
                input: { path: "src/index.ts" },
                error: "The user rejected this request",
              }),
            },
          },
        },
      ],
      hold,
    );
    const adapter = createOpenCodeNativeAdapter({ process: new FakeProcess(), network });
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(toolRows(observations).at(-1)).toMatchObject({
      toolCallId: "call-write",
      state: "output-error",
      errorText: "The user rejected this request",
    });
    hold.resolve(undefined);
    await handle.release("requested");
  });

  it("keeps a settled call on OpenCode's verdict when a permission outlives it", async () => {
    const hold = new Deferred<void>();
    const network = gatedTurn(
      [
        {
          id: "done",
          type: "message.part.updated",
          properties: {
            sessionID: "native-session-1",
            part: {
              id: "p1",
              messageID: "provider-assistant",
              ...toolPart("write", "call-write", {
                status: "completed",
                input: { path: "src/index.ts" },
                output: "written",
              }),
            },
          },
        },
        askedFor("call-write"),
      ],
      hold,
    );
    const adapter = createOpenCodeNativeAdapter({ process: new FakeProcess(), network });
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A reply this binding never saw must not strand the row on a stale prompt.
    expect(toolRows(observations).every(({ state }) => state !== "approval-requested")).toBe(true);
    expect(toolRows(observations).at(-1)).toMatchObject({
      toolCallId: "call-write",
      state: "output-available",
      output: "written",
    });
    hold.resolve(undefined);
    await handle.release("requested");
  });

  it("hydrates a gated tool row for a permission opened before this binding attached", async () => {
    const { adapter, network } = composition();
    network.messageResponse = {
      info: { id: "history-1", role: "assistant" },
      parts: [toolPart("write", "call-write", { status: "running", input: { path: "src/a.ts" } })],
    };
    const originalRequest = network.request.bind(network);
    network.request = async (input) =>
      input.path.startsWith("/permission")
        ? {
            status: 200,
            body: [
              {
                sessionID: "native-session-1",
                id: "per_1",
                title: "Allow write",
                tool: { messageID: "history-1", callID: "call-write" },
              },
            ],
          }
        : originalRequest(input);
    const handle = await adapter.attach(spec(), { emit: async () => undefined });
    const { observations } = await handle.reconcile(null);

    // A permission blocks on a human, so it routinely outlives the connection
    // that first reported it. Resuming has to redraw the gate, not lose it.
    expect(toolRows(observations).at(-1)).toMatchObject({
      toolCallId: "call-write",
      state: "approval-requested",
      approval: { id: "per_1" },
    });
    // Messages still precede interactions in the resumed batch.
    expect(observations.findIndex(({ kind }) => kind === "transcript.message")).toBeLessThan(
      observations.findIndex(({ kind }) => kind === "interaction.opened"),
    );
  });

  it("gates only the call a permission names, not every call in flight", async () => {
    const hold = new Deferred<void>();
    const network = gatedTurn(
      [
        // A permission opened against a different message must not leak onto
        // this one's identically named call.
        askedFor("call-write", "other-assistant"),
        {
          id: "anonymous-reply",
          type: "permission.replied",
          properties: { sessionID: "native-session-1", reply: "once" },
        },
        {
          id: "more",
          type: "message.part.updated",
          properties: {
            sessionID: "native-session-1",
            part: {
              id: "t1",
              messageID: "provider-assistant",
              type: "text",
              text: "Still working",
            },
          },
        },
      ],
      hold,
    );
    const adapter = createOpenCodeNativeAdapter({ process: new FakeProcess(), network });
    const observations: HarnessObservation[] = [];
    const handle = await adapter.attach(spec(), {
      emit: async (observation) => {
        observations.push(observation);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(toolRows(observations).every(({ state }) => state !== "approval-requested")).toBe(true);
    expect(toolRows(observations).at(-1)).toMatchObject({
      toolCallId: "call-write",
      state: "input-available",
    });
    hold.resolve(undefined);
    await handle.release("requested");
  });
});
