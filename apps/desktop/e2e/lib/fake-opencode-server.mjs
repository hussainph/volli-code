#!/usr/bin/env node
/**
 * Fake `opencode` binary for the chat Session e2e smoke.
 *
 * Impersonates just enough of the real OpenCode CLI's `--version` + `serve`
 * contract for `OpenCodeNativeAdapter` (packages/opencode-adapter/src/index.ts)
 * to verify it, spawn it, and drive a chat turn over it — copied from the wire
 * shapes the adapter's own test fakes already prove correct:
 * packages/opencode-adapter/src/index.test.ts's `FakeNetwork`/`FakeProcess`,
 * apps/desktop/src/renderer/lab/chat/delta-frames.integration.test.ts's
 * `ScriptedNetwork`, and packages/opencode-adapter/src/stream-cost.bench.test.ts.
 * This is not a general OpenCode simulator: one session, one scripted answer,
 * then idle.
 *
 * argv selects the mode, mirroring the real binary:
 *   --version                                  → print a version line, exit 0
 *   serve --hostname H --port N [--no-mdns]     → serve the HTTP + SSE API
 *
 * `main/index.ts` spawns the real port with `stdio: "ignore"`, so nothing this
 * process writes to stdout/stderr in `serve` mode is visible to the app or the
 * smoke — set VOLLI_FAKE_OPENCODE_LOG to an absolute file path to get an
 * append-only request/event log for debugging a failing run.
 *
 * Endpoint map (auth: HTTP Basic, `opencode:$OPENCODE_SERVER_PASSWORD` — the
 * same credential the adapter's spawn env carries):
 *   GET  /global/health                     → { healthy, version }
 *   POST /session                           → { id }  (title ignored, stored)
 *   GET  /session/:id                       → { id, title } | 404
 *   POST /session/:id/prompt_async          → 204, then streams the scripted
 *                                              answer over SSE and goes idle
 *   GET  /session/:id/message               → the settled answer, once it has
 *                                              one (reconcile/hydrate shape)
 *   GET  /session/:id/todo                  → []
 *   POST /session/:id/abort                 → {}
 *   GET  /session/status                    → { [id]: { type: "idle"|"busy" } }
 *   GET  /permission | /question            → []  (nothing ever asks)
 *   POST /permission/:id/reply
 *   POST /question/:id/reply|reject         → {}  (unreachable in this script)
 *   GET  /provider                          → one provider, one model, connected
 *   GET  /agent | /command | /skill         → []
 *   GET  /mcp                               → {}
 *   GET  /experimental/tool/ids             → []
 *   GET  /event                             → the SSE stream every session
 *                                              broadcasts to (?directory= is
 *                                              accepted and ignored, like every
 *                                              other endpoint's scope query)
 */
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const FAKE_VERSION = "1.17.18-fake";
const PROVIDER_ID = "fake-provider";
const MODEL_ID = "fake-model";
const MODEL_LABEL = "Fake Model";
const TEXT_PART_ID = "answer";
const CHUNK_DELAY_MS = 60;

// Kept byte-for-byte in sync with ANSWER_TEXT in session-chat-smoke.mjs, which
// asserts this exact string renders and settles — the two files don't share an
// import (this one runs as a spawned binary, argv-dispatched; importing it
// would re-trigger that dispatch against the smoke's own argv).
const ANSWER_CHUNKS = [
  "This is a fake OpenCode answer, ",
  "streamed in three pieces, ",
  "and now it settles.",
];

function log(...parts) {
  const target = process.env.VOLLI_FAKE_OPENCODE_LOG;
  if (!target) return;
  try {
    appendFileSync(target, `[${new Date().toISOString()}] ${parts.join(" ")}\n`);
  } catch {
    // Best-effort debugging aid only.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- argv dispatch -----------------------------------------------------

const args = process.argv.slice(2);

if (args[0] === "--version") {
  process.stdout.write(`${FAKE_VERSION}\n`);
  process.exit(0);
}

if (args[0] !== "serve") {
  process.stderr.write(`fake-opencode-server: unsupported argv ${JSON.stringify(args)}\n`);
  process.exit(1);
}

function flagValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
}

const hostname = flagValue("--hostname") ?? "127.0.0.1";
const port = Number(flagValue("--port") ?? "0");

// ---- session state -------------------------------------------------------

/** @type {Map<string, {id:string, title:string|null, status:"idle"|"busy", assistantMessageId:string|null, text:string}>} */
const sessions = new Map();
const sseClients = new Set();
let eventSequence = 0;

function nextEventId(kind) {
  eventSequence += 1;
  return `fake:${kind}:${eventSequence}`;
}

function broadcast(type, properties) {
  const event = { id: nextEventId(type), type, properties };
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(payload);
  log("sse", type, JSON.stringify(properties));
}

async function runScriptedTurn(session) {
  const messageId = randomUUID();
  session.status = "busy";
  session.assistantMessageId = messageId;
  session.text = "";
  broadcast("message.updated", {
    info: { id: messageId, sessionID: session.id, role: "assistant" },
  });
  for (const chunk of ANSWER_CHUNKS) {
    await sleep(CHUNK_DELAY_MS);
    session.text += chunk;
    broadcast("message.part.delta", {
      sessionID: session.id,
      messageID: messageId,
      partID: TEXT_PART_ID,
      field: "text",
      delta: chunk,
    });
  }
  await sleep(CHUNK_DELAY_MS);
  session.status = "idle";
  broadcast("session.idle", { sessionID: session.id });
}

// ---- HTTP plumbing ---------------------------------------------------------

function isAuthorized(req) {
  const expectedUser = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
  const expectedPass = process.env.OPENCODE_SERVER_PASSWORD ?? "";
  const header = req.headers["authorization"];
  if (!header) return false;
  const expected = `Basic ${Buffer.from(`${expectedUser}:${expectedPass}`).toString("base64")}`;
  return header === expected;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === null ? "" : JSON.stringify(body));
}

