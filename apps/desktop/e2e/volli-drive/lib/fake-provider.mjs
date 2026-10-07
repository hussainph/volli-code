// A loopback fake model provider for volli-drive (VC-703).
//
// A live Volli dev build runs its chat turns on `@earendil-works/pi-ai`, and
// pi-ai has no in-app fake. This server is the seam instead: it speaks enough
// of the OpenAI **Responses** API (streaming SSE, plus the non-streaming JSON
// shape) for pi-ai's built-in `azure-openai-responses` provider to complete a
// text or function-tool turn, and it binds 127.0.0.1 only.
//
// Why the Azure route (and not `openai`, `openrouter`, ...):
//   • it is the one built-in chat provider whose endpoint is configured purely
//     from the environment — `AZURE_OPENAI_BASE_URL` (pi-ai
//     `dist/api/azure-openai-responses.js` `resolveAzureConfig`) — and every
//     catalog model ships `baseUrl: ""` for exactly that reason;
//   • its auth is `envApiKeyAuth("Azure OpenAI API key", ["AZURE_OPENAI_API_KEY"])`
//     (pi-ai `dist/providers/azure-openai-responses.js`), so an env var alone
//     makes `Models.checkAuth`/`getAvailable` succeed — no `auth.json`, no
//     keychain, no OAuth;
//   • a non-Azure host (127.0.0.1) skips `normalizeAzureBaseUrl`'s path
//     rewrite, so the base URL is used verbatim, and the `AzureOpenAI` SDK
//     client posts `/responses` (not deployment-scoped) under it, with the
//     key in an `api-key` header and `?api-version=v1`.
// Volli's redirection guard (`packages/agent-runtime/src/pi/model-catalog.ts`)
// only judges *feed* catalog entries; the env base URL never passes through it.
//
// The pin a launcher hands `modelAccess.setDefault`:
//   { providerId: "azure-openai-responses", modelId: "gpt-4.1-mini", reasoningLevel: "off" }
// gpt-4.1-mini is a non-reasoning model, so Pi reports exactly ["off"].
//
// Reply behaviour, per turn, from the LAST user message's text:
//   • default           → `fake-agent: <text>` streamed as a few deltas
//   • `[slow:<ms>]`     → hold the turn open that long before the first delta
//                         (else `defaultDelayMs`) — keeps a turn "running"
//   • `[plan]`          → a small markdown plan body
//   • `script`          → a function `(turn) => reply | undefined` or an array of
//                         replies consumed one per turn; a reply is a string or
//                         `{ text?, toolCalls?, delayMs?, status?, error? }`.
//                         toolCalls is an array of { name, arguments } (an
//                         object or JSON string); without text, a nonempty
//                         toolCalls reply emits only function calls. Scripts
//                         can inspect turn.body.input for function_call_output
//                         on follow-up turns. Undefined / exhausted falls back
//                         to the default behaviour.
// A request whose key is not the fake one gets HTTP 401.
//
// CLI: `node fake-provider.mjs [--port 0] [--host 127.0.0.1] [--delay 0]`
// prints `{"url","port","env","providerId","modelId","reasoningLevel","pin"}` as
// ONE JSON line on stdout, logs each request as a JSON line on stderr, and
// serves until SIGTERM/SIGINT.
//
// No dependencies beyond node: builtins.

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const FAKE_API_KEY = "volli-drive-fake-key";
export const FAKE_PROVIDER_ID = "azure-openai-responses";
export const FAKE_MODEL_ID = "gpt-4.1-mini";
export const FAKE_REASONING_LEVEL = "off";
/** The path prefix the Azure route is pointed at; `/responses` is appended by the SDK. */
const BASE_PATH = "/openai/v1";

const SLOW_MARKER = /\[slow:(\d+)\]/i;
const PLAN_MARKER = /\[plan\]/i;

/**
 * @typedef {{ name: string, arguments: Record<string, unknown>|string }} FakeToolCall
 * @typedef {{ text?: string, toolCalls?: FakeToolCall[], delayMs?: number, status?: number, error?: string }} FakeReply
 * @typedef {{ index: number, path: string, model: string|null, stream: boolean, text: string, body: any }} FakeTurn
 * @typedef {{
 *   at: number, method: string, path: string, model: string|null, stream: boolean|null,
 *   lastUserText: string|null, authorized: boolean, status: number, delayMs?: number,
 *   reply?: string, aborted?: boolean
 * }} FakeRequestRecord
 */

