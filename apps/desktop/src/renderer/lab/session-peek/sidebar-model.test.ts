import { describe, expect, it } from "vite-plus/test";

import {
  buildActiveSessionListing,
  groupPreviousByTicket,
  type ActiveSessionRow,
  type PreviousSessionRow,
} from "@renderer/components/sidebar/active-session-listing";

import { NOW, project } from "../fixtures";
import { CORPUS, LISTING_INPUT, RAIL_TICKET_ID } from "./sidebar-corpus";
import {
  activeMarkState,
  canPeekRow,
  canPinRow,
  corpusIdOf,
  fixtureStateOf,
  folderRowId,
  folderSessions,
  folderTicketId,
  folderVendors,
  FOLDER_VIEW_START,
  listedActive,
  listedPrevious,
  peekSubject,
  previousMarkState,
  railRoster,
  sessionFixture,
} from "./sidebar-model";

/** The corpus through the SHIPPED builder — the same listing the scratch draws. */
const listing = buildActiveSessionListing({ ...LISTING_INPUT, now: NOW });
const entries = groupPreviousByTicket(listing.previous);
const folders = folderSessions(entries);

function active(sessionId: string): ActiveSessionRow {
  const row = listing.active.find((candidate) => corpusIdOf(candidate.id) === sessionId);
  if (row === undefined) throw new Error(`${sessionId} is not in Active`);
  return row;
}

function previous(sessionId: string): PreviousSessionRow {
  const row = listing.previous.find((candidate) => corpusIdOf(candidate.id) === sessionId);
  if (row === undefined) throw new Error(`${sessionId} is not in Previous`);
  return row;
}

describe("the corpus, through the shipped listing", () => {
  it("bands every Session the way the scratch's notes claim", () => {
    expect(listing.active.map((row) => corpusIdOf(row.id))).toEqual([
      // Attention first, then recency — the shipped comparator, not this file's.
      "chat-a1",
      "chat-a2",
      "chat-a3",
      "chat-a4",
      "chat-a5",
    ]);
    expect(listing.previous).toHaveLength(13);
  });

  it("groups Previous into folders of four, two and one, with the ticketless Session left bare", () => {
    expect(entries.map((entry) => (entry.kind === "ticket" ? entry.id : "bare"))).toEqual([
      "tkt-11",
      "tkt-14",
      "tkt-10",
      "bare",
      "tkt-12",
      "tkt-9",
      "tkt-7",
    ]);
    expect(folders.get("tkt-11")).toHaveLength(4);
    expect(folders.get("tkt-14")).toHaveLength(2);
  });

  it("gives every listed Session a corpus entry the peek can read", () => {
    for (const row of [...listing.active, ...listing.previous]) {
      expect(CORPUS.get(corpusIdOf(row.id)), row.id).toBeDefined();
    }
  });

  it("holds three Sessions titled Chat in one folder — the case only a summary disambiguates", () => {
    const titles = (folders.get("tkt-11") ?? []).map(
      (rowId) => listing.previous.find((row) => row.id === rowId)?.title,
    );
    expect(titles.filter((title) => title === "Chat")).toHaveLength(3);
    const summaries = new Set(
      (folders.get("tkt-11") ?? []).map((rowId) => CORPUS.get(corpusIdOf(rowId))?.summary),
    );
    expect(summaries.size).toBe(4);
  });
});

describe("row ids", () => {
  it("round-trips a folder id and never mistakes a Session row for one", () => {
    expect(folderTicketId(folderRowId("tkt-11"))).toBe("tkt-11");
    expect(folderTicketId("chat:chat-p3")).toBeNull();
    expect(folderTicketId("session:term-p2")).toBeNull();
  });

  it("strips the listing's kind prefix to reach the corpus", () => {
    expect(corpusIdOf("chat:chat-p3")).toBe("chat-p3");
    expect(corpusIdOf("session:term-p2")).toBe("term-p2");
    expect(corpusIdOf("plain")).toBe("plain");
  });
});

describe("who peeks and who is answered", () => {
  it("peeks every Session, and a folder unless folder peeks are off", () => {
    expect(canPeekRow("chat:chat-a1", "off")).toBe(true);
    expect(canPeekRow(folderRowId("tkt-11"), "ticket")).toBe(true);
    expect(canPeekRow(folderRowId("tkt-11"), "newest")).toBe(true);
    expect(canPeekRow(folderRowId("tkt-11"), "off")).toBe(false);
  });

  it("pins a chat, never a folder and never a closed terminal", () => {
    expect(canPinRow("chat:chat-a1", CORPUS)).toBe(true);
    expect(canPinRow("chat:chat-p3", CORPUS)).toBe(true);
    expect(canPinRow(folderRowId("tkt-11"), CORPUS)).toBe(false);
    expect(canPinRow("session:term-p2", CORPUS)).toBe(false);
    expect(canPinRow("chat:unknown", CORPUS)).toBe(false);
  });
});

