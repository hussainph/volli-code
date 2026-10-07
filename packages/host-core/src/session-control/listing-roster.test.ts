/**
 * The Session listing's one body (VC-713): the rows `volli:session-list` and
 * the host protocol's `session.listing` both read, and the bound that keeps a
 * remote answer inside one frame without hiding a row the person must see.
 */
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  PERSON_STARTED,
  roleImpliedByTicket,
  SESSION_LISTING_BOUNDS,
  type ChatSessionRecord,
  type SessionListingRow,
} from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testSession, testTicket, type TestDb } from "../db/test-helpers";
import { insertTicket } from "../db/tickets-repo";
import { createTestSessionEngine } from "../testing/session-engine";
import {
  boundedSessionListing,
  clipListingText,
  projectSessionListing,
  SESSION_LISTING_LIMIT,
  ticketSessionListing,
  type SessionListingSources,
} from "./listing-roster";
import { insertSession } from "./test-support";

const PROJECT = "project";
let ctx: TestDb;

beforeEach(() => {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: PROJECT, ticketPrefix: "VC" }));
  insertTicket(ctx.db, testTicket(PROJECT, { id: "ticket", ticketNumber: 1 }));
});
afterEach(() => ctx.cleanup());

function sources(live: ReadonlySet<string> = new Set()): SessionListingSources {
  const engine = createTestSessionEngine(ctx.db, { now: () => 500 });
  return {
    db: ctx.db,
    listSessions: (query) => engine.listSessions(query),
    liveAttachmentIds: () => live,
  };
}

const rowId = (row: SessionListingRow): string =>
  row.kind === "chat" ? row.record.sessionId : row.record.id;

describe("the listing's one body", () => {
  it("lists a project's Sessions, every scope, terminal and chat alike", async () => {
    insertSession(ctx.db, testSession(PROJECT, null, { id: "board-session" }));
    insertSession(ctx.db, testSession(PROJECT, "ticket", { id: "ticket-session" }));
    const engine = createTestSessionEngine(ctx.db, { now: () => 500 });
    const chat = await engine.createSession({
      commandId: "create",
      projectId: PROJECT,
      ticketId: "ticket",
      role: roleImpliedByTicket("ticket"),
      parentSessionId: null,
      title: "Remote chat",
      provenance: {
        source: { kind: "user", id: "test", detail: null },
        venue: { id: "box", kind: "remote" },
      },
    });

    const rows = await projectSessionListing(sources(), PROJECT);
    expect(rows.map(rowId).toSorted()).toEqual(
      [chat.session.id, "board-session", "ticket-session"].toSorted(),
    );
    expect(rows.find((row) => rowId(row) === chat.session.id)).toMatchObject({
      kind: "chat",
      record: { title: "Remote chat", activity: "idle", live: false },
      usage: EMPTY_SESSION_USAGE_SUMMARY,
      provenance: PERSON_STARTED,
    });
  });

  it("lists one ticket's Sessions, and nothing for a ticket this host does not have", async () => {
    insertSession(ctx.db, testSession(PROJECT, null, { id: "board-session" }));
    insertSession(ctx.db, testSession(PROJECT, "ticket", { id: "ticket-session" }));
    expect((await ticketSessionListing(sources(), "ticket")).map(rowId)).toEqual([
      "ticket-session",
    ]);
    expect(await ticketSessionListing(sources(), "no-such-ticket")).toEqual([]);
  });
});

function chatRow(
  id: string,
  lastActivityAt: number,
  activity: ChatSessionRecord["activity"] = "idle",
): SessionListingRow {
  return {
    kind: "chat",
    record: {
      sessionId: id,
      title: id,
      projectId: PROJECT,
      ticketId: null,
      createdAt: 0,
      adapterId: null,
      live: false,
      activity,
      waitingOn: activity === "waiting" ? "question" : null,
      outcome: null,
      lastActivityAt,
      bornTicketless: true,
      role: "project",
      parentSessionId: null,
      model: null,
    },
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
  };
}

/** A row's UTF-8 JSON, as the wire weighs it. */
const size = (row: SessionListingRow) => Buffer.byteLength(JSON.stringify(row), "utf8");

/**
 * Text at its heaviest: quotes, backslashes and control characters escape to
 * two to six bytes each, and an astral character is four.
 */
const heavy = (length: number) => '"\\\u0001😀'.repeat(Math.ceil(length / 5)).slice(0, length);

