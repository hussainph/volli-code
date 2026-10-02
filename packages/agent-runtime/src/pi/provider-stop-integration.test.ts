/** Exercise Pi's actual Codex adapter; all auth and responses are inert fixtures. */
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { createModels, normalizeContext, type AssistantMessage } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { stream as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { RuntimeObservation } from "@volli/shared";
import { ProviderStopCapture } from "./provider-stop";
import { createPiAgentRuntime } from "./runtime";

const token = `dummy.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "dummy-account" } })).toString("base64url")}.dummy`;
const model = openaiCodexProvider().getModels()[0]!;
const context = normalizeContext({
  messages: [{ role: "user" as const, content: "fixture", timestamp: 0 }],
});

/** Open normally; optionally emit a provider event before an abnormal close. */
function socketFixture(started: boolean) {
  return class extends EventTarget {
    readyState = 0;
    constructor() {
      super();
      queueMicrotask(() => {
        if (!started) {
          this.dispatchEvent(
            Object.assign(new Event("error"), {
              error: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
            }),
          );
        } else {
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
        }
      });
    }
    send() {
      // Pi installs its parser immediately after send.
      setTimeout(() => {
        if (started)
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "response.created",
                response: { id: "dummy-response" },
              }),
            }),
          );
        setTimeout(() => {
          this.readyState = 3;
          this.dispatchEvent(
            Object.assign(new Event("close"), { code: 1006, reason: "fixture", wasClean: false }),
          );
        }, 0);
      }, 0);
    }
    close() {
      this.readyState = 3;
    }
  };
}

it("terminal usage limit after actual WebSocket-to-SSE fallback is not retried (review item 3)", async () => {
  vi.stubGlobal("WebSocket", socketFixture(false));
  const root = mkdtempSync(join(process.cwd(), ".stop-fallback-test-"));
  const workspace = join(root, "worktree");
  mkdirSync(workspace);
  const observations: RuntimeObservation[] = [];
  let calls = 0;
  const models = createModels();
  const provider = openaiCodexProvider();
  models.setProvider({
    ...provider,
    auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: token } }) } },
    streamSimple: (candidate, transcript, options) => {
      calls += 1;
      return codexStream(candidate as typeof model, transcript, {
        ...options,
        apiKey: token,
        maxRetries: 0,
        transport: "auto",
      });
    },
  });
  // A synthetic fetch supplies only the provider response, not its interpretation.
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({ error: { type: "usage_limit_reached", message: "Limit used" } }),
        { status: 429 },
      ),
  );
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
    observer: async (o) => {
      observations.push(o);
    },
  });
  try {
    await handle.submitUserMessage("fixture");
    expect(calls).toBe(1);
    expect(observations.at(-1)).toMatchObject({
      kind: "turn",
      state: "interrupted",
      stopDetail: {
        category: "rate-limited",
        providerType: "usage_limit_reached",
        retry: "not-retried",
      },
    });
  } finally {
    await handle.close();
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  }
});

it("maps Pi's actual terminal WebSocketCloseError code 1006 (review item 4)", async () => {
  vi.stubGlobal("WebSocket", socketFixture(true));
  try {
    const capture = new ProviderStopCapture();
    const output = await codexStream(model, context, {
      apiKey: token,
      transport: "websocket",
      maxRetries: 0,
      onProviderStreamEvent: (event) => capture.event(event),
    }).result();
    expect(output.diagnostics).toContainEqual(
      expect.objectContaining({
        type: "provider_transport_failure",
        error: expect.objectContaining({ name: "WebSocketCloseError", code: 1006 }),
        details: expect.objectContaining({ eventsEmitted: true }),
      }),
    );
    expect(capture.detail(output)).toMatchObject({
      category: "network",
      providerType: "WebSocketCloseError",
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("maps Node fetch UND_ERR_SOCKET through Pi's actual SSE implementation (review item 4)", async () => {
  const server = createServer((request) => {
    request.socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a local port");
    const capture = new ProviderStopCapture();
    let actualCode: unknown;
    const inner: typeof fetch = async (input, init) => {
      try {
        return await fetch(input, init);
      } catch (error) {
        actualCode = (error as Error & { cause: { code: string } }).cause.code;
        throw error;
      }
    };
    const output: AssistantMessage = await codexStream(
      { ...model, baseUrl: `http://127.0.0.1:${address.port}` },
      context,
      { apiKey: token, transport: "sse", maxRetries: 0, fetch: capture.fetch(inner, () => 0) },
    ).result();
    expect(actualCode).toBe("UND_ERR_SOCKET");
    expect(capture.detail(output)).toMatchObject({
      category: "network",
      providerType: "UND_ERR_SOCKET",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
