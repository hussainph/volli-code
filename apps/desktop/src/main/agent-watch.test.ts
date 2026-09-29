/**
 * The tool doors onto the watch registry (VC-457): `watch`, the retired
 * awaits, and the automatic watch a Session-opening tool arms. Every door
 * returns at once; what is proved here is resolution, the Role bound, policy,
 * and the words a model reads.
 */

import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_AUTHORITY_POLICY,
  resolveAuthorityPolicy,
  type AuthorityPolicy,
  type RuntimeSessionIdentity,
  type SessionProjection,
} from "@volli/shared";

import {
  retiredSessionAwaitTool,
  retiredTicketAwaitTool,
  watchOpenedSession,
  watchTool,
} from "./agent-watch";
import type { WatchToolPorts } from "./agent-watch";
import { openTestDb, testProject, testTicket } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import { insertProject, listProjects } from "./db/projects-repo";
import { insertTicket } from "./db/tickets-repo";
import type { Watches, WatchSessionInput, WatchTicketInput } from "./watches";

let ctx: TestDb | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const BOARD: RuntimeSessionIdentity = {
  role: "project",
  sessionId: "board-session-0000",
  rootThreadId: "thread",
  attachmentId: "attachment",
  projectId: "project-one",
  ticketId: null,
};
const TICKET: RuntimeSessionIdentity = {
  ...BOARD,
  role: "ticket",
  sessionId: "ticket-session-0000",
  ticketId: "ticket-one",
};
const SUBAGENT: RuntimeSessionIdentity = {
  ...BOARD,
  role: "subagent",
  sessionId: "sub-session-0",
  parentSessionId: BOARD.sessionId,
};

function projection(
  id: string,
  overrides: { parentSessionId?: string | null; turnActive?: boolean; terminal?: boolean } = {},
): SessionProjection {
  return {
    session: {
      id,
      projectId: "project-one",
      ticketId: null,
      role: "ticket",
      parentSessionId: overrides.parentSessionId ?? null,
      title: `Title ${id.slice(0, 4)}`,
      createdAt: 1,
    },
    attachments: overrides.terminal
      ? [
          {
            id: "pty",
            sessionId: id,
            adapterId: "terminal",
            venue: { id: "local", kind: "local" },
            continuity: "fresh",
            native: null,
            authority: null,
            status: "open",
            openedAt: 1,
            closedAt: null,
            outcome: null,
            failure: null,
            exitCode: null,
          },
        ]
      : [],
    turnActive: overrides.turnActive ?? false,
  } as unknown as SessionProjection;
}

function recordingWatches() {
  const sessions: WatchSessionInput[] = [];
  const tickets: WatchTicketInput[] = [];
  const unwatched: unknown[] = [];
  const watches: Watches = {
    watchSession: (input) => {
      sessions.push(input);
    },
    watchTicket: (input) => {
      tickets.push(input);
    },
    unwatch: (_watcher, targets) => {
      unwatched.push(targets);
      return (targets.sessions?.length ?? 0) + (targets.tickets?.length ?? 0) > 0 ? 2 : 0;
    },
    watching: () => ({ sessions: [], tickets: [] }),
    dispose: () => undefined,
  };
  return { watches, sessions, tickets, unwatched };
}

function harness(
  options: {
    policy?: AuthorityPolicy;
    projections?: SessionProjection[];
    runtime?: boolean;
  } = {},
) {
  ctx = openTestDb();
  const db = ctx.db;
  insertProject(db, testProject({ id: "project-one", ticketPrefix: "VC", path: "/repo/one" }));
  insertTicket(db, testTicket("project-one", { id: "ticket-one", ticketNumber: 12 }));
  insertTicket(db, testTicket("project-one", { id: "ticket-two", ticketNumber: 14 }));
  const recorded = recordingWatches();
  const runtime = options.runtime ?? true;
  const ports: WatchToolPorts = {
    db,
    projects: () => listProjects(db),
    authorityPolicy: () => options.policy ?? DEFAULT_AUTHORITY_POLICY,
    sessions: () =>
      runtime
        ? {
            listSessions: async () =>
              options.projections ?? [
                projection("aaaaaaaa-1", { turnActive: true }),
                projection("bbbbbbbb-1", { parentSessionId: TICKET.sessionId }),
                projection("cccccccc-1", { terminal: true }),
                projection("dddddddd-1"),
                projection("dddddddd-2"),
                projection(BOARD.sessionId),
              ],
          }
        : null,
    watches: () => (runtime ? recorded.watches : null),
  };
  const call = (
    tool: typeof watchTool,
    input: Record<string, unknown>,
    caller: RuntimeSessionIdentity = BOARD,
  ) => tool(ports, caller, { verb: "watch", toolCallId: "tc", input } as never);
  return { ports, call, ...recorded };
}