describe("what a peek is about", () => {
  const folder = folderRowId("tkt-11");
  const rows = folders.get("tkt-11") ?? [];

  it("is the row's own Session for a Session row, in every folder mode", () => {
    for (const mode of ["ticket", "newest", "off"] as const) {
      expect(peekSubject("chat:chat-a1", mode, folders, FOLDER_VIEW_START)).toEqual({
        kind: "session",
        rowId: "chat:chat-a1",
        via: { kind: "row" },
      });
    }
  });

  it("is the ticket for a folder in ticket mode, then the drilled Session with the way back", () => {
    expect(peekSubject(folder, "ticket", folders, FOLDER_VIEW_START)).toEqual({
      kind: "ticket",
      ticketId: "tkt-11",
      sessionIds: rows,
    });
    expect(peekSubject(folder, "ticket", folders, { drill: rows[2]!, page: 0 })).toEqual({
      kind: "session",
      rowId: rows[2],
      via: { kind: "drill", ticketId: "tkt-11" },
    });
  });

  it("ignores a drill into a Session the folder does not hold", () => {
    expect(peekSubject(folder, "ticket", folders, { drill: "chat:chat-a1", page: 0 })?.kind).toBe(
      "ticket",
    );
  });

  it("is the newest Session in newest mode, with a pager clamped to the folder", () => {
    expect(peekSubject(folder, "newest", folders, FOLDER_VIEW_START)).toEqual({
      kind: "session",
      rowId: rows[0],
      via: { kind: "pager", ticketId: "tkt-11", index: 0, count: 4 },
    });
    expect(peekSubject(folder, "newest", folders, { drill: null, page: 9 })).toMatchObject({
      rowId: rows[3],
      via: { index: 3 },
    });
    expect(peekSubject(folder, "newest", folders, { drill: null, page: -2 })).toMatchObject({
      rowId: rows[0],
    });
  });

  it("is nothing for a folder with peeks off, or one that holds no Sessions", () => {
    expect(peekSubject(folder, "off", folders, FOLDER_VIEW_START)).toBeNull();
    expect(
      peekSubject(folderRowId("tkt-missing"), "ticket", folders, FOLDER_VIEW_START),
    ).toBeNull();
  });
});

describe("the state a mark carries", () => {
  it("gives Active the band's vocabulary, attention first", () => {
    expect(activeMarkState(active("chat-a1"), false)).toBe("waiting");
    expect(activeMarkState(active("chat-a2"), false)).toBe("working");
    expect(activeMarkState(active("chat-a4"), false)).toBe("interrupted");
    expect(activeMarkState(active("chat-a5"), false)).toBe("idle");
  });

  it("flips a waiting row to working once its answer is delivered, and nothing else", () => {
    expect(activeMarkState(active("chat-a1"), true)).toBe("working");
    expect(activeMarkState(active("chat-a4"), true)).toBe("interrupted");
  });

  it("keeps Previous still, except for a turn that died", () => {
    expect(previousMarkState(previous("chat-p3"))).toBeNull();
    expect(previousMarkState(previous("term-p2"))).toBeNull();
    expect(previousMarkState(previous("chat-p6"))).toBe("interrupted");
  });

  it("maps onto the card's four fixture states", () => {
    expect(fixtureStateOf("working")).toBe("active");
    expect(fixtureStateOf("waiting")).toBe("waiting");
    expect(fixtureStateOf("interrupted")).toBe("failed");
    expect(fixtureStateOf("idle")).toBe("idle");
    expect(fixtureStateOf(null)).toBe("idle");
  });
});

describe("the peek's fixture", () => {
  it("carries the listing's title and ticket and the corpus's summary, question and model", () => {
    const fixture = sessionFixture(
      listedActive(active("chat-a1"), false),
      CORPUS.get("chat-a1")!,
      project.ticketPrefix,
      NOW,
    );
    expect(fixture).toMatchObject({
      rowId: "chat:chat-a1",
      sessionTitle: "Trace the dropped decorations back to the debounce",
      ticketId: "VLT-14",
      ticketStage: "Doing",
      recency: "2m ago",
      state: "waiting",
      failure: null,
      model: { providerId: "anthropic", providerLabel: "Anthropic" },
    });
    expect(fixture.question?.prompts[0]?.label).toBe("Which fix should land first?");
  });

  it("says a ticketless Session has no ticket, and a dead turn why", () => {
    const board = sessionFixture(
      listedActive(active("chat-a5"), false),
      CORPUS.get("chat-a5")!,
      project.ticketPrefix,
      NOW,
    );
    expect(board).toMatchObject({ ticketId: null, ticketTitle: null, ticketStage: null });
    const died = sessionFixture(
      listedPrevious(previous("chat-p6")),
      CORPUS.get("chat-p6")!,
      project.ticketPrefix,
      NOW,
    );
    expect(died.state).toBe("failed");
    expect(died.failure).not.toBeNull();
  });

  it("draws a terminal with its harness and no transcript", () => {
    const terminal = CORPUS.get("term-p2")!;
    expect(terminal).toMatchObject({ kind: "terminal", vendor: "anthropic", messages: [] });
    expect(terminal.runs.label).toBe("Claude Code");
    expect(terminal.summary).toContain("Exited 0 after 1h 12m");
  });
});

describe("the rail's roster", () => {
  it("lists the open ticket's live rows, then its record", () => {
    const roster = railRoster(listing, RAIL_TICKET_ID);
    expect(roster.current.map((row) => corpusIdOf(row.id))).toEqual(["chat-a1", "chat-a2"]);
    expect(roster.record.map((row) => corpusIdOf(row.id))).toEqual(["chat-p1", "term-p2"]);
  });

  it("is empty for a ticket with no Sessions", () => {
    expect(railRoster(listing, "tkt-missing")).toEqual({ current: [], record: [] });
  });
});

function vendorOf(rowId: string) {
  return CORPUS.get(corpusIdOf(rowId))?.vendor;
}

describe("the folder's marks face", () => {
  it("names each vendor once, newest first, up to the limit", () => {
    expect(folderVendors(folders.get("tkt-11") ?? [], vendorOf)).toEqual([
      "anthropic",
      "openai-codex",
      "zai",
    ]);
    expect(folderVendors(folders.get("tkt-11") ?? [], vendorOf, 2)).toEqual([
      "anthropic",
      "openai-codex",
    ]);
    expect(folderVendors(["chat:unknown"], vendorOf)).toEqual([]);
  });
});
