/**
 * The contract test: the Worker exactly as wrangler bundles it for deploy,
 * running in workerd through Miniflare, with its queue and KV bindings, and
 * a fake provider and backend behind Miniflare's outbound service. No
 * Cloudflare account and no network: every outbound request lands in
 * `outbound` below.
 *
 * One call per API family proves the header strip and inject, the path
 * mapping, streaming pass-through and the usage tap; the usage record is
 * followed through the real queue to the ingest endpoint.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { GatewayUsageRecord } from "@volli/shared/cloud";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";

import { createDevSealingKey } from "../scripts/dev-credentials.ts";
import {
  CALL_ID,
  CONN,
  PROVIDER_KEY,
  fixture,
  grant,
  route,
  sse,
  type Fixture,
} from "./support.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INGEST = "https://ingest.volli.test/usage";

interface Outbound {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const outbound: Outbound[] = [];
const ingested: GatewayUsageRecord[] = [];
let respond: (request: Outbound) => Response = () => new Response("unexpected", { status: 500 });
let mf: Miniflare;
let f: Fixture;
let outdir: string;

beforeAll(async () => {
  outdir = mkdtempSync(join(tmpdir(), "volli-gateway-"));
  const wrangler = join(
    dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
    "bin/wrangler.js",
  );
  execFileSync(process.execPath, [wrangler, "deploy", "--dry-run", "--outdir", outdir], {
    cwd: root,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: "pipe",
  });
  const config = JSON.parse(readFileSync(join(root, "wrangler.json"), "utf8")) as {
    compatibility_date: string;
    compatibility_flags: string[];
    queues: { producers: { binding: string; queue: string }[]; consumers: { queue: string }[] };
    kv_namespaces: { binding: string }[];
  };
  f = await fixture();
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: [{ type: "ESModule", path: join(outdir, "index.js") }],
      // Module names are relative to this root; one that climbs out of it
      // ("../../tmp/…") makes workerd fail to start.
      modulesRoot: outdir,
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      bindings: {
        GATEWAY_ISSUER: f.issuer.issuer,
        GATEWAY_JWKS: f.issuer.jwks,
        GATEWAY_SEALING_KEYS: f.sealingKey.keyring,
        USAGE_INGEST_URL: INGEST,
        USAGE_INGEST_TOKEN: "ingest-token",
      },
      kvNamespaces: config.kv_namespaces.map(({ binding }) => binding),
      queueProducers: Object.fromEntries(
        config.queues.producers.map(({ binding, queue }) => [binding, { queueName: queue }]),
      ),
      queueConsumers: Object.fromEntries(
        config.queues.consumers.map(({ queue }) => [
          queue,
          { maxBatchSize: 1, maxBatchTimeout: 0 },
        ]),
      ),
      outboundService: async (request: Request) => {
        const seen: Outbound = {
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: await request.text(),
        };
        if (seen.url === INGEST) {
          expect(seen.headers.authorization).toBe("Bearer ingest-token");
          ingested.push(...(JSON.parse(seen.body) as { records: GatewayUsageRecord[] }).records);
          return new Response(null, { status: 204 });
        }
        outbound.push(seen);
        return respond(seen);
      },
    }),
  );
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  rmSync(outdir, { recursive: true, force: true });
});

async function relay(path: string, headers: Record<string, string>, body?: string) {
  outbound.length = 0;
  const response = await mf.dispatchFetch(`https://gateway.volli.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-volli-call-id": CALL_ID, ...headers },
    ...(body === undefined ? {} : { body }),
  });
  return { response, text: await response.text() };
}

async function ingestedFor(callCount: number): Promise<GatewayUsageRecord[]> {
  await vi.waitFor(() => expect(ingested.length).toBeGreaterThanOrEqual(callCount), {
    timeout: 10_000,
    interval: 50,
  });
  return ingested;
}

test("anthropic-messages: a stream relays byte for byte and its usage reaches the backend through the queue", async () => {
  const stream = sse([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 7, cache_read_input_tokens: 900 },
        },
      },
    },
    { event: "message_delta", data: { type: "message_delta", usage: { output_tokens: 11 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
  respond = () => new Response(stream, { headers: { "content-type": "text/event-stream" } });
  const token = await grant(f);
  const { response, text } = await relay(
    `/v1/c/${CONN}/v1/messages`,
    { "x-api-key": token, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    '{"model":"claude-sonnet-4-5","stream":true}',
  );
  expect(response.status).toBe(200);
  expect(text).toBe(stream);
  expect(outbound).toHaveLength(1);
  expect(outbound[0]!.url).toBe("https://api.anthropic.com/v1/messages");
  expect(outbound[0]!.headers["x-api-key"]).toBe(PROVIDER_KEY);
  expect(outbound[0]!.headers["anthropic-version"]).toBe("2023-06-01");
  expect(JSON.stringify(outbound[0]!.headers)).not.toContain(token);
  expect(outbound[0]!.body).toBe('{"model":"claude-sonnet-4-5","stream":true}');

  const [record] = await ingestedFor(1);
  expect(record).toMatchObject({
    callId: CALL_ID,
    connectionId: CONN,
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    usage: { input: 7, cacheRead: 900, output: 11 },
    status: "completed",
    upstreamStatus: 200,
  });
});

test("openai-responses: a bearer grant becomes a bearer key under the route's base path", async () => {
  respond = () =>
    new Response(
      sse([
        {
          data: {
            type: "response.completed",
            response: { model: "gpt-5", usage: { input_tokens: 4, output_tokens: 2 } },
          },
        },
      ]),
      { headers: { "content-type": "text/event-stream" } },
    );
  const token = await grant(f, {
    routes: [
      route({
        providerId: "openai",
        api: "openai-responses",
        upstream: "https://api.openai.com/v1",
      }),
    ],
  });
  const { response } = await relay(
    `/v1/c/${CONN}/responses`,
    { authorization: `Bearer ${token}` },
    "{}",
  );
  expect(response.status).toBe(200);
  expect(outbound[0]!.url).toBe("https://api.openai.com/v1/responses");
  expect(outbound[0]!.headers.authorization).toBe(`Bearer ${PROVIDER_KEY}`);
  const records = await ingestedFor(2);
  expect(records[1]).toMatchObject({
    providerId: "openai",
    usage: { input: 4, output: 2 },
    status: "completed",
  });
});

test("openai-completions (OpenRouter): the stream is asked for usage, which is metered", async () => {
  respond = () =>
    new Response(
      sse([
        {
          data: {
            model: "openai/gpt-5",
            choices: [],
            usage: { prompt_tokens: 9, completion_tokens: 3, cost: 0.002 },
          },
        },
        { data: "[DONE]" },
      ]),
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
  const token = await grant(f, {
    routes: [
      route({
        providerId: "openrouter",
        api: "openai-completions",
        upstream: "https://openrouter.ai/api/v1",
        headers: { "x-title": "Volli" },
      }),
    ],
  });
  const { response } = await relay(
    `/v1/c/${CONN}/chat/completions`,
    { authorization: `Bearer ${token}`, "content-type": "application/json" },
    '{"model":"openai/gpt-5","stream":true}',
  );
  expect(response.status).toBe(200);
  expect(outbound[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(outbound[0]!.headers["x-title"]).toBe("Volli");
  expect(JSON.parse(outbound[0]!.body)).toEqual({
    model: "openai/gpt-5",
    stream: true,
    stream_options: { include_usage: true },
  });
  const records = await ingestedFor(3);
  expect(records[2]).toMatchObject({
    providerId: "openrouter",
    usage: { input: 9, output: 3, upstreamCostUsd: 0.002 },
  });
});

test("typed refusals come back before anything is forwarded, and the KV kill switch revokes", async () => {
  const missing = await relay(`/v1/c/${CONN}/v1/messages`, {}, "{}");
  expect(missing.response.status).toBe(401);
  expect(missing.response.headers.get("x-volli-error")).toBe("volli_grant_missing");

  const stale = await grant({ ...f, sealingKey: await createDevSealingKey("retired") });
  const staleResult = await relay(`/v1/c/${CONN}/v1/messages`, { "x-api-key": stale }, "{}");
  expect(JSON.parse(staleResult.text)).toMatchObject({
    type: "error",
    error: { type: "volli_grant_stale" },
  });

  const token = await grant(f);
  // Miniflare types its bindings through workers-types, which this package does not load.
  const kv = (await mf.getKVNamespace("REVOCATIONS")) as unknown as {
    put(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  await kv.put(`conn:${CONN}:kv:3`, "rotated");
  const revoked = await relay(`/v1/c/${CONN}/v1/messages`, { "x-api-key": token }, "{}");
  expect(revoked.response.headers.get("x-volli-error")).toBe("volli_grant_revoked");
  await kv.delete(`conn:${CONN}:kv:3`);
  expect(outbound).toEqual([]);

  const health = await mf.dispatchFetch("https://gateway.volli.test/healthz");
  expect(await health.json()).toEqual({ ok: true });
});
