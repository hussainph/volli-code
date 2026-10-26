/**
 * The cloud board verbs against a real HTTP server that speaks Convex's
 * functions API (`POST /api/query|mutation|action`), holding a small board in
 * memory: the runner's side end to end, through the real client and the real
 * Agent-token cache. The backend's own rules are `convex/`'s to test; this
 * server answers only what the verbs read and records what they write.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";

import type { AgentCommand, AgentRequest, AgentResponse } from "@volli/shared";

import { createAgentBackend } from "./agent-backend";
import { createCloudBoardVerbs, type CloudBoardVerbs } from "./board-verbs";
import { createCloudFunctionsClient } from "./functions-client";

const SESSION = "5e550000-0000-4000-8000-000000000001";
const PROJECT = "a0000000-0000-4000-8000-000000000001";
const OTHER_PROJECT = "a0000000-0000-4000-8000-000000000002";
const T1 = "71000000-0000-4000-8000-000000000001";
const T2 = "71000000-0000-4000-8000-000000000002";
const L1 = "1a000000-0000-4000-8000-000000000001";
const L2 = "1a000000-0000-4000-8000-000000000002";
const L3 = "1a000000-0000-4000-8000-000000000003";

interface Call {
  kind: string;
  path: string;
  args: Record<string, unknown>;
  token: string;
}

function ticket(id: string, number: number, fields: Record<string, unknown> = {}) {
  return {
    id,
    projectId: PROJECT,
    number,
    title: `Ticket ${number}`,
    status: "todo",
    priority: "medium",
    position: `a${number}`,
    labelIds: [],
    checkoutMode: "worktree",
    preferredHarnessId: "pi",
    branch: null,
    baseBranch: null,
    createdAt: 10,
    updatedAt: 20,
    archivedAt: null,
    ...fields,
  };
}

/** A small board, as the backend's functions would answer it. */
function boardState() {
  return {
    projects: [
      { id: PROJECT, name: "Volli Code", ticketPrefix: "VC", archivedAt: null },
      { id: OTHER_PROJECT, name: "Website", ticketPrefix: "WEB", archivedAt: null },
    ],
    tickets: [
      ticket(T1, 1, { labelIds: [L1, L3], status: "doing", position: "a1" }),
      ticket(T2, 2, { priority: "high", position: "a0" }),
    ] as ReturnType<typeof ticket>[],
    bodies: new Map<string, string>([
      [T1, "Do the thing."],
      [T2, ""],
    ]),
    labels: [
      { id: L1, name: "front-end", mergedIntoId: null },
      { id: L2, name: "api", mergedIntoId: null },
      { id: L3, name: "fe", mergedIntoId: L1 },
    ],
    events: [
      {
        seq: 1,
        ticketId: T1,
        kind: "created",
        actor: { kind: "person", userId: "u" },
        occurredAt: 11,
        payload: { kind: "created" },
      },
      {
        seq: 2,
        ticketId: T1,
        kind: "commented",
        actor: { kind: "agent", userId: "u", sessionId: SESSION, ticketId: T1 },
        occurredAt: 12,
        payload: { kind: "commented", commentId: "c0000000-0000-4000-8000-000000000001" },
      },
      {
        seq: 3,
        ticketId: T1,
        kind: "session_started",
        actor: { kind: "agent", userId: "u", sessionId: SESSION, ticketId: T2 },
        occurredAt: 13,
        payload: {
          kind: "session_started",
          sessionId: SESSION,
          origin: { kind: "session", sessionId: SESSION },
        },
      },
      {
        seq: 4,
        ticketId: T1,
        kind: "session_resumed",
        actor: {
          kind: "agent",
          userId: "u",
          sessionId: SESSION,
          ticketId: "71000000-0000-4000-8000-0000000000ff",
        },
        occurredAt: 14,
        payload: {
          kind: "session_resumed",
          sessionId: "not-a-uuid",
          attachmentId: "abcdef0123456789",
          origin: null,
          runnerId: "r0000000-0000-4000-8000-000000000001",
        },
      },
    ],
    comments: [
      {
        body: "First.",
        author: { kind: "person", userId: "u" },
        sessionId: null,
        createdAt: 13,
        editedAt: null,
      },
      {
        body: "Second.",
        author: { kind: "agent", userId: "u", sessionId: SESSION },
        sessionId: SESSION,
        createdAt: 14,
        editedAt: 15,
      },
    ],
    signals: [
      { kind: "review", verdict: "fail", detail: null, sessionId: null, createdAt: 1 },
      { kind: "review", verdict: "pass", detail: "ok", sessionId: SESSION, createdAt: 2 },
    ],
  };
}

