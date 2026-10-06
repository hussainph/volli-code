// Proves the loopback fake provider against pi-ai's REAL provider stream and
// against Volli's own model access, in plain Node, with no network beyond
// 127.0.0.1 and no real credentials.
//
//   node --test apps/desktop/e2e/volli-drive/lib/fake-provider.test.mjs
//
// Isolation: every Pi / HOME path these tests touch is a fresh temp dir. The
// Volli-model-access check runs in a child process whose environment is built
// from scratch (PATH + the fake provider's env + temp HOME/PI_CODING_AGENT_DIR),
// so no developer credential in this shell can make a model look available.
// Every `fetch` to a non-loopback host is refused and counted.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FAKE_API_KEY, defaultReplyText, spokenText, startFakeProvider } from "./fake-provider.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const AGENT_RUNTIME = join(REPO, "packages/agent-runtime");
const PROVIDER_CLI = join(HERE, "fake-provider.mjs");

// pi-ai exactly as agent-runtime resolves it: through agent-runtime's own
// node_modules link (pnpm), not whatever a sibling package happens to hoist.
const PI_AI_DIR = realpathSync(join(AGENT_RUNTIME, "node_modules/@earendil-works/pi-ai"));
const piAi = (distPath) => import(pathToFileURL(join(PI_AI_DIR, "dist", distPath)).href);

// ---- no non-loopback network in this process --------------------------------

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const realFetch = globalThis.fetch;
const blockedFetches = [];
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!LOOPBACK.has(url.hostname)) {
    blockedFetches.push(url.origin);
    return Promise.reject(
      new Error(`fake-provider test: refused non-loopback fetch to ${url.origin}`),
    );
  }
  return realFetch(input, init);
};