describe("the bound for one frame", () => {
  it("answers a listing within the bound whole", () => {
    const rows = [chatRow("a", 1), chatRow("b", 2)];
    expect(boundedSessionListing(rows)).toEqual({ sessions: rows, omitted: 0 });
    expect(SESSION_LISTING_LIMIT).toBe(500);
  });

  it("keeps every waiting and working row, then the newest, in the listing's own order", () => {
    const rows = [
      chatRow("old-waiting", 1, "waiting"),
      chatRow("newest", 9),
      chatRow("oldest", 0),
      chatRow("old-working", 2, "working"),
      chatRow("newer", 8),
      chatRow("middle", 5),
    ];
    expect(boundedSessionListing(rows, 4)).toEqual({
      sessions: [rows[0], rows[1], rows[3], rows[4]],
      omitted: 2,
    });
  });

  it("never answers past the bound, even with more rows the person must see", () => {
    const urgent = [chatRow("w1", 1, "waiting"), chatRow("w2", 2, "working")];
    const terminal = insertedTerminalRow();
    expect(boundedSessionListing([...urgent, terminal], 1)).toEqual({
      sessions: [urgent[1]],
      omitted: 2,
    });
  });

  it("clips display strings to the wire's bounds and never touches an id", () => {
    const long = "t".repeat(SESSION_LISTING_BOUNDS.text + 10);
    const chat = chatRow("a".repeat(600), 1);
    if (chat.kind !== "chat") throw new Error("a chat row");
    chat.record.title = long;
    chat.record.latestTurnOrigin = {
      kind: "automation",
      automationRunId: "run",
      automationName: long,
    };
    const terminal = insertedTerminalRow();
    if (terminal.kind !== "terminal") throw new Error("a terminal row");
    terminal.record.cwd = `/${"d".repeat(SESSION_LISTING_BOUNDS.path)}`;
    terminal.provenance = { kind: "session", parentSessionId: "p", parentTitle: long };
    const automated: SessionListingRow = {
      ...chatRow("b", 2),
      provenance: { kind: "automation", automationName: long, automationRunId: null },
    };
    const [clippedChat, clippedTerminal, clippedAutomated] = boundedSessionListing([
      chat,
      terminal,
      automated,
    ]).sessions;
    expect(clippedChat).toMatchObject({
      record: {
        sessionId: "a".repeat(600),
        title: `${"t".repeat(SESSION_LISTING_BOUNDS.text - 1)}…`,
        latestTurnOrigin: { automationName: `${"t".repeat(SESSION_LISTING_BOUNDS.text - 1)}…` },
      },
    });
    expect(clippedTerminal).toMatchObject({
      record: { cwd: `/${"d".repeat(SESSION_LISTING_BOUNDS.path - 2)}…` },
      provenance: { parentTitle: `${"t".repeat(SESSION_LISTING_BOUNDS.text - 1)}…` },
    });
    expect(clippedAutomated).toMatchObject({
      provenance: { automationName: `${"t".repeat(SESSION_LISTING_BOUNDS.text - 1)}…` },
    });
    // A null name stays null, and a short one is left alone.
    expect(
      boundedSessionListing([
        {
          ...chatRow("c", 3),
          provenance: { kind: "automation", automationName: null, automationRunId: null },
        },
      ]).sessions[0]!.provenance,
    ).toEqual({ kind: "automation", automationName: null, automationRunId: null });
  });

  it("stops at the byte budget too, the person's rows first, and counts what it left out", () => {
    const rows = [
      chatRow("old", 1),
      chatRow("waiting", 0, "waiting"),
      chatRow("new", 9),
      chatRow("newer", 10),
    ];
    // Room for exactly two rows (and the array around them).
    const budget = 2 + size(rows[1]!) + 1 + size(rows[3]!);
    expect(boundedSessionListing(rows, 500, budget)).toEqual({
      sessions: [rows[1], rows[3]],
      omitted: 2,
    });
    expect(boundedSessionListing(rows, 500, budget - 1)).toEqual({
      sessions: [rows[1]],
      omitted: 3,
    });
    // A budget no row fits says so rather than sending a page past the frame.
    expect(boundedSessionListing(rows, 500, 10)).toEqual({ sessions: [], omitted: 4 });
  });

  it("keeps 500 rows of the largest strings the wire allows inside the budget", () => {
    const { text, path } = SESSION_LISTING_BOUNDS;
    const rows = Array.from({ length: 500 }, (_, index): SessionListingRow => {
      const record = testSession(PROJECT, null, {
        id: `terminal-${index}`,
        title: heavy(text),
        cwd: heavy(path),
      });
      return {
        kind: "terminal",
        record: { ...record, lastActivityAt: index },
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      };
    });
    const page = boundedSessionListing(rows);
    const bytes = Buffer.byteLength(JSON.stringify(page.sessions), "utf8");
    expect(bytes).toBeLessThanOrEqual(SESSION_LISTING_BOUNDS.bytes);
    expect(page.sessions.length).toBeGreaterThan(0);
    expect(page.sessions.length + page.omitted).toBe(500);
    // The newest are the ones kept.
    expect(page.sessions.at(-1)).toMatchObject({ record: { id: "terminal-499" } });
  });

  it("never clips through a surrogate pair", () => {
    expect(clipListingText("ab😀cd", 4)).toBe("ab…");
    expect(clipListingText("abcdef", 4)).toBe("abc…");
    expect(clipListingText("abc", 4)).toBe("abc");
  });
});

/** A terminal row is never urgent: a PTY has no question to ask the person. */
function insertedTerminalRow(): SessionListingRow {
  const record = testSession(PROJECT, null, { id: "terminal" });
  return {
    kind: "terminal",
    record,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
  };
}
