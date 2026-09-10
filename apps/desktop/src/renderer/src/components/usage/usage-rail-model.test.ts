import { describe, expect, it } from "vite-plus/test";
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  summarizeSessionUsage,
  type ChatSessionRecord,
  type SessionListingIdentity,
  type SessionRecord,
  type SessionUsage,
  type SessionUsageReport,
  type SessionUsageSummary,
} from "@volli/shared";

import { groupRows, modelLabel, sessionLabel, ticketSessionRows } from "./usage-rail-model";

/** A summary that cost `usd`, priced, so rows can be compared by money. */
function spent(usd: number): SessionUsageSummary {
  const operation: SessionUsage = {
    cause: "assistant",
    providerId: "anthropic",
    modelId: "claude-opus-4-1",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: usd,
    costBasis: "catalog-estimate",
  };
  return summarizeSessionUsage([operation]);
}

function report(groups: readonly { key: string | null; usage: SessionUsageSummary }[]) {
  return {
    total: EMPTY_SESSION_USAGE_SUMMARY,
    // As the report hands them over: ordered by known cost, descending.
    groups: [...groups].toSorted(
      (left, right) => (right.usage.knownCostUsd ?? 0) - (left.usage.knownCostUsd ?? 0),
    ),
    history: { meteredFrom: 0, complete: true },
    meteredSessionCount: groups.length,
  } satisfies SessionUsageReport;
}

function chatRow(
  overrides: Partial<ChatSessionRecord> & { sessionId: string },
): SessionListingIdentity {
  const record: ChatSessionRecord = {
    title: "Chat",
    projectId: "p1",
    ticketId: "t1",
    createdAt: 0,
    adapterId: "pi",
    live: false,
    activity: "idle",
    waitingOn: null,
    outcome: null,
    lastActivityAt: 0,
    bornTicketless: false,
    role: "ticket",
    parentSessionId: null,
    ...overrides,
  };
  return { kind: "chat", record };
}

function child(
  sessionId: string,
  parentSessionId: string,
  title = "Helper",
): SessionListingIdentity {
  return chatRow({ sessionId, title, role: "subagent", parentSessionId });
}

function terminalRow(id: string, title = "Terminal"): SessionListingIdentity {
  const record = {
    id,
    ticketId: "t1",
    title,
    createdAt: 0,
    endedAt: null,
    launchKind: "shell",
    placement: "tab",
    harnessId: null,
    declaredHarnessId: null,
    cwd: "/tmp",
    adapterId: null,
  } as unknown as SessionRecord;
  return { kind: "terminal", record };
}

const money = (rows: readonly { label: string; usage: SessionUsageSummary }[]) =>
  rows.map((row) => [row.label, row.usage.knownCostUsd] as const);