const tempDirs = [];
function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `volli-drive-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function collectText(message) {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Drain a pi-ai event stream, counting text deltas and timing the first one. */
async function drain(stream, started) {
  let deltas = 0;
  let firstDeltaAt = null;
  for await (const event of stream) {
    if (event.type === "text_delta") {
      deltas++;
      firstDeltaAt ??= Date.now() - started;
    }
  }
  const message = await stream.result();
  return { deltas, firstDeltaAt, message, elapsed: Date.now() - started };
}

describe("fake provider via pi-ai's real azure-openai-responses stream", () => {
  let provider;
  let models;
  let model;
  const savedEnv = {};
  const logged = [];

  before(async () => {
    provider = await startFakeProvider({ log: (entry) => logged.push(entry) });
    // pi-ai resolves both the key (envApiKeyAuth → ctx.env) and the base URL
    // (getProviderEnvValue) from process.env, which is what Electron main has.
    for (const [key, value] of Object.entries(provider.env)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    const { builtinModels } = await piAi("providers/all.js");
    const { InMemoryCredentialStore } = await piAi("index.js");
    models = builtinModels({ credentials: new InMemoryCredentialStore() });
    model = models.getModel(provider.providerId, provider.modelId);
  });

  after(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await provider?.close();
  });

  test("binds loopback on a random port and exposes the launch contract", () => {
    assert.match(provider.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(provider.port, 0);
    assert.deepEqual(provider.env, {
      AZURE_OPENAI_BASE_URL: `${provider.url}/openai/v1`,
      AZURE_OPENAI_API_KEY: FAKE_API_KEY,
      AZURE_OPENAI_API_VERSION: "v1",
    });
    assert.deepEqual(provider.pin, {
      providerId: "azure-openai-responses",
      modelId: "gpt-4.1-mini",
      reasoningLevel: "off",
    });
    assert.ok(model, "pi-ai's builtin catalog has the pinned model");
    assert.equal(model.api, "azure-openai-responses");
    assert.equal(model.reasoning, false);
  });

  test("(a) completes a streamed text turn with the echoed text", async () => {
    const auth = await models.checkAuth(provider.providerId);
    assert.deepEqual(auth, { source: "AZURE_OPENAI_API_KEY", type: "api_key" });
    const available = await models.getAvailable(provider.providerId);
    assert.ok(
      available.some((m) => m.id === provider.modelId),
      "env-only key makes the model available",
    );

    const seen = provider.requests.length;
    const started = Date.now();
    const result = await drain(
      models.streamSimple(model, {
        systemPrompt: "You are a test.",
        messages: [{ role: "user", content: "hello from node", timestamp: Date.now() }],
      }),
      started,
    );
    assert.equal(result.message.stopReason, "stop", result.message.errorMessage);
    assert.equal(collectText(result.message), "fake-agent: hello from node");
    assert.ok(result.deltas >= 2, `streamed as several deltas (got ${result.deltas})`);
    assert.ok(result.message.usage.totalTokens > 0);

    const request = provider.requests[seen];
    assert.equal(request.path, "/openai/v1/responses");
    assert.equal(request.model, "gpt-4.1-mini");
    assert.equal(request.stream, true);
    assert.equal(request.lastUserText, "hello from node");
    assert.equal(request.authorized, true);
    assert.ok(logged.includes(request), "every request reaches log");
  });

  test("(a') multi-turn: echoes the LAST user message", async () => {
    const message = await models.completeSimple(model, {
      messages: [
        { role: "user", content: "first", timestamp: Date.now() },
        {
          role: "assistant",
          content: [{ type: "text", text: "fake-agent: first" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
        { role: "user", content: [{ type: "text", text: "second" }], timestamp: Date.now() },
      ],
    });
    assert.equal(message.stopReason, "stop", message.errorMessage);
    assert.equal(collectText(message), "fake-agent: second");
  });

  test("(b) [slow:300] holds the turn open before the first delta", async () => {
    const started = Date.now();
    const result = await drain(
      models.streamSimple(model, {
        messages: [{ role: "user", content: "take your time [slow:300]", timestamp: Date.now() }],
      }),
      started,
    );
    assert.equal(result.message.stopReason, "stop", result.message.errorMessage);
    assert.equal(collectText(result.message), "fake-agent: take your time [slow:300]");
    assert.ok(
      result.firstDeltaAt >= 290,
      `first delta after the hold (at ${result.firstDeltaAt}ms)`,
    );
    assert.ok(result.elapsed >= 300, `turn lasted ${result.elapsed}ms`);
    assert.equal(provider.requests.at(-1).delayMs, 300);
  });

  test("(b') [plan] replies with a markdown plan body", async () => {
    const message = await models.completeSimple(model, {
      messages: [{ role: "user", content: "fix the bug [plan]", timestamp: Date.now() }],
    });
    const text = collectText(message);
    assert.match(text, /^fake-agent plan:/);
    assert.match(text, /## Plan\n\n1\. /);
  });

  test("(b'') an aborted slow turn is recorded as aborted", async () => {
    const controller = new AbortController();
    const stream = models.streamSimple(
      model,
      { messages: [{ role: "user", content: "interrupt me [slow:5000]", timestamp: Date.now() }] },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 150);
    const started = Date.now();
    const { message } = await drain(stream, started);
    assert.equal(message.stopReason, "aborted");
    assert.ok(Date.now() - started < 2000, "abort does not wait out the hold");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(provider.requests.at(-1).aborted, true);
  });

  test("(c) a wrong API key is refused with 401", async () => {
    const seen = provider.requests.length;
    const message = await models.completeSimple(
      model,
      { messages: [{ role: "user", content: "let me in", timestamp: Date.now() }] },
      { apiKey: "not-the-fake-key" },
    );
    assert.equal(message.stopReason, "error");
    assert.match(message.errorMessage, /401/);
    const refused = provider.requests.slice(seen);
    assert.equal(refused.length, 1, "401 is not retried");
    assert.equal(refused[0].authorized, false);
    assert.equal(refused[0].status, 401);

    const raw = await fetch(`${provider.url}/openai/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1-mini", input: "no key", stream: true }),
    });
    assert.equal(raw.status, 401);
  });

  test("non-streaming fallback returns a completed Responses object", async () => {
    const res = await fetch(`${provider.url}/openai/v1/responses?api-version=v1`, {
      method: "POST",
      headers: { "content-type": "application/json", "api-key": FAKE_API_KEY },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        stream: false,
        input: [{ role: "user", content: [{ type: "input_text", text: "plain json" }] }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "completed");
    assert.equal(body.output_text, "fake-agent: plain json");
    assert.equal(body.output[0].content[0].text, "fake-agent: plain json");
    // Bearer auth (plain OpenAI clients) is accepted too.
    const bearer = await fetch(`${provider.url}/openai/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${FAKE_API_KEY}` },
      body: JSON.stringify({ model: "gpt-4.1-mini", stream: false, input: "bearer" }),
    });
    assert.equal((await bearer.json()).output_text, "fake-agent: bearer");
  });
});