describe("watch", () => {
  it("arms Session and Ticket watches for a Board Session and returns at once", async () => {
    const h = harness();
    const result = await h.call(watchTool, { sessions: "aaaaaaaa", tickets: "VC-12, VC-14" });

    expect(h.sessions).toEqual([
      {
        watcherSessionId: BOARD.sessionId,
        targetSessionId: "aaaaaaaa-1",
        title: "Title aaaa",
        kinds: ["turn", "verdict", "stopped"],
        armTurn: true,
      },
    ]);
    expect(h.tickets.map((ticket) => ticket.display)).toEqual(["VC-12", "VC-14"]);
    expect(result.text).toContain(
      "Watching Session aaaaaaaa: a notice arrives when its next turn ends, when it signals done or blocked, if it is stopped.",
    );
    expect(result.text).toContain(
      "Watching VC-12, VC-14: a notice arrives on signals, comments, moves made by anyone but this Session",
    );
    expect(result.text).toContain("This call did not wait.");
  });

  it("unwatches, and says when there was nothing to end", async () => {
    const h = harness();
    expect((await h.call(watchTool, { tickets: "VC-12", action: "unwatch" })).text).toBe(
      "Stopped watching 2 targets. Nothing more about them will arrive here.",
    );
    const none = harness();
    none.watches.unwatch = () => 0;
    expect((await none.call(watchTool, { sessions: "aaaaaaaa", action: "unwatch" })).text).toMatch(
      /nothing changed/,
    );
    const one = harness();
    one.watches.unwatch = () => 1;
    expect((await one.call(watchTool, { tickets: "VC-12", action: "unwatch" })).text).toMatch(
      /Stopped watching 1 target\./,
    );
  });

  it("refuses bad input in words", async () => {
    const h = harness();
    const refusals = [
      [{}, /Name at least one target/],
      [{ sessions: 7 }, /`sessions` must be short session ids/],
      [{ tickets: 7 }, /`tickets` must be ticket display ids/],
      [{ sessions: "aaaaaaaa", action: "maybe" }, /`action` must be watch or unwatch/],
      [{ tickets: Array.from({ length: 101 }, (_, i) => `VC-${i + 1}`).join(" ") }, /at most 100/],
      [{ sessions: "zzzzzzzz" }, /No session zzzzzzzz in this project/],
      [{ sessions: "dddddddd" }, /ambiguous/],
      [{ sessions: "cccccccc" }, /terminal session/],
      [{ sessions: "board-se" }, /is this Session/],
      [{ tickets: "OT-1" }, /No ticket OT-1 in this project/],
      [{ tickets: "VC-x" }, /No ticket VC-x/],
      [{ tickets: "VC-99" }, /No ticket VC-99/],
    ] as const;
    for (const [input, expected] of refusals) {
      expect((await h.call(watchTool, input)).text).toMatch(expected);
    }
    expect(h.sessions).toEqual([]);
    expect(h.tickets).toEqual([]);
  });

  it("bounds a Ticket Session to its own subagents, and a subagent to nothing", async () => {
    const h = harness();
    expect((await h.call(watchTool, { sessions: "aaaaaaaa" }, TICKET)).text).toMatch(
      /may watch only its own subagents/,
    );
    await h.call(watchTool, { sessions: "bbbbbbbb", tickets: "VC-14" }, TICKET);
    expect(h.sessions.map((s) => s.targetSessionId)).toEqual(["bbbbbbbb-1"]);
    expect((await h.call(watchTool, { sessions: "aaaaaaaa" }, SUBAGENT)).text).toMatch(
      /A subagent Session watches nothing/,
    );
  });

  it("follows project policy, and says so when it allows nothing", async () => {
    const narrow = resolveAuthorityPolicy({
      actors: { session: { awaitableSessions: [], awaitable: [] } },
    });
    const h = harness({ policy: narrow });
    expect((await h.call(watchTool, { sessions: "aaaaaaaa" })).text).toMatch(
      /policy lets Sessions watch no Session facts/,
    );
    expect((await h.call(watchTool, { tickets: "VC-12" })).text).toMatch(
      /policy lets Sessions watch no Ticket facts/,
    );
    const verdictsOnly = harness({
      policy: resolveAuthorityPolicy({ actors: { session: { awaitableSessions: ["verdict"] } } }),
    });
    expect((await verdictsOnly.call(watchTool, { sessions: "aaaaaaaa" })).text).toContain(
      "a notice arrives when it signals done or blocked.",
    );
    const nothingNamed = harness({
      policy: resolveAuthorityPolicy({ actors: { session: { awaitableSessions: ["turn"] } } }),
    });
    expect(
      await watchOpenedSession(
        nothingNamed.ports,
        BOARD,
        { sessionId: "x", title: null },
        "started",
      ),
    ).toContain("when its next turn ends");
  });

  it("arms nothing when one half of a combined call is refused by policy (VC-457 review)", async () => {
    const h = harness({
      policy: resolveAuthorityPolicy({ actors: { session: { awaitable: [] } } }),
    });
    expect((await h.call(watchTool, { sessions: "aaaaaaaa", tickets: "VC-12" })).text).toMatch(
      /watch no Ticket facts, so nothing was watched/,
    );
    expect(h.sessions).toEqual([]);
    expect(h.tickets).toEqual([]);
  });

  it("refuses when the project or runtime is gone", async () => {
    const h = harness({ runtime: false });
    expect((await h.call(watchTool, { tickets: "VC-12" })).text).toMatch(/not available/);
    const gone = harness();
    expect(
      (await gone.call(watchTool, { tickets: "VC-12" }, { ...BOARD, projectId: "nope" })).text,
    ).toMatch(/no longer registered/);
    const noEngine = harness();
    noEngine.ports.sessions = () => null;
    expect((await noEngine.call(watchTool, { sessions: "aaaaaaaa" })).text).toMatch(
      /runtime is not available/,
    );
  });
});

