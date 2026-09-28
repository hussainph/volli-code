import { describe, expect, it } from "vite-plus/test";
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  summarizeSessionUsage,
  type ChatSessionRecord,
  type ModelAccessModel,
  type ModelAccessProvider,
  type SessionListingIdentity,
  type SessionRecord,
  type SessionUsage,
  type SessionUsageReport,
  type SessionUsageSummary,
} from "@volli/shared";

import {
  modelName,
  modelRows,
  sessionLabel,
  ticketSessionRows,
  type UsageModelCatalogue,
} from "./usage-rail-model";

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

function model(over: Partial<ModelAccessModel> & Pick<ModelAccessModel, "modelId" | "label">) {
  return {
    providerId: "anthropic",
    state: "available",
    reasoningLevels: [],
    acceptsImageInput: true,
    ...over,
  } satisfies ModelAccessModel;
}

function provider(id: string, label: string): ModelAccessProvider {
  return {
    id,
    label,
    state: "available",
    accountLabel: null,
    billingSource: "api-key",
    recovery: null,
    signIn: [],
    hasStoredCredential: true,
  };
}

const CATALOGUE: UsageModelCatalogue = {
  providers: [provider("anthropic", "Anthropic"), provider("openrouter", "OpenRouter")],
  models: [
    model({ modelId: "claude-opus-4-1", label: "Claude Opus 4.1" }),
    // A model the reader has hidden, or whose provider has been signed out. The
    // catalogue still holds it and this row still spent money.
    model({ modelId: "claude-haiku-4-5", label: "Claude Haiku 4.5", state: "unavailable" }),
    model({
      providerId: "openrouter",
      modelId: "anthropic/claude-sonnet-4.5",
      label: "Claude Sonnet 4.5",
    }),
  ],
};

describe("modelRows", () => {
  it("names each model as the catalogue does, in the report's cost order", () => {
    const rows = modelRows(
      report([
        { key: "anthropic/claude-opus-4-1", usage: spent(3) },
        { key: "anthropic/claude-haiku-4-5", usage: spent(1) },
      ]),
      CATALOGUE,
    );
    expect(rows.map((row) => row.label)).toEqual(["Claude Opus 4.1", "Claude Haiku 4.5"]);
    // The identity the mark is drawn from travels with the row: the drawing
    // resolves nothing itself.
    expect(rows[0]?.model).toEqual({
      model: {
        providerId: "anthropic",
        modelId: "claude-opus-4-1",
        label: "Claude Opus 4.1",
      },
      providerLabel: "Anthropic",
    });
  });

  it("keeps a null group under a stable key, so it cannot collide or vanish", () => {
    const rows = modelRows(report([{ key: null, usage: spent(1) }]), CATALOGUE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe("\u0000none");
    expect(rows[0]?.label).toBe("Unknown model");
    // Nothing to mark: there is no model here to be recognised.
    expect(rows[0]?.model).toBeNull();
  });
});

describe("modelName", () => {
  it("reads the whole catalogue, because history stays valid after a sign-out", () => {
    // `state: "unavailable"` is exactly what the composers' offerable slice
    // drops. The money was still spent by a model with a name.
    expect(modelName("anthropic/claude-haiku-4-5", CATALOGUE).label).toBe("Claude Haiku 4.5");
  });

  it("splits the key at its FIRST slash, so a gateway's model id survives whole", () => {
    const named = modelName("openrouter/anthropic/claude-sonnet-4.5", CATALOGUE);
    expect(named.label).toBe("Claude Sonnet 4.5");
    expect(named.model?.model.modelId).toBe("anthropic/claude-sonnet-4.5");
    expect(named.model?.providerLabel).toBe("OpenRouter");
  });

  it("keeps the model id when the catalogue cannot name it", () => {
    // A model retired from the catalogue, or a provider this build never knew.
    const named = modelName("openai/gpt-5.6-luna", CATALOGUE);
    expect(named.label).toBe("gpt-5.6-luna");
    // Still a mark: the provider and the model ids are the ledger's own facts,
    // so the row does not move sideways for want of a display name.
    expect(named.model).toEqual({
      model: { providerId: "openai", modelId: "gpt-5.6-luna", label: "gpt-5.6-luna" },
      // Nothing named the account either, so the id stands in for it.
      providerLabel: "openai",
    });
  });

  it("keeps the ids when there is no catalogue at all", () => {
    // The read is still out, or it failed. An honest id beats a guess.
    const named = modelName("anthropic/claude-opus-4-1", null);
    expect(named.label).toBe("claude-opus-4-1");
    expect(named.model?.providerLabel).toBe("anthropic");
  });

  it("marks nothing for a null key or a key that is not a model reference", () => {
    expect(modelName(null, CATALOGUE)).toEqual({ label: "Unknown model", model: null });
    expect(modelName("claude-opus-4-1", CATALOGUE)).toEqual({
      label: "claude-opus-4-1",
      model: null,
    });
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