describe("echo of what the person typed", () => {
  test("strips the blocks and wrapper Volli adds to a Ticket Session's first message", () => {
    const first = [
      '<ticket id="DRV-5">',
      "--- BEGIN TICKET BRIEF ---",
      "You are working in an isolated git worktree …",
      "--- END TICKET BRIEF ---",
      "",
      "--- BEGIN SESSION TOOLS ---",
      "session.start — call it as session_start",
      "--- END SESSION TOOLS ---",
      "</ticket>",
      "",
      "hello drive",
    ].join("\n");
    assert.equal(spokenText(first), "hello drive");
    assert.equal(defaultReplyText(first), "fake-agent: hello drive");
  });

  test("leaves ordinary text alone and never echoes nothing", () => {
    assert.equal(defaultReplyText("second message"), "fake-agent: second message");
    const onlyBrief = "--- BEGIN TICKET BRIEF ---\nx\n--- END TICKET BRIEF ---";
    assert.equal(spokenText(onlyBrief), onlyBrief);
  });
});

describe("script, defaultDelayMs", () => {
  test("a scripted array is consumed per turn, then falls back to echo; defaultDelayMs applies", async () => {
    const provider = await startFakeProvider({
      script: ["scripted one", { text: "scripted two", delayMs: 0 }],
      defaultDelayMs: 200,
    });
    try {
      const ask = async (text) => {
        const started = Date.now();
        const res = await fetch(`${provider.url}/openai/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json", "api-key": FAKE_API_KEY },
          body: JSON.stringify({ model: "gpt-4.1-mini", stream: false, input: text }),
        });
        return { text: (await res.json()).output_text, elapsed: Date.now() - started };
      };
      const one = await ask("a");
      const two = await ask("b");
      const three = await ask("c");
      assert.equal(one.text, "scripted one");
      assert.ok(one.elapsed >= 190, `string reply keeps defaultDelayMs (${one.elapsed}ms)`);
      assert.equal(two.text, "scripted two");
      assert.equal(three.text, "fake-agent: c");
      assert.ok(three.elapsed >= 190);
    } finally {
      await provider.close();
    }
  });
});

describe("CLI entry", () => {
  test("prints the launch contract as one JSON line and serves until SIGTERM", async () => {
    const child = spawn(process.execPath, [PROVIDER_CLI, "--port", "0"], {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    const line = await new Promise((resolveLine, reject) => {
      child.stdout.on("data", (c) => {
        stdout += c;
        const nl = stdout.indexOf("\n");
        if (nl >= 0) resolveLine(stdout.slice(0, nl));
      });
      child.once("exit", (code) => reject(new Error(`CLI exited early (${code}): ${stderr}`)));
    });
    const info = JSON.parse(line);
    assert.equal(info.providerId, "azure-openai-responses");
    assert.equal(info.modelId, "gpt-4.1-mini");
    assert.equal(info.env.AZURE_OPENAI_API_KEY, FAKE_API_KEY);
    assert.equal(info.env.AZURE_OPENAI_BASE_URL, `${info.url}/openai/v1`);
    const health = await fetch(`${info.url}/health`);
    assert.equal((await health.json()).ok, true);
    const res = await fetch(`${info.url}/openai/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "api-key": FAKE_API_KEY },
      body: JSON.stringify({ model: "gpt-4.1-mini", stream: false, input: "cli" }),
    });
    assert.equal((await res.json()).output_text, "fake-agent: cli");
    const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
    child.kill("SIGTERM");
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.match(stderr, /"lastUserText":"cli"/, "requests are logged to stderr");
  });
});

// ---- (d) Volli's own model access, env-only ---------------------------------