describe("the automatic watch a Session-opening tool arms", () => {
  it("arms the next turn and the verdicts for its caller, and words it", async () => {
    const h = harness();
    const line = await watchOpenedSession(
      h.ports,
      BOARD,
      { sessionId: "eeeeeeee-1", title: "Started" },
      "started",
    );
    expect(line).toMatch(
      /^A notice from Volli will arrive in this Session when its next turn ends/,
    );
    expect(line).toContain("`volli session peek eeeeeeee`");
    expect(h.sessions).toEqual([
      expect.objectContaining({ targetSessionId: "eeeeeeee-1", armTurn: true }),
    ]);
  });

  it("says nothing reports back when nothing can", async () => {
    const h = harness({ runtime: false });
    expect(
      await watchOpenedSession(h.ports, BOARD, { sessionId: "x", title: null }, "started"),
    ).toMatch(/Nothing reports back/);
    const sub = harness();
    expect(
      await watchOpenedSession(sub.ports, SUBAGENT, { sessionId: "x", title: null }, "started"),
    ).toMatch(/Nothing reports back/);
    expect(sub.sessions).toEqual([]);
  });

  it("judges a steered target by the watch tool's own bound (VC-457 review)", async () => {
    const h = harness();
    // A Ticket Session holding session_send steers a Session it did not
    // delegate: the explicit `watch` would refuse it, so the send arms nothing.
    expect(
      await watchOpenedSession(
        h.ports,
        TICKET,
        { sessionId: "aaaaaaaa-1", title: null },
        "steered",
      ),
    ).toMatch(/Nothing reports back/);
    // Its own subagent it may watch.
    expect(
      await watchOpenedSession(
        h.ports,
        TICKET,
        { sessionId: "bbbbbbbb-1", title: null },
        "steered",
      ),
    ).toMatch(/A notice from Volli will arrive/);
    // A target the engine cannot find, or no engine at all, arms nothing.
    expect(
      await watchOpenedSession(h.ports, BOARD, { sessionId: "missing", title: null }, "steered"),
    ).toMatch(/Nothing reports back/);
    h.ports.sessions = () => null;
    expect(
      await watchOpenedSession(h.ports, BOARD, { sessionId: "aaaaaaaa-1", title: null }, "steered"),
    ).toMatch(/Nothing reports back/);
    expect(h.sessions.map((watch) => watch.targetSessionId)).toEqual(["bbbbbbbb-1"]);
    // A Session it STARTED, a Ticket Session may watch without a delegation.
    await watchOpenedSession(h.ports, TICKET, { sessionId: "aaaaaaaa-1", title: null }, "started");
    expect(h.sessions.map((watch) => watch.targetSessionId)).toEqual(["bbbbbbbb-1", "aaaaaaaa-1"]);
  });
});