function providerCatalogBody() {
  return {
    all: [
      {
        id: PROVIDER_ID,
        models: {
          [MODEL_ID]: { id: MODEL_ID, name: MODEL_LABEL },
        },
      },
    ],
    connected: [PROVIDER_ID],
  };
}

function messageResponseBody(session) {
  if (!session.assistantMessageId) return [];
  return [
    {
      info: { id: session.assistantMessageId, sessionID: session.id, role: "assistant" },
      parts: [
        {
          id: TEXT_PART_ID,
          messageID: session.assistantMessageId,
          type: "text",
          text: session.text,
        },
      ],
    },
  ];
}

function statusBody() {
  const body = {};
  for (const session of sessions.values()) body[session.id] = { type: session.status };
  return body;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${hostname}:${port}`);
  const pathname = url.pathname;
  const method = req.method ?? "GET";
  log("request", method, pathname);

  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (method === "GET" && pathname === "/global/health") {
    sendJson(res, 200, { healthy: true, version: FAKE_VERSION });
    return;
  }

  if (method === "GET" && pathname === "/event") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(":ok\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (method === "POST" && pathname === "/session") {
    const body = (await readJsonBody(req)) ?? {};
    const id = randomUUID();
    sessions.set(id, {
      id,
      title: typeof body.title === "string" ? body.title : null,
      status: "idle",
      assistantMessageId: null,
      text: "",
    });
    log("session created", id);
    sendJson(res, 200, { id });
    return;
  }

  if (method === "GET" && pathname === "/session/status") {
    sendJson(res, 200, statusBody());
    return;
  }

  if (method === "GET" && pathname === "/provider") {
    sendJson(res, 200, providerCatalogBody());
    return;
  }
  if (
    method === "GET" &&
    (pathname === "/agent" || pathname === "/command" || pathname === "/skill")
  ) {
    sendJson(res, 200, []);
    return;
  }
  if (method === "GET" && pathname === "/mcp") {
    sendJson(res, 200, {});
    return;
  }
  if (method === "GET" && pathname === "/experimental/tool/ids") {
    sendJson(res, 200, []);
    return;
  }
  if (method === "GET" && (pathname === "/permission" || pathname === "/question")) {
    sendJson(res, 200, []);
    return;
  }

  const sessionMatch = pathname.match(/^\/session\/([^/]+)(\/.*)?$/);
  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const rest = sessionMatch[2] ?? "";
    const session = sessions.get(sessionId);

    if (method === "GET" && rest === "") {
      if (!session) return sendJson(res, 404, { error: "not found" });
      return sendJson(res, 200, { id: session.id, title: session.title });
    }
    if (method === "POST" && rest === "/prompt_async") {
      if (!session) return sendJson(res, 404, { error: "not found" });
      await readJsonBody(req); // drained, ignored — the script answers the same regardless of prompt text
      res.writeHead(204);
      res.end();
      log("prompt_async", sessionId);
      void runScriptedTurn(session).catch((error) => log("turn failed", String(error)));
      return;
    }
    if (method === "GET" && rest === "/message") {
      return sendJson(res, 200, session ? messageResponseBody(session) : []);
    }
    if (method === "GET" && rest === "/todo") {
      return sendJson(res, 200, []);
    }
    if (method === "POST" && rest === "/abort") {
      if (session) session.status = "idle";
      return sendJson(res, 200, {});
    }
  }

  if (method === "POST" && /^\/(permission|question)\/[^/]+\/(reply|reject)$/.test(pathname)) {
    sendJson(res, 200, {});
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(port, hostname, () => {
  log("listening", `${hostname}:${port}`);
});