describe("ticketSessionRows", () => {
  it("names each Session that spent, and each one that spent nothing at all", () => {
    const rows = ticketSessionRows(report([{ key: "s1", usage: spent(2) }]), [
      chatRow({ sessionId: "s1", title: "The chat" }),
      terminalRow("t-1", "A shell"),
    ]);
    expect(money(rows)).toEqual([
      ["The chat", 2],
      ["A shell", null],
    ]);
  });

  // VC-279's half of this file: a delegated child is never a row, here or in
  // any Session listing — but its money is the Ticket's money and the total
  // above these rows counts it, so it moves onto the row for the Session that
  // decided to spend it.
  it("folds a child's spend into the Session that delegated it", () => {
    const rows = ticketSessionRows(
      report([
        { key: "parent", usage: spent(0.5) },
        { key: "kid-a", usage: spent(2) },
        { key: "kid-b", usage: spent(1) },
      ]),
      [
        chatRow({ sessionId: "parent", title: "The chat that delegated" }),
        child("kid-a", "parent", "Find the auth refresh"),
        child("kid-b", "parent", "Summarise the diff"),
      ],
    );
    expect(money(rows)).toEqual([["The chat that delegated", 3.5]]);
  });

  it("keeps a child that metered nothing out of the rows entirely", () => {
    // The unmetered arm is where a hidden row would otherwise reappear: it is
    // built from the roster, which holds every child.
    const rows = ticketSessionRows(report([{ key: "parent", usage: spent(1) }]), [
      chatRow({ sessionId: "parent", title: "The chat that delegated" }),
      child("kid", "parent", "Read the migration"),
    ]);
    expect(money(rows)).toEqual([["The chat that delegated", 1]]);
  });

  it("re-ranks after folding, so a parent's helpers can outspend a dearer Session", () => {
    // The report ordered `rich` first on its own $3. The parent metered $1 and
    // is only dearer once its children are added — a fold that kept the
    // report's order would print a $4 row under a $3 one.
    const rows = ticketSessionRows(
      report([
        { key: "rich", usage: spent(3) },
        { key: "parent", usage: spent(1) },
        { key: "kid", usage: spent(3) },
      ]),
      [
        chatRow({ sessionId: "rich", title: "Expensive solo chat" }),
        chatRow({ sessionId: "parent", title: "The chat that delegated" }),
        child("kid", "parent"),
      ],
    );
    expect(money(rows)).toEqual([
      ["The chat that delegated", 4],
      ["Expensive solo chat", 3],
    ]);
  });

  it("lets a parent that metered nothing itself carry its children's spend", () => {
    // A parent whose own turns were free — it delegated and waited — has no
    // group of its own in the report. Its row is created by the fold, and it
    // must not be the `—` row it would have been.
    const rows = ticketSessionRows(report([{ key: "kid", usage: spent(2) }]), [
      chatRow({ sessionId: "parent", title: "The chat that delegated" }),
      child("kid", "parent"),
    ]);
    expect(money(rows)).toEqual([["The chat that delegated", 2]]);
  });

  it("keeps a child's own row when the roster no longer holds its parent", () => {
    // The honest fallback: money with nowhere to go stays where it was spent,
    // because losing it is worse than showing a helper.
    const rows = ticketSessionRows(report([{ key: "kid", usage: spent(2) }]), [
      child("kid", "deleted-parent", "Orphaned helper"),
    ]);
    expect(money(rows)).toEqual([["Orphaned helper", 2]]);
  });

  it("keeps spend the roster cannot name, under the id the CLI would print", () => {
    const rows = ticketSessionRows(report([{ key: "9f8e7d6c5b4a", usage: spent(4) }]), [
      chatRow({ sessionId: "s1", title: "The chat" }),
    ]);
    expect(money(rows)).toEqual([
      ["Session 9f8e7d6c", 4],
      ["The chat", null],
    ]);
  });

  it("keeps unattributed spend as its own row rather than folding it anywhere", () => {
    const rows = ticketSessionRows(report([{ key: null, usage: spent(1) }]), [
      chatRow({ sessionId: "s1", title: "The chat" }),
    ]);
    expect(money(rows)).toEqual([
      ["Unattributed", 1],
      ["The chat", null],
    ]);
  });

  it("draws nothing from an empty report and an unread roster", () => {
    expect(ticketSessionRows(report([]), undefined)).toEqual([]);
  });
});

describe("groupRows", () => {
  it("keeps a null group under a stable key, so it cannot collide or vanish", () => {
    const rows = groupRows(report([{ key: null, usage: spent(1) }]), (key) =>
      key === null ? "Unknown model" : key,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe("\u0000none");
    expect(rows[0]?.label).toBe("Unknown model");
  });
});

describe("modelLabel", () => {
  it("drops the provider prefix and keeps an unprefixed id whole", () => {
    expect(modelLabel("anthropic/claude-opus-4-1")).toBe("claude-opus-4-1");
    expect(modelLabel("claude-opus-4-1")).toBe("claude-opus-4-1");
    expect(modelLabel(null)).toBe("Unknown model");
  });
});

describe("sessionLabel", () => {
  it("falls back to the short id for a Session with no title, and for one nobody holds", () => {
    const roster = [chatRow({ sessionId: "9f8e7d6c5b4a", title: "" })];
    expect(sessionLabel("9f8e7d6c5b4a", roster)).toBe("Session 9f8e7d6c");
    expect(sessionLabel("9f8e7d6c5b4a", undefined)).toBe("Session 9f8e7d6c");
    expect(sessionLabel(null, roster)).toBe("Unattributed");
  });
});