describe("the retired awaits (frozen surfaces only)", () => {
  it("session_await arms a watch and returns, ignoring its wait fields", async () => {
    const h = harness();
    const result = await h.call(retiredSessionAwaitTool, {
      sessions: "aaaaaaaa",
      for: "turn",
      timeoutSeconds: 600,
      cursor: "whatever",
    });
    expect(result.text).toMatch(/^session_await no longer waits/);
    expect(result.text).toContain("Watching aaaaaaaa: a notice arrives when its next turn ends.");
    expect(h.sessions).toEqual([expect.objectContaining({ kinds: ["turn"] })]);
  });

  it("session_await refuses in words", async () => {
    const h = harness();
    expect((await h.call(retiredSessionAwaitTool, {})).text).toMatch(/`sessions` must name/);
    expect((await h.call(retiredSessionAwaitTool, { sessions: "a", for: "x" })).text).toMatch(
      /`for` must be one of/,
    );
    expect((await h.call(retiredSessionAwaitTool, { sessions: "zzzzzzzz" })).text).toMatch(
      /No session zzzzzzzz/,
    );
    expect(
      (
        await h.call(
          retiredSessionAwaitTool,
          { sessions: "aaaaaaaa" },
          { ...BOARD, projectId: "x" },
        )
      ).text,
    ).toMatch(/Nothing can be watched/);
    const narrow = harness({
      policy: resolveAuthorityPolicy({ actors: { session: { awaitableSessions: ["stopped"] } } }),
    });
    expect(
      (await narrow.call(retiredSessionAwaitTool, { sessions: "aaaaaaaa", for: "turn" })).text,
    ).toMatch(/does not allow watching for turn; it allows: stopped/);
    const none = harness({
      policy: resolveAuthorityPolicy({ actors: { session: { awaitableSessions: [] } } }),
    });
    expect((await none.call(retiredSessionAwaitTool, { sessions: "aaaaaaaa" })).text).toMatch(
      /it allows: nothing/,
    );
  });

  it("ticket_await arms a watch and returns", async () => {
    const h = harness();
    const result = await h.call(
      retiredTicketAwaitTool,
      { tickets: "VC-12", for: "status" },
      TICKET,
    );
    expect(result.text).toMatch(/^ticket_await no longer waits/);
    expect(result.text).toContain("Watching VC-12: a notice arrives on moves");
    expect(h.tickets).toEqual([
      {
        watcherSessionId: TICKET.sessionId,
        ticketId: "ticket-one",
        display: "VC-12",
        kinds: ["status"],
      },
    ]);
  });

  it("ticket_await refuses in words", async () => {
    const h = harness();
    expect((await h.call(retiredTicketAwaitTool, {})).text).toMatch(/`tickets` must name/);
    expect((await h.call(retiredTicketAwaitTool, { tickets: "VC-12", for: "x" })).text).toMatch(
      /`for` must be one of/,
    );
    expect((await h.call(retiredTicketAwaitTool, { tickets: "VC-12" }, SUBAGENT)).text).toMatch(
      /subagent Session watches nothing/,
    );
    expect(
      (await h.call(retiredTicketAwaitTool, { tickets: "VC-12" }, { ...BOARD, projectId: "x" }))
        .text,
    ).toMatch(/Nothing can be watched/);
    expect((await h.call(retiredTicketAwaitTool, { tickets: "VC-99" })).text).toMatch(
      /No ticket VC-99/,
    );
    const narrow = harness({
      policy: resolveAuthorityPolicy({ actors: { session: { awaitable: ["signal"] } } }),
    });
    expect(
      (await narrow.call(retiredTicketAwaitTool, { tickets: "VC-12", for: "comment" })).text,
    ).toMatch(/does not allow watching for comment; it allows: signal/);
    const none = harness({
      policy: resolveAuthorityPolicy({ actors: { session: { awaitable: [] } } }),
    });
    expect((await none.call(retiredTicketAwaitTool, { tickets: "VC-12" })).text).toMatch(
      /it allows: nothing/,
    );
  });
});