type Answer =
  | { value: unknown }
  | { error: { code: string; message: string; [k: string]: unknown } };

interface FakeBackend {
  url: string;
  calls: Call[];
  state: ReturnType<typeof boardState>;
  /** Overrides one path's answer (for refusals and stalls). */
  override: Map<string, (call: Call) => Answer | "hang">;
  close(): Promise<void>;
}

const backends: FakeBackend[] = [];

async function fakeBackend(): Promise<FakeBackend> {
  const state = boardState();
  const calls: Call[] = [];
  const override = new Map<string, (call: Call) => Answer | "hang">();
  const answer = (call: Call): Answer => {
    const { path, args } = call;
    const byId = (id: unknown) => state.tickets.find((row) => row.id === id);
    switch (path) {
      case "agentTokens:mint":
        return {
          value: { token: `agent-${String(args["sessionId"])}`, expiresAt: 900_000, serverTime: 0 },
        };
      case "projects:listForActor":
        return { value: { projects: state.projects, current: PROJECT } };
      case "projects:get":
        return { value: state.projects.find((project) => project.id === args["projectId"]) };
      case "board:roster":
        return {
          value: {
            tickets: state.tickets.filter((row) => row.projectId === args["projectId"]),
            labels: state.labels,
          },
        };
      case "board:resolveTicketKey": {
        const match = /^VC-(\d+)$/.exec(String(args["key"]));
        const row = state.tickets.find((t) => match !== null && t.number === Number(match[1]));
        return row === undefined
          ? {
              error: {
                code: "not_found",
                message: `No ticket ${String(args["key"])} that you can see.`,
              },
            }
          : { value: { ticketId: row.id, projectId: row.projectId, key: `VC-${row.number}` } };
      }
      case "board:getTicket": {
        const row = byId(args["ticketId"]);
        if (row === undefined) return { error: { code: "not_found", message: "No such ticket." } };
        const names = row.labelIds
          .map((id) => state.labels.find((label) => label.id === id))
          .map((label) =>
            label?.mergedIntoId ? state.labels.find((l) => l.id === label.mergedIntoId) : label,
          )
          .map((label) => label!.name);
        return {
          value: {
            ticket: row,
            body: state.bodies.get(row.id) ?? "",
            bodyRevision: 1,
            labels: [...new Set(names)],
          },
        };
      }
      case "board:ticketEvents":
        return { value: state.events };
      case "board:comments":
        return { value: state.comments };
      case "board:signals":
        return { value: state.signals };
      case "board:labels":
        return {
          value: [
            { labelId: L1, name: "front-end", color: null, tickets: 1 },
            { labelId: L2, name: "api", color: "#fff", tickets: 0 },
          ],
        };
      case "board:labelMergePreview":
        return {
          value: {
            applied: false,
            from: args["from"],
            into: args["into"],
            ticketCount: 1,
            tickets: [{ ticketId: T1, key: "VC-1", title: "Ticket 1", archived: false }],
          },
        };
      case "board:mergeLabels":
        return { value: { from: args["from"], into: args["into"], applied: true } };
      case "board:archivedTickets": {
        // Two pages for this project, none for any other.
        const first = (args["paginationOpts"] as { cursor: string | null }).cursor === null;
        return {
          value:
            args["projectId"] !== PROJECT
              ? { page: [], isDone: true, continueCursor: "" }
              : first
                ? { page: [1, 2], isDone: false, continueCursor: "next" }
                : { page: [3], isDone: true, continueCursor: "" },
        };
      }
      case "board:createTicket": {
        const created = ticket(String(args["ticketId"]), state.tickets.length + 1, {
          title: args["title"],
          status: args["status"],
          priority: args["priority"],
        });
        state.tickets.push(created);
        state.bodies.set(created.id, String(args["body"] ?? ""));
        return {
          value: { ticketId: created.id, number: created.number, key: `VC-${created.number}` },
        };
      }
      case "board:updateTicket": {
        const row = byId(args["ticketId"])!;
        if (typeof args["title"] === "string") row.title = args["title"];
        return { value: { ticketId: row.id, changed: true } };
      }
      case "board:moveTickets": {
        for (const id of args["ticketIds"] as string[]) byId(id)!.status = String(args["toStatus"]);
        return { value: { moved: args["ticketIds"], unstartedRuns: [] } };
      }
      case "board:createComment":
        return { value: { commentId: args["commentId"], createdAt: 77 } };
      case "board:createSignal":
        return { value: { signalId: args["signalId"], createdAt: 78 } };
      default:
        return { error: { code: "server_error", message: `No function ${path}` } };
    }
  };
  const server: Server = createServer((incoming, response: ServerResponse) => {
    let raw = "";
    incoming.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    incoming.on("end", () => {
      const body = JSON.parse(raw) as { path: string; args: Record<string, unknown> };
      const call: Call = {
        kind: (incoming.url ?? "").replace("/api/", ""),
        path: body.path,
        args: body.args,
        token: (incoming.headers.authorization ?? "").replace("Bearer ", ""),
      };
      calls.push(call);
      const custom = override.get(call.path);
      const result = typeof custom === "function" ? custom(call) : answer(call);
      if (result === "hang") return;
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
  const backend: FakeBackend = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    state,
    override,
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

let ids = 0;

async function verbsOver(
  options: { connected?: () => boolean; timeoutMs?: number } = {},
): Promise<{ backend: FakeBackend; verbs: CloudBoardVerbs }> {
  const backend = await fakeBackend();
  const agentBackend = createAgentBackend({
    functions: createCloudFunctionsClient({
      url: backend.url,
      timeoutMs: options.timeoutMs ?? 2_000,
    }),
    runnerToken: async () => "runner-token",
    connected: options.connected ?? (() => true),
  });
  const verbs = createCloudBoardVerbs({
    backend: agentBackend,
    runnerName: "Hussain's Mac",
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    place: {
      projectPath: (projectId) => (projectId === PROJECT ? "/repo/volli" : null),
      worktreePath: (ticketId) => (ticketId === T1 ? "/repo/volli/.worktrees/vc-1" : null),
    },
  });
  return { backend, verbs };
}

function request(cmd: AgentCommand, args: Record<string, unknown> = {}): AgentRequest {
  return { v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: {} } };
}

function data(response: AgentResponse): Record<string, unknown> {
  if (!response.ok) throw new Error(`refused: ${response.error.code} ${response.error.message}`);
  return response.data as Record<string, unknown>;
}

const writes = (backend: FakeBackend) => backend.calls.filter((call) => call.kind === "mutation");

describe("cloud board reads", () => {
  it("board groups the roster by column in position order, with no bodies", async () => {
    const { verbs, backend } = await verbsOver();
    const board = data(await verbs.board({ sessionId: SESSION, request: request("board") }));
    expect(board["project"]).toEqual({ name: "Volli Code", prefix: "VC", path: "/repo/volli" });
    const columns = board["columns"] as Record<string, Record<string, unknown>[]>;
    expect(columns["doing"]!.map((row) => row["id"])).toEqual(["VC-1"]);
    expect(columns["todo"]!.map((row) => row["id"])).toEqual(["VC-2"]);
    expect(columns["doing"]![0]).toEqual({
      id: "VC-1",
      project: "Volli Code",
      title: "Ticket 1",
      status: "doing",
      priority: "medium",
      // An alias is worn as the label it was merged into, once.
      labels: ["front-end"],
      usesWorktree: true,
      harness: "pi",
      worktreePath: "/repo/volli/.worktrees/vc-1",
      branch: null,
      baseBranch: null,
      badge: null,
      createdAt: 10,
      updatedAt: 20,
    });
    // The Agent token was minted once, with the runner's token, then used.
    expect(backend.calls[0]).toMatchObject({
      kind: "action",
      path: "agentTokens:mint",
      token: "runner-token",
    });
    expect(backend.calls.slice(1).every((call) => call.token === `agent-${SESSION}`)).toBe(true);
  });

  it("ticket list filters by status, priority, label and limit, and refuses a bad filter", async () => {
    const { verbs } = await verbsOver();
    const list = async (args: Record<string, unknown>) =>
      (
        data(
          await verbs["ticket.list"]({ sessionId: SESSION, request: request("ticket.list", args) }),
        )["tickets"] as Record<string, unknown>[]
      ).map((row) => row["id"]);
    expect(await list({})).toEqual(["VC-2", "VC-1"]);
    expect(await list({ status: "doing" })).toEqual(["VC-1"]);
    expect(await list({ priority: "high" })).toEqual(["VC-2"]);
    expect(await list({ label: "FRONT-END" })).toEqual(["VC-1"]);
    // A retired name follows its merge; a name no label has matches nothing.
    expect(await list({ label: "fe" })).toEqual(["VC-1"]);
    expect(await list({ label: "nope" })).toEqual([]);
    await expect(
      verbs["ticket.list"]({ sessionId: SESSION, request: request("ticket.list", { body: "no" }) }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(await list({ limit: 1 })).toEqual(["VC-2"]);
    await expect(
      verbs["ticket.list"]({
        sessionId: SESSION,
        request: request("ticket.list", { status: "x" }),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  });

  it("ticket list takes --project by name or prefix, and says when none or several match", async () => {
    const { verbs, backend } = await verbsOver();
    await verbs["ticket.list"]({
      sessionId: SESSION,
      request: request("ticket.list", { project: "web" }),
    });
    expect(backend.calls.at(-1)).toMatchObject({
      path: "board:roster",
      args: { projectId: OTHER_PROJECT },
    });
    await expect(
      verbs["ticket.list"]({
        sessionId: SESSION,
        request: request("ticket.list", { project: "nope" }),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "PROJECT_NOT_FOUND" } });
    backend.state.projects.push({ id: PROJECT, name: "web", ticketPrefix: "W2", archivedAt: null });
    await expect(
      verbs["ticket.list"]({
        sessionId: SESSION,
        request: request("ticket.list", { project: "web" }),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "AMBIGUOUS_PROJECT" } });
  });

  it("ticket show answers the ticket, its standing signals and recent history", async () => {
    const { verbs } = await verbsOver();
    const shown = data(
      await verbs["ticket.show"]({
        sessionId: SESSION,
        request: request("ticket.show", { id: "VC-1", comments: 1, events: 4 }),
      }),
    );
    expect(shown["ticket"]).toMatchObject({
      id: "VC-1",
      body: "Do the thing.",
      labels: ["front-end"],
    });
    expect(shown["signals"]).toEqual([
      {
        ticket: "VC-1",
        kind: "review",
        verdict: "pass",
        detail: "ok",
        session: SESSION.slice(0, 8),
        createdAt: 2,
      },
    ]);
    expect(shown["events"]).toEqual([
      { actor: "user", actorContext: null, payload: { kind: "created" }, createdAt: 11 },
      {
        actor: "session",
        actorContext: { session: SESSION.slice(0, 8), ticket: "VC-1" },
        payload: { kind: "commented" },
        createdAt: 12,
      },
      {
        actor: "session",
        // The Session acted on another ticket: its key, read once.
        actorContext: { session: SESSION.slice(0, 8), ticket: "VC-2" },
        payload: {
          kind: "session_started",
          session: SESSION.slice(0, 8),
          origin: { kind: "session", sessionId: SESSION.slice(0, 8) },
        },
        createdAt: 13,
      },
      {
        actor: "session",
        // A ticket it can no longer see has no key.
        actorContext: { session: SESSION.slice(0, 8), ticket: null },
        payload: {
          kind: "session_resumed",
          session: "not-a-uuid",
          attachment: "abcdef01",
          origin: null,
        },
        createdAt: 14,
      },
    ]);
    expect(shown["comments"]).toEqual([
      {
        ticket: "VC-1",
        body: "Second.",
        actor: "session",
        session: SESSION.slice(0, 8),
        createdAt: 14,
        updatedAt: 15,
      },
    ]);

    const compact = data(
      await verbs["ticket.show"]({
        sessionId: SESSION,
        request: request("ticket.show", { id: "VC-1", events: 0, comments: 0 }),
      }),
    );
    expect(compact).toMatchObject({
      ticket: { id: "VC-1", status: "doing", title: "Ticket 1" },
      events: [],
      comments: [],
    });
  });

  it("ticket events, brief, label list and project list", async () => {
    const { verbs } = await verbsOver();
    const events = data(
      await verbs["ticket.events"]({
        sessionId: SESSION,
        request: request("ticket.events", { id: "VC-1", limit: 1 }),
      }),
    );
    expect((events["events"] as unknown[]).length).toBe(1);

    const brief = data(
      await verbs["ticket.brief"]({
        sessionId: SESSION,
        request: request("ticket.brief", { id: T1 }),
      }),
    );
    expect(brief["prompt"]).toContain("VC-1");
    expect(brief["prompt"]).toContain("Do the thing.");

    expect(
      data(await verbs["label.list"]({ sessionId: SESSION, request: request("label.list") })),
    ).toEqual({
      labels: [
        { name: "front-end", color: null, tickets: 1 },
        { name: "api", color: "#fff", tickets: 0 },
      ],
    });

    expect(
      data(await verbs["project.list"]({ sessionId: SESSION, request: request("project.list") })),
    ).toEqual({
      projects: [
        {
          id: PROJECT,
          name: "Volli Code",
          prefix: "VC",
          path: "/repo/volli",
          tickets: 2,
          archived: 3,
        },
        {
          id: OTHER_PROJECT,
          name: "Website",
          prefix: "WEB",
          path: null,
          tickets: 0,
          archived: 0,
        },
      ],
    });
  });

  it("a key nobody can see, or one that names two tickets, is refused in the socket's words", async () => {
    const { verbs, backend } = await verbsOver();
    await expect(
      verbs["ticket.show"]({
        sessionId: SESSION,
        request: request("ticket.show", { id: "VC-99" }),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "TICKET_NOT_FOUND" } });
    await expect(
      verbs["ticket.show"]({ sessionId: SESSION, request: request("ticket.show", {}) }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    backend.override.set("board:resolveTicketKey", () => ({
      error: {
        code: "ambiguous_key",
        message: "VC-1 names a ticket in more than one project.",
        candidates: [
          { qualifiedKey: "volli-code/VC-1", ticketId: T1 },
          { qualifiedKey: null, ticketId: T2 },
        ],
      },
    }));
    await expect(
      verbs["ticket.show"]({ sessionId: SESSION, request: request("ticket.show", { id: "VC-1" }) }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "AMBIGUOUS_TICKET",
        next: `Retry with one of these keys, or the ticket id in brackets: volli-code/VC-1 (${T1}), ${T2}.`,
      },
    });
  });
});

describe("cloud board writes", () => {
  it("create mints the command and ticket ids and answers the new ticket", async () => {
    const { verbs, backend } = await verbsOver();
    const created = data(
      await verbs["board.createTicket"]({
        sessionId: SESSION,
        request: request("ticket.create", {
          title: "  Found while working ",
          status: "todo",
          labels: ["api"],
          body: "Details.",
          usesWorktree: false,
          harness: "codex",
        }),
      }),
    );
    expect(created["ticket"]).toMatchObject({
      id: "VC-3",
      title: "Found while working",
      body: "Details.",
      status: "todo",
    });
    const [write] = writes(backend);
    expect(write).toMatchObject({
      path: "board:createTicket",
      args: {
        projectId: PROJECT,
        title: "Found while working",
        status: "todo",
        priority: "medium",
        labels: ["api"],
        checkoutMode: "main_checkout",
        preferredHarnessId: "codex",
        baseBranch: null,
      },
    });
    expect(write!.args["commandId"]).toMatch(/^00000000-/);
    expect(write!.args["ticketId"]).toMatch(/^00000000-/);
    expect(write!.args["ticketId"]).not.toBe(write!.args["commandId"]);
  });

  it("create refuses bad arguments and a harness the board cannot know, and previews on dryRun", async () => {
    const { verbs, backend } = await verbsOver();
    const create = (args: Record<string, unknown>) =>
      verbs["board.createTicket"]({ sessionId: SESSION, request: request("ticket.create", args) });
    await expect(create({ title: " " })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    await expect(create({ title: "x", harness: "my-local-harness" })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    const preview = data(await create({ title: "x", dryRun: true }));
    expect(preview).toHaveProperty("durableWrites");
    expect(writes(backend)).toEqual([]);
  });

  it("update checks a body edit against the body first, then writes one command", async () => {
    const { verbs, backend } = await verbsOver();
    const update = (args: Record<string, unknown>) =>
      verbs["board.updateTicket"]({ sessionId: SESSION, request: request("ticket.update", args) });
    await expect(
      update({ id: "VC-1", bodyMutation: { mode: "edit", oldText: "absent", newText: "x" } }),
    ).resolves.toMatchObject({ ok: false, error: { code: "BODY_MATCH_FAILED" } });
    await expect(update({ id: "VC-1", base: "main" })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    await expect(update({ id: "VC-1", priority: "urgent" })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(writes(backend)).toEqual([]);
    const updated = data(
      await update({
        id: "VC-1",
        title: "Renamed",
        priority: "low",
        addLabels: ["api"],
        removeLabels: ["fe"],
        bodyMutation: { mode: "edit", oldText: "thing", newText: "other thing" },
      }),
    );
    expect(updated["ticket"]).toMatchObject({ id: "VC-1", title: "Renamed" });
    expect(writes(backend)).toEqual([
      expect.objectContaining({
        path: "board:updateTicket",
        args: expect.objectContaining({
          ticketId: T1,
          title: "Renamed",
          priority: "low",
          addLabels: ["api"],
          removeLabels: ["fe"],
          bodyMutation: { mode: "edit", oldText: "thing", newText: "other thing" },
        }),
      }),
    ]);
  });

  it("move is a column move; to the column it is in, it changes nothing", async () => {
    const { verbs, backend } = await verbsOver();
    const move = (args: Record<string, unknown>) =>
      verbs["ticket.move"]({ sessionId: SESSION, request: request("ticket.move", args) });
    await expect(move({ id: "VC-1", to: "nowhere" })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    await expect(move({ id: "VC-1", to: "doing" })).resolves.toMatchObject({
      ok: true,
      data: { ticket: { status: "doing" } },
    });
    expect(data(await move({ id: "VC-1", to: "doing", dryRun: true }))).toMatchObject({
      durableWrites: [],
    });
    expect(writes(backend)).toEqual([]);
    expect(data(await move({ id: "VC-2", to: "done", dryRun: true }))).toHaveProperty(
      "durableWrites",
    );
    await expect(move({ id: "VC-2", to: "done" })).resolves.toMatchObject({
      ok: true,
      data: { ticket: { id: "VC-2", status: "done" } },
    });
    expect(writes(backend)).toEqual([
      expect.objectContaining({
        path: "board:moveTickets",
        args: expect.objectContaining({ projectId: PROJECT, ticketIds: [T2], toStatus: "done" }),
      }),
    ]);
  });

  it("comment and signal write as the Session, and say what they wrote", async () => {
    const { verbs, backend } = await verbsOver();
    await expect(
      verbs["board.createComment"]({
        sessionId: SESSION,
        request: request("ticket.comment", { id: "VC-1", message: "" }),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    const comment = data(
      await verbs["board.createComment"]({
        sessionId: SESSION,
        request: request("ticket.comment", { id: "VC-1", message: "Halfway." }),
      }),
    );
    expect(comment["comment"]).toMatchObject({
      ticket: "VC-1",
      body: "Halfway.",
      actor: "session",
      session: SESSION.slice(0, 8),
    });
    const signal = (args: Record<string, unknown>) =>
      verbs["ticket.signal"]({
        sessionId: SESSION,
        request: request("ticket.signal", { id: "VC-1", ...args }),
      });
    for (const bad of [
      { kind: "vibes", verdict: "pass" },
      { kind: "review", verdict: "maybe" },
      { kind: "review", verdict: "pass", detail: 3 },
    ]) {
      await expect(signal(bad)).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
    }
    expect(
      data(await signal({ kind: "review", verdict: "pass", detail: "  " }))["signal"],
    ).toMatchObject({
      ticket: "VC-1",
      kind: "review",
      verdict: "pass",
      detail: null,
    });
    expect(data(await signal({ kind: "review", verdict: "fail", dryRun: true }))).toHaveProperty(
      "durableWrites",
    );
    expect(writes(backend).map((call) => call.path)).toEqual([
      "board:createComment",
      "board:createSignal",
    ]);
    // Only on the Session's own project.
    backend.state.tickets[1]!.projectId = OTHER_PROJECT;
    await expect(signal({ id: "VC-2", kind: "review", verdict: "pass" })).resolves.toMatchObject({
      ok: false,
      error: { code: "TICKET_NOT_FOUND" },
    });
  });

  it("label merge previews by default and writes only with --apply", async () => {
    const { verbs, backend } = await verbsOver();
    const merge = (args: Record<string, unknown>) =>
      verbs["label.merge"]({ sessionId: SESSION, request: request("label.merge", args) });
    await expect(merge({ into: "x" })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    await expect(merge({ from: "x" })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(data(await merge({ from: "fe", into: "front-end" }))).toEqual({
      applied: false,
      from: "fe",
      into: "front-end",
      ticketCount: 1,
      tickets: [{ id: "VC-1", title: "Ticket 1", archived: false }],
      next: "Re-run with --apply to move 1 Ticket(s) onto front-end and retire fe as an alias.",
    });
    expect(writes(backend)).toEqual([]);
    expect(data(await merge({ from: "fe", into: "front-end", apply: true }))).toMatchObject({
      applied: true,
      ticketCount: 1,
      tickets: [{ id: "VC-1" }],
    });
    expect(writes(backend).map((call) => call.path)).toEqual(["board:mergeLabels"]);
  });
});

describe("failing fast", () => {
  it("offline answers OFFLINE before any request, naming the runner and what is kept", async () => {
    const { verbs, backend } = await verbsOver({ connected: () => false });
    const refused = await verbs["board.createTicket"]({
      sessionId: SESSION,
      request: request("ticket.create", { title: "x" }),
    });
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: "OFFLINE",
        message:
          "Hussain's Mac can't reach Volli Cloud. Board changes need a connection; Session updates are kept and sent when it's back.",
      },
    });
    expect(backend.calls).toEqual([]);
  });

  it("a backend that went away is offline too", async () => {
    const { verbs, backend } = await verbsOver();
    await backend.close();
    await expect(
      verbs.board({ sessionId: SESSION, request: request("board") }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "OFFLINE" },
    });
  });

  it("a write that timed out is sent once more with the same command id, then may have landed", async () => {
    const { verbs, backend } = await verbsOver({ timeoutMs: 100 });
    backend.override.set("board:createComment", () => "hang");
    const refused = await verbs["board.createComment"]({
      sessionId: SESSION,
      request: request("ticket.comment", { id: "VC-1", message: "Once." }),
    });
    // Not OFFLINE: the write may have been applied, so retrying blind could double it.
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: "TIMEOUT",
        message:
          "Hussain's Mac sent this change to Volli Cloud but got no answer, so it may have been written.",
      },
    });
    const attempts = writes(backend);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.args).toEqual(attempts[0]!.args);
  });

  it("a write that landed is ok even when reading it back fails", async () => {
    const { verbs, backend } = await verbsOver();
    backend.override.set("board:getTicket", () => ({
      error: { code: "server_error", message: "Read failed." },
    }));
    // The project is resolved from the listing, so only the read-back fails.
    const created = await verbs["board.createTicket"]({
      sessionId: SESSION,
      request: request("ticket.create", { title: "Landed", status: "todo" }),
    });
    expect(created).toEqual({
      v: 1,
      ok: true,
      data: {
        ticket: {
          id: "VC-3",
          project: "Volli Code",
          title: "Landed",
          status: "todo",
          priority: "medium",
        },
      },
    });
  });

  it("a comment and a signal carry the backend's time", async () => {
    const { verbs } = await verbsOver();
    expect(
      data(
        await verbs["board.createComment"]({
          sessionId: SESSION,
          request: request("ticket.comment", { id: "VC-1", message: "x" }),
        }),
      )["comment"],
    ).toMatchObject({ createdAt: 77 });
    expect(
      data(
        await verbs["ticket.signal"]({
          sessionId: SESSION,
          request: request("ticket.signal", { id: "VC-1", kind: "review", verdict: "pass" }),
        }),
      )["signal"],
    ).toMatchObject({ createdAt: 78 });
  });

  it("no Session evidence is SIGN_IN_REQUIRED; a claim moved elsewhere is FORBIDDEN_ACTOR", async () => {
    const { verbs, backend } = await verbsOver();
    await expect(
      verbs.board({ sessionId: null, request: request("board") }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "SIGN_IN_REQUIRED" },
    });
    expect(backend.calls).toEqual([]);
    backend.override.set("board:roster", () => ({
      error: { code: "fenced", message: "Another runner holds this session now." },
    }));
    await expect(
      verbs.board({ sessionId: SESSION, request: request("board") }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN_ACTOR", message: "Another runner holds this session now." },
    });
    // Fenced, the token is dropped and the call tried once under a fresh one;
    // still fenced, it is dropped again and the next verb mints anew.
    expect(backend.calls.filter((call) => call.path === "agentTokens:mint")).toHaveLength(2);
    backend.override.delete("board:roster");
    await verbs.board({ sessionId: SESSION, request: request("board") });
    expect(backend.calls.filter((call) => call.path === "agentTokens:mint")).toHaveLength(3);
  });

  it("preview cutoff is an authorization refusal rather than a failed mutation", async () => {
    const { verbs, backend } = await verbsOver();
    backend.override.set("board:roster", () => ({
      error: { code: "preview_access_required", message: "Preview access is needed." },
    }));
    await expect(
      verbs.board({ sessionId: SESSION, request: request("board") }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN_ACTOR", message: "Preview access is needed." },
    });
  });

  it("an unexpected refusal is a failed operation with the backend's sentence", async () => {
    const { verbs, backend } = await verbsOver();
    backend.override.set("board:labels", () => ({
      error: { code: "server_error", message: "Something broke." },
    }));
    await expect(
      verbs["label.list"]({ sessionId: SESSION, request: request("label.list") }),
    ).resolves.toMatchObject({ ok: false, error: { code: "MUTATION_FAILED" } });
    for (const code of ["archived", "invalid_argument", "body_match_failed"]) {
      backend.override.set("board:labels", () => ({ error: { code, message: code } }));
      const answer = await verbs["label.list"]({
        sessionId: SESSION,
        request: request("label.list"),
      });
      expect(answer.ok).toBe(false);
    }
  });
});
