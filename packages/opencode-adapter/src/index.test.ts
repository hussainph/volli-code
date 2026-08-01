import { describe, expect, it } from "vite-plus/test";
import type { HarnessCommand, HarnessObservation, ObservationSink } from "@volli/session-engine";
import {
  createOpenCodeNativeAdapter,
  parseOpenCodeSse,
  type OpenCodeChild,
  type OpenCodeNetworkPort,
  type OpenCodeProcessPort,
  type OpenCodeSseEvent,
} from "./index";

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

class FakeProcess implements OpenCodeProcessPort {
  spawns: Array<{
    path: string;
    args: readonly string[];
    env: Readonly<Record<string, string | undefined>>;
  }> = [];
  readonly exited = new Deferred<number | null>();
  spawnFailure: Error | null = null;
  async resolveBinary(path: string): Promise<string> {
    return path === "opencode" ? "/trusted/opencode" : path;
  }
  async version(): Promise<string> {
    return "1.17.18";
  }
  async sha256(): Promise<string> {
    return "sha256:trusted";
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
    return { status: 200, body: [{ id: "reported", name: "Reported" }] };
  }
  async subscribe(
    input: Parameters<OpenCodeNetworkPort["subscribe"]>[0],
  ): Promise<AsyncIterable<OpenCodeSseEvent>> {
    this.subscriptions.push(input);
    const values = this.events;
    return (async function* () {
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
  const adapter = createOpenCodeNativeAdapter({ process, network, now: () => 1234 });
  return { adapter, process, network };
}

describe("OpenCodeNativeAdapter", () => {
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
      env: { OPENCODE_SERVER_PASSWORD: "never-persist-this" },
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
          part: { type: "text", messageID: "native-message-1", text: "hello" },
        },
      },
      {
        id: "e-busy",
        type: "session.status",
        properties: { sessionID: "native-session-1", status: { type: "busy" } },
      },
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
        id: "e-message",
        kind: "transcript.message",
        message: { id: "native-message-1", role: "assistant", parts: [] },
      }),
      expect.objectContaining({
        id: "e-part",
        kind: "transcript.message",
        message: {
          id: "native-message-1",
          role: "assistant",
          parts: [{ type: "text", text: "hello" }],
        },
      }),
      expect.objectContaining({ id: "e-busy", kind: "turn.started" }),
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
      expect.objectContaining({
        id: "opencode:sse-binding-failed:native-session-1",
        kind: "attachment.failed",
        detail: "OpenCode event stream ended",
      }),
    ]);
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
            linear: { status: "failed", error: "authentication required" },
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

  it("maps OpenCode 1.17 Part text, reasoning, and tool lifecycle without leaking tool payloads", async () => {
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
              state: { status: "running", input: { token: "must-not-leak" }, title: "Run checks" },
            },
            {
              type: "tool",
              tool: "search",
              callID: "call-pending",
              state: { status: "pending", input: {}, raw: "must-not-leak" },
            },
            {
              type: "tool",
              tool: "read",
              callID: "call-complete",
              state: {
                status: "completed",
                input: { path: "/private/must-not-leak" },
                output: "must-not-leak",
                title: "Read file",
                metadata: {},
                time: { start: 1, end: 2 },
              },
            },
            {
              type: "tool",
              tool: "write",
              callID: "call-error",
              state: {
                status: "error",
                input: {},
                error: "must-not-leak",
                time: { start: 1, end: 2 },
              },
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
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "parts",
          message: expect.objectContaining({
            parts: [
              { type: "text", text: "Visible answer" },
              { type: "reasoning", text: "Visible reasoning" },
              {
                type: "dynamic-tool",
                toolName: "bash",
                toolCallId: "call-running",
                title: "Run checks",
                state: "input-streaming",
              },
              {
                type: "dynamic-tool",
                toolName: "search",
                toolCallId: "call-pending",
                state: "input-streaming",
              },
              {
                type: "dynamic-tool",
                toolName: "read",
                toolCallId: "call-complete",
                title: "Read file",
                state: "output-available",
                input: null,
                output: null,
              },
              {
                type: "dynamic-tool",
                toolName: "write",
                toolCallId: "call-error",
                state: "output-error",
                input: null,
                errorText: "Tool failed",
              },
            ],
          }),
        }),
        expect.objectContaining({
          id: "reasoning-delta",
          message: expect.objectContaining({
            id: "assistant-with-parts",
            parts: [{ type: "reasoning", text: "streamed thought" }],
          }),
        }),
        expect.objectContaining({
          id: "reasoning-empty",
          message: expect.objectContaining({ parts: [] }),
        }),
        expect.objectContaining({
          id: "tool-malformed",
          message: expect.objectContaining({ parts: [] }),
        }),
        expect.objectContaining({
          id: "tool-unknown-state",
          message: expect.objectContaining({ parts: [] }),
        }),
      ]),
    );
    expect(JSON.stringify(observations)).not.toContain("must-not-leak");
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

  it("waits for the shared server health endpoint before its first attach", async () => {
    const { network } = composition();
    network.healthStatuses = [503, 503, 200];
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
      expect.objectContaining({ id: "reconcile:status", kind: "turn.completed" }),
    ]);
    expect(reconciliation.cursor).toEqual({ eventId: "reconcile:status" });
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

  it("maps every status family and ignores malformed or unrelated SSE events", async () => {
    const { adapter } = composition([
      {
        id: "delta",
        type: "message.part.delta",
        properties: { sessionID: "native-session-1", delta: "d" },
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
        properties: { sessionID: "native-session-1", status: { type: "retry", message: "again" } },
      },
      {
        id: "error",
        type: "session.error",
        properties: { sessionID: "native-session-1", error: { message: "bad" } },
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
      "delta",
      "busy-nested",
      "idle",
      "retry",
      "error",
      "opencode:sse-disconnected:native-session-1",
      "opencode:sse-binding-failed:native-session-1",
    ]);
    expect(observations[3]).toMatchObject({
      kind: "attention.raised",
      attention: { kind: "transport_retrying", detail: "again" },
    });
    expect(observations[4]).toMatchObject({
      kind: "attention.raised",
      attention: { kind: "adapter_unrecoverable", detail: "bad" },
    });
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
    const adapter = createOpenCodeNativeAdapter({ process, network, now: () => 1234 });
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
      expect.objectContaining({
        id: "opencode:sse-binding-failed:native-session-1",
        kind: "attachment.failed",
        detail: "stream closed",
      }),
    ]);
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

    // The binding terminal fact is independently attempted even if both the
    // source event and durable attention were rejected by the sink.
    expect(emits).toBe(3);
    expect(attempted.map(({ kind }) => kind)).toEqual([
      "turn.completed",
      "attention.raised",
      "attachment.failed",
    ]);
    expect(attempted[1]).toMatchObject({
      id: "opencode:sse-disconnected:native-session-1",
      attention: { kind: "adapter_disconnected", detail: "durable store unavailable" },
    });
    expect(attempted[2]).toMatchObject({
      id: "opencode:sse-binding-failed:native-session-1",
      detail: "durable store unavailable",
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
      expect.objectContaining({
        kind: "attachment.failed",
        detail: "OpenCode event stream disconnected",
      }),
    ]);
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
        return { status: 200, body: { items: [{ info: {} }, 7] } };
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
          kind: "transcript.message",
          message: expect.objectContaining({
            id: "raw",
            role: "assistant",
            parts: [{ type: "text", text: "kept" }],
          }),
        }),
        expect.objectContaining({
          kind: "transcript.message",
          message: expect.objectContaining({
            id: "outer",
            parts: [{ type: "text", text: "nested" }],
          }),
        }),
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
    expect(reconciliation.cursor).toEqual({ eventId: "question:q" });
    expect(reconciliation.observations).toEqual([
      expect.objectContaining({
        kind: "interaction.opened",
        interaction: expect.objectContaining({ id: "question:q", title: "Question", detail: "d" }),
      }),
    ]);

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
          id: "message-fallback",
          kind: "transcript.message",
          message: expect.objectContaining({ id: "message-fallback", parts: [] }),
        }),
        expect.objectContaining({
          id: "part-nested",
          kind: "transcript.message",
          message: expect.objectContaining({
            id: "nested",
            parts: [{ type: "text", text: "delta" }],
          }),
        }),
        expect.objectContaining({
          id: "part-fallback",
          kind: "transcript.message",
          message: expect.objectContaining({ id: "part-fallback", parts: [] }),
        }),
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
});
