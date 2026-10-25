import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vite-plus/test";

import { boardIntentDigest, boardReceiptExpiry, boardReceiptVerdict } from "./board-receipts";

const hash = (canonical: string) => bytesToHex(sha256(utf8ToBytes(canonical)));

describe("the canonical intent", () => {
  test("sorts keys at every depth and keeps array order", () => {
    expect(boardIntentDigest("op", { b: 1, a: { d: [3, 1], c: "x" } })).toBe(
      hash('{"intent":{"a":{"c":"x","d":[3,1]},"b":1},"operation":"op"}'),
    );
  });

  test("drops undefined members and writes an undefined array item as null", () => {
    expect(boardIntentDigest("op", { a: undefined, b: [undefined, 1] })).toBe(
      hash('{"intent":{"b":[null,1]},"operation":"op"}'),
    );
  });

  test("writes scalars as JSON does", () => {
    expect(boardIntentDigest("op", ["é", true, 1.5])).toBe(
      hash('{"intent":["é",true,1.5],"operation":"op"}'),
    );
  });
});

describe("boardIntentDigest", () => {
  test("is stable under key order and differs by operation and intent", () => {
    const a = boardIntentDigest("board.moveTickets", { toStatus: "doing", ticketIds: ["t"] });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(boardIntentDigest("board.moveTickets", { ticketIds: ["t"], toStatus: "doing" })).toBe(a);
    expect(
      boardIntentDigest("board.archiveTicket", { ticketIds: ["t"], toStatus: "doing" }),
    ).not.toBe(a);
    expect(boardIntentDigest("board.moveTickets", { ticketIds: ["t"], toStatus: "todo" })).not.toBe(
      a,
    );
  });

  test("treats an absent intent as null", () => {
    expect(boardIntentDigest("op", undefined)).toBe(boardIntentDigest("op", null));
  });
});

describe("boardReceiptVerdict", () => {
  const now = 1_000_000;
  const stored = {
    operation: "board.createTicket",
    intentDigest: boardIntentDigest("board.createTicket", { title: "A" }),
    reply: { ticketId: "t" },
    expiresAt: boardReceiptExpiry(now - 1),
  };

  test("a receipt expires seven days after it was recorded", () => {
    expect(boardReceiptExpiry(5)).toBe(5 + 604_800_000);
  });

  test("no receipt, or an expired one, is absent", () => {
    const command = { operation: "board.createTicket", intent: { title: "A" }, now };
    expect(boardReceiptVerdict(null, command)).toEqual({ kind: "absent" });
    expect(boardReceiptVerdict({ ...stored, expiresAt: now }, command)).toEqual({ kind: "absent" });
  });

  test("the same operation and intent replays the stored reply", () => {
    expect(
      boardReceiptVerdict(stored, { operation: "board.createTicket", intent: { title: "A" }, now }),
    ).toEqual({ kind: "replay", reply: { ticketId: "t" } });
  });

  test("another intent or another operation under the same id is a conflict", () => {
    expect(
      boardReceiptVerdict(stored, { operation: "board.createTicket", intent: { title: "B" }, now }),
    ).toEqual({ kind: "conflict" });
    expect(
      boardReceiptVerdict(stored, { operation: "board.updateTicket", intent: { title: "A" }, now }),
    ).toEqual({ kind: "conflict" });
  });
});
