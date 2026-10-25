import type { GatewayUsageRecord } from "@volli/shared/cloud";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { createDevSealingKey, signJws } from "../scripts/dev-credentials.ts";
import {
  CALL_ID,
  CONN,
  PROVIDER_KEY,
  SESSION,
  batch,
  context,
  fixture,
  grant,
  route,
  sse,
  streamOf,
  type Fixture,
} from "../test/support.ts";
import { fromBase64Url } from "./bytes.ts";
import type { GatewayEnv } from "./env.ts";
import { createGateway } from "./gateway.ts";

const GATEWAY = "https://gateway.volli.test";

type Upstream = (url: string, init: RequestInit) => Response | Promise<Response>;

interface Harness {
  f: Fixture;
  env: GatewayEnv;
  records: GatewayUsageRecord[];
  calls: { url: string; init: RequestInit; body: string | undefined }[];
  call(path: string, init?: RequestInit & { grant?: string | null }): Promise<Response>;
  settled(): Promise<unknown>;
}

async function harness(upstream: Upstream, env: Partial<GatewayEnv> = {}): Promise<Harness> {
  const f = await fixture();
  const records: GatewayUsageRecord[] = [];
  const calls: Harness["calls"] = [];
  const ctx = context();
  const fullEnv: GatewayEnv = {
    ...f.env,
    USAGE_QUEUE: {
      send: async (record) => {
        records.push(record);
      },
    },
    ...env,
  };
  const gateway = createGateway({
    fetch: async (input, init = {}) => {
      const url = String(input);
      const body = init.body === undefined ? undefined : await new Response(init.body).text();
      calls.push({ url, init, body });
      return upstream(url, init);
    },
    now: () => Date.now(),
  });
  return {
    f,
    env: fullEnv,
    records,
    calls,
    async call(path, init = {}) {
      const { grant: presented, headers, ...rest } = init;
      const token = presented === undefined ? await grant(f) : presented;
      const request = new Request(`${GATEWAY}${path}`, {
        method: "POST",
        ...rest,
        headers: {
          ...(token === null ? {} : { "x-api-key": token }),
          "x-volli-call-id": CALL_ID,
          ...(headers as Record<string, string> | undefined),
        },
      });
      return gateway.fetch(request, fullEnv, ctx);
    },
    settled: () => ctx.settled(),
  };
}

const anthropicStream = sse([
  {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        model: "claude-sonnet-4-5-20250929",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 3000,
          output_tokens: 1,
        },
      },
    },
  },
  {
    event: "content_block_delta",
    data: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
  },
  {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 12 },
    },
  },
  { event: "message_stop", data: { type: "message_stop" } },
]);

