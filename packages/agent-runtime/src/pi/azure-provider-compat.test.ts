import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeContext,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { azureProvider } from "@earendil-works/pi-ai/providers/azure";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { withDurableAzureProvider } from "./azure-provider-compat";
import { PiFileModelsStore } from "./model-catalog";
import { piModelsFilePath, piOwnedModelAccess, type PiModelAccess } from "./models";

const PROVIDER = "azure-openai-responses";
const ENDPOINT = "https://volli-test.openai.azure.com";
const credential = {
  type: "api_key",
  key: "test-key-not-a-credential",
  env: {
    AZURE_OPENAI_BASE_URL: ENDPOINT,
    AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5=deployment-five",
  },
};
const dirs: string[] = [];

function profile(contents = JSON.stringify({ [PROVIDER]: credential })): string {
  const dir = mkdtempSync(join(tmpdir(), "volli-azure-compat-"));
  dirs.push(dir);
  writeFileSync(join(dir, "auth.json"), contents);
  return dir;
}

async function access(agentDir = profile()): Promise<PiModelAccess> {
  const value = piOwnedModelAccess({ agentDir });
  await value.catalogReady;
  return value;
}

function modelOf(value: PiModelAccess, id = "gpt-5"): Model<Api> {
  const model = value.models.getModel(PROVIDER, id);
  if (model === undefined) throw new Error(`Missing test model ${id}`);
  return model;
}

const oldReasoning = {
  type: "reasoning",
  id: "rs_old",
  summary: [{ type: "summary_text", text: "Old reasoning" }],
  encrypted_content: "opaque-old-signature",
};
const newReasoning = { ...oldReasoning, id: "rs_new", encrypted_content: "opaque-new-signature" };
const newCall = {
  type: "function_call",
  id: "fc_new",
  call_id: "call_new",
  name: "lookup",
  arguments: '{"query":"new"}',
  status: "completed",
};
const newText = {
  type: "message",
  id: "msg_new",
  role: "assistant",
  content: [{ type: "output_text", text: "Done", annotations: [] }],
  status: "completed",
};

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    api: "azure-openai-responses",
    provider: PROVIDER,
    model: "gpt-5",
    content: [
      {
        type: "thinking",
        thinking: "Old reasoning",
        thinkingSignature: JSON.stringify(oldReasoning),
      },
      { type: "toolCall", id: "call_old|fc_old", name: "lookup", arguments: { query: "old" } },
    ],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
    ...overrides,
  };
}

function history(message = assistant()): Context {
  return {
    tools: [
      {
        name: "lookup",
        description: "Look up a query",
        parameters: { type: "object", properties: {} },
      },
    ],
    messages: [
      { role: "user", content: "Look it up", timestamp: 0 },
      message,
      {
        role: "toolResult",
        toolCallId: "call_old|fc_old",
        toolName: "lookup",
        content: [{ type: "text", text: "old result" }],
        isError: false,
        timestamp: 2,
      },
    ],
  };
}

