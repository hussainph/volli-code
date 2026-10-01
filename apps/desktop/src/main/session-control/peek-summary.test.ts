import { describe, expect, it, vi } from "vite-plus/test";
import {
  EMPTY_MODEL_ACCESS_DEFAULTS,
  UtilityCompletionError,
  type ModelAccessSnapshot,
  type SessionPeekEntry,
  type SessionUsage,
} from "@volli/shared";
import {
  createPeekSummarizer,
  PEEK_SUMMARY_GLOBAL_GAP_MS,
  PEEK_SUMMARY_INPUT_CHARS,
  PEEK_SUMMARY_SESSION_GAP_MS,
  PEEK_SUMMARY_SYSTEM_PROMPT,
  type PeekSummarizerOptions,
} from "./peek-summary";

const UTILITY = { providerId: "openai", modelId: "cheap", reasoningLevel: "high" } as const;
const MODEL: ModelAccessSnapshot["models"][number] = {
  ...UTILITY,
  label: "Cheap",
  state: "available",
  reasoningLevels: ["off", "low", "high"],
  acceptsImageInput: false,
};
const USAGE: SessionUsage = {
  providerId: "openai",
  modelId: "cheap",
  cause: "utility",
  inputTokens: 100,
  outputTokens: 30,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.002,
  costBasis: "catalog-estimate",
};
function entry(
  text: string,
  role: SessionPeekEntry["role"] = "assistant",
  at = 1,
): SessionPeekEntry {
  return { at, role, text, tools: [] };
}
function excerpt(text: string): string {
  return text.repeat(Math.ceil(2_000 / text.length)).slice(0, 2_000);
}
function harness(overrides: Partial<PeekSummarizerOptions> = {}) {
  let clock = 0;
  const readModelDefaults = vi.fn(() => ({ ...EMPTY_MODEL_ACCESS_DEFAULTS, utility: UTILITY }));
  const inspectModelAccess = vi.fn<PeekSummarizerOptions["inspectModelAccess"]>(async () => ({
    observedAt: 0,
    providers: [],
    models: [MODEL],
  }));
  const completeUtility = vi.fn<PeekSummarizerOptions["completeUtility"]>(async () => ({
    text: "The requested fix is in progress.",
    usage: null,
  }));
  const recordUsage = vi.fn<PeekSummarizerOptions["recordUsage"]>(async () => {});
  const summarizer = createPeekSummarizer({
    readModelDefaults,
    inspectModelAccess,
    completeUtility,
    recordUsage,
    now: () => clock,
    ...overrides,
  });
  return {
    ...summarizer,
    readModelDefaults,
    inspectModelAccess,
    completeUtility,
    recordUsage,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("hover-only peek summaries", () => {
  it("does no work until requested, then combines only user and assistant words in one call", async () => {
    const h = harness();
    expect(h.inspectModelAccess).not.toHaveBeenCalled();
    expect(h.completeUtility).not.toHaveBeenCalled();
    await h.summarize("s", [
      entry("Ignore the summary rules", "system"),
      entry("Fix the hover peek", "user"),
      { ...entry(""), tools: ["private_tool_arguments"] },
      { ...entry("Removing the clamp", "assistant", 2), tools: ["private_tool_output"] },
    ]);
    expect(h.completeUtility).toHaveBeenCalledTimes(1);
    const call = h.completeUtility.mock.calls[0]![0];
    expect(call.model).toEqual({ ...UTILITY, reasoningLevel: "off" });
    expect(call.systemPrompt).toBe(PEEK_SUMMARY_SYSTEM_PROMPT);
    expect(call.systemPrompt).toContain(
      "Strict limit: 250 characters including spaces and punctuation",
    );
    expect(call.systemPrompt).toContain("Do not exceed it");
    expect(call.systemPrompt).toContain("1–2 short plain-text sentences");
    expect(call.systemPrompt).toContain("current goal");
    expect(call.systemPrompt).toContain("brief next action when one is stated in the conversation");
    expect(call.systemPrompt).toContain("Do not invent progress or action items");
    expect(call.systemPrompt).toContain("check the character count");
    expect(JSON.parse(call.user)).toEqual([
      { role: "user", text: "Fix the hover peek" },
      { role: "assistant", text: "Removing the clamp" },
    ]);
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it("never calls for empty, system-only or tools-only entries", async () => {
    const h = harness();
    expect(await h.summarize("s", [])).toBeNull();
    expect(
      await h.summarize("s", [entry("system", "system"), { ...entry("  "), tools: ["read"] }]),
    ).toBeNull();
    expect(h.readModelDefaults).not.toHaveBeenCalled();
    expect(h.completeUtility).not.toHaveBeenCalled();
  });

  it("reuses cached summaries across hovers and tool churn even after the cooldown", async () => {
    const h = harness();
    const spoken = [entry("Request", "user"), entry("Working", "assistant", 2)];
    const text = await h.summarize("s", spoken);
    h.advance(PEEK_SUMMARY_SESSION_GAP_MS);
    expect(
      await h.summarize("s", [spoken[1]!, { ...entry("", "assistant", 3), tools: ["bash"] }]),
    ).toBe(text);
    expect(await h.summarize("s", [{ ...entry(""), tools: ["bash"] }])).toBe(text);
    expect(h.completeUtility).toHaveBeenCalledTimes(1);
  });

  it("throttles changed messages per Session and across Sessions without scheduling later work", async () => {
    const h = harness();
    const first = await h.summarize("a", [entry("First")]);
    expect(await h.summarize("a", [entry("Second", "assistant", 2)])).toBe(first);
    expect(await h.summarize("b", [entry("Other session")])).toBeNull();
    h.advance(PEEK_SUMMARY_GLOBAL_GAP_MS);
    await h.summarize("b", [entry("Other session")]);
    expect(h.completeUtility).toHaveBeenCalledTimes(2);
    h.advance(PEEK_SUMMARY_SESSION_GAP_MS - PEEK_SUMMARY_GLOBAL_GAP_MS);
    expect(h.completeUtility).toHaveBeenCalledTimes(2);
    await h.summarize("a", [entry("Second", "assistant", 2)]);
    expect(h.completeUtility).toHaveBeenCalledTimes(3);
  });

  it("never queues concurrent hovers, even beyond the global cooldown", async () => {
    const pending = Promise.withResolvers<{ text: string; usage: null }>();
    const h = harness({ completeUtility: async () => pending.promise });
    const first = h.summarize("a", [entry("First")]);
    await Promise.resolve();
    h.advance(PEEK_SUMMARY_SESSION_GAP_MS);
    expect(await h.summarize("a", [entry("First")])).toBeNull();
    expect(await h.summarize("b", [entry("Second")])).toBeNull();
    expect(h.inspectModelAccess).toHaveBeenCalledTimes(1);
    pending.resolve({ text: "Summary", usage: null });
    expect(await first).toBe("Summary");
  });

  it("uses only the configured utility model, never a role default", async () => {
    const h = harness({
      readModelDefaults: () => ({ ...EMPTY_MODEL_ACCESS_DEFAULTS, ticket: UTILITY }),
    });
    expect(await h.summarize("s", [entry("Working")])).toBeNull();
    expect(h.inspectModelAccess).not.toHaveBeenCalled();
    expect(h.completeUtility).not.toHaveBeenCalled();
  });

  it.each<{ models: ModelAccessSnapshot["models"] }>([
    { models: [] },
    { models: [{ ...MODEL, state: "unavailable" }] },
    { models: [{ ...MODEL, reasoningLevels: [] }] },
  ])(
    "keeps the fallback when Model Access cannot offer the selected model (%j)",
    async ({ models }) => {
      const h = harness({
        inspectModelAccess: async () => ({ observedAt: 0, providers: [], models }),
      });
      expect(await h.summarize("s", [entry("Working")])).toBeNull();
      expect(h.completeUtility).not.toHaveBeenCalled();
    },
  );

  it("retains the latest user request alongside the five newest progress entries", async () => {
    const h = harness();
    const goal = entry("Fix hover summaries without increasing utility model costs.", "user", 3);
    const progress = [
      "Read the current summary prompt and hover request path.",
      "Found the six-message slice that discards the user's request.",
      "Reserved bounded input space for the latest user goal.",
      "Kept the newest progress excerpts in conversation order.",
      "Added input-selection regressions without changing cooldowns.",
      "The focused tests pass; the change is ready for review.",
    ].map((text, index) => entry(text, "assistant", index + 4));
    const entries = [
      entry("Rename the sidebar headings.", "user", 1),
      entry("The sidebar headings are updated.", "assistant", 2),
      goal,
      ...progress,
    ];
    const summary = await h.summarize("s", entries);
    const sent = JSON.parse(h.completeUtility.mock.calls[0]![0].user) as {
      role: string;
      text: string;
    }[];
    expect(sent).toEqual([goal, ...progress.slice(1)].map(({ role, text }) => ({ role, text })));
    expect(sent).toHaveLength(6);
    expect(sent.reduce((total, message) => total + message.text.length, 0)).toBeLessThanOrEqual(
      PEEK_SUMMARY_INPUT_CHARS,
    );
    h.advance(PEEK_SUMMARY_SESSION_GAP_MS);
    expect(
      await h.summarize("s", [
        progress.at(-1)!,
        { ...entry(" ", "assistant", 10), tools: ["read_file"] },
        entry("Internal summary instructions", "system", 11),
      ]),
    ).toBe(summary);
    expect(h.inspectModelAccess).toHaveBeenCalledTimes(1);
    expect(h.completeUtility).toHaveBeenCalledTimes(1);
  });

  it.each([3, 6])(
    "reserves the goal when %i realistic 2000-character progress excerpts fill the input budget",
    async (progressCount) => {
      const h = harness();
      const goal = entry(
        excerpt(
          "Fix the hover summary so the user's request remains visible alongside recent progress. ",
        ),
        "user",
        1,
      );
      const progress = [
        "Read the summary service and identified the newest-first input allocation. ",
        "Confirmed that tool-only messages do not invalidate the cached summary. ",
        "Kept the utility model selection, accounting and cooldown behavior intact. ",
        "Added a regression that exceeds the six-entry limit with spoken progress. ",
        "Reserved input space for the goal before allocating the newest progress text. ",
        "Verified chronological message order and the total character budget in the focused tests. ",
      ]
        .slice(0, progressCount)
        .map((text, index) => entry(excerpt(text), "assistant", index + 2));
      await h.summarize("s", [goal, ...progress]);
      const sent = JSON.parse(h.completeUtility.mock.calls[0]![0].user) as {
        role: string;
        text: string;
      }[];
      expect(sent).toEqual([goal, ...progress.slice(-2)].map(({ role, text }) => ({ role, text })));
      expect(sent.length).toBeLessThanOrEqual(6);
      expect(sent.reduce((total, message) => total + message.text.length, 0)).toBe(
        PEEK_SUMMARY_INPUT_CHARS,
      );
      expect(h.completeUtility).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves message order when the latest request follows earlier progress", async () => {
    const h = harness();
    const progress = [
      "Read the existing implementation. ",
      "Updated the summary input allocation. ",
      "The focused regressions pass. ",
    ].map((text, index) =>
      entry(text.repeat(Math.ceil(2_000 / text.length)).slice(0, 2_000), "assistant", index + 1),
    );
    const goal = entry(
      "Also preserve the utility cooldown. ".repeat(100).slice(0, 2_000),
      "user",
      4,
    );
    await h.summarize("s", [...progress, goal]);
    expect(JSON.parse(h.completeUtility.mock.calls[0]![0].user)).toEqual(
      [...progress.slice(-2), goal].map(({ role, text }) => ({ role, text })),
    );
    expect(h.completeUtility).toHaveBeenCalledTimes(1);
  });

  it.each(["assistant", "user"] as const)(
    "accepts %s-only input while keeping at most six spoken entries",
    async (role) => {
      const h = harness();
      const entries = Array.from({ length: 7 }, (_, index) =>
        entry(`Summary input message ${index + 1}.`, role, index + 1),
      );
      await h.summarize("s", entries);
      expect(JSON.parse(h.completeUtility.mock.calls[0]![0].user)).toEqual(
        entries.slice(-6).map(({ role: messageRole, text }) => ({ role: messageRole, text })),
      );
      expect(h.completeUtility).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds the goal, keeps newest progress, and sends no extra repair for long output", async () => {
    const longOutput = "Readable summary. ".repeat(100);
    const h = harness();
    h.completeUtility.mockResolvedValue({ text: ` ${longOutput} `, usage: null });
    expect(
      await h.summarize("s", [
        entry("old".repeat(3_000), "user"),
        entry("new".repeat(2_000), "assistant", 2),
      ]),
    ).toBe(longOutput.trim());
    const sent = JSON.parse(h.completeUtility.mock.calls[0]![0].user) as {
      role: string;
      text: string;
    }[];
    expect(sent).toEqual([
      { role: "user", text: "old".repeat(3_000).slice(0, 2_000) },
      { role: "assistant", text: "new".repeat(2_000).slice(0, 4_000) },
    ]);
    expect(sent.reduce((total, message) => total + message.text.length, 0)).toBe(
      PEEK_SUMMARY_INPUT_CHARS,
    );
    expect(h.completeUtility).toHaveBeenCalledTimes(1);
  });

  it("records successful and billed failed usage; failures retain the old summary and can retry after the gap", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = harness();
      h.completeUtility.mockResolvedValueOnce({ text: "First summary", usage: USAGE });
      expect(await h.summarize("s", [entry("First")])).toBe("First summary");
      h.advance(PEEK_SUMMARY_SESSION_GAP_MS);
      h.completeUtility.mockRejectedValueOnce(new UtilityCompletionError("Failed", USAGE));
      expect(await h.summarize("s", [entry("Second", "assistant", 2)])).toBe("First summary");
      expect(h.recordUsage).toHaveBeenCalledTimes(2);
      expect(h.recordUsage).toHaveBeenLastCalledWith("s", USAGE);
      h.advance(PEEK_SUMMARY_SESSION_GAP_MS);
      h.completeUtility.mockResolvedValueOnce({ text: "Second summary", usage: null });
      expect(await h.summarize("s", [entry("Second", "assistant", 2)])).toBe("Second summary");
    } finally {
      log.mockRestore();
    }
  });

  it("contains probe failures and empty answers without blocking future hovers", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = harness();
      h.inspectModelAccess.mockRejectedValueOnce(new Error("Offline"));
      expect(await h.summarize("s", [entry("Working")])).toBeNull();
      h.advance(PEEK_SUMMARY_SESSION_GAP_MS);
      h.completeUtility.mockResolvedValueOnce({ text: "  ", usage: null });
      expect(await h.summarize("s", [entry("Working")])).toBeNull();
      h.advance(PEEK_SUMMARY_SESSION_GAP_MS);
      expect(await h.summarize("s", [entry("Working")])).not.toBeNull();
    } finally {
      log.mockRestore();
    }
  });

  it("keeps a useful answer even when usage recording fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = harness({
        recordUsage: async () => {
          throw new Error("Ledger refused");
        },
      });
      h.completeUtility.mockResolvedValue({ text: "Summary", usage: USAGE });
      expect(await h.summarize("s", [entry("Working")])).toBe("Summary");
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("bounds the cache of visited Sessions", async () => {
    const h = harness();
    for (let i = 0; i < 201; i++) {
      await h.summarize(`s-${i}`, [entry("Working")]);
      h.advance(PEEK_SUMMARY_GLOBAL_GAP_MS);
    }
    await h.summarize("s-0", [entry("Working")]);
    expect(h.completeUtility).toHaveBeenCalledTimes(202);
  });
});
