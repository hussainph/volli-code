import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  fauxProvider,
  InMemoryCredentialStore,
  ModelsError,
  type AssistantMessage,
  type Context,
  type Model,
  type Models,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { BUILTIN_RULE_PACK_HASH, BUILTIN_RULE_PACK_ID } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";
import type { RuntimeObservation, SessionRuntimeSpec } from "../contracts";
import { ScopedExecutionEnv, type SessionExecutionEnv } from "./scoped-execution-env";
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
  spec: SessionRuntimeSpec;
  observations: RuntimeObservation[];
  worktreePath: string;
  sessionDataDir: string;
}

function fixture(overrides: Partial<SessionRuntimeSpec> = {}): Attachment {
  const root = mkdtempSync(join(tmpdir(), "volli-ticket-"));
  const worktreePath = join(root, "worktree");
  const sessionDataDir = join(root, "sessions");
  mkdirSync(worktreePath, { recursive: true });
  mkdirSync(sessionDataDir, { recursive: true });
  writeFileSync(join(worktreePath, "MARKER.txt"), "volli-marker-42\n");

  const observations: RuntimeObservation[] = [];
  const spec: SessionRuntimeSpec = {
    identity: {
      role: "ticket",
      sessionId: "session-1",
      rootThreadId: "thread-1",
      attachmentId: "attachment-1",
      projectId: "project-1",
      ticketId: "ticket-1",
    },
    workspacePath: worktreePath,
    venue: "local",
    model: { providerId: PROVIDER_ID, modelId: MODEL_ID, reasoningLevel: "off" },
    authority: {
      mode: "auto",
      location: "worktree",
      tools: [],
      rulePackId: BUILTIN_RULE_PACK_ID,
      rulePackHash: BUILTIN_RULE_PACK_HASH,
      classifierModel: null,
      fallback: { consecutiveDenials: 3, sessionDenials: 20 },
    },
    brief: { text: "VC-12 — read the marker." },
    tools: { tools: ["read"] },
    observer: async (observation) => {
      observations.push(observation);
    },
    ...overrides,
  };
  return {
    observations,
    worktreePath,
    sessionDataDir,
    // The Snapshot names the bundle the attachment actually loads. A fixture
    // that let the two drift would describe a Session that cannot exist.
    spec: { ...spec, authority: { ...spec.authority, tools: spec.tools.tools } },
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

function readJsonl(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function writeLinearJsonl(path: string, entries: Record<string, unknown>[]): void {
  entries.forEach((entry, index) => {
    if (index === 0) return;
    entry["seq"] = index;
    entry["parentId"] = index === 1 ? null : entries[index - 1]?.["id"];
  });
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

// --- tests -----------------------------------------------------------------

describe("model access", () => {
  it("reports sanitized available and sign-in-required model access", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai-codex", async () => ({
      type: "oauth",
      access: "access-secret",
      refresh: "refresh-secret",
      expires: Date.now() + 60_000,
    }));
    const configured = fauxProvider({
      provider: "openai-codex",
      models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true }],
    });
    const unconfigured = fauxProvider({
      provider: "anthropic",
      models: [{ id: "claude-sonnet", name: "Claude Sonnet", reasoning: true }],
    });
    const models = createModels({ credentials });
    models.setProvider({
      ...configured.provider,
      name: "OpenAI Codex",
      baseUrl: "https://access-secret.invalid",
      headers: { Authorization: "Bearer access-secret" },
      auth: {
        oauth: {
          name: "OpenAI (ChatGPT Plus/Pro)",
          isSubscription: true,
          login: async () => {
            throw new Error("not called");
          },
          refresh: async (credential) => credential,
          toAuth: async () => ({ headers: { Authorization: "Bearer access-secret" } }),
        },
      },
    });
    models.setProvider({
      ...unconfigured.provider,
      name: "Anthropic",
      auth: {
        apiKey: {
          name: "Anthropic API key",
          resolve: async () => undefined,
        },
      },
    });

    const runtime = createPiAgentRuntime({
      sessionDataDir: "/runtime-owned/sessions",
      models,
      now: () => 42,
    });

    const access = await runtime.inspectModelAccess();

    expect(access).toEqual({
      observedAt: 42,
      providers: [
        {
          id: "openai-codex",
          label: "OpenAI Codex",
          state: "available",
          accountLabel: null,
          billingSource: "subscription",
          recovery: null,
        },
        {
          id: "anthropic",
          label: "Anthropic",
          state: "authentication-required",
          accountLabel: null,
          billingSource: "unknown",
          recovery: { kind: "external-sign-in" },
        },
      ],
      models: [
        {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          label: "GPT-5.6 Sol",
          state: "available",
          reasoningLevels: ["off", "minimal", "low", "medium", "high"],
        },
        {
          providerId: "anthropic",
          modelId: "claude-sonnet",
          label: "Claude Sonnet",
          state: "authentication-required",
          reasoningLevels: ["off", "minimal", "low", "medium", "high"],
        },
      ],
    });
    expect(JSON.stringify(access)).not.toMatch(/access-secret|refresh-secret|authorization/i);
  });

  it("isolates provider authentication failures without exposing their details", async () => {
    const broken = fauxProvider({
      provider: "anthropic",
      models: [{ id: "claude-sonnet", name: "Claude Sonnet", reasoning: true }],
    });
    const models = createModels();
    models.setProvider({
      ...broken.provider,
      name: "Anthropic",
      auth: {
        apiKey: {
          name: "Anthropic API key",
          resolve: async () => {
            throw new Error("credential-store-secret");
          },
        },
      },
    });
    const runtime = createPiAgentRuntime({
      sessionDataDir: "/runtime-owned/sessions",
      models,
      now: () => 43,
    });

    const access = await runtime.inspectModelAccess();

    expect(access).toEqual({
      observedAt: 43,
      providers: [
        {
          id: "anthropic",
          label: "Anthropic",
          state: "unavailable",
          accountLabel: null,
          billingSource: "unknown",
          recovery: { kind: "retry" },
        },
      ],
      models: [
        {
          providerId: "anthropic",
          modelId: "claude-sonnet",
          label: "Claude Sonnet",
          state: "unavailable",
          reasoningLevels: ["off", "minimal", "low", "medium", "high"],
        },
      ],
    });
    expect(JSON.stringify(access)).not.toContain("credential-store-secret");
  });

  it("reports only reasoning levels the model supports", async () => {
    const faux = fauxProvider({
      provider: "example",
      models: [
        { id: "always-reasons", reasoning: true },
        { id: "plain", reasoning: false },
      ],
    });
    const [alwaysReasons, plain] = faux.models;
    const models = createModels();
    models.setProvider({
      ...faux.provider,
      auth: {
        apiKey: {
          name: "Example API key",
          resolve: async () => ({ auth: { apiKey: "configured" }, source: "EXAMPLE_API_KEY" }),
        },
      },
      getModels: () => [
        {
          ...alwaysReasons,
          thinkingLevelMap: { off: null, minimal: null, max: null },
        },
        plain,
      ],
    });
    const runtime = createPiAgentRuntime({
      sessionDataDir: "/runtime-owned/sessions",
      models,
    });

    const access = await runtime.inspectModelAccess();

    expect(access.models.map((model) => [model.modelId, model.reasoningLevels])).toEqual([
      ["always-reasons", ["low", "medium", "high"]],
      ["plain", ["off"]],
    ]);
  });

  it("keeps credential-filtered models unavailable when their provider is usable", async () => {
    const faux = fauxProvider({
      provider: "subscription",
      models: [{ id: "included" }, { id: "excluded" }],
    });
    const models = createModels();
    models.setProvider({
      ...faux.provider,
      auth: {
        apiKey: {
          name: "Subscription credential",
          resolve: async () => ({ auth: { apiKey: "configured" } }),
        },
      },
      filterModels: (catalog) => catalog.filter((model) => model.id === "included"),
    });
    const runtime = createPiAgentRuntime({
      sessionDataDir: "/runtime-owned/sessions",
      models,
    });

    const access = await runtime.inspectModelAccess();

    expect(access.providers[0]?.state).toBe("available");
    expect(access.providers[0]?.billingSource).toBe("unknown");
    expect(access.models.map((model) => [model.modelId, model.state])).toEqual([
      ["included", "available"],
      ["excluded", "unavailable"],
    ]);
  });

  it("does not call API-key access a subscription merely because OAuth is offered", async () => {
    const faux = fauxProvider({ provider: "mixed-auth", models: [{ id: "model-1" }] });
    const models = createModels();
    models.setProvider({
      ...faux.provider,
      auth: {
        oauth: {
          name: "Mixed subscription",
          isSubscription: true,
          login: async () => {
            throw new Error("not called");
          },
          refresh: async (credential) => credential,
          toAuth: async () => ({ headers: { Authorization: "Bearer oauth-secret" } }),
        },
      },
    });
    vi.spyOn(models, "checkAuth").mockResolvedValue({
      type: "api_key",
      source: "MIXED_API_KEY",
    });
    vi.spyOn(models, "getAvailable").mockResolvedValue(faux.models);
    const runtime = createPiAgentRuntime({ sessionDataDir: "/runtime-owned/sessions", models });

    const access = await runtime.inspectModelAccess();

    expect(access.providers[0]).toMatchObject({
      state: "available",
      accountLabel: null,
      billingSource: "unknown",
    });
    expect(JSON.stringify(access)).not.toMatch(/api-secret|MIXED_API_KEY|oauth-secret/);
  });

  it("turns a failed explicit catalog refresh into sanitized retry recovery", async () => {
    const faux = fauxProvider({
      provider: "dynamic",
      models: [{ id: "stale-model" }],
    });
    const models = createModels();
    models.setProvider({
      ...faux.provider,
      auth: {
        apiKey: {
          name: "Dynamic API key",
          resolve: async () => ({ auth: { apiKey: "configured" } }),
        },
      },
    });
    vi.spyOn(models, "refresh").mockResolvedValue({
      aborted: false,
      errors: new Map([["dynamic", new Error("refresh-secret")]]),
    });
    const runtime = createPiAgentRuntime({
      sessionDataDir: "/runtime-owned/sessions",
      models,
    });

    const access = await runtime.inspectModelAccess({ refresh: true });

    expect(access.providers).toEqual([
      {
        id: "dynamic",
        label: "dynamic",
        state: "unavailable",
        accountLabel: null,
        billingSource: "unknown",
        recovery: { kind: "retry" },
      },
    ]);
    expect(access.models[0]?.state).toBe("unavailable");
    expect(JSON.stringify(access)).not.toContain("refresh-secret");
  });

  it("honors cancellation even when the model collection is empty", async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = createPiAgentRuntime({
      sessionDataDir: "/runtime-owned/sessions",
      models: createModels(),
    });

    await expect(runtime.inspectModelAccess({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("honors cancellation reported by Pi refresh", async () => {
    const models = createModels();
    vi.spyOn(models, "refresh").mockResolvedValue({ aborted: true, errors: new Map() });
    const runtime = createPiAgentRuntime({
      sessionDataDir: "/runtime-owned/sessions",
      models,
    });

    await expect(runtime.inspectModelAccess({ refresh: true })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("threads an active cancellation signal through refresh and provider probes", async () => {
    const faux = fauxProvider({ provider: "sign-in", models: [{ id: "model" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const controller = new AbortController();
    const refresh = vi.spyOn(models, "refresh").mockResolvedValue({
      aborted: false,
      errors: new Map(),
    });
    const checkAuth = vi.spyOn(models, "checkAuth").mockResolvedValue(undefined);
    const getAvailable = vi.spyOn(models, "getAvailable").mockResolvedValue([]);
    const runtime = createPiAgentRuntime({ sessionDataDir: "/runtime-owned/sessions", models });

    const access = await runtime.inspectModelAccess({ refresh: true, signal: controller.signal });

    expect(refresh).toHaveBeenCalledWith({ force: true, signal: controller.signal });
    expect(checkAuth).toHaveBeenCalledWith("sign-in", { signal: controller.signal });
    expect(getAvailable).toHaveBeenCalledWith("sign-in", { signal: controller.signal });
    expect(access.providers[0]).toMatchObject({
      state: "authentication-required",
      recovery: { kind: "external-sign-in" },
    });
    expect(access.models[0]?.state).toBe("authentication-required");

    checkAuth.mockResolvedValue({ type: "api_key", source: "SIGN_IN_API_KEY" });
    const configuredButEmpty = await runtime.inspectModelAccess();
    expect(configuredButEmpty.providers[0]).toMatchObject({
      state: "unavailable",
      recovery: null,
    });
  });

  it("maps OAuth refresh failures to external sign-in without exposing details", async () => {
    const faux = fauxProvider({ provider: "oauth-provider", models: [{ id: "model" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    vi.spyOn(models, "refresh").mockResolvedValue({
      aborted: false,
      errors: new Map([["oauth-provider", new ModelsError("oauth", "oauth-refresh-secret")]]),
    });
    const runtime = createPiAgentRuntime({
      sessionDataDir: "/runtime-owned/sessions",
      models,
    });

    const access = await runtime.inspectModelAccess({ refresh: true });

    expect(access.providers[0]?.recovery).toEqual({ kind: "external-sign-in" });
    expect(JSON.stringify(access)).not.toContain("oauth-refresh-secret");
  });
});

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

describe("startSession", () => {
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
    } as unknown as SessionExecutionEnv;
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
      executionEnvFactory: async () => unavailableEnv,
    });

    await expect(runtime.startSession(attachment.spec)).rejects.toThrow(
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

    await expect(runtime.startSession(attachment.spec)).rejects.toThrow(
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
    } as unknown as SessionExecutionEnv;
    const stream = vi.fn(scriptedStream([]));
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(stream),
      executionEnvFactory: async () => containedEnv,
    });

    await expect(runtime.startSession(attachment.spec)).rejects.toThrow(
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
    } as unknown as SessionExecutionEnv;
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

    await expect(runtime.startSession(attachment.spec)).rejects.toThrow(
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
    } as unknown as SessionExecutionEnv;
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

    await expect(runtime.startSession(attachment.spec)).rejects.toThrow(
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
    } as unknown as SessionExecutionEnv;
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

    const handle = await runtime.startSession(attachment.spec);
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

  it.each([
    {
      what: "a command the Session's authority denies",
      command: "git reset --hard",
      expected: "discards uncommitted work",
    },
    {
      what: "a command that cannot be normalized at all",
      command: `cat ${"x".repeat(400)}`,
      expected: "could not be checked against the Session's authority",
    },
  ])("refuses $what before the process is spawned", async ({ command, expected }) => {
    // A Main checkout, because that is where discarding a person's uncommitted
    // work is the refusal worth making.
    const attachment = fixture({ tools: { tools: ["execute"] } });
    attachment.spec.authority = { ...attachment.spec.authority, location: "main-checkout" };
    const exec = vi.fn(async () => ({
      ok: true as const,
      value: { stdout: "", stderr: "", exitCode: 0 },
    }));
    const containedEnv = {
      cwd: attachment.worktreePath,
      prepareProcessExecution: async () => ({ ok: true as const, value: undefined }),
      exec,
      cleanup: async () => undefined,
    } as unknown as SessionExecutionEnv;
    let toolResultContext: Context | undefined;
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      executionEnvFactory: async () => containedEnv,
      models: modelsWithStream(
        scriptedStream([
          (emit) => {
            emit.toolCall("bash", { command });
            emit.finish();
          },
          (emit, context) => {
            toolResultContext = context;
            emit.text("Understood.");
            emit.finish();
          },
        ]),
      ),
    });

    const handle = await runtime.startSession(attachment.spec);
    await handle.submitUserMessage("Do it.");
    await handle.close();

    expect(exec).not.toHaveBeenCalled();
    expect(JSON.stringify(toolResultContext?.messages)).toContain(expected);
  });

  it("commits exactly one authority observation, ahead of the turn's own completion, naming what refused the call", async () => {
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
    const handle = await runtime.startSession(spec);

    await handle.submitUserMessage("Read the file outside this worktree.");
    await handle.close();

    // Pi still opens and settles the tool's own activity lifecycle around a
    // blocked call — it just settles as failed — and the authority fact lands
    // between the two: recorded once the call is known refused, ahead of the
    // failure Pi reports back to the model.
    expect(kinds(observations)).toEqual([
      "attachment:started",
      "turn:started",
      "activity",
      "authority",
      "activity",
      "delta",
      "message-settled",
      "turn:completed",
      "attachment:closed",
    ]);
    const activities = observations.filter(
      (observation): observation is Extract<RuntimeObservation, { kind: "activity" }> =>
        observation.kind === "activity",
    );
    expect(activities.map((activity) => activity.state)).toEqual(["started", "failed"]);
    const authority = observations.find(
      (observation): observation is Extract<RuntimeObservation, { kind: "authority" }> =>
        observation.kind === "authority",
    );
    expect(authority).toMatchObject({
      kind: "authority",
      state: "denied",
      turnId: expect.any(String),
      tool: "read",
      cause: "path.outside-workspace",
    });
    // Not a paraphrase: the exact reason the model was refused with.
    expect(JSON.stringify(toolResultContext?.messages)).toContain(authority?.reason);
  });

  it("does not return the block until the authority observation is durably committed", async () => {
    const committed = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    const attachment = fixture({ tools: { tools: ["execute"] } });
    attachment.spec.authority = { ...attachment.spec.authority, location: "main-checkout" };
    const exec = vi.fn(async () => ({
      ok: true as const,
      value: { stdout: "", stderr: "", exitCode: 0 },
    }));
    const containedEnv = {
      cwd: attachment.worktreePath,
      prepareProcessExecution: async () => ({ ok: true as const, value: undefined }),
      exec,
      cleanup: async () => undefined,
    } as unknown as SessionExecutionEnv;
    attachment.spec.observer = async (observation) => {
      attachment.observations.push(observation);
      if (observation.kind === "authority") {
        observed.resolve();
        await committed.promise;
      }
    };
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      executionEnvFactory: async () => containedEnv,
      models: modelsWithStream(
        scriptedStream([
          (emit) => {
            emit.toolCall("bash", { command: "git reset --hard" });
            emit.finish();
          },
          (emit) => {
            emit.text("Understood.");
            emit.finish();
          },
        ]),
      ),
    });
    const handle = await runtime.startSession(attachment.spec);
    let delivered = false;

    const delivery = handle.submitUserMessage("Reset the tree.").then((outcome) => {
      delivered = true;
      return outcome;
    });
    await observed.promise;
    await Promise.resolve();
    expect(delivered).toBe(false);
    expect(exec).not.toHaveBeenCalled();

    committed.resolve();
    await expect(delivery).resolves.toEqual({ kind: "delivered", delivery: "prompt" });
    expect(exec).not.toHaveBeenCalled();
    await handle.close();
  });

  it("still blocks the call when the observer rejects, and surfaces the failure at the next command boundary", async () => {
    const attachment = fixture({ tools: { tools: ["execute"] } });
    attachment.spec.authority = { ...attachment.spec.authority, location: "main-checkout" };
    const exec = vi.fn(async () => ({
      ok: true as const,
      value: { stdout: "", stderr: "", exitCode: 0 },
    }));
    const containedEnv = {
      cwd: attachment.worktreePath,
      prepareProcessExecution: async () => ({ ok: true as const, value: undefined }),
      exec,
      cleanup: async () => undefined,
    } as unknown as SessionExecutionEnv;
    let toolResultContext: Context | undefined;
    attachment.spec.observer = async (observation) => {
      attachment.observations.push(observation);
      if (observation.kind === "authority") {
        throw new Error("authority ledger write failed");
      }
    };
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      executionEnvFactory: async () => containedEnv,
      models: modelsWithStream(
        scriptedStream([
          (emit) => {
            emit.toolCall("bash", { command: "git reset --hard" });
            emit.finish();
          },
          (emit, context) => {
            toolResultContext = context;
            emit.text("Understood.");
            emit.finish();
          },
        ]),
      ),
    });
    const handle = await runtime.startSession(attachment.spec);

    // The queue never rejects into Pi — the run completes and the model is
    // still told the call was refused — but the failed durable write is not
    // forgotten: it surfaces once the command settles, same as any other
    // observation failure.
    await expect(handle.submitUserMessage("Reset the tree.")).rejects.toThrow(
      "authority ledger write failed",
    );

    expect(exec).not.toHaveBeenCalled();
    expect(JSON.stringify(toolResultContext?.messages)).toContain("discards uncommitted work");
    await handle.close();
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

    const handle = await runtime.startSession(spec);
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

    const replay = await handle.reconcile(null);
    expect(replay.observations.filter((observation) => observation.kind === "activity")).toEqual([
      activities[1],
    ]);
    expect(
      replay.observations.some(
        (observation) =>
          observation.kind === "activity" &&
          (observation.state === "started" || observation.state === "progress"),
      ),
    ).toBe(false);

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
    const handle = await runtime.startSession(spec);

    await handle.submitUserMessage("Read the file outside this worktree.");
    await handle.close();

    const serialized = JSON.stringify(toolResultContext?.messages);
    expect(serialized).toContain("outside the Session workspace");
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
    const handle = await runtime.startSession(attachment.spec);
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
    const handle = await runtime.startSession(attachment.spec);

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
      const handle = await runtime.startSession(attachment.spec);

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

    await expect(unusableRuntime.startSession(unusableHost.spec)).rejects.toThrow();

    const missingWorktree = fixture();
    missingWorktree.spec.workspacePath = join(missingWorktree.worktreePath, "missing");
    const missingRuntime = createPiAgentRuntime({
      sessionDataDir: missingWorktree.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
    });

    await expect(missingRuntime.startSession(missingWorktree.spec)).rejects.toThrow();
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

    await expect(observerRuntime.startSession(rejectedObserver.spec)).rejects.toThrow(
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
    const handle = await runtime.startSession(spec);

    await handle.submitUserMessage("first");
    await handle.submitUserMessage("second");
    await handle.close();

    expect(JSON.stringify(seen[0])).toContain("BEGIN TICKET BRIEF");
    const secondUserMessages = JSON.stringify(seen[1]?.slice(2));
    expect(secondUserMessages).toContain("second");
    expect(secondUserMessages).not.toContain("BEGIN TICKET BRIEF");
  });

  it("reopens its owned sidecar and seeds the next turn with settled context", async () => {
    const attachment = fixture();
    const firstRuntime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(
        scriptedStream([
          (emit) => {
            emit.text("remembered answer");
            emit.finish();
          },
        ]),
      ),
    });
    const firstHandle = await firstRuntime.startSession(attachment.spec);
    await firstHandle.submitUserMessage("remember this");
    const recovery = firstHandle.recovery;
    const firstReplay = await firstHandle.reconcile(null);
    expect(kinds([...firstReplay.observations])).toEqual([
      "turn:started",
      "message-settled",
      "turn:completed",
    ]);
    await firstHandle.close();

    let recoveredContext: Context | undefined;
    const secondRuntime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(
        scriptedStream([
          (emit, context) => {
            recoveredContext = context;
            emit.text("continued answer");
            emit.finish();
          },
        ]),
      ),
    });
    const secondHandle = await secondRuntime.startSession({
      ...attachment.spec,
      recovery,
    });
    expect(await secondHandle.reconcile(null)).toEqual(firstReplay);
    expect(await secondHandle.reconcile(firstReplay.cursor)).toEqual({
      cursor: firstReplay.cursor,
      observations: [],
    });
    await expect(secondHandle.reconcile("missing-cursor")).rejects.toThrow("cursor is not present");
    await secondHandle.submitUserMessage("continue");

    expect(jsonlFiles(attachment.sessionDataDir)).toHaveLength(1);
    expect(JSON.stringify(recoveredContext?.messages)).toContain("remembered answer");
    expect(secondHandle.recovery).toEqual(recovery);
    await secondHandle.close();
  });

  it("recovers accepted prompt and retry receipts independently of the observation cursor", async () => {
    const attachment = fixture();
    const firstRuntime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(
        scriptedStream([
          (emit) => emit.fail("invalid api key"),
          (emit) => {
            emit.text("authenticated");
            emit.finish();
          },
        ]),
      ),
    });
    const firstHandle = await firstRuntime.startSession(attachment.spec);
    await firstHandle.submitUserMessage("authenticate", "queue", "command-prompt");
    await firstHandle.retry("command-retry");
    const replay = await firstHandle.reconcile(null);

    expect(replay.receipts).toEqual([
      expect.objectContaining({ commandId: "command-prompt", acceptedAt: expect.any(Number) }),
      expect.objectContaining({ commandId: "command-retry", acceptedAt: expect.any(Number) }),
    ]);
    const markerKinds = readFileSync(firstHandle.recovery!.sessionFilePath, "utf8")
      .trimEnd()
      .split("\n")
      .flatMap((line) => {
        const entry = JSON.parse(line) as {
          customType?: string;
          data?: { kind?: string; state?: string };
        };
        return entry.customType === "volli.observation.v1"
          ? [`${entry.data?.kind}:${entry.data?.state ?? ""}`]
          : [];
      });
    expect(markerKinds.indexOf("turn:started")).toBeLessThan(
      markerKinds.indexOf("command-accepted:"),
    );
    expect((await firstHandle.reconcile(replay.cursor)).receipts).toEqual(replay.receipts);
    const recovery = firstHandle.recovery;
    await firstHandle.close();

    const reopenedRuntime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
    });
    const reopened = await reopenedRuntime.startSession({ ...attachment.spec, recovery });
    expect((await reopened.reconcile(replay.cursor)).receipts).toEqual(replay.receipts);
    await reopened.close();
  });

  it("recovers an accepted receipt for an interrupted open-tail command", async () => {
    const attachment = fixture();
    const streaming = Promise.withResolvers<void>();
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([haltOnAbort("partial", streaming.resolve)])),
    });
    const handle = await runtime.startSession(attachment.spec);
    const delivery = handle.submitUserMessage("start", "queue", "command-interrupted");
    await streaming.promise;
    await handle.interrupt();
    await delivery;

    expect((await handle.reconcile(null)).receipts).toEqual([
      expect.objectContaining({ commandId: "command-interrupted" }),
    ]);
    await handle.close();
  });

  it("does not feed an aborted assistant tail back into Pi after reopen", async () => {
    const attachment = fixture();
    const streaming = Promise.withResolvers<void>();
    const firstRuntime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(
        scriptedStream([haltOnAbort("half-written private thought", streaming.resolve)]),
      ),
    });
    const firstHandle = await firstRuntime.startSession(attachment.spec);
    const firstDelivery = firstHandle.submitUserMessage("start", "queue", "command-recovered-user");
    await streaming.promise;
    await firstHandle.interrupt();
    await firstDelivery;
    const recovery = firstHandle.recovery;
    const replay = await firstHandle.reconcile(null);
    expect(kinds([...replay.observations])).toEqual(["turn:started", "turn:interrupted"]);
    const durableEntries = readFileSync(recovery!.sessionFilePath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; message?: { role?: string } });
    expect(
      durableEntries.filter((entry) => entry.type === "message" && entry.message?.role === "user"),
    ).toEqual([]);
    await firstHandle.close();

    let recoveredContext: Context | undefined;
    const secondRuntime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(
        scriptedStream([
          (emit, context) => {
            recoveredContext = context;
            emit.text("clean continuation");
            emit.finish();
          },
        ]),
      ),
    });
    const secondHandle = await secondRuntime.startSession({ ...attachment.spec, recovery });
    await secondHandle.submitUserMessage("continue");

    expect(JSON.stringify(recoveredContext?.messages)).not.toContain(
      "half-written private thought",
    );
    expect(recoveredContext?.messages.filter(({ role }) => role === "user")).toHaveLength(2);
    expect(JSON.stringify(recoveredContext?.messages[0])).toContain("start");
    await secondHandle.close();
  });

  it("settles an unterminated recovered turn as partial instead of completing it", async () => {
    const attachment = fixture();
    const firstRuntime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(
        scriptedStream([
          (emit) => {
            emit.text("settled before crash");
            emit.finish();
          },
        ]),
      ),
    });
    const firstHandle = await firstRuntime.startSession(attachment.spec);
    await firstHandle.submitUserMessage("start", "queue", "command-partial-turn");
    const recovery = firstHandle.recovery!;
    await firstHandle.close();
    const lines = readFileSync(recovery.sessionFilePath, "utf8").trimEnd().split("\n");
    writeFileSync(
      recovery.sessionFilePath,
      `${lines
        .filter((line) => {
          const entry = JSON.parse(line) as {
            type?: string;
            customType?: string;
            data?: { kind?: string; state?: string };
          };
          return !(
            entry.type === "custom" &&
            entry.customType === "volli.observation.v1" &&
            entry.data?.kind === "turn" &&
            entry.data.state === "completed"
          );
        })
        .join("\n")}\n`,
    );

    const secondRuntime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
    });
    const secondHandle = await secondRuntime.startSession({ ...attachment.spec, recovery });
    const replay = await secondHandle.reconcile(null);

    expect(kinds([...replay.observations])).toEqual([
      "turn:started",
      "message-settled",
      "attention",
      "turn:interrupted",
    ]);
    expect(replay.observations[2]).toMatchObject({
      kind: "attention",
      state: "raised",
      reason: "partial-turn",
    });
    expect(replay.receipts).toEqual([
      expect.objectContaining({ commandId: "command-partial-turn" }),
    ]);
    await secondHandle.close();
  });

  it("withholds an assistant entry without a semantic marker as a recoverable partial turn", async () => {
    const attachment = fixture();
    const firstRuntime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(
        scriptedStream([
          (emit) => {
            emit.text("answer without ledger evidence");
            emit.finish();
          },
        ]),
      ),
    });
    const firstHandle = await firstRuntime.startSession(attachment.spec);
    await firstHandle.submitUserMessage("start");
    const recovery = firstHandle.recovery!;
    await firstHandle.close();
    const lines = readFileSync(recovery.sessionFilePath, "utf8").trimEnd().split("\n");
    const retained = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => {
        const data = entry["data"] as { kind?: string } | undefined;
        return !(
          entry["type"] === "custom" &&
          entry["customType"] === "volli.observation.v1" &&
          data?.kind === "message-settled"
        );
      });
    retained.forEach((entry, index, entries) => {
      if (index === 0) return;
      entry["seq"] = index;
      entry["parentId"] = index === 1 ? null : entries[index - 1]?.["id"];
    });
    writeFileSync(
      recovery.sessionFilePath,
      `${retained.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    let recoveredContext: Context | undefined;
    const secondRuntime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(
        scriptedStream([
          (emit, context) => {
            recoveredContext = context;
            emit.text("safe retry");
            emit.finish();
          },
        ]),
      ),
    });
    const secondHandle = await secondRuntime.startSession({ ...attachment.spec, recovery });
    expect((await secondHandle.reconcile(null)).observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "attention",
          state: "raised",
          reason: "partial-turn",
        }),
      ]),
    );
    await secondHandle.submitUserMessage("retry safely");
    expect(JSON.stringify(recoveredContext?.messages)).not.toContain(
      "answer without ledger evidence",
    );
    await secondHandle.close();
  });

  it("withholds duplicate settled markers as a recoverable partial turn", async () => {
    const attachment = fixture();
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(
        scriptedStream([
          (emit) => {
            emit.text("duplicated answer");
            emit.finish();
          },
        ]),
      ),
    });
    const firstHandle = await runtime.startSession(attachment.spec);
    await firstHandle.submitUserMessage("start");
    const recovery = firstHandle.recovery!;
    await firstHandle.close();
    const entries = readJsonl(recovery.sessionFilePath);
    const marker = entries.find((entry) => {
      const data = entry["data"] as { kind?: string } | undefined;
      return data?.kind === "message-settled";
    })!;
    entries.push({ ...marker, id: `${String(marker["id"])}-duplicate` });
    writeLinearJsonl(recovery.sessionFilePath, entries);

    const reopened = await runtime.startSession({ ...attachment.spec, recovery });
    const replay = await reopened.reconcile(null);

    expect(replay.observations.some((observation) => observation.kind === "message-settled")).toBe(
      false,
    );
    expect(replay.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "attention",
          state: "raised",
          reason: "partial-turn",
        }),
      ]),
    );
    await reopened.close();
  });

  it("withholds a settled marker without an assistant entry as a recoverable partial turn", async () => {
    const attachment = fixture();
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(
        scriptedStream([
          (emit) => {
            emit.text("orphaned answer");
            emit.finish();
          },
        ]),
      ),
    });
    const firstHandle = await runtime.startSession(attachment.spec);
    await firstHandle.submitUserMessage("start");
    const recovery = firstHandle.recovery!;
    await firstHandle.close();
    const entries = readJsonl(recovery.sessionFilePath).filter((entry) => {
      const message = entry["message"] as { role?: string } | undefined;
      return message?.role !== "assistant";
    });
    writeLinearJsonl(recovery.sessionFilePath, entries);

    const reopened = await runtime.startSession({ ...attachment.spec, recovery });
    const replay = await reopened.reconcile(null);

    expect(replay.observations.some((observation) => observation.kind === "message-settled")).toBe(
      false,
    );
    expect(replay.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "attention",
          state: "raised",
          reason: "partial-turn",
        }),
      ]),
    );
    await reopened.close();
  });

  it("rejects structurally malformed recovery markers without deleting the sidecar", async () => {
    const attachment = fixture();
    const firstRuntime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
    });
    const firstHandle = await firstRuntime.startSession(attachment.spec);
    const recovery = firstHandle.recovery!;
    await firstHandle.close();
    const lines = readFileSync(recovery.sessionFilePath, "utf8").trimEnd().split("\n");
    const header = lines[0]!;
    const settled = {
      entryId: "entry-1",
      role: "assistant",
      text: "settled",
      reasoning: "because",
      model: { providerId: "anthropic", modelId: MODEL_ID },
      usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.01 },
    };
    const descriptor = {
      kind: "read-file",
      nativeToolName: "read",
      subject: { label: null, path: null, lineRange: { start: 1, end: 2 } },
      outcome: {
        exitCode: null,
        matchCount: null,
        fileCount: null,
        lineCount: null,
        bytes: null,
        addedLines: null,
        removedLines: null,
        diff: null,
        summary: null,
      },
      startedAt: 1,
      endedAt: 2,
    };
    const activity = {
      kind: "activity",
      turnId: "turn-1",
      activityId: "activity-1",
      state: "failed",
      descriptor,
      input: { nested: [1, true, null] },
      output: "failed",
      error: "provider failed",
    };
    const malformedData: unknown[] = [
      null,
      { kind: "unknown" },
      { kind: "turn", state: "started" },
      { kind: "message-settled", turnId: "turn-1", message: null },
      { kind: "message-settled", turnId: "turn-1", message: { ...settled, entryId: 1 } },
      { kind: "message-settled", turnId: "turn-1", message: { ...settled, role: "user" } },
      { kind: "message-settled", turnId: "turn-1", message: { ...settled, text: 1 } },
      { kind: "message-settled", turnId: "turn-1", message: { ...settled, reasoning: 1 } },
      { kind: "message-settled", turnId: "turn-1", message: { ...settled, model: null } },
      {
        kind: "message-settled",
        turnId: "turn-1",
        message: { ...settled, model: { providerId: 1, modelId: MODEL_ID } },
      },
      {
        kind: "message-settled",
        turnId: "turn-1",
        message: { ...settled, model: { providerId: "anthropic", modelId: 1 } },
      },
      { kind: "message-settled", turnId: "turn-1", message: { ...settled, usage: null } },
      {
        kind: "message-settled",
        turnId: "turn-1",
        message: { ...settled, usage: { inputTokens: Number.POSITIVE_INFINITY } },
      },
      { ...activity, descriptor: null },
      { ...activity, descriptor: { ...descriptor, kind: "unknown" } },
      { ...activity, descriptor: { ...descriptor, nativeToolName: 1 } },
      { ...activity, descriptor: { ...descriptor, subject: null } },
      {
        ...activity,
        descriptor: { ...descriptor, subject: { ...descriptor.subject, label: 1 } },
      },
      {
        ...activity,
        descriptor: { ...descriptor, subject: { ...descriptor.subject, path: 1 } },
      },
      {
        ...activity,
        descriptor: { ...descriptor, subject: { ...descriptor.subject, lineRange: "1-2" } },
      },
      {
        ...activity,
        descriptor: {
          ...descriptor,
          subject: { ...descriptor.subject, lineRange: { start: "1", end: 2 } },
        },
      },
      {
        ...activity,
        descriptor: {
          ...descriptor,
          subject: { ...descriptor.subject, lineRange: { start: 1, end: "2" } },
        },
      },
      { ...activity, descriptor: { ...descriptor, outcome: "failed" } },
      {
        ...activity,
        descriptor: { ...descriptor, outcome: { ...descriptor.outcome, exitCode: "one" } },
      },
      {
        ...activity,
        descriptor: { ...descriptor, outcome: { ...descriptor.outcome, diff: 1 } },
      },
      {
        ...activity,
        descriptor: { ...descriptor, outcome: { ...descriptor.outcome, summary: 1 } },
      },
      { ...activity, descriptor: { ...descriptor, endedAt: "later" } },
      { ...activity, error: 1 },
      { kind: "attention", state: "raised", reason: "auth", message: 1 },
      {
        kind: "command-accepted",
        commandId: 1,
        operation: "message.submit",
        delivery: "prompt",
        turnId: "turn-1",
      },
      {
        kind: "command-accepted",
        commandId: "command-1",
        operation: "unknown",
        delivery: "prompt",
        turnId: "turn-1",
      },
      {
        kind: "command-accepted",
        commandId: "command-1",
        operation: "message.submit",
        delivery: "unknown",
        turnId: "turn-1",
      },
      {
        kind: "command-accepted",
        commandId: "command-1",
        operation: "message.submit",
        delivery: "prompt",
        turnId: 1,
      },
      {
        kind: "command-accepted",
        commandId: "command-1",
        operation: "executor.retry",
        delivery: "queue",
        turnId: "turn-1",
      },
      {
        kind: "command-accepted",
        commandId: "command-1",
        operation: "message.submit",
        delivery: "retry",
        turnId: "turn-1",
        message: { role: "user", content: "accepted", timestamp: Date.now() },
      },
    ];

    const secondRuntime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
    });
    for (const [index, data] of malformedData.entries()) {
      const malformed = {
        kind: "entry",
        lane: "main",
        type: "custom",
        id: `malformed-marker-${index}`,
        parentId: null,
        seq: 1,
        timestamp: Date.now(),
        customType: "volli.observation.v1",
        data,
      };
      writeFileSync(recovery.sessionFilePath, `${header}\n${JSON.stringify(malformed)}\n`);
      try {
        const unexpected = await secondRuntime.startSession({
          ...attachment.spec,
          recovery,
        });
        await unexpected.close();
        throw new Error(`Malformed marker case ${index} was accepted.`);
      } catch (error) {
        if (error instanceof Error && error.message.includes("was accepted")) throw error;
        expect(error).toEqual(
          expect.objectContaining({ message: "Pi recovery marker is malformed." }),
        );
      }
      expect(existsSync(recovery.sessionFilePath)).toBe(true);
    }
  });

  it("accepts complete semantic markers and ignores foreign custom entries", async () => {
    const attachment = fixture();
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
    });
    const firstHandle = await runtime.startSession(attachment.spec);
    const recovery = firstHandle.recovery!;
    await firstHandle.close();
    const [header] = readFileSync(recovery.sessionFilePath, "utf8").trimEnd().split("\n");
    const entries = [
      {
        kind: "entry",
        lane: "main",
        type: "custom",
        id: "foreign-marker",
        parentId: null,
        seq: 1,
        timestamp: Date.now(),
        customType: "foreign.marker",
        data: null,
      },
      {
        kind: "entry",
        lane: "main",
        type: "custom",
        id: "activity-marker",
        parentId: "foreign-marker",
        seq: 2,
        timestamp: Date.now(),
        customType: "volli.observation.v1",
        data: {
          kind: "activity",
          turnId: "turn-1",
          activityId: "activity-1",
          state: "failed",
          descriptor: {
            kind: "read-file",
            nativeToolName: "read",
            subject: { label: null, path: null, lineRange: null },
            outcome: null,
            startedAt: null,
            endedAt: null,
          },
          input: null,
          output: false,
          error: "failed",
        },
      },
      {
        kind: "entry",
        lane: "main",
        type: "custom",
        id: "attention-clear-marker",
        parentId: "activity-marker",
        seq: 3,
        timestamp: Date.now(),
        customType: "volli.observation.v1",
        data: {
          kind: "attention",
          state: "cleared",
          reason: "runtime-failure",
          message: "Runtime recovered.",
        },
      },
    ];
    writeFileSync(
      recovery.sessionFilePath,
      `${header}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const reopened = await runtime.startSession({ ...attachment.spec, recovery });
    expect((await reopened.reconcile(null)).observations).toHaveLength(2);
    await reopened.close();
  });

  it("rejects duplicate or conflicting command delivery markers", async () => {
    for (const second of [
      { commandId: "command-1", turnId: "turn-2" },
      { commandId: "command-2", turnId: "turn-1" },
    ]) {
      const attachment = fixture();
      const runtime = createPiAgentRuntime({
        sessionDataDir: attachment.sessionDataDir,
        models: modelsWithStream(scriptedStream([])),
      });
      const firstHandle = await runtime.startSession(attachment.spec);
      const recovery = firstHandle.recovery!;
      await firstHandle.close();
      const [header] = readFileSync(recovery.sessionFilePath, "utf8").trimEnd().split("\n");
      const markers = [{ commandId: "command-1", turnId: "turn-1" }, second].map((data, index) => ({
        kind: "entry",
        lane: "main",
        type: "custom",
        id: `delivery-${index}`,
        parentId: index === 0 ? null : "delivery-0",
        seq: index + 1,
        timestamp: Date.now() + index,
        customType: "volli.observation.v1",
        data: {
          kind: "command-accepted",
          operation: "message.submit",
          delivery: "prompt",
          message: { role: "user", content: "accepted", timestamp: Date.now() },
          ...data,
        },
      }));
      writeFileSync(
        recovery.sessionFilePath,
        `${header}\n${markers.map((marker) => JSON.stringify(marker)).join("\n")}\n`,
      );

      await expect(runtime.startSession({ ...attachment.spec, recovery })).rejects.toThrow(
        "Pi recovery delivery markers conflict.",
      );
      expect(existsSync(recovery.sessionFilePath)).toBe(true);
    }
  });

  it("rejects a forged recovery path without touching the foreign file", async () => {
    const attachment = fixture();
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
    });
    const firstHandle = await runtime.startSession(attachment.spec);
    const recovery = firstHandle.recovery!;
    await firstHandle.close();
    const foreignPath = join(attachment.worktreePath, "foreign.jsonl");
    writeFileSync(foreignPath, "foreign bytes\n");

    await expect(
      runtime.startSession({
        ...attachment.spec,
        recovery: { ...recovery, sessionFilePath: foreignPath },
      }),
    ).rejects.toThrow("path does not match");
    expect(readFileSync(foreignPath, "utf8")).toBe("foreign bytes\n");
    expect(existsSync(recovery.sessionFilePath)).toBe(true);
  });

  it("rejects a missing recovery id before trusting its locator", async () => {
    const attachment = fixture();
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
    });
    const firstHandle = await runtime.startSession(attachment.spec);
    const recovery = firstHandle.recovery!;
    await firstHandle.close();

    await expect(
      runtime.startSession({
        ...attachment.spec,
        recovery: { ...recovery, sessionId: "missing-session" },
      }),
    ).rejects.toThrow("not found uniquely");
    expect(existsSync(recovery.sessionFilePath)).toBe(true);
  });

  it("rejects a recovery sidecar symlink that escapes the owned directory", async () => {
    const attachment = fixture();
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
    });
    const firstHandle = await runtime.startSession(attachment.spec);
    const recovery = firstHandle.recovery!;
    await firstHandle.close();
    const foreignPath = join(attachment.worktreePath, "foreign-sidecar.jsonl");
    writeFileSync(foreignPath, readFileSync(recovery.sessionFilePath));
    unlinkSync(recovery.sessionFilePath);
    symlinkSync(foreignPath, recovery.sessionFilePath);

    await expect(runtime.startSession({ ...attachment.spec, recovery })).rejects.toThrow(
      "outside the runtime-owned session directory",
    );
    expect(readFileSync(foreignPath, "utf8")).toContain(recovery.sessionId);
  });

  it("rejects recovery metadata owned by a different attachment", async () => {
    const attachment = fixture();
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
    });
    const firstHandle = await runtime.startSession(attachment.spec);
    const recovery = firstHandle.recovery!;
    await firstHandle.close();

    await expect(
      runtime.startSession({
        ...attachment.spec,
        identity: { ...attachment.spec.identity, attachmentId: "attachment-2" },
        recovery,
      }),
    ).rejects.toThrow("identity does not match");
    expect(existsSync(recovery.sessionFilePath)).toBe(true);
  });

  it("preserves a reopened sidecar when attachment preparation fails", async () => {
    const attachment = fixture();
    const firstRuntime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
    });
    const firstHandle = await firstRuntime.startSession(attachment.spec);
    const recovery = firstHandle.recovery!;
    await firstHandle.close();

    const failingRuntime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
      executionEnvFactory: async () => {
        throw new Error("sandbox unavailable");
      },
    });
    await expect(
      failingRuntime.startSession({
        ...attachment.spec,
        tools: { tools: ["execute"] },
        recovery,
      }),
    ).rejects.toThrow("Contained process execution is unavailable.");
    expect(existsSync(recovery.sessionFilePath)).toBe(true);
    expect(jsonlFiles(attachment.sessionDataDir)).toHaveLength(1);
  });

  it("rejects replace while the agent is still working", async () => {
    const { spec, sessionDataDir } = fixture();
    const streaming = Promise.withResolvers<void>();

    const runtime = createPiAgentRuntime({
      sessionDataDir,
      models: modelsWithStream(scriptedStream([haltOnAbort("working", streaming.resolve)])),
    });
    const handle = await runtime.startSession(spec);

    const first = handle.submitUserMessage("go");
    await streaming.promise;
    expect(await handle.submitUserMessage("and also", "replace")).toEqual({
      kind: "rejected",
      reason: "replace-unsupported",
      message: "Pi does not support replacing the active turn.",
    });

    await handle.interrupt();
    await first;
    await handle.close();
  });

  it("queues a follow-up while the current turn is still working", async () => {
    const { spec, sessionDataDir } = fixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const followUpStarted = Promise.withResolvers<void>();
    const followUpRelease = Promise.withResolvers<void>();
    const contexts: Context[] = [];
    const runtime = createPiAgentRuntime({
      sessionDataDir,
      models: modelsWithStream(
        scriptedStream([
          async (emit, context) => {
            contexts.push(context);
            started.resolve();
            await release.promise;
            emit.text("first done");
            emit.finish();
          },
          async (emit, context) => {
            contexts.push(context);
            followUpStarted.resolve();
            await followUpRelease.promise;
            emit.text("follow-up done");
            emit.finish();
          },
        ]),
      ),
    });
    const handle = await runtime.startSession(spec);

    const first = handle.submitUserMessage("first", "queue", "command-first");
    await started.promise;
    await expect(handle.submitUserMessage("also verify the tests", "queue")).resolves.toEqual({
      kind: "delivered",
      delivery: "queue",
    });
    expect((await handle.reconcile(null)).receipts).toEqual([
      expect.objectContaining({ commandId: "command-first" }),
    ]);
    release.resolve();
    await followUpStarted.promise;

    expect(JSON.stringify(contexts[1]?.messages)).toContain("also verify the tests");
    expect((await handle.reconcile(null)).receipts).toEqual([
      expect.objectContaining({ commandId: "command-first" }),
    ]);
    followUpRelease.resolve();
    await first;
    await handle.close();
  });

  it("steers before an ordinary queued follow-up", async () => {
    const { spec, sessionDataDir } = fixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const steerStarted = Promise.withResolvers<void>();
    const steerRelease = Promise.withResolvers<void>();
    const queueStarted = Promise.withResolvers<void>();
    const queueRelease = Promise.withResolvers<void>();
    const contexts: Context[] = [];
    const runtime = createPiAgentRuntime({
      sessionDataDir,
      models: modelsWithStream(
        scriptedStream([
          async (emit, context) => {
            contexts.push(context);
            started.resolve();
            await release.promise;
            emit.text("first done");
            emit.finish();
          },
          async (emit, context) => {
            contexts.push(context);
            steerStarted.resolve();
            await steerRelease.promise;
            emit.text("steer done");
            emit.finish();
          },
          async (emit, context) => {
            contexts.push(context);
            queueStarted.resolve();
            await queueRelease.promise;
            emit.text("queue done");
            emit.finish();
          },
        ]),
      ),
    });
    const handle = await runtime.startSession(spec);

    const first = handle.submitUserMessage("first", "queue", "command-first");
    await started.promise;
    await handle.submitUserMessage("queue this later", "queue", "command-queue");
    await handle.submitUserMessage("steer with this now", "steer", "command-steer");
    release.resolve();
    await steerStarted.promise;

    const nextTurn = JSON.stringify(contexts[1]?.messages);
    expect(nextTurn).toContain("steer with this now");
    expect(nextTurn).not.toContain("queue this later");
    expect((await handle.reconcile(null)).receipts?.map(({ commandId }) => commandId)).toEqual([
      "command-first",
      "command-steer",
    ]);
    steerRelease.resolve();
    await queueStarted.promise;
    expect(JSON.stringify(contexts[2]?.messages)).toContain("queue this later");
    expect((await handle.reconcile(null)).receipts?.map(({ commandId }) => commandId)).toEqual([
      "command-first",
      "command-steer",
      "command-queue",
    ]);
    queueRelease.resolve();
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
    const handle = await runtime.startSession(spec);

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
    const handle = await runtime.startSession({ ...spec, signal: controller.signal });

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
      runtime.startSession({ ...attachment.spec, signal: controller.signal }),
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
    const handle = await runtime.startSession(attachment.spec);

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
    const handle = await runtime.startSession(spec);

    await handle.close();
    await handle.close();

    expect(kinds(observations)).toEqual(["attachment:started", "attachment:closed"]);
    expect(await handle.submitUserMessage("too late")).toEqual({
      kind: "rejected",
      reason: "closed",
      message: "This attachment is closed.",
    });
  });

  it("applies an available idle model and reasoning policy to the next turn", async () => {
    const used: Array<{ providerId: string; modelId: string; reasoning: string | undefined }> = [];
    const script = scriptedStream([(emit) => emit.finish()]);
    const provider = fauxProvider({
      api: "anthropic-messages",
      provider: PROVIDER_ID,
      models: [
        { id: MODEL_ID, reasoning: true },
        { id: "claude-sonnet-4-6", reasoning: true },
      ],
    });
    const models = createModels();
    models.setProvider({
      ...provider.provider,
      streamSimple: ((model, context, options) => {
        used.push({ providerId: model.provider, modelId: model.id, reasoning: options?.reasoning });
        return script(model, context, options);
      }) as typeof provider.provider.streamSimple,
    });
    const attachment = fixture();
    const handle = await createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models,
    }).startSession(attachment.spec);

    await expect(
      handle.selectModel({
        providerId: PROVIDER_ID,
        modelId: "claude-sonnet-4-6",
        reasoningLevel: "high",
      }),
    ).resolves.toEqual({ kind: "selected" });
    await handle.submitUserMessage("use the new policy");

    expect(used).toEqual([
      { providerId: PROVIDER_ID, modelId: "claude-sonnet-4-6", reasoning: "high" },
    ]);
    await handle.close();
  });

  it("rejects model changes while busy or closed without partially changing policy", async () => {
    const streaming = Promise.withResolvers<void>();
    const attachment = fixture();
    const handle = await createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([haltOnAbort("working", streaming.resolve)])),
    }).startSession(attachment.spec);
    const delivery = handle.submitUserMessage("start");
    await streaming.promise;

    await expect(
      handle.selectModel({
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        reasoningLevel: "high",
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "busy-unsupported" });
    await handle.interrupt();
    await delivery;
    await handle.close();
    await expect(
      handle.selectModel({
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        reasoningLevel: "high",
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "closed" });
  });

  it("rejects unavailable and unsupported selections", async () => {
    const attachment = fixture();
    const handle = await createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
    }).startSession(attachment.spec);

    await expect(
      handle.selectModel({
        providerId: PROVIDER_ID,
        modelId: "missing",
        reasoningLevel: "off",
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "model-unavailable" });
    await expect(
      handle.selectModel({
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        reasoningLevel: "max",
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "reasoning-unsupported" });
    await handle.close();
  });

  it("carries attachment cancellation into an idle model availability probe", async () => {
    const controller = new AbortController();
    const attachment = fixture({ signal: controller.signal });
    const models = modelsWithStream(scriptedStream([]));
    const getAvailable = vi.spyOn(models, "getAvailable");
    const handle = await createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models,
    }).startSession(attachment.spec);

    await handle.selectModel({
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      reasoningLevel: "off",
    });

    expect(getAvailable).toHaveBeenCalledWith(PROVIDER_ID, { signal: controller.signal });
    await handle.close();
  });

  it("sanitizes model availability failures during an idle change", async () => {
    const attachment = fixture();
    const models = modelsWithStream(scriptedStream([]));
    vi.spyOn(models, "getAvailable").mockRejectedValue(
      new Error("credential store exposed secret-token"),
    );
    const handle = await createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models,
    }).startSession(attachment.spec);

    const selected = await handle.selectModel({
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      reasoningLevel: "off",
    });

    expect(selected).toEqual({
      kind: "rejected",
      reason: "model-unavailable",
      message: "The selected model is not currently available.",
    });
    expect(JSON.stringify(selected)).not.toContain("secret-token");
    await handle.close();
  });

  it("rechecks idle after asynchronous model availability resolves", async () => {
    const streaming = Promise.withResolvers<void>();
    const availabilityStarted = Promise.withResolvers<void>();
    const releaseAvailability = Promise.withResolvers<void>();
    const attachment = fixture();
    const models = modelsWithStream(scriptedStream([haltOnAbort("working", streaming.resolve)]));
    const getAvailable = models.getAvailable.bind(models);
    vi.spyOn(models, "getAvailable").mockImplementation(async (...args) => {
      availabilityStarted.resolve();
      await releaseAvailability.promise;
      return getAvailable(...args);
    });
    const handle = await createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models,
    }).startSession(attachment.spec);

    const selected = handle.selectModel({
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      reasoningLevel: "high",
    });
    await availabilityStarted.promise;
    const delivery = handle.submitUserMessage("start");
    await streaming.promise;
    releaseAvailability.resolve();

    await expect(selected).resolves.toMatchObject({
      kind: "rejected",
      reason: "busy-unsupported",
    });
    await handle.interrupt();
    await delivery;
    await handle.close();
  });

  it("rejects when the attachment closes during asynchronous model availability", async () => {
    const availabilityStarted = Promise.withResolvers<void>();
    const releaseAvailability = Promise.withResolvers<void>();
    const attachment = fixture();
    const models = modelsWithStream(scriptedStream([]));
    const getAvailable = models.getAvailable.bind(models);
    vi.spyOn(models, "getAvailable").mockImplementation(async (...args) => {
      availabilityStarted.resolve();
      await releaseAvailability.promise;
      return getAvailable(...args);
    });
    const handle = await createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models,
    }).startSession(attachment.spec);

    const selected = handle.selectModel({
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      reasoningLevel: "high",
    });
    await availabilityStarted.promise;
    await handle.close();
    releaseAvailability.resolve();

    await expect(selected).resolves.toMatchObject({ kind: "rejected", reason: "closed" });
  });

  it("fails attachment when the model is not in the runtime catalog", async () => {
    const { spec, observations, sessionDataDir } = fixture({
      model: { providerId: PROVIDER_ID, modelId: "claude-not-a-model", reasoningLevel: "medium" },
    });
    const runtime = createPiAgentRuntime({
      sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
    });

    await expect(runtime.startSession(spec)).rejects.toThrow(
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
    const handle = await runtime.startSession(spec);

    await handle.submitUserMessage("go");

    expect(kinds(observations)).toEqual([
      "attachment:started",
      "turn:started",
      "attention",
      "turn:interrupted",
    ]);
    expect(observations[2]).toMatchObject({
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
    const handle = await runtime.startSession(spec);

    await handle.submitUserMessage("go");

    expect(observations.filter((observation) => observation.kind === "attention")).toEqual([
      expect.objectContaining({
        kind: "attention",
        state: "raised",
        reason: "runtime-failure",
        message: "malformed provider payload",
      }),
    ]);
    await handle.close();
  });

  it("rejects retry when the attachment is closed, busy, or has no failed turn", async () => {
    const idle = fixture();
    const idleRuntime = createPiAgentRuntime({
      sessionDataDir: idle.sessionDataDir,
      models: modelsWithStream(scriptedStream([])),
    });
    const idleHandle = await idleRuntime.startSession(idle.spec);
    await expect(idleHandle.retry()).resolves.toMatchObject({
      kind: "rejected",
      reason: "retry-unavailable",
    });
    await idleHandle.close();
    await expect(idleHandle.retry()).resolves.toMatchObject({ kind: "rejected", reason: "closed" });

    const busy = fixture();
    const streaming = Promise.withResolvers<void>();
    const busyRuntime = createPiAgentRuntime({
      sessionDataDir: busy.sessionDataDir,
      models: modelsWithStream(scriptedStream([haltOnAbort("working", streaming.resolve)])),
    });
    const busyHandle = await busyRuntime.startSession(busy.spec);
    const delivery = busyHandle.submitUserMessage("start");
    await streaming.promise;
    await expect(busyHandle.retry()).resolves.toMatchObject({
      kind: "rejected",
      reason: "busy-unsupported",
    });
    await busyHandle.interrupt();
    await delivery;
    await busyHandle.close();
  });

  it("propagates a durable observation failure from retry", async () => {
    const attachment = fixture();
    let failRetryCommit = false;
    attachment.spec.observer = async (observation) => {
      attachment.observations.push(observation);
      if (failRetryCommit && observation.kind === "message-settled") {
        failRetryCommit = false;
        throw new Error("retry commit failed");
      }
    };
    const runtime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(
        scriptedStream([
          (emit) => emit.fail("invalid api key"),
          (emit) => {
            emit.text("authenticated");
            emit.finish();
          },
        ]),
      ),
    });
    const handle = await runtime.startSession(attachment.spec);
    await handle.submitUserMessage("start");
    failRetryCommit = true;

    await expect(handle.retry()).rejects.toThrow("retry commit failed");
    await handle.close();
  });

  it("durably clears runtime attention only after a successful retry", async () => {
    const { spec, observations, sessionDataDir } = fixture();
    const runtime = createPiAgentRuntime({
      sessionDataDir,
      models: modelsWithStream(
        scriptedStream([
          (emit) => emit.fail("invalid x-api-key secret-token"),
          (emit) => {
            emit.text("authenticated now");
            emit.finish();
          },
        ]),
      ),
    });
    const handle = await runtime.startSession(spec);
    await handle.submitUserMessage("first");
    expect(observations.filter((observation) => observation.kind === "attention")).toHaveLength(1);

    await expect(handle.retry()).resolves.toEqual({ kind: "delivered", delivery: "retry" });

    expect(observations.filter((observation) => observation.kind === "attention")).toEqual([
      expect.objectContaining({ kind: "attention", state: "raised", reason: "auth" }),
      expect.objectContaining({ kind: "attention", state: "cleared", reason: "auth" }),
    ]);
    expect(kinds(observations).slice(-3)).toEqual([
      "message-settled",
      "attention",
      "turn:completed",
    ]);
    expect(
      (await handle.reconcile(null)).observations.filter(
        (observation) => observation.kind === "attention",
      ),
    ).toEqual(observations.filter((observation) => observation.kind === "attention"));
    await handle.close();
  });

  it("retries a recovered failed turn and clears its durable attention", async () => {
    const attachment = fixture();
    const firstRuntime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(scriptedStream([(emit) => emit.fail("invalid api key")])),
    });
    const firstHandle = await firstRuntime.startSession(attachment.spec);
    await firstHandle.submitUserMessage("authenticate this request");
    const recovery = firstHandle.recovery;
    await firstHandle.close();

    let recoveredContext: Context | undefined;
    const secondRuntime = createPiAgentRuntime({
      sessionDataDir: attachment.sessionDataDir,
      models: modelsWithStream(
        scriptedStream([
          (emit, context) => {
            recoveredContext = context;
            emit.text("recovered successfully");
            emit.finish();
          },
        ]),
      ),
    });
    const secondHandle = await secondRuntime.startSession({ ...attachment.spec, recovery });

    await expect(secondHandle.retry()).resolves.toEqual({ kind: "delivered", delivery: "retry" });
    expect(JSON.stringify(recoveredContext?.messages)).toContain("authenticate this request");
    expect(
      attachment.observations.filter((observation) => observation.kind === "attention"),
    ).toEqual([
      expect.objectContaining({ state: "raised", reason: "auth" }),
      expect.objectContaining({ state: "cleared", reason: "auth" }),
    ]);
    await secondHandle.close();
  });

  it("raises attention when production provider wiring has no credentials", async () => {
    // No injected model collection: this is the production wiring. The Pi
    // Agent represents provider refusal as a failed assistant turn.
    const { spec, observations, sessionDataDir } = fixture();
    const runtime = createPiAgentRuntime({ sessionDataDir });
    const handle = await runtime.startSession(spec);

    await expect(handle.submitUserMessage("go")).resolves.toEqual({
      kind: "delivered",
      delivery: "prompt",
    });

    expect(observations.filter((observation) => observation.kind === "attention")).toEqual([
      expect.objectContaining({
        kind: "attention",
        state: "raised",
        reason: "auth",
        message: expect.any(String),
      }),
    ]);
    await handle.close();
  });
});
