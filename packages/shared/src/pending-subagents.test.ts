import { describe, expect, it } from "vite-plus/test";
import { isSessionListState, pendingSubagentIds, SESSION_LIST_STATES } from "./pending-subagents";
import type { ChatSessionRecord } from "./session";

type Record = Parameters<typeof pendingSubagentIds>[1][number];
const child = (
  sessionId: string,
  createdAt: number,
  activity: ChatSessionRecord["activity"] = "working",
  extra: Partial<Record> = {},
): Record => ({
  sessionId,
  createdAt,
  activity,
  role: "subagent",
  parentSessionId: "parent",
  ...extra,
});

describe("pendingSubagentIds", () => {
  it("keeps only working/waiting delegated children, in start order with stable ties", () => {
    const records = [
      child("cccccccc-full", 2, "waiting"),
      child("bbbbbbbb-full", 2),
      child("aaaaaaaa-full", 1),
      child("stopped", 0, "stopped"),
      child("idle", 0, "idle"),
      child("interrupted", 0, "interrupted"),
      child("other-parent", 0, "working", { parentSessionId: "other" }),
      child("no-parent", 0, "working", { parentSessionId: null }),
      child("not-delegated", 0, "working", { role: "ticket" }),
    ];
    const original = [...records];
    expect(pendingSubagentIds("parent", records)).toEqual(["aaaaaaaa", "bbbbbbbb", "cccccccc"]);
    expect(records).toEqual(original);
    expect(pendingSubagentIds("absent", records)).toEqual([]);
    expect(pendingSubagentIds("parent", [])).toEqual([]);
  });
});

describe("session list states", () => {
  it("accepts only the exact printed words", () => {
    for (const state of SESSION_LIST_STATES) expect(isSessionListState(state)).toBe(true);
    for (const value of ["Working", "parked", "", null, 1])
      expect(isSessionListState(value)).toBe(false);
  });
});
