/**
 * The cloud Session reads against a real HTTP server that speaks Convex's
 * functions API (`POST /api/query|action`) and, beside it, a signed-GET object
 * store: the runner's side end to end, through the real functions client and
 * Agent-token cache. The backend's own rules are `convex/`'s to test; this
 * server answers only what the reads ask, in the shapes the backend returns.
 */
import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { zstdCompressSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { EMPTY_SESSION_USAGE_SUMMARY } from "@volli/shared";
import type { AgentCommand, AgentRequest, AgentResponse } from "@volli/shared";

import { createAgentBackend } from "./agent-backend";
import { BUSY_MESSAGE } from "./board-verbs";
import { CloudContentionError, createCloudFunctionsClient } from "./functions-client";
import { cloudSessionRefusal, createCloudSessionReads } from "./session-reads";

const CALLER = "5e550000-0000-4000-8000-000000000001";
const TARGET = "7a26e700-0000-4000-8000-000000000002";
const CHILD = "c41d0000-0000-4000-8000-000000000003";
const TWIN_A = "dddd0000-0000-4000-8000-00000000000a";
const TWIN_B = "dddd0000-0000-4000-8000-00000000000b";
const PROJECT = "a0000000-0000-4000-8000-000000000001";
const OTHER_PROJECT = "a0000000-0000-4000-8000-000000000002";
const TICKET = "71000000-0000-4000-8000-000000000001";
const SEGMENT = "5e600000-0000-4000-8000-000000000001";

const NOW = 1_000_000;

const digest = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;

function row(id: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    projectId: PROJECT,
    ticketId: null,
    role: "project",
    parentSessionId: null,
    ownerUserId: "u0000000-0000-4000-8000-000000000001",
    origin: { kind: "user" },
    title: `Session ${id.slice(0, 4)}`,
    visibility: "shared",
    status: "open",
    turnActive: false,
    lastTurnOutcome: null,
    signal: null,
    stopped: null,
    needsUser: false,
    attentionCount: 0,
    placeRunnerId: "r0000000-0000-4000-8000-000000000002",
    model: null,
    usageTotals: {
      costUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      coverage: "unavailable",
      summary: EMPTY_SESSION_USAGE_SUMMARY,
    },
    listing: { activity: "idle", waitingOn: null, live: false, bornTicketless: true },
    createdAt: NOW - 5_000,
    lastActivityAt: NOW - 1_000,
    ...fields,
  };
}

function view(overrides: Record<string, unknown> = {}) {
  return {
    session: { id: TARGET, projectId: PROJECT },
    status: "open",
    latestTurnId: "turn-1",
    latestTurnOrigin: { kind: "session", sessionId: CALLER },
    turnActive: false,
    lastTurnOutcome: "completed",
    lastTurnStopDetail: null,
    liveAttachment: null,
    pendingExecutorStartId: null,
    attention: { active: [], primary: null, dropped: 0 },
    interactions: { active: [], dropped: 0 },
    needsUser: false,
    signal: { signal: "done", reason: "Shipped.", occurredAt: NOW - 2_000 },
    stopped: null,
    modelSelection: { providerId: "openai", modelId: "gpt-5", reasoningLevel: "high" },
    modelTier: "fast",
    modelAuto: null,
    usage: { ...EMPTY_SESSION_USAGE_SUMMARY, inputTokens: 10, outputTokens: 5 },
    todoList: null,
    latestReply: null,
    resumedAfterStop: false,
    lastActivityAt: NOW - 1_000,
    bornTicketless: true,
    throughSequence: 6,
    truncated: false,
    ...overrides,
  };
}

function envelope(sessionId: string, sequence: number, payload: Record<string, unknown>) {
  return {
    id: `event-${sequence}`,
    sessionId,
    sequence,
    occurredAt: NOW - 10_000 + sequence,
    recordedAt: NOW - 10_000 + sequence,
    provenance: { source: { kind: "system", id: "session-runtime", detail: null }, venue: null },
    payload,
  };
}

const turn = (sessionId: string, sequence: number, kind: "turn.started" | "turn.completed") =>
  envelope(sessionId, sequence, { kind, attachmentId: "attach-1", turnId: "turn-1" });