function response(): Response {
  const events = [
    { type: "response.created", response: { id: "resp_new" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...newReasoning, encrypted_content: undefined },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...newReasoning, encrypted_content: undefined },
    },
    { type: "response.output_item.added", output_index: 1, item: { ...newCall, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: newCall.arguments },
    { type: "response.output_item.done", output_index: 1, item: newCall },
    { type: "response.output_item.added", output_index: 2, item: { ...newText, content: [] } },
    { type: "response.output_text.delta", output_index: 2, delta: "Done" },
    { type: "response.output_item.done", output_index: 2, item: newText },
    {
      type: "response.completed",
      response: {
        id: "resp_new",
        status: "completed",
        output: [newReasoning, newCall, newText],
        usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
      },
    },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

interface ResponsesPayload {
  model: string;
  input: Record<string, unknown>[];
}

function transport() {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return response();
  };
  const payload = async (index = 0): Promise<ResponsesPayload> =>
    JSON.parse(await requests[index]!.text()) as ResponsesPayload;
  return { fetch, requests, payload };
}

function eventMessage(event: AssistantMessageEvent): AssistantMessage {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  return event.partial;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Azure durable provider identity", () => {
  it("uses existing credentials and selections without introducing a second provider or rewriting auth", async () => {
    const agentDir = profile();
    const before = readFileSync(join(agentDir, "auth.json"), "utf8");
    const value = await access(agentDir);
    const selection = JSON.parse('{"providerId":"azure-openai-responses","modelId":"gpt-5"}') as {
      providerId: string;
      modelId: string;
    };
    const selected = value.models.getModel(selection.providerId, selection.modelId);
    expect(selected).toMatchObject({
      provider: PROVIDER,
      id: "gpt-5",
      api: "azure-openai-responses",
    });
    await expect(value.models.checkAuth(PROVIDER)).resolves.toEqual({
      type: "api_key",
      source: "stored credential",
    });
    expect(await value.models.getAvailable(PROVIDER)).toContainEqual(selected);
    expect(
      value.models
        .getProviders()
        .filter((provider) => [PROVIDER, "azure"].includes(provider.id))
        .map((provider) => provider.id),
    ).toEqual([PROVIDER]);
    expect(value.models.getAllModels(PROVIDER).every((model) => model.provider === PROVIDER)).toBe(
      true,
    );
    expect(value.models.getProvider("azure")).toBeUndefined();
    expect(value.models.getModel("azure", "gpt-5")).toBeUndefined();
    expect(await value.credentials.list()).toEqual([{ providerId: PROVIDER, type: "api_key" }]);
    expect(readFileSync(join(agentDir, "auth.json"), "utf8")).toBe(before);
  });

  it("stores new sign-ins under the id an older build already knows", async () => {
    const agentDir = profile("{}");
    const value = await access(agentDir);
    await value.models.login(PROVIDER, "api_key", {
      signal: new AbortController().signal,
      prompt: async () => "new-test-key",
      notify: () => undefined,
    });
    expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))).toEqual({
      [PROVIDER]: { type: "api_key", key: "new-test-key" },
    });
    await value.models.logout(PROVIDER);
    expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))).toEqual({});
  });

  it("restores an old provider-keyed catalog without rewriting it or bypassing admission", async () => {
    const agentDir = profile();
    const first = await access(agentDir);
    const baseline = modelOf(first);
    const added = { ...baseline, id: "persisted-only-azure-model", __volliProtocolAdmission: 2 };
    await new PiFileModelsStore(piModelsFilePath({ agentDir })).write(PROVIDER, {
      models: [
        { ...baseline, name: "Persisted name", baseUrl: "https://untrusted.invalid" },
        added,
        { ...added, id: "rejected-redirect", baseUrl: "https://untrusted.invalid" },
      ],
      checkedAt: 1,
      __volliCatalogFormat: 2,
    } as Parameters<PiFileModelsStore["write"]>[1]);
    const before = readFileSync(piModelsFilePath({ agentDir }), "utf8");
    const restarted = await access(agentDir);
    expect(modelOf(restarted)).toMatchObject({
      provider: PROVIDER,
      name: "Persisted name",
      baseUrl: "",
      api: baseline.api,
    });
    expect(modelOf(restarted, added.id)).toMatchObject({ provider: PROVIDER, api: baseline.api });
    expect(restarted.models.getModel(PROVIDER, "rejected-redirect")).toBeUndefined();
    expect(readFileSync(piModelsFilePath({ agentDir }), "utf8")).toBe(before);
  });

  it("reads Pi's renamed feed through the unchanged protocol guard and persists only the durable id", async () => {
    const requested: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      requested.push(String(input));
      return new Response(
        JSON.stringify({
          "feed-responses": { ...modelOf(value), id: "feed-responses", provider: "azure" },
          "feed-completions": {
            ...modelOf(value, "deepseek-v4-pro"),
            id: "feed-completions",
            provider: "azure",
          },
          redirected: {
            ...modelOf(value),
            id: "redirected",
            provider: "azure",
            baseUrl: "https://untrusted.invalid",
          },
          "foreign-api": {
            ...modelOf(value),
            id: "foreign-api",
            provider: "azure",
            api: "anthropic-messages",
          },
          "foreign-provider": { ...modelOf(value), id: "foreign-provider", provider: "anthropic" },
        }),
      );
    };
    vi.stubGlobal("fetch", fetchFn);
    const agentDir = profile();
    const value = await access(agentDir);
    const result = await value.catalogs.refresh({ providers: [PROVIDER], force: true });
    expect(result.errors.size).toBe(0);
    expect(result.refreshedProviderIds).toEqual([PROVIDER]);
    expect(result.rejectedByProvider.get(PROVIDER)).toBe(3);
    expect(requested).toEqual(["https://pi.dev/api/models/providers/azure"]);
    expect(modelOf(value, "feed-responses")).toMatchObject({
      provider: PROVIDER,
      api: "azure-openai-responses",
    });
    expect(modelOf(value, "feed-completions")).toMatchObject({
      provider: PROVIDER,
      api: "openai-completions",
    });
    expect(value.models.getModel(PROVIDER, "redirected")).toBeUndefined();
    const stored = JSON.parse(readFileSync(piModelsFilePath({ agentDir }), "utf8")) as Record<
      string,
      { models: Model<Api>[] }
    >;
    expect(Object.keys(stored)).toEqual([PROVIDER]);
    expect(stored[PROVIDER]!.models.every((model) => model.provider === PROVIDER)).toBe(true);
    const restarted = await access(agentDir);
    expect(modelOf(restarted, "feed-responses").provider).toBe(PROVIDER);
    expect(modelOf(restarted, "feed-completions").provider).toBe(PROVIDER);
    expect(requested).toHaveLength(1);
    // Other feeds still use their own identity; the Azure translation is not
    // an aliasing layer over every provider or a bypass around the parser.
    await value.catalogs.refresh({ providers: ["opencode-go"], force: true });
    expect(requested[1]).toBe("https://pi.dev/api/models/providers/opencode-go");
  });

  it("preserves provider defaults when called without Models' resolved options", async () => {
    const wrapped = withDurableAzureProvider({ ...azureProvider(), getAllModels: undefined });
    const baseline = wrapped.getModels();
    expect(wrapped.getAllModels?.()).toEqual(baseline);
    const selected = baseline.find((model) => model.id === "gpt-5");
    if (selected === undefined) throw new Error("Missing test model");
    for (const method of ["stream", "streamSimple"] as const) {
      const result = await wrapped[method](selected, normalizeContext(history())).result();
      expect(result).toMatchObject({ provider: PROVIDER, stopReason: "error" });
      expect(result.errorMessage).toContain("No API key");
    }
  });

  it.each(["stream", "streamSimple"] as const)(
    "replays old signatures and tool ids through Models.%s and emits the N-1 provider id on every frame",
    async (method) => {
      const value = await access();
      const model = modelOf(value);
      const capture = transport();
      const context = history();
      const before = JSON.stringify(context);
      const callbackProviders: string[] = [];
      const options = {
        fetch: capture.fetch,
        maxRetries: 0,
        onPayload: (_payload: unknown, callbackModel: Model<Api>) => {
          callbackProviders.push(callbackModel.provider);
        },
        onResponse: (_response: unknown, callbackModel: Model<Api>) => {
          callbackProviders.push(callbackModel.provider);
        },
        onProviderStreamEvent: (_event: unknown, callbackModel: Model<Api>) => {
          callbackProviders.push(callbackModel.provider);
        },
      };
      const stream = value.models[method](model, context, options);
      const events: AssistantMessageEvent[] = [];
      for await (const event of stream) events.push(event);
      const result = await stream.result();
      expect(result.stopReason, result.errorMessage).toBe("toolUse");
      expect(capture.requests[0]!.url).toBe(`${ENDPOINT}/openai/v1/responses?api-version=v1`);
      expect(capture.requests[0]!.headers.get("api-key")).toBe(credential.key);
      const payload = await capture.payload();
      expect(payload.model).toBe("deployment-five");
      expect(payload.input).toContainEqual(oldReasoning);
      expect(payload.input).toContainEqual(
        expect.objectContaining({ type: "function_call", call_id: "call_old", id: "fc_old" }),
      );
      expect(payload.input).toContainEqual(
        expect.objectContaining({ type: "function_call_output", call_id: "call_old" }),
      );
      expect(callbackProviders.length).toBeGreaterThan(2);
      expect(callbackProviders.every((provider) => provider === PROVIDER)).toBe(true);
      expect(events.map((event) => event.type)).toContain("toolcall_end");
      expect(events.map((event) => event.type)).toContain("thinking_end");
      expect(events.every((event) => eventMessage(event).provider === PROVIDER)).toBe(true);
      expect(eventMessage(events[0]!)).toBe(result);
      expect(result).toMatchObject({
        provider: PROVIDER,
        api: "azure-openai-responses",
        model: "gpt-5",
        responseId: "resp_new",
        usage: { input: 9, output: 4, totalTokens: 13 },
      });
      expect(result.content).toContainEqual(
        expect.objectContaining({ type: "toolCall", id: "call_new|fc_new" }),
      );
      expect(result.content).toContainEqual(
        expect.objectContaining({
          type: "thinking",
          thinkingSignature: JSON.stringify(newReasoning),
        }),
      );
      expect(JSON.stringify(context)).toBe(before);
      expect(model.provider).toBe(PROVIDER);

      // This is what the transcript writer persists and an older build reads:
      // no native provider id, and unchanged opaque reasoning / composite ids.
      const persisted = JSON.parse(JSON.stringify(result)) as AssistantMessage;
      const next = history(persisted);
      next.messages[2] = {
        role: "toolResult",
        toolCallId: "call_new|fc_new",
        toolName: "lookup",
        content: [{ type: "text", text: "new result" }],
        isError: false,
        timestamp: 3,
      };
      await value.models.complete(model, next, { fetch: capture.fetch, maxRetries: 0 });
      const replayed = await capture.payload(1);
      expect(replayed.input).toContainEqual(newReasoning);
      expect(replayed.input).toContainEqual(
        expect.objectContaining({ type: "function_call", call_id: "call_new", id: "fc_new" }),
      );
      expect(replayed.input).toContainEqual(
        expect.objectContaining({ type: "function_call_output", call_id: "call_new" }),
      );
    },
  );

  it.each([{ model: "gpt-4.1" }, { provider: "openai", api: "openai-responses" }])(
    "keeps tool-result pairing but discards foreign reasoning on replay: %j",
    async (source) => {
      const value = await access();
      const capture = transport();
      const context = history(assistant(source));
      const before = JSON.stringify(context);
      const result = await value.models.complete(modelOf(value), context, {
        fetch: capture.fetch,
        maxRetries: 0,
      });
      expect(result.stopReason, result.errorMessage).toBe("toolUse");
      const payload = await capture.payload();
      expect(payload.input.some((item) => item.type === "reasoning")).toBe(false);
      expect(payload.input).toContainEqual(
        expect.objectContaining({ type: "function_call", call_id: "call_old" }),
      );
      expect(payload.input).toContainEqual(
        expect.objectContaining({ type: "function_call_output", call_id: "call_old" }),
      );
      expect(JSON.stringify(context)).toBe(before);
    },
  );

  it("keeps the durable identity on a real HTTP failure and on native dispatch errors", async () => {
    const value = await access();
    const failure = new Response(JSON.stringify({ error: { message: "Test rejection" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
    const fetchFn: typeof fetch = async () => failure;
    const result = await value.models.complete(modelOf(value), history(), {
      fetch: fetchFn,
      maxRetries: 0,
    });
    expect(result).toMatchObject({ provider: PROVIDER, stopReason: "error" });
    expect(result.errorMessage).toContain("Test rejection");
    const unsupportedModel: Model<Api> = { ...modelOf(value), api: "unsupported-test-api" };
    const unsupported = await value.models.complete(unsupportedModel, history(), { maxRetries: 0 });
    expect(unsupported).toMatchObject({ provider: PROVIDER, stopReason: "error" });
  });

  it("dispatches Azure's new completions API without changing its persisted provider id", async () => {
    const value = await access();
    const requests: Request[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(
        `data: ${JSON.stringify({ id: "chat_test", choices: [{ index: 0, delta: { content: "Done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const result = await value.models.completeSimple(
      modelOf(value, "deepseek-v4-pro"),
      { messages: [{ role: "user", content: "Hi", timestamp: 0 }] },
      { fetch: fetchFn, maxRetries: 0 },
    );
    expect(result).toMatchObject({
      provider: PROVIDER,
      api: "openai-completions",
      model: "deepseek-v4-pro",
      stopReason: "stop",
    });
    expect(requests[0]!.url).toBe(`${ENDPOINT}/openai/v1/chat/completions`);
    expect((JSON.parse(await requests[0]!.text()) as { model: string }).model).toBe(
      "deepseek-v4-pro",
    );
  });
});
