/**
 * A stopped credential through the real runtime boundary (VC-1236).
 *
 * Pi's real Anthropic provider, its real OAuth refresh and the real Anthropic
 * SDK, talking HTTP to a local fake that answers the way the provider documents
 * for each case. Nothing here is a real credential: every token is an inert
 * fixture string, and the only network is a loopback server.
 *
 * The wire shapes:
 *
 * - Messages API errors are `{"type":"error","error":{"type":…,"message":…}}`
 *   with 401 `authentication_error` for a malformed, revoked or expired API key
 *   (https://platform.claude.com/docs/en/api/errors), and the same 401 type for
 *   a subscription access token the API rejects as expired or revoked
 *   (https://code.claude.com/docs/en/errors, "OAuth token revoked or expired").
 * - A refresh token the OAuth service rejects ("Login expired" on the same page)
 *   is answered by the token endpoint. Anthropic does not publish that body; the
 *   fixture uses OAuth 2.0's own error response, 400 `invalid_grant`
 *   (RFC 6749 §5.2), which is what such an endpoint returns for a revoked or
 *   expired refresh token.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createModels, InMemoryCredentialStore, type Credential } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { RuntimeObservation } from "@volli/shared";
import { createPiAgentRuntime } from "./runtime";

type Handler = (request: IncomingMessage, body: string, response: ServerResponse) => void;

interface Fake {
  origin: string;
  /** Every request the fake answered, by path; bodies are never kept. */
  paths: string[];
  /** The request bodies the Messages endpoint received, for the resume check. */
  messageBodies: string[];
  handle: { messages: Handler; token: Handler };
  close(): Promise<void>;
}