// Runs in a child with a from-scratch environment. Loads agent-runtime's TS
// sources directly (Node strips types; the hook resolves extensionless
// relative imports to .ts, exactly like host-core's secrets/test-support/
// ts-hooks.mjs), builds `piOwnedModelAccess()` — the very constructor
// host-core's runtime-services.ts calls — and runs `inspectPiModelAccess` over
// it the way runtime.ts's `inspectModelAccess` does. Then it runs one real turn
// through that same `Models`.
const CHILD = String.raw`
import { existsSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".")) throw error;
      for (const suffix of [".ts", "/index.ts"]) {
        const url = new URL(specifier + suffix, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
      throw error;
    }
  },
});

const blocked = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    blocked.push(url.origin);
    return Promise.reject(new Error("refused non-loopback fetch"));
  }
  return realFetch(input, init);
};

const src = (p) => pathToFileURL(join(process.env.AGENT_RUNTIME_DIR, "src/pi", p)).href;
const { piOwnedModelAccess, piAuthFilePath } = await import(src("models.ts"));
const { inspectPiModelAccess } = await import(src("model-access.ts"));

const access = piOwnedModelAccess();
const snapshot = await inspectPiModelAccess(
  { models: access.models, credentials: access.credentials, catalogReady: access.catalogReady, catalogs: access.catalogs },
  () => Date.now(),
  {},
);
const providerId = process.env.PIN_PROVIDER;
const modelId = process.env.PIN_MODEL;
const out = {
  authFile: piAuthFilePath(),
  provider: snapshot.providers.find((p) => p.id === providerId) ?? null,
  model: snapshot.models.find((m) => m.providerId === providerId && m.modelId === modelId) ?? null,
  availableModels: snapshot.models.filter((m) => m.state === "available").map((m) => m.providerId + "/" + m.modelId),
  turn: null,
};
if (process.env.RUN_TURN === "1") {
  const model = access.models.getModel(providerId, modelId);
  const message = await access.models.completeSimple(model, {
    messages: [{ role: "user", content: "through volli model access", timestamp: Date.now() }],
  });
  out.turn = {
    stopReason: message.stopReason,
    errorMessage: message.errorMessage ?? null,
    text: message.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
  };
}
out.blocked = blocked;
out.agentDirEntries = existsSync(process.env.PI_CODING_AGENT_DIR) ? readdirSync(process.env.PI_CODING_AGENT_DIR) : [];
process.stdout.write(JSON.stringify(out) + "\n");
`;

function runChild(env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD], {
      cwd: AGENT_RUNTIME,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}:\n${stderr}`));
      try {
        resolveRun(JSON.parse(stdout.trim().split("\n").at(-1)));
      } catch (error) {
        reject(new Error(`unparseable child output: ${stdout}\n${stderr}`, { cause: error }));
      }
    });
  });
}

describe("(d) Volli's piOwnedModelAccess + inspectPiModelAccess, env-only credentials", () => {
  let provider;
  before(async () => {
    provider = await startFakeProvider();
  });
  after(async () => {
    await provider?.close();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  const isolatedEnv = (extra) => {
    const home = tempDir("home");
    const agentDir = join(home, "pi-agent");
    return {
      PATH: process.env.PATH ?? "",
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      AGENT_RUNTIME_DIR: AGENT_RUNTIME,
      PIN_PROVIDER: provider.providerId,
      PIN_MODEL: provider.modelId,
      ...extra,
    };
  };

  test("control: without the env, the pinned model needs authentication and nothing is available", async () => {
    const env = isolatedEnv({});
    const out = await runChild(env);
    assert.equal(out.authFile, join(env.PI_CODING_AGENT_DIR, "auth.json"));
    assert.equal(out.provider.state, "authentication-required");
    assert.equal(out.model.state, "authentication-required");
    assert.deepEqual(out.availableModels, [], "an empty isolated profile has no available model");
    assert.deepEqual(out.blocked, []);
  });

  test("with ONLY the fake provider env, the pinned model is available and a turn completes", async () => {
    const env = isolatedEnv({ ...provider.env, RUN_TURN: "1" });
    const out = await runChild(env);
    assert.equal(out.provider.state, "available");
    assert.equal(out.provider.hasStoredCredential, false, "nothing was stored — env only");
    assert.equal(out.provider.billingSource, "unknown");
    assert.equal(out.model.state, "available");
    assert.deepEqual(out.model.reasoningLevels, ["off"]);
    assert.ok(out.availableModels.includes("azure-openai-responses/gpt-4.1-mini"));
    assert.ok(
      out.availableModels.every((id) => id.startsWith("azure-openai-responses/")),
      `only the fake route is available: ${out.availableModels.join(", ")}`,
    );
    assert.deepEqual(out.turn, {
      stopReason: "stop",
      errorMessage: null,
      text: "fake-agent: through volli model access",
    });
    assert.deepEqual(out.blocked, [], "no non-loopback fetch was attempted");
    assert.ok(!out.agentDirEntries.includes("auth.json"), "no auth.json was written");
    assert.equal(provider.requests.at(-1).lastUserText, "through volli model access");
  });
});

after(() => {
  assert.deepEqual(blockedFetches, [], "this test process never fetched off-loopback");
  // Temp dirs from describe blocks that did not clean up.
  for (const dir of tempDirs) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});
