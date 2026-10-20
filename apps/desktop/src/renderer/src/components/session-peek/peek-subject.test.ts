/**
 * What each row peeks, and who may be answered.
 *
 * Ported from the lab's `sidebar-model.test.ts`, minus the cases about the
 * comparisons production dropped (the `newest` pager, the folder-peek switch,
 * the fixture mark states).
 */
import { describe, expect, it } from "vite-plus/test";

import {
  canPeekRow,
  canPinRow,
  FOLDER_PEEK_START,
  folderRowId,
  folderTicketId,
  peekSessionId,
  peekSubjectOf,
} from "./peek-subject";

const FOLDERS = new Map<string, readonly string[]>([
  ["tkt-11", ["chat:chat-p1", "session:pane-9", "chat:chat-p2"]],
  ["tkt-empty", []],
]);

describe("row ids", () => {
  it("round-trips a folder's ticket and leaves a Session row alone", () => {
    expect(folderRowId("tkt-11")).toBe("folder:tkt-11");
    expect(folderTicketId(folderRowId("tkt-11"))).toBe("tkt-11");
    expect(folderTicketId("chat:chat-p1")).toBeNull();
  });

  it("strips the listing's kind prefix, and refuses a row that carries none", () => {
    expect(peekSessionId("chat:chat-p1")).toBe("chat-p1");
    expect(peekSessionId("session:pane-9")).toBe("pane-9");
    // A Chat Draft's row id is the bare id it will keep — no Session exists yet.
    expect(peekSessionId("3f0c-draft")).toBeNull();
    expect(peekSessionId(folderRowId("tkt-11"))).toBeNull();
  });
});

describe("canPeekRow", () => {
  it("peeks every Session and every folder, and never a Draft", () => {
    expect(canPeekRow("chat:chat-p1")).toBe(true);
    expect(canPeekRow("session:pane-9")).toBe(true);
    expect(canPeekRow(folderRowId("tkt-11"))).toBe(true);
    expect(canPeekRow("3f0c-draft")).toBe(false);
  });
});

/** One chat Session, one terminal companion, and nothing known about the rest. */
const kindOf = (rowId: string): "chat" | "terminal" | undefined =>
  rowId === "chat:chat-p1" ? "chat" : rowId === "session:pane-9" ? "terminal" : undefined;

describe("canPinRow", () => {
  it("pins a chat Session only", () => {
    expect(canPinRow("chat:chat-p1", kindOf)).toBe(true);
    // A terminal companion has no turns and no interactions to answer (§3.5).
    expect(canPinRow("session:pane-9", kindOf)).toBe(false);
    // A folder's card lists several Sessions, so a reply would have no recipient.
    expect(canPinRow(folderRowId("tkt-11"), kindOf)).toBe(false);
    // A Draft, and a row whose kind nobody can answer for.
    expect(canPinRow("3f0c-draft", kindOf)).toBe(false);
    expect(canPinRow("chat:unknown", kindOf)).toBe(false);
  });
});

describe("peekSubjectOf", () => {
  it("gives a Session row its own card, reached from the row", () => {
    expect(peekSubjectOf("chat:chat-p1", FOLDERS, FOLDER_PEEK_START)).toEqual({
      kind: "session",
      rowId: "chat:chat-p1",
      via: { kind: "row" },
    });
  });

  it("gives a folder its ticket, with its Sessions in the listing's order", () => {
    expect(peekSubjectOf(folderRowId("tkt-11"), FOLDERS, FOLDER_PEEK_START)).toEqual({
      kind: "ticket",
      ticketId: "tkt-11",
      sessionRowIds: ["chat:chat-p1", "session:pane-9", "chat:chat-p2"],
    });
  });

  it("drills into one of the folder's Sessions, and says where it came from", () => {
    expect(peekSubjectOf(folderRowId("tkt-11"), FOLDERS, { drill: "session:pane-9" })).toEqual({
      kind: "session",
      rowId: "session:pane-9",
      via: { kind: "drill", ticketId: "tkt-11" },
    });
  });

  it("falls back to the ticket when the drilled Session has left the folder", () => {
    // The listing rebuilt under the pointer and that Session is gone: the card
    // shows the ticket again rather than a row nothing stands behind.
    expect(peekSubjectOf(folderRowId("tkt-11"), FOLDERS, { drill: "chat:retired" })?.kind).toBe(
      "ticket",
    );
  });

  it("has nothing to show for an empty folder, an unknown one, or a Draft", () => {
    expect(peekSubjectOf(folderRowId("tkt-empty"), FOLDERS, FOLDER_PEEK_START)).toBeNull();
    expect(peekSubjectOf(folderRowId("tkt-nope"), FOLDERS, FOLDER_PEEK_START)).toBeNull();
    expect(peekSubjectOf("3f0c-draft", FOLDERS, FOLDER_PEEK_START)).toBeNull();
  });
});