function json(response: ServerResponse, status: number, body: unknown, headers = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function apiError(type: string, message: string) {
  return { type: "error", error: { type, message }, request_id: "req_fixture" };
}

/** A complete, minimal Messages stream: one text block that says `text`. */
function okStream(response: ServerResponse, text: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const events: [string, unknown][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model: "fixture",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  for (const [event, data] of events) {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  response.end();
}

async function startFake(): Promise<Fake> {
  const fake = {
    paths: [] as string[],
    messageBodies: [] as string[],
    handle: {
      messages: ((_request, _body, response) => okStream(response, "ok")) as Handler,
      token: ((_request, _body, response) =>
        json(response, 400, { error: "invalid_grant" })) as Handler,
    },
  };
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const path = new URL(request.url ?? "/", "http://fixture").pathname;
      fake.paths.push(path);
      if (path === "/v1/oauth/token") {
        fake.handle.token(request, body, response);
        return;
      }
      fake.messageBodies.push(body);
      fake.handle.messages(request, body, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a local port");
  return Object.assign(fake, {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });
}

/**
 * Route the provider's two real hosts to the fake. The Anthropic SDK and Pi's
 * OAuth refresh both call the global `fetch` (the SDK through the runtime's
 * capture wrapper), so the bytes cross a real HTTP connection either way.
 */
function routeTo(fake: Fake): void {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "api.anthropic.com" || url.hostname === "platform.claude.com") {
      const local = new URL(url.pathname + url.search, fake.origin);
      return input instanceof Request ? real(new Request(local, input), init) : real(local, init);
    }
    return real(input, init);
  });
}

const provider = anthropicProvider();
const model = provider.getModels()[0]!;
/** Inert fixture tokens. `sk-ant-oat` is the prefix Pi reads as a subscription token. */
const SUBSCRIPTION_ACCESS = "sk-ant-oat-fixture-access";
const SUBSCRIPTION_REFRESH = "fixture-refresh";
const API_KEY = "fixture-api-key";

let fake: Fake;
let root: string;

beforeEach(async () => {
  fake = await startFake();
  routeTo(fake);
  root = mkdtempSync(join(process.cwd(), ".credential-stop-test-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});

async function session(credential: Credential | undefined) {
  const credentials = new InMemoryCredentialStore();
  if (credential !== undefined) await credentials.modify(provider.id, async () => credential);
  // No ambient environment: a key in the test runner's env must not answer for
  // the credential under test.
  const models = createModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  models.setProvider(provider);
  const workspace = join(root, "worktree");
  mkdirSync(workspace, { recursive: true });
  const observations: RuntimeObservation[] = [];
  const runtime = createPiAgentRuntime({
    sessionDataDir: join(root, "sessions"),
    models,
    retryBackoffMs: () => 0,
  });
  const handle = await runtime.startSession({
    identity: {
      sessionId: "s",
      projectId: "p",
      ticketId: null,
      role: "project",
      attachmentId: "a",
      rootThreadId: "t",
    },
    workspacePath: workspace,
    venue: "local",
    model: { providerId: provider.id, modelId: model.id, reasoningLevel: "off" },
    brief: { text: "fixture" },
    tools: { tools: [] },
    observer: async (observation) => {
      observations.push(observation);
    },
  });
  return { handle, observations, credentials };
}

function stopOf(observations: readonly RuntimeObservation[]) {
  const turn = observations.findLast((o) => o.kind === "turn");
  const attention = observations.findLast((o) => o.kind === "attention" && o.state === "raised");
  return { turn, attention };
}

const SIGN_IN_STOP = {
  kind: "turn",
  state: "interrupted",
  stopDetail: { category: "auth-failed", retry: "not-retried" },
} as const;

describe("subscription (OAuth) login", () => {
  it("a refresh the token endpoint refuses stops as a sign-in failure, not unknown", async () => {
    // Reproduces the stop that read `unknown` with null type and status: the
    // refused refresh's sentence embeds the endpoint's JSON body, so its text
    // is withheld, and no request ever reached the Messages API.
    const { handle, observations } = await session({
      type: "oauth",
      access: SUBSCRIPTION_ACCESS,
      refresh: SUBSCRIPTION_REFRESH,
      expires: Date.now() - 60_000,
    });
    try {
      await handle.submitUserMessage("fixture");
      const { turn, attention } = stopOf(observations);
      expect(fake.paths).toContain("/v1/oauth/token");
      expect(fake.paths).not.toContain("/v1/messages");
      expect(turn).toMatchObject({
        ...SIGN_IN_STOP,
        stopDetail: {
          ...SIGN_IN_STOP.stopDetail,
          providerType: "volli.credential-refresh-failed",
          httpStatus: null,
          // Only the free text is withheld; the cause above survives it.
          message: "[Provider text withheld: possible request content.]",
        },
      });
      expect(attention).toMatchObject({ kind: "attention", reason: "auth" });
      // Nothing from the fixture credential or the endpoint's body leaks.
      const recorded = JSON.stringify(observations);
      for (const secret of [SUBSCRIPTION_ACCESS, SUBSCRIPTION_REFRESH, "invalid_grant"]) {
        expect(recorded).not.toContain(secret);
      }
    } finally {
      await handle.close();
    }
  });

  it("an access token the Messages API rejects as expired stops as a sign-in failure", async () => {
    fake.handle.messages = (_request, _body, response) =>
      json(
        response,
        401,
        apiError(
          "authentication_error",
          "OAuth token has expired. Please obtain a new token or refresh your existing token.",
        ),
      );
    const { handle, observations } = await session({
      type: "oauth",
      access: SUBSCRIPTION_ACCESS,
      refresh: SUBSCRIPTION_REFRESH,
      expires: Date.now() + 3_600_000,
    });
    try {
      await handle.submitUserMessage("fixture");
      const { turn, attention } = stopOf(observations);
      expect(fake.paths).not.toContain("/v1/oauth/token");
      expect(turn).toMatchObject({
        ...SIGN_IN_STOP,
        stopDetail: {
          ...SIGN_IN_STOP.stopDetail,
          providerType: "authentication_error",
          httpStatus: 401,
        },
      });
      expect(attention).toMatchObject({ kind: "attention", reason: "auth" });
      expect(JSON.stringify(observations)).not.toContain(SUBSCRIPTION_ACCESS);
    } finally {
      await handle.close();
    }
  });

  it("after signing in again, a message continues the Session without repeating it", async () => {
    const { handle, observations, credentials } = await session({
      type: "oauth",
      access: SUBSCRIPTION_ACCESS,
      refresh: SUBSCRIPTION_REFRESH,
      expires: Date.now() - 60_000,
    });
    try {
      await handle.submitUserMessage("first fixture message");
      expect(stopOf(observations).turn).toMatchObject(SIGN_IN_STOP);
      // The person signs in again: a fresh login replaces the stored one.
      await credentials.modify(provider.id, async () => ({
        type: "oauth",
        access: `${SUBSCRIPTION_ACCESS}-renewed`,
        refresh: `${SUBSCRIPTION_REFRESH}-renewed`,
        expires: Date.now() + 3_600_000,
      }));
      await handle.submitUserMessage("second fixture message");
      expect(stopOf(observations).turn).toMatchObject({ kind: "turn", state: "completed" });
      // One request, carrying the stopped message once and the new one once:
      // the failed attempt sent nothing, so nothing is duplicated.
      expect(fake.messageBodies).toHaveLength(1);
      const sent = fake.messageBodies[0]!;
      expect(sent.split("first fixture message")).toHaveLength(2);
      expect(sent.split("second fixture message")).toHaveLength(2);
    } finally {
      await handle.close();
    }
  });
});

describe("API key", () => {
  it("a revoked or invalid key stops as a sign-in failure with its status and type", async () => {
    fake.handle.messages = (_request, _body, response) =>
      json(response, 401, apiError("authentication_error", "invalid x-api-key"));
    const { handle, observations } = await session({ type: "api_key", key: API_KEY });
    try {
      await handle.submitUserMessage("fixture");
      const { turn, attention } = stopOf(observations);
      expect(turn).toMatchObject({
        ...SIGN_IN_STOP,
        stopDetail: {
          ...SIGN_IN_STOP.stopDetail,
          providerType: "authentication_error",
          httpStatus: 401,
          message: "invalid x-api-key",
        },
      });
      expect(attention).toMatchObject({ kind: "attention", reason: "auth" });
      expect(JSON.stringify(observations)).not.toContain(API_KEY);
    } finally {
      await handle.close();
    }
  });

  it("no credential at all stops as a sign-in failure before any request", async () => {
    const { handle, observations } = await session(undefined);
    try {
      await handle.submitUserMessage("fixture");
      const { turn, attention } = stopOf(observations);
      expect(fake.paths).toEqual([]);
      expect(turn).toMatchObject({
        ...SIGN_IN_STOP,
        stopDetail: { ...SIGN_IN_STOP.stopDetail, providerType: "volli.credential-missing" },
      });
      expect(attention).toMatchObject({ kind: "attention", reason: "auth" });
    } finally {
      await handle.close();
    }
  });
});

describe("the neighbours that also need a person", () => {
  it("permission denied keeps its status and type and asks for the person", async () => {
    fake.handle.messages = (_request, _body, response) =>
      json(
        response,
        403,
        apiError(
          "permission_error",
          "Your API key does not have permission to use the specified resource.",
        ),
      );
    const { handle, observations } = await session({ type: "api_key", key: API_KEY });
    try {
      await handle.submitUserMessage("fixture");
      const { turn, attention } = stopOf(observations);
      expect(turn).toMatchObject({
        stopDetail: { category: "auth-failed", providerType: "permission_error", httpStatus: 403 },
      });
      expect(attention).toMatchObject({ reason: "auth" });
    } finally {
      await handle.close();
    }
  });

  it("a model the account is not served stops as configuration, not a retryable failure", async () => {
    fake.handle.messages = (_request, _body, response) =>
      json(response, 404, apiError("not_found_error", "model: fixture-model"));
    const { handle, observations } = await session({ type: "api_key", key: API_KEY });
    try {
      await handle.submitUserMessage("fixture");
      const { turn, attention } = stopOf(observations);
      expect(fake.paths.filter((path) => path === "/v1/messages")).toHaveLength(1);
      expect(turn).toMatchObject({
        stopDetail: { category: "bad-request", providerType: "not_found_error", httpStatus: 404 },
      });
      expect(attention).toMatchObject({ reason: "configuration" });
    } finally {
      await handle.close();
    }
  });

  it("a spent allowance is not retried and carries the provider's reset", async () => {
    const resetSeconds = 120;
    fake.handle.messages = (_request, _body, response) =>
      json(response, 402, apiError("billing_error", "Your credit balance is too low."), {
        "retry-after": String(resetSeconds),
      });
    const { handle, observations } = await session({ type: "api_key", key: API_KEY });
    try {
      const before = Date.now();
      await handle.submitUserMessage("fixture");
      const { turn } = stopOf(observations);
      expect(fake.paths.filter((path) => path === "/v1/messages")).toHaveLength(1);
      expect(turn).toMatchObject({
        stopDetail: {
          category: "rate-limited",
          providerType: "billing_error",
          httpStatus: 402,
          retry: "not-retried",
        },
      });
      const resetsAt = turn?.kind === "turn" ? turn.stopDetail?.resetsAt : null;
      expect(resetsAt).toBeGreaterThanOrEqual(before + resetSeconds * 1000);
    } finally {
      await handle.close();
    }
  });

  it("a dropped connection is retried, not surfaced as a stop", async () => {
    let calls = 0;
    fake.handle.messages = (request, _body, response) => {
      calls += 1;
      if (calls === 1) {
        request.socket.destroy();
        return;
      }
      okStream(response, "recovered");
    };
    const { handle, observations } = await session({ type: "api_key", key: API_KEY });
    try {
      await handle.submitUserMessage("fixture");
      expect(calls).toBeGreaterThan(1);
      expect(stopOf(observations).turn).toMatchObject({ kind: "turn", state: "completed" });
      expect(
        observations.some(
          (o) => o.kind === "attention" && o.state === "raised" && o.reason === "auth",
        ),
      ).toBe(false);
    } finally {
      await handle.close();
    }
  });
});