const referenced = (sessionId: string, sequence: number, bodyNumber: number) =>
  envelope(sessionId, sequence, {
    kind: "transcript.referenced",
    attachmentId: null,
    turnId: "turn-1",
    reference: { id: digest(bodyNumber), mediaType: null, digest: digest(bodyNumber) },
  });

function body(id: string, role: "user" | "assistant", text: string) {
  return JSON.stringify({
    attemptId: "attempt-1",
    branchId: "branch-1",
    message: { id, role, parts: [{ type: "text", text }] },
    threadId: "thread-1",
    turnId: "turn-1",
    version: 1,
  });
}

interface Call {
  kind: string;
  path: string;
  args: Record<string, unknown>;
}

type Answer = { value: unknown } | { error: { code: string; message: string } };

/** The world the fake backend answers from. */
function world() {
  // TARGET: a user message (staged inline), a spilled assistant message, a
  // packed one, and the final assistant answer, packed too.
  const events = [
    turn(TARGET, 1, "turn.started"),
    referenced(TARGET, 2, 1),
    referenced(TARGET, 3, 2),
    referenced(TARGET, 4, 3),
    referenced(TARGET, 5, 4),
    turn(TARGET, 6, "turn.completed"),
  ];
  const pack = [
    JSON.stringify({
      format: "volli.transcript-pack/1",
      sessionId: TARGET,
      firstSequence: 4,
      lastSequence: 6,
      turnIds: ["turn-1"],
      createdAt: 0,
      artifactCount: 2,
      enc: null,
    }),
    `{"digest":"${digest(3)}","mediaType":"application/json","bytes":1,"body":${body("m3", "assistant", "Looking at the code.")}}`,
    `{"digest":"${digest(4)}","mediaType":"application/json","bytes":1,"body":${body("m4", "assistant", "The whole answer:\nline two, in full.")}}`,
  ]
    .map((line) => `${line}\n`)
    .join("");
  const packBytes = zstdCompressSync(Buffer.from(pack));
  return {
    rows: [
      row(TARGET, {
        ticketId: TICKET,
        role: "ticket",
        origin: { kind: "session", sessionId: CALLER },
        title: "Fix the thing",
        listing: { activity: "idle", waitingOn: null, live: true, bornTicketless: false },
        lastActivityAt: NOW - 1_000,
      }),
      row(CHILD, {
        role: "subagent",
        parentSessionId: TARGET,
        origin: { kind: "session", sessionId: TARGET },
        listing: { activity: "working", waitingOn: null, live: true, bornTicketless: true },
        lastActivityAt: NOW - 500,
      }),
      row(CALLER, { lastActivityAt: NOW - 3 * 24 * 60 * 60 * 1000 }),
    ],
    otherRows: [
      row(TWIN_A, { projectId: OTHER_PROJECT }),
      row(TWIN_B, { projectId: OTHER_PROJECT }),
    ],
    views: new Map<string, unknown>([[TARGET, view()]]),
    events: new Map<string, ReturnType<typeof envelope>[]>([[TARGET, events]]),
    staged: new Map<string, unknown>([
      [digest(1), { status: "inline", body: body("m1", "user", "Please fix it.") }],
      [digest(2), { status: "spilled" }],
    ]),
    objects: new Map<string, Buffer>([
      [`spill-${digest(2)}`, zstdCompressSync(Buffer.from(body("m2", "assistant", "On it.")))],
      [`pack-${SEGMENT}`, packBytes],
    ]),
    segments: [
      {
        segmentId: SEGMENT,
        firstSequence: 4,
        lastSequence: 6,
        sha256: createHash("sha256").update(packBytes).digest("hex"),
      },
    ],
    storage: true,
  };
}

interface FakeBackend {
  url: string;
  calls: Call[];
  state: ReturnType<typeof world>;
  close(): Promise<void>;
}

const backends: FakeBackend[] = [];