const eventStream = (body: string, init: ResponseInit = {}) =>
  new Response(streamOf([body.slice(0, 50), body.slice(50)]), {
    ...init,
    headers: {
      "content-type": "text/event-stream",
      "request-id": "req_1",
      "content-encoding": "identity",
      ...init.headers,
    },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("relaying", () => {
  test("an Anthropic stream: real key in, grant out, bytes unchanged, usage metered", async () => {
    const h = await harness(() => eventStream(anthropicStream));
    const requestBody = JSON.stringify({ model: "claude-sonnet-4-5", stream: true, messages: [] });
    const response = await h.call(`/v1/c/${CONN}/v1/messages?beta=true`, {
      body: requestBody,
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        cookie: "c=1",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-volli-call-id")).toBe(CALL_ID);
    expect(response.headers.get("request-id")).toBe("req_1");
    expect(response.headers.has("content-encoding")).toBe(false);
    expect(await response.text()).toBe(anthropicStream);

    const [upstream] = h.calls;
    expect(upstream!.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(upstream!.body).toBe(requestBody);
    expect(upstream!.init.redirect).toBe("manual");
    const sent = Object.fromEntries(new Headers(upstream!.init.headers));
    expect(sent).toEqual({
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": PROVIDER_KEY,
    });

    await h.settled();
    expect(h.records).toEqual([
      {
        recordId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        callId: CALL_ID,
        grantJti: expect.any(String),
        workspaceId: "9e2b5d8a-4c7f-4b13-a6e9-0f3c8d1b5a27",
        projectId: "1c5e8a2d-6b9f-4d37-8e1a-3f7c0b4d9e62",
        userId: "4a9d2c7e-1f6b-4e05-9c38-5b7e0a1d3f86",
        sessionId: SESSION,
        runnerId: "8c3e1f5a-7b2d-4a96-8e0c-1d4f6b9a2c75",
        connectionId: CONN,
        keyVersion: 3,
        providerId: "anthropic",
        api: "anthropic-messages",
        modelId: "claude-sonnet-4-5-20250929",
        usage: { input: 10, output: 12, cacheRead: 3000, cacheWrite: 20 },
        status: "completed",
        upstreamStatus: 200,
        startedAt: expect.any(Number),
        ttftMs: expect.any(Number),
        durationMs: expect.any(Number),
      },
    ]);
  });

  test("an OpenAI Responses stream, with the grant as a bearer token", async () => {
    const body = sse([
      {
        event: "response.created",
        data: { type: "response.created", response: { model: "gpt-5" } },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            model: "gpt-5",
            usage: {
              input_tokens: 50,
              input_tokens_details: { cached_tokens: 40 },
              output_tokens: 5,
            },
          },
        },
      },
    ]);
    const h = await harness(() => eventStream(body));
    const token = await grant(await fixture(), {
      routes: [
        route({
          providerId: "openai",
          upstream: "https://api.openai.com/v1",
          api: "openai-responses",
        }),
      ],
    });
    const response = await h.call(`/v1/c/${CONN}/responses`, {
      grant: null,
      headers: { authorization: `Bearer ${token}`, "x-goog-api-key": "ignored" },
      body: "{}",
    });
    expect(await response.text()).toBe(body);
    expect(h.calls[0]!.url).toBe("https://api.openai.com/v1/responses");
    const sent = new Headers(h.calls[0]!.init.headers);
    expect(sent.get("authorization")).toBe(`Bearer ${PROVIDER_KEY}`);
    expect(sent.has("x-goog-api-key")).toBe(false);
    await h.settled();
    expect(h.records[0]).toMatchObject({
      providerId: "openai",
      usage: { input: 10, cacheRead: 40, output: 5 },
      status: "completed",
    });
  });

  test("an OpenRouter chat stream: usage requested, attribution headers sent, model from the request", async () => {
    const body = sse([
      { data: { choices: [{ delta: { content: "x" } }] } },
      { data: { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, cost: 0.001 } } },
      { data: "[DONE]" },
    ]);
    const h = await harness(() => eventStream(body));
    const token = await grant(await fixture(), {
      routes: [
        route({
          providerId: "openrouter",
          upstream: "https://openrouter.ai/api/v1",
          api: "openai-completions",
          headers: {
            "http-referer": "https://volli.app",
            "x-title": "Volli",
            authorization: "Bearer smuggled",
          },
        }),
      ],
    });
    const response = await h.call(`/v1/c/${CONN}/chat/completions`, {
      grant: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-sonnet-4.5", stream: true }),
    });
    expect(await response.text()).toBe(body);
    const sent = new Headers(h.calls[0]!.init.headers);
    expect(sent.get("http-referer")).toBe("https://volli.app");
    expect(sent.get("x-title")).toBe("Volli");
    expect(sent.get("authorization")).toBe(`Bearer ${PROVIDER_KEY}`);
    expect(JSON.parse(h.calls[0]!.body!)).toEqual({
      model: "anthropic/claude-sonnet-4.5",
      stream: true,
      stream_options: { include_usage: true },
    });
    await h.settled();
    expect(h.records[0]).toMatchObject({
      modelId: "anthropic/claude-sonnet-4.5",
      usage: { input: 8, output: 2, upstreamCostUsd: 0.001 },
      status: "completed",
    });
  });

  test("a chat request that is not JSON, or has no model, is forwarded as it came", async () => {
    const h = await harness(() => Response.json({ choices: [] }));
    const token = await grant(await fixture(), {
      routes: [route({ api: "openai-completions", upstream: "https://api.openai.com/v1" })],
    });
    const send = async (init: RequestInit) =>
      (await h.call(`/v1/c/${CONN}/chat/completions`, { grant: token, ...init })).text();
    await send({ headers: { "content-type": "application/json" }, body: "{" });
    expect(h.calls[0]!.body).toBe("{");
    await send({ headers: { "content-type": "application/json" }, body: '{"stream":false}' });
    expect(h.calls[1]!.body).toBe('{"stream":false}');
    await h.settled();
    expect(h.records.map((record) => record.modelId)).toEqual([undefined, undefined]);
    expect(h.records.map((record) => record.status)).toEqual(["partial", "partial"]);
    expect(new Set(h.records.map((record) => record.recordId)).size).toBe(2);
  });

  test("a mislabelled chat stream is still asked for its usage", async () => {
    const h = await harness(() => Response.json({}));
    const token = await grant(await fixture(), {
      routes: [route({ api: "openai-completions", upstream: "https://api.openai.com/v1" })],
    });
    await (
      await h.call(`/v1/c/${CONN}/chat/completions`, {
        grant: token,
        headers: { "content-type": "text/plain" },
        body: '{"model":"m","stream":true}',
      })
    ).text();
    expect(JSON.parse(h.calls[0]!.body!)).toEqual({
      model: "m",
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  test("a non-streaming JSON answer is metered at its end", async () => {
    const h = await harness(() =>
      Response.json({ model: "claude-haiku-4-5", usage: { input_tokens: 3, output_tokens: 4 } }),
    );
    const response = await h.call(`/v1/c/${CONN}/v1/messages`, { body: "{}" });
    expect(await response.json()).toMatchObject({ model: "claude-haiku-4-5" });
    await h.settled();
    expect(h.records[0]).toMatchObject({ usage: { input: 3, output: 4 }, status: "completed" });
  });

  test("a GET (a model list) is relayed without a body", async () => {
    const h = await harness(() => Response.json({ data: [] }));
    const response = await h.call(`/v1/c/${CONN}/v1/models`, { method: "GET" });
    expect(response.status).toBe(200);
    expect(h.calls[0]!.init.method).toBe("GET");
    expect(h.calls[0]!.body).toBeUndefined();
  });

  test("an untyped body under a base path relays, and a grant without a project omits it", async () => {
    const h = await harness(() => new Response(streamOf(["raw"])));
    const token = await grant(await fixture(), {
      routes: [route({ upstream: "https://llm.team.example/anthropic" })],
      claims: { prj: undefined },
    });
    const response = await h.call(`/v1/c/${CONN}/v1/models`, { method: "GET", grant: token });
    expect(await response.text()).toBe("raw");
    expect(h.calls[0]!.url).toBe("https://llm.team.example/anthropic/v1/models");
    await h.settled();
    expect(h.records[0]).not.toHaveProperty("projectId");
    expect(h.records[0]).toMatchObject({ status: "partial", usage: {} });
  });

  test("a provider error passes through with its status and headers, metered as an upstream error", async () => {
    const h = await harness(
      () =>
        new Response('{"type":"error","error":{"type":"rate_limit_error"}}', {
          status: 429,
          headers: { "retry-after": "7", "content-type": "application/json" },
        }),
    );
    const response = await h.call(`/v1/c/${CONN}/v1/messages`, { body: "{}" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(await response.text()).toContain("rate_limit_error");
    await h.settled();
    expect(h.records[0]).toMatchObject({ status: "upstream-error", upstreamStatus: 429 });
  });

  test("an answer with no body is relayed as is", async () => {
    const h = await harness(() => new Response(null, { status: 204, headers: { "x-thing": "1" } }));
    const response = await h.call(`/v1/c/${CONN}/v1/messages`, { body: "{}" });
    expect(response.status).toBe(204);
    expect(response.headers.get("x-thing")).toBe("1");
    await h.settled();
    expect(h.records[0]).toMatchObject({ status: "partial", upstreamStatus: 204 });
  });

  test("a runner that stops mid-stream cancels the provider and is metered as partial", async () => {
    const cancel = vi.fn();
    const h = await harness(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  anthropicStream.slice(0, anthropicStream.indexOf("event: message_delta")),
                ),
              );
            },
            cancel,
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const response = await h.call(`/v1/c/${CONN}/v1/messages`, { body: "{}" });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancel).toHaveBeenCalled();
    await h.settled();
    expect(h.records[0]).toMatchObject({
      status: "partial",
      usage: { input: 10, output: 1, cacheRead: 3000, cacheWrite: 20 },
    });
  });
});

const never: Upstream = () => {
  throw new Error("must not be forwarded");
};

async function expectRefusal(response: Response, code: string, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("x-volli-error")).toBe(code);
  const body = (await response.json()) as {
    type: string;
    error: { type: string; code: string; message: string };
  };
  expect(body.type).toBe("error");
  expect(body.error.type).toBe(code);
  expect(body.error.code).toBe(code);
  expect(body.error.message).not.toContain(PROVIDER_KEY);
}

describe("refusals", () => {
  test("health answers without a grant", async () => {
    const h = await harness(never);
    expect(await (await h.call("/healthz", { method: "GET", grant: null })).json()).toEqual({
      ok: true,
    });
  });

  test.each([
    ["/", "POST"],
    ["/healthz", "POST"],
    ["/v1/c/not-a-uuid/v1/messages", "POST"],
    [`/v1/c/${CONN.toUpperCase()}/v1/messages`, "POST"],
    // Endpoints a key reaches beyond model calls are never relayed.
    [`/v1/c/${CONN}`, "GET"],
    [`/v1/c/${CONN}/v1/files`, "GET"],
    [`/v1/c/${CONN}/v1/messages/batches`, "POST"],
    [`/v1/c/${CONN}/v1/messages/`, "POST"],
  ])("volli_route_not_found for %s", async (path, method) => {
    const h = await harness(never);
    await expectRefusal(await h.call(path, { method }), "volli_route_not_found", 404);
  });

  test("volli_method_not_allowed, for an unrelayed method or the wrong one for the endpoint", async () => {
    const h = await harness(never);
    await expectRefusal(
      await h.call(`/v1/c/${CONN}/v1/messages`, { method: "GET" }),
      "volli_method_not_allowed",
      405,
    );
    await expectRefusal(
      await h.call(`/v1/c/${CONN}/v1/messages`, { method: "DELETE" }),
      "volli_method_not_allowed",
      405,
    );
  });

  test("volli_grant_missing, including a non-bearer authorization", async () => {
    const h = await harness(never);
    await expectRefusal(
      await h.call(`/v1/c/${CONN}/v1/messages`, { grant: null }),
      "volli_grant_missing",
      401,
    );
    await expectRefusal(
      await h.call(`/v1/c/${CONN}/v1/messages`, {
        grant: null,
        headers: { authorization: "Basic abc" },
      }),
      "volli_grant_missing",
      401,
    );
  });

  test("volli_grant_invalid", async () => {
    const h = await harness(never);
    await expectRefusal(
      await h.call(`/v1/c/${CONN}/v1/messages`, { grant: "a.b.c" }),
      "volli_grant_invalid",
      401,
    );
  });

  test("volli_grant_expired", async () => {
    const h = await harness(never);
    const expired = await grant(h.f, {
      issuedAt: Math.floor(Date.now() / 1000) - 1000,
      lifetimeSeconds: 600,
    });
    await expectRefusal(
      await h.call(`/v1/c/${CONN}/v1/messages`, { grant: expired }),
      "volli_grant_expired",
      401,
    );
  });

  test("volli_grant_stale when the sealing key has rotated out", async () => {
    const h = await harness(never, {
      GATEWAY_SEALING_KEYS: (await createDevSealingKey("next")).keyring,
    });
    await expectRefusal(await h.call(`/v1/c/${CONN}/v1/messages`), "volli_grant_stale", 401);
  });

  test("volli_grant_stale when the grant's key version was retired", async () => {
    const h = await harness(never, {
      REVOCATIONS: { get: async (key) => (key === `conn:${CONN}:kv:3` ? "rotated" : null) },
    });
    await expectRefusal(await h.call(`/v1/c/${CONN}/v1/messages`), "volli_grant_stale", 401);
  });

  test.each([["grant:"], [`conn:${CONN}`]])("volli_grant_revoked by a %s entry", async (prefix) => {
    const h = await harness(never, {
      REVOCATIONS: {
        get: async (key) =>
          key.startsWith(prefix) && (prefix !== `conn:${CONN}` || key === prefix) ? "1" : null,
      },
    });
    await expectRefusal(await h.call(`/v1/c/${CONN}/v1/messages`), "volli_grant_revoked", 403);
  });

  test("an empty revocation set lets the call through", async () => {
    const h = await harness(() => Response.json({}), { REVOCATIONS: { get: async () => null } });
    expect((await h.call(`/v1/c/${CONN}/v1/messages`, { body: "{}" })).status).toBe(200);
  });

  test("volli_route_not_granted for a connection the grant does not name", async () => {
    const h = await harness(never);
    await expectRefusal(
      await h.call("/v1/c/1c5e8a2d-6b9f-4d37-8e1a-3f7c0b4d9e62/v1/messages"),
      "volli_route_not_granted",
      403,
    );
  });

  test("volli_call_id_missing", async () => {
    const h = await harness(never);
    await expectRefusal(
      await h.call(`/v1/c/${CONN}/v1/messages`, { headers: { "x-volli-call-id": "nope" } }),
      "volli_call_id_missing",
      400,
    );
  });

  test("volli_body_too_large, by declared length and by actual size", async () => {
    const h = await harness(never, { GATEWAY_MAX_BODY_BYTES: "8" });
    await expectRefusal(
      await h.call(`/v1/c/${CONN}/v1/messages`, {
        body: "123456789",
        headers: { "content-length": "9" },
      }),
      "volli_body_too_large",
      413,
    );
    await expectRefusal(
      await h.call(`/v1/c/${CONN}/v1/messages`, { body: "123456789" }),
      "volli_body_too_large",
      413,
    );
  });

  test("volli_upstream_forbidden for a private upstream", async () => {
    const h = await harness(never);
    const token = await grant(h.f, { routes: [route({ upstream: "https://10.0.0.5" })] });
    await expectRefusal(
      await h.call(`/v1/c/${CONN}/v1/messages`, { grant: token }),
      "volli_upstream_forbidden",
      400,
    );
  });

  test("a provider 403 is the provider's to explain, and passes through", async () => {
    const h = await harness(
      () => new Response('{"error":{"type":"permission_error"}}', { status: 403 }),
    );
    const response = await h.call(`/v1/c/${CONN}/v1/messages`, { body: "{}" });
    expect(response.status).toBe(403);
    expect(response.headers.has("x-volli-error")).toBe(false);
    expect(await response.text()).toContain("permission_error");
  });

  test("volli_connection_key_unreadable when the sealed key was not sealed for this connection", async () => {
    const h = await harness(never);
    // Sealed for key version 3, presented as version 4: the AAD differs.
    const f = h.f;
    const token = await grant(f);
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(token.split(".")[1]!)!)) as {
      routes: { anthropic: Record<string, unknown> };
    };
    const moved = await signJws(f.issuer, {
      ...claims,
      routes: { anthropic: { ...claims.routes.anthropic, kv: 4 } },
    });
    await expectRefusal(
      await h.call(`/v1/c/${CONN}/v1/messages`, { grant: moved }),
      "volli_connection_key_unreadable",
      500,
    );
  });

  test("errors tell the SDK whether to retry", async () => {
    const h = await harness(() => {
      throw new TypeError("fetch failed");
    });
    const transient = await h.call(`/v1/c/${CONN}/v1/messages`, { body: "{}" });
    expect(transient.headers.get("x-should-retry")).toBe("true");
    const refresh = await h.call(`/v1/c/${CONN}/v1/messages`, { grant: "a.b.c" });
    expect(refresh.headers.get("x-should-retry")).toBe("false");
  });

  test("volli_upstream_auth when the provider rejects the key, without its body", async () => {
    const h = await harness(() => new Response('{"error":"invalid x-api-key"}', { status: 401 }));
    await expectRefusal(
      await h.call(`/v1/c/${CONN}/v1/messages`, { body: "{}" }),
      "volli_upstream_auth",
      401,
    );
    await h.settled();
    expect(h.records[0]).toMatchObject({ status: "upstream-error", upstreamStatus: 401 });
  });

  test("volli_upstream_redirect: a redirect is never followed", async () => {
    const h = await harness(
      () =>
        new Response(null, { status: 307, headers: { location: "https://elsewhere.example/" } }),
    );
    const response = await h.call(`/v1/c/${CONN}/v1/messages`, { body: "{}" });
    expect(response.headers.has("location")).toBe(false);
    await expectRefusal(response, "volli_upstream_redirect", 502);
  });

  test("volli_upstream_unreachable, with nothing metered", async () => {
    const h = await harness(() => {
      throw new TypeError("fetch failed");
    });
    await expectRefusal(
      await h.call(`/v1/c/${CONN}/v1/messages`, { body: "{}" }),
      "volli_upstream_unreachable",
      502,
    );
    await h.settled();
    expect(h.records).toEqual([]);
  });

  test.each([
    ["no issuer", { GATEWAY_ISSUER: undefined }],
    ["no issuer keys", { GATEWAY_JWKS: undefined }],
    ["both an inline JWKS and a JWKS URL", { GATEWAY_JWKS_URL: "https://issuer.example/jwks" }],
    ["no sealing keys", { GATEWAY_SEALING_KEYS: undefined }],
  ])("volli_gateway_misconfigured with %s", async (_label, env) => {
    const h = await harness(never, env);
    await expectRefusal(
      await h.call(`/v1/c/${CONN}/v1/messages`),
      "volli_gateway_misconfigured",
      500,
    );
  });

  test("an unexpected failure is answered, not thrown, and names no detail", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = await harness(never, {
      REVOCATIONS: {
        get: async () => {
          throw new RangeError(`boom ${PROVIDER_KEY}`);
        },
      },
    });
    const response = await h.call(`/v1/c/${CONN}/v1/messages`);
    await expectRefusal(response, "volli_gateway_misconfigured", 500);
    expect(response.headers.get("x-volli-call-id")).toBe(CALL_ID);
    expect(error).toHaveBeenCalledWith("[volli-gateway] unexpected failure: RangeError");
    const odd = await harness(never, {
      REVOCATIONS: {
        get: async () => {
          throw "not an error";
        },
      },
    });
    await expectRefusal(
      await odd.call(`/v1/c/${CONN}/v1/messages`),
      "volli_gateway_misconfigured",
      500,
    );
    expect(error).toHaveBeenCalledWith("[volli-gateway] unexpected failure: unknown");
  });

  test("a refusal echoes a valid call id", async () => {
    const h = await harness(never);
    const response = await h.call(`/v1/c/${CONN}/v1/messages`, { grant: "a.b.c" });
    expect(response.headers.get("x-volli-call-id")).toBe(CALL_ID);
  });
});

describe("issuer keys and usage delivery", () => {
  test("a JWKS URL is fetched through the gateway's fetch and cached per configuration", async () => {
    const f = await fixture();
    let jwksFetches = 0;
    const h = await harness(
      (url) => {
        if (url === "https://issuer.example/jwks") {
          jwksFetches += 1;
          return new Response(f.issuer.jwks);
        }
        return Response.json({});
      },
      { GATEWAY_JWKS: undefined, GATEWAY_JWKS_URL: "https://issuer.example/jwks" },
    );
    expect((await h.call(`/v1/c/${CONN}/v1/messages`, { body: "{}" })).status).toBe(200);
    expect((await h.call(`/v1/c/${CONN}/v1/messages`, { body: "{}" })).status).toBe(200);
    expect(jwksFetches).toBe(1);
  });

  test("with no queue bound the call still relays and the gap is logged", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = await harness(() => Response.json({}), { USAGE_QUEUE: undefined });
    const response = await h.call(`/v1/c/${CONN}/v1/messages`, { body: "{}" });
    expect(response.status).toBe(200);
    await response.text();
    await h.settled();
    expect(error).toHaveBeenCalledWith(
      `[volli-gateway] no usage queue bound; call ${CALL_ID} is unmetered`,
    );
  });

  test("a queue send that fails is logged by call id only", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const thrown of [new TypeError("queue down"), "odd"]) {
      const h = await harness(() => Response.json({}), {
        USAGE_QUEUE: {
          send: async () => {
            throw thrown;
          },
        },
      });
      await (await h.call(`/v1/c/${CONN}/v1/messages`, { body: "{}" })).text();
      await h.settled();
    }
    expect(error).toHaveBeenCalledWith(
      `[volli-gateway] usage for call ${CALL_ID} not queued: TypeError`,
    );
    expect(error).toHaveBeenCalledWith(
      `[volli-gateway] usage for call ${CALL_ID} not queued: unknown`,
    );
  });

  test("queue() hands batches to the consumer", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const gateway = createGateway({ fetch: vi.fn(), now: () => 0 });
    const delivered = batch([{ callId: "a" }]);
    await gateway.queue(delivered, {});
    expect(delivered.acked).toBe(true);
    expect(log).toHaveBeenCalled();
  });
});