/**
 * Start the fake provider.
 *
 * @param {{
 *   script?: ((turn: FakeTurn) => (string|FakeReply|undefined|Promise<string|FakeReply|undefined>)) | Array<string|FakeReply>,
 *   defaultDelayMs?: number,
 *   log?: (record: FakeRequestRecord) => void,
 *   host?: string,
 *   port?: number,
 *   apiKey?: string,
 *   modelId?: string,
 *   chunkDelayMs?: number,
 * }} [options]
 */
export async function startFakeProvider(options = {}) {
  const {
    script,
    defaultDelayMs = 0,
    log,
    host = "127.0.0.1",
    port = 0,
    apiKey = FAKE_API_KEY,
    modelId = FAKE_MODEL_ID,
    chunkDelayMs = 5,
  } = options;
  /** @type {FakeRequestRecord[]} */
  const requests = [];
  const scripted = Array.isArray(script) ? [...script] : null;
  let turnIndex = 0;
  const sockets = new Set();

  const record = (entry) => {
    requests.push(entry);
    try {
      log?.(entry);
    } catch {
      // A logger failure must never fail a turn.
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: { message: String(error?.message ?? error), type: "server_error" },
        });
      } else {
        res.destroy();
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    const path = url.pathname;
    const base = {
      at: Date.now(),
      method: req.method ?? "GET",
      path,
      model: null,
      stream: null,
      lastUserText: null,
    };

    if (req.method === "GET" && (path === "/health" || path === "/")) {
      sendJson(res, 200, { ok: true, providerId: FAKE_PROVIDER_ID, modelId });
      return;
    }

    const authorized = presentedKey(req) === apiKey;
    if (!authorized) {
      // Drain the body so the client sees the 401, not a reset.
      await readBody(req).catch(() => "");
      record({ ...base, authorized: false, status: 401 });
      sendJson(res, 401, {
        error: {
          message: "Incorrect API key provided (volli-drive fake provider).",
          type: "invalid_request_error",
          code: "invalid_api_key",
          param: null,
        },
      });
      return;
    }

    if (req.method === "GET" && path.endsWith("/models")) {
      record({ ...base, authorized: true, status: 200 });
      sendJson(res, 200, {
        object: "list",
        data: [{ id: modelId, object: "model", owned_by: "volli-drive" }],
      });
      return;
    }

    if (req.method !== "POST" || !path.endsWith("/responses")) {
      record({ ...base, authorized: true, status: 404 });
      sendJson(res, 404, {
        error: { message: `fake provider: no route for ${req.method} ${path}`, type: "not_found" },
      });
      return;
    }

    let body;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      record({ ...base, authorized: true, status: 400 });
      sendJson(res, 400, {
        error: { message: "fake provider: body is not JSON", type: "invalid_request_error" },
      });
      return;
    }
    const text = lastUserText(body.input);
    const stream = body.stream === true;
    const model = typeof body.model === "string" ? body.model : null;
    const turn = { index: turnIndex++, path, model, stream, text, body };

    const reply = normalizeReply(await pickReply(turn), text, defaultDelayMs);
    const entry = {
      ...base,
      model,
      stream,
      lastUserText: text,
      authorized: true,
      status: reply.status ?? 200,
      delayMs: reply.delayMs,
      reply: reply.text,
    };
    record(entry);

    if (reply.status !== undefined && reply.status !== 200) {
      sendJson(res, reply.status, {
        error: {
          message: reply.error ?? `fake provider: scripted ${reply.status}`,
          type: "server_error",
        },
      });
      return;
    }

    // A client that gives up (interrupt / abort) closes the socket; stop then.
    let closed = false;
    const onClose = () => {
      if (!res.writableFinished) {
        closed = true;
        entry.aborted = true;
      }
    };
    res.on("close", onClose);

    const ids = {
      response: `resp_${randomUUID().replaceAll("-", "")}`,
      message: `msg_${randomUUID().replaceAll("-", "")}`,
    };
    const createdAt = Math.floor(Date.now() / 1000);
    const toolItems = (reply.toolCalls ?? []).map((call) => ({
      id: `fc_${randomUUID().replaceAll("-", "")}`,
      type: "function_call",
      status: "completed",
      call_id: `call_${randomUUID().replaceAll("-", "")}`,
      name: call.name,
      arguments:
        typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
    }));
    const output = [];
    // No synthetic echo/message on a tool-only turn; keep the old empty-text
    // message behaviour for replies without tools.
    if (reply.text.length > 0 || toolItems.length === 0) {
      output.push({
        id: ids.message,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: reply.text, annotations: [] }],
      });
    }
    output.push(...toolItems);
    const usage = usageFor(
      body,
      reply.text + toolItems.map((item) => item.name + item.arguments).join(""),
    );
    const responseObject = (status, items) => ({
      id: ids.response,
      object: "response",
      created_at: createdAt,
      status,
      model: model ?? modelId,
      output: items,
      usage: status === "completed" ? usage : null,
      error: null,
      incomplete_details: null,
    });

    if (!stream) {
      await sleep(reply.delayMs, () => closed);
      if (closed) return;
      sendJson(res, 200, {
        ...responseObject("completed", output),
        output_text: reply.text,
      });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let seq = 0;
    const send = (type, payload) => {
      if (closed) return;
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`,
      );
    };

    send("response.created", { response: responseObject("in_progress", []) });
    send("response.in_progress", { response: responseObject("in_progress", []) });
    // The hold happens with the stream open, so the turn reads as running.
    await sleep(reply.delayMs, () => closed);
    if (closed) return;
    for (const [outputIndex, item] of output.entries()) {
      const address = { item_id: item.id, output_index: outputIndex };
      if (item.type === "function_call") {
        send("response.output_item.added", {
          output_index: outputIndex,
          item: { ...item, status: "in_progress", arguments: "" },
        });
        for (const delta of chunk(item.arguments)) {
          send("response.function_call_arguments.delta", { ...address, delta });
          await sleep(chunkDelayMs, () => closed);
          if (closed) return;
        }
        send("response.function_call_arguments.done", { ...address, arguments: item.arguments });
      } else {
        send("response.output_item.added", {
          output_index: outputIndex,
          item: { ...item, status: "in_progress", content: [] },
        });
        const contentAddress = { ...address, content_index: 0 };
        send("response.content_part.added", {
          ...contentAddress,
          part: { type: "output_text", text: "", annotations: [] },
        });
        for (const delta of chunk(reply.text)) {
          send("response.output_text.delta", { ...contentAddress, delta });
          await sleep(chunkDelayMs, () => closed);
          if (closed) return;
        }
        send("response.output_text.done", { ...contentAddress, text: reply.text });
        send("response.content_part.done", {
          ...contentAddress,
          part: { type: "output_text", text: reply.text, annotations: [] },
        });
      }
      send("response.output_item.done", { output_index: outputIndex, item });
    }
    send("response.completed", { response: responseObject("completed", output) });
    res.end();
  }

  async function pickReply(turn) {
    if (scripted !== null) return scripted.length > 0 ? scripted.shift() : undefined;
    if (typeof script === "function") return script(turn);
    return undefined;
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  const url = `http://${host}:${boundPort}`;
  const env = {
    AZURE_OPENAI_BASE_URL: `${url}${BASE_PATH}`,
    AZURE_OPENAI_API_KEY: apiKey,
    AZURE_OPENAI_API_VERSION: "v1",
  };

  let closing = null;
  return {
    url,
    port: boundPort,
    baseUrl: env.AZURE_OPENAI_BASE_URL,
    env,
    apiKey,
    providerId: FAKE_PROVIDER_ID,
    modelId,
    reasoningLevel: FAKE_REASONING_LEVEL,
    pin: { providerId: FAKE_PROVIDER_ID, modelId, reasoningLevel: FAKE_REASONING_LEVEL },
    requests,
    close() {
      closing ??= new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}

/**
 * What the person typed, without what Volli wraps around it for the model: a
 * Ticket Session's first message carries `--- BEGIN TICKET BRIEF --- … ---
 * END TICKET BRIEF ---` (and SESSION TOOLS, RESOURCE …) blocks, sometimes
 * inside a `<ticket …>` element. The echo answers the person's words so a
 * driver can wait for `fake-agent: <what I typed>`; the full text still
 * reaches `requests`. Falls back to everything when nothing is left.
 */
export function spokenText(text) {
  const stripped = withoutElementTags(
    String(text).replace(/--- BEGIN ([A-Z][A-Z :_-]*?) ---[\s\S]*?--- END \1 ---/g, ""),
  ).trim();
  return stripped.length > 0 ? stripped : String(text);
}

const isTagNameStart = (ch) => (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");

/**
 * Drops `<name …>` / `</name>` wrappers in one left-to-right pass. This is a
 * text normalizer for an echo, not an HTML sanitizer: its output is matched
 * by a test driver, never rendered. A `<` that does not open a tag, or a tag
 * left unclosed, is kept verbatim.
 */
function withoutElementTags(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "<") {
      const nameAt = text[i + 1] === "/" ? i + 2 : i + 1;
      const close = text.indexOf(">", nameAt);
      if (isTagNameStart(text[nameAt] ?? "") && close !== -1) {
        i = close + 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** The reply text for a user message under the default rules. */
export function defaultReplyText(text) {
  if (PLAN_MARKER.test(text)) {
    return [
      "fake-agent plan:",
      "",
      "## Plan",
      "",
      "1. Read the relevant files.",
      "2. Make the smallest change that works.",
      "3. Run the checks and report.",
      "",
      `Request: ${text}`,
    ].join("\n");
  }
  return `fake-agent: ${spokenText(text)}`;
}

function normalizeReply(raw, text, defaultDelayMs) {
  const slow = SLOW_MARKER.exec(text);
  const markerDelay = slow ? Number(slow[1]) : undefined;
  const fallbackDelay = markerDelay ?? defaultDelayMs;
  if (raw === undefined || raw === null)
    return { text: defaultReplyText(text), delayMs: fallbackDelay };
  if (typeof raw === "string") return { text: raw, delayMs: fallbackDelay };
  return {
    text: raw.text ?? (raw.toolCalls?.length > 0 ? "" : defaultReplyText(text)),
    ...(raw.toolCalls === undefined ? {} : { toolCalls: raw.toolCalls }),
    delayMs: raw.delayMs ?? fallbackDelay,
    ...(raw.status === undefined ? {} : { status: raw.status }),
    ...(raw.error === undefined ? {} : { error: raw.error }),
  };
}

/** The key the client presented: Azure sends `api-key`; plain OpenAI clients send a Bearer token. */
function presentedKey(req) {
  const header = req.headers["api-key"];
  if (typeof header === "string" && header.length > 0) return header;
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return undefined;
}

/** The text of the last `role: "user"` item of a Responses `input` (string or item array). */
export function lastUserText(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item?.role !== "user") continue;
    if (typeof item.content === "string") return item.content;
    if (Array.isArray(item.content)) {
      return item.content
        .filter(
          (part) =>
            part &&
            (part.type === "input_text" || part.type === "text") &&
            typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("\n");
    }
    return "";
  }
  return "";
}

function usageFor(body, replyText) {
  const inputTokens = Math.max(1, Math.ceil(JSON.stringify(body.input ?? "").length / 4));
  const outputTokens = Math.max(1, Math.ceil(replyText.length / 4));
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
  };
}

/** A few deltas: roughly four pieces, split on character count. */
function chunk(text) {
  if (text.length === 0) return [];
  const size = Math.max(1, Math.ceil(text.length / 4));
  const pieces = [];
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  return pieces;
}

function sleep(ms, cancelled) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (cancelled() || Date.now() - started >= ms) return resolve();
      setTimeout(tick, Math.min(50, ms - (Date.now() - started)));
    };
    tick();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

// ---- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.split("=", 2);
    const value = inline ?? argv[i + 1];
    const take = () => {
      if (inline === undefined) i++;
      return value;
    };
    if (flag === "--port") out.port = Number(take());
    else if (flag === "--host") out.host = take();
    else if (flag === "--delay") out.defaultDelayMs = Number(take());
    else if (flag === "--quiet") out.quiet = true;
  }
  return out;
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const provider = await startFakeProvider({
    port: Number.isFinite(args.port) ? args.port : 0,
    ...(args.host ? { host: args.host } : {}),
    ...(Number.isFinite(args.defaultDelayMs) ? { defaultDelayMs: args.defaultDelayMs } : {}),
    log: args.quiet ? undefined : (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`),
  });
  process.stdout.write(
    `${JSON.stringify({
      url: provider.url,
      port: provider.port,
      env: provider.env,
      providerId: provider.providerId,
      modelId: provider.modelId,
      reasoningLevel: provider.reasoningLevel,
      pin: provider.pin,
    })}\n`,
  );
  const stop = async () => {
    await provider.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