async function fakeBackend(): Promise<FakeBackend> {
  const state = world();
  const calls: Call[] = [];
  let url = "";
  const answer = ({ path, args }: Call): Answer => {
    const sessionId = String(args["sessionId"]);
    switch (path) {
      case "agentTokens:mint":
        return { value: { token: `agent-${sessionId}`, expiresAt: 900_000, serverTime: 0 } };
      case "projects:listForActor":
        return {
          value: {
            projects: [
              { id: PROJECT, name: "Volli Code", ticketPrefix: "VC", archivedAt: null },
              { id: OTHER_PROJECT, name: "Website", ticketPrefix: "WEB", archivedAt: null },
            ],
            current: PROJECT,
          },
        };
      case "board:roster":
        return {
          value: {
            tickets: args["projectId"] === PROJECT ? [{ id: TICKET, number: 7 }] : [],
            labels: [],
          },
        };
      case "board:resolveTicketKey":
        return args["key"] === "VC-7"
          ? { value: { ticketId: TICKET, projectId: PROJECT, key: "VC-7" } }
          : { error: { code: "not_found", message: `No ticket ${String(args["key"])}.` } };
      case "sessions:list": {
        const all = (args["projectId"] === PROJECT ? state.rows : state.otherRows)
          .filter((r) => args["ticketId"] === undefined || r.ticketId === args["ticketId"])
          .toSorted((a, b) => b.lastActivityAt - a.lastActivityAt);
        const { numItems, cursor } = args["paginationOpts"] as {
          numItems: number;
          cursor: string | null;
        };
        const start = cursor === null ? 0 : Number(cursor);
        const page = all.slice(start, start + numItems);
        const next = start + page.length;
        return {
          value: { page, isDone: next >= all.length, continueCursor: String(next) },
        };
      }
      case "sessions:snapshot": {
        const found = [...state.rows, ...state.otherRows].find((r) => r.id === sessionId);
        if (found === undefined) {
          return { error: { code: "not_found", message: "That session does not exist." } };
        }
        const folded = state.views.get(sessionId);
        return {
          value: {
            session: found,
            foldedThrough: 6,
            catchingUp: false,
            state: folded === undefined ? null : JSON.stringify(folded),
          },
        };
      }
      case "sessions:history": {
        const all = state.events.get(sessionId) ?? [];
        const before = Number(args["beforeSequence"]);
        const limit = Number(args["limit"]);
        const older = all.filter((event) => event.sequence < before);
        const page = older.slice(-limit);
        return {
          value: {
            events: page.map((event) => ({
              sequence: event.sequence,
              eventId: event.id,
              kind: event.payload["kind"],
              status: "ok",
              quarantine: null,
              event: JSON.stringify(event),
            })),
            hasMore: older.length > page.length,
          },
        };
      }
      case "sessionTranscript:artifacts":
        return {
          value: (args["digests"] as string[]).map((d) =>
            Object.assign({ digest: d }, state.staged.get(d) ?? { status: "absent" }),
          ),
        };
      case "sessionTranscript:segments": {
        const before = Number(args["beforeSequence"]);
        return {
          value: {
            segments: state.segments.filter((segment) => segment.firstSequence < before),
            hasMore: false,
            packedThrough: 6,
          },
        };
      }
      case "sessionTranscript:presignGet": {
        if (!state.storage) {
          return {
            error: {
              code: "storage_unconfigured",
              message: "Object storage is not configured on this deployment.",
            },
          };
        }
        const object = args["object"] as { kind: string; segmentId?: string; digest?: string };
        const key = object.kind === "pack" ? `pack-${object.segmentId}` : `spill-${object.digest}`;
        if (!state.objects.has(key)) return { value: { status: "absent" } };
        return {
          value: {
            status: "sign",
            request: {
              method: "GET",
              url: `${url}/objects/${encodeURIComponent(key)}`,
              headers: { "x-amz-test": "signed" },
              expiresAt: NOW + 300_000,
            },
            bytes: null,
            sha256: null,
          },
        };
      }
      default:
        return { error: { code: "server_error", message: `No function ${path}` } };
    }
  };
  const server: Server = createServer((incoming, response: ServerResponse) => {
    if (incoming.method === "GET" && (incoming.url ?? "").startsWith("/objects/")) {
      const key = decodeURIComponent((incoming.url ?? "").slice("/objects/".length));
      const bytes = state.objects.get(key);
      if (bytes === undefined || incoming.headers["x-amz-test"] !== "signed") {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
      return;
    }
    let raw = "";
    incoming.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    incoming.on("end", () => {
      const parsed = JSON.parse(raw) as { path: string; args: Record<string, unknown> };
      const call: Call = {
        kind: (incoming.url ?? "").replace("/api/", ""),
        path: parsed.path,
        args: parsed.args,
      };
      calls.push(call);
      const result = answer(call);
      response.writeHead("value" in result ? 200 : 400, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          "value" in result
            ? { status: "success", value: result.value }
            : { status: "error", errorMessage: result.error.message, errorData: result.error },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const backend: FakeBackend = {
    url,
    calls,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  backends.push(backend);
  return backend;
}

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
});

async function readsOver(options: { connected?: () => boolean } = {}) {
  const backend = await fakeBackend();
  const reads = createCloudSessionReads({
    backend: createAgentBackend({
      functions: createCloudFunctionsClient({ url: backend.url, timeoutMs: 2_000 }),
      runnerToken: async () => "runner-token",
      connected: options.connected ?? (() => true),
      // One clock for the verb's deadline and the backend's budget against it.
      now: () => NOW,
    }),
    runnerName: "Hussain's Mac",
    now: () => NOW,
  });
  return { backend, reads };
}

function request(cmd: AgentCommand, args: Record<string, unknown> = {}): AgentRequest {
  return { v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: {} } };
}

function data(response: AgentResponse): Record<string, unknown> {
  if (!response.ok) throw new Error(`refused: ${response.error.code} ${response.error.message}`);
  return response.data as Record<string, unknown>;
}

function code(response: AgentResponse): string {
  if (response.ok) throw new Error("expected a refusal");
  return response.error.code;
}

describe("cloudSessionRefusal", () => {
  it("a command that kept losing to concurrent writes is BUSY: nothing applied, safe to send again", () => {
    expect(cloudSessionRefusal(new CloudContentionError("sessions:command: busy"))).toMatchObject({
      ok: false,
      error: { code: "BUSY", message: BUSY_MESSAGE },
    });
  });
});

describe("cloud session list", () => {
  it("lists the caller's project in the local wire shape, short handles only", async () => {
    const { reads, backend } = await readsOver();
    const listed = data(
      await reads["session.list"]({ sessionId: CALLER, request: request("session.list") }),
    );
    const sessions = listed["sessions"] as Record<string, unknown>[];
    // Newest activity first; the caller's own Session is older than a day.
    expect(sessions.map((s) => s["id"])).toEqual(["c41d0000", "7a26e700"]);
    expect(listed["hidden"]).toBe(1);
    expect(listed).not.toHaveProperty("truncated");
    expect(sessions[1]).toMatchObject({
      kind: "chat",
      role: "ticket",
      ticket: "VC-7",
      title: "Fix the thing",
      status: "idle",
      waitingOn: null,
      interruptedReason: null,
      pendingSubagents: ["c41d0000"],
      live: true,
      lastActivityAgeMs: 1_000,
      ageMs: 5_000,
      startedBy: { kind: "session", parentSessionId: "5e550000" },
      tokens: 0,
    });
    // Nothing internal crosses: no full ids, no runner or owner ids.
    expect(JSON.stringify(listed)).not.toContain(TARGET);
    expect(JSON.stringify(listed)).not.toContain("placeRunnerId");
    // A read writes nothing.
    expect(backend.calls.filter((call) => call.kind === "mutation")).toEqual([]);
  });

  it("filters by ticket and state, and refuses an unknown state", async () => {
    const { reads } = await readsOver();
    const byTicket = data(
      await reads["session.list"]({
        sessionId: CALLER,
        request: request("session.list", { ticket: "VC-7", all: true }),
      }),
    );
    expect((byTicket["sessions"] as unknown[]).length).toBe(1);
    const working = data(
      await reads["session.list"]({
        sessionId: CALLER,
        request: request("session.list", { state: ["working"] }),
      }),
    );
    expect((working["sessions"] as Record<string, unknown>[]).map((s) => s["id"])).toEqual([
      "c41d0000",
    ]);
    expect(
      code(
        await reads["session.list"]({
          sessionId: CALLER,
          request: request("session.list", { state: ["asleep"] }),
        }),
      ),
    ).toBe("INVALID_REQUEST");
    expect(
      code(
        await reads["session.list"]({
          sessionId: CALLER,
          request: request("session.list", { ticket: "VC-7", project: "Website" }),
        }),
      ),
    ).toBe("CONTEXT_MISMATCH");
  });

  it("asks a caller with no Session to be one, and answers OFFLINE without a request", async () => {
    const signedOut = await readsOver();
    expect(
      code(
        await signedOut.reads["session.list"]({
          sessionId: null,
          request: request("session.list"),
        }),
      ),
    ).toBe("SIGN_IN_REQUIRED");
    const offline = await readsOver({ connected: () => false });
    const response = await offline.reads["session.peek"]({
      sessionId: CALLER,
      request: request("session.peek", { id: "7a26e700" }),
    });
    expect(code(response)).toBe("OFFLINE");
    expect(offline.backend.calls).toEqual([]);
  });
});

describe("resolveTarget", () => {
  it("finds a short handle and returns the supervision fields", async () => {
    const { reads } = await readsOver();
    const resolved = await reads.resolveTarget(CALLER, "c41d0000");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.target).toMatchObject({
      id: CHILD,
      projectId: PROJECT,
      role: "subagent",
      parentSessionId: TARGET,
      title: "Session c41d",
      stopped: null,
      activity: "working",
    });
  });

  it("names an ambiguity, a miss, and reads a full id directly", async () => {
    const { reads } = await readsOver();
    const twin = await reads.resolveTarget(CALLER, "dddd0000");
    expect(twin.ok).toBe(false);
    if (twin.ok) return;
    expect(code(twin.response)).toBe("AMBIGUOUS_CONTEXT");
    expect(twin.response.ok ? null : twin.response.error.next).toContain("Website");
    const miss = await reads.resolveTarget(CALLER, "00000000");
    expect(miss.ok ? null : code(miss.response)).toBe("SESSION_NOT_FOUND");
    const scoped = await reads.resolveTarget(CALLER, "dddd0000", PROJECT);
    expect(scoped.ok ? null : code(scoped.response)).toBe("SESSION_NOT_FOUND");
    const full = await reads.resolveTarget(CALLER, TARGET);
    expect(full.ok && full.target.id).toBe(TARGET);
    const bad = await reads.resolveTarget(CALLER, "");
    expect(bad.ok ? null : code(bad.response)).toBe("INVALID_REQUEST");
  });
});

describe("cloud session show", () => {
  it("answers the fold's cells, its family, and leaves out what the cloud does not keep", async () => {
    const { reads } = await readsOver();
    const shown = data(
      await reads["session.show"]({
        sessionId: CALLER,
        request: request("session.show", { id: "7a26e700" }),
      }),
    );
    expect(shown).toMatchObject({
      id: "7a26e700",
      kind: "chat",
      status: "idle",
      role: "ticket",
      project: "Volli Code",
      ticket: "VC-7",
      signal: { kind: "done", reason: "Shipped.", ageMs: 2_000 },
      pendingQuestions: [],
      interruptedReason: null,
      startedBy: { kind: "session", parentSessionId: "5e550000", parentTitle: "Session 5e55" },
      parentSession: null,
      children: [{ id: "c41d0000", role: "subagent", status: "working" }],
      pendingSubagents: ["c41d0000"],
      latestTurn: { origin: { kind: "session", sessionId: "5e550000" }, resumedAfterStop: false },
      model: "openai/gpt-5",
      reasoning: "high",
      tier: "fast",
      tokens: 15,
    });
    expect(shown).not.toHaveProperty("resumptions");
    expect(shown).not.toHaveProperty("latestAttachment");
  });
});

describe("cloud session peek", () => {
  it("hydrates staged, spilled and packed bodies into the transcript tail", async () => {
    const { reads, backend } = await readsOver();
    const peek = data(
      await reads["session.peek"]({
        sessionId: CALLER,
        request: request("session.peek", { id: "7a26e700" }),
      }),
    );
    expect(peek).toMatchObject({
      session: "7a26e700",
      status: "idle",
      lastTurnOutcome: "completed",
      turns: 1,
      turnDepth: 4,
      messages: 4,
      unreadable: 0,
      historyComplete: true,
      attention: null,
      stopped: null,
    });
    expect(
      (peek["transcript"] as Record<string, unknown>[]).map((entry) => [
        entry["role"],
        entry["text"],
      ]),
    ).toEqual([
      ["user", "Please fix it."],
      ["assistant", "On it."],
      ["assistant", "Looking at the code."],
      ["assistant", "The whole answer: line two, in full."],
    ]);
    // The runner-local queue is not the cloud's: not answered, not zero.
    expect(peek).not.toHaveProperty("pendingMessageCount");
    // One staging read for the window, one pack download for two bodies.
    expect(backend.calls.filter((c) => c.path === "sessionTranscript:artifacts").length).toBe(1);
    expect(backend.calls.filter((c) => c.path === "sessionTranscript:presignGet").length).toBe(2);
  });

  it("counts a body no store holds as unreadable, with the reason", async () => {
    const { reads, backend } = await readsOver();
    backend.state.storage = false;
    const peek = data(
      await reads["session.peek"]({
        sessionId: CALLER,
        request: request("session.peek", { id: "7a26e700" }),
      }),
    );
    expect(peek["unreadable"]).toBe(3);
    expect(String(peek["unreadableReason"])).toContain("no object storage");
    expect((peek["transcript"] as unknown[]).length).toBe(1);
  });

  it("refuses, retryably, a Session the backend has not folded yet", async () => {
    const { reads, backend } = await readsOver();
    backend.state.views.delete(TARGET);
    expect(
      code(
        await reads["session.peek"]({
          sessionId: CALLER,
          request: request("session.peek", { id: "7a26e700" }),
        }),
      ),
    ).toBe("NOT_YET_SYNCED");
  });

  it("reports life-long counts as unknown when history is longer than the window", async () => {
    const { reads, backend } = await readsOver();
    const long: ReturnType<typeof envelope>[] = [];
    // Past the read's bound: ten pages of 200 facts.
    const total = 10 * 200 + 50;
    for (let sequence = 1; sequence <= total; sequence += 1) {
      long.push(turn(TARGET, sequence, sequence % 2 === 1 ? "turn.started" : "turn.completed"));
    }
    backend.state.events.set(TARGET, long);
    const peek = data(
      await reads["session.peek"]({
        sessionId: CALLER,
        request: request("session.peek", { id: "7a26e700" }),
      }),
    );
    expect(peek).toMatchObject({ historyComplete: false, turns: null, messages: null });
    const answer = data(
      await reads["session.answer"]({
        sessionId: CALLER,
        request: request("session.answer", { id: "7a26e700" }),
      }),
    );
    // Not "it said nothing": its last message is older than this read reaches.
    expect(answer).toMatchObject({ answer: null, unreadable: true, turns: null });
    expect(String(answer["unreadableReason"])).toContain("older than");
  });
});

describe("cloud session answer", () => {
  it("reads the final assistant message in full from its pack", async () => {
    const { reads } = await readsOver();
    const answer = data(
      await reads["session.answer"]({
        sessionId: CALLER,
        request: request("session.answer", { id: "7a26e700" }),
      }),
    );
    expect(answer).toEqual({
      session: "7a26e700",
      role: "ticket",
      title: "Fix the thing",
      state: "completed",
      signal: { kind: "done", reason: "Shipped.", at: NOW - 2_000, ageMs: 2_000 },
      turns: 1,
      unreadable: false,
      historyComplete: true,
      answer: "The whole answer:\nline two, in full.",
    });
  });

  it("says why an answer could not be read rather than that none was given", async () => {
    const { reads, backend } = await readsOver();
    backend.state.storage = false;
    const answer = data(
      await reads["session.answer"]({
        sessionId: CALLER,
        request: request("session.answer", { id: "7a26e700" }),
      }),
    );
    expect(answer).toMatchObject({ answer: null, unreadable: true });
    expect(String(answer["unreadableReason"])).toContain("no object storage");
  });

  it("refuses a handle no visible Session has", async () => {
    const { reads } = await readsOver();
    expect(
      code(
        await reads["session.answer"]({
          sessionId: CALLER,
          request: request("session.answer", { id: "ffffffff" }),
        }),
      ),
    ).toBe("SESSION_NOT_FOUND");
  });
});
