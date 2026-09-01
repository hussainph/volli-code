import { describe, expect, it } from "vite-plus/test";
import type { UIMessage } from "ai";

import { contextGridCells, formatTokens, sessionContextUsage } from "./context-usage";

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

function assistant(
  id: string,
  text: string,
  tokens?: Record<string, unknown> | null,
  extraParts: unknown[] = [],
): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text, state: "done" }, ...extraParts],
    ...(tokens === undefined ? {} : { metadata: { tokens } }),
  } as UIMessage;
}

describe("sessionContextUsage", () => {
  it("answers null while nothing has been metered — not a zero", () => {
    expect(sessionContextUsage([], 200_000)).toBeNull();
    expect(sessionContextUsage([user("u1", "hello")], 200_000)).toBeNull();
    // An assistant reply with no metadata is unmetered too.
    expect(sessionContextUsage([user("u1", "hi"), assistant("a1", "hello")], 200_000)).toBeNull();
  });

  it("sums the provider's four counters into occupancy", () => {
    const usage = sessionContextUsage(
      [
        user("u1", "hello"),
        assistant("a1", "world", { input: 100, output: 50, cacheRead: 800, cacheWrite: 50 }),
      ],
      200_000,
    );
    expect(usage).not.toBeNull();
    expect(usage!.usedTokens).toBe(1000);
    expect(usage!.contextWindow).toBe(200_000);
    expect(usage!.fraction).toBeCloseTo(0.005);
  });

  it("reads the LAST metered reply, and tolerates nulls where older ledgers left them", () => {
    const usage = sessionContextUsage(
      [
        assistant("a1", "first", { input: 10, output: 5, cacheRead: null, cacheWrite: null }),
        user("u2", "again"),
        assistant("a2", "second", { input: 40, output: 10, cacheRead: null, cacheWrite: null }),
      ],
      1000,
    );
    expect(usage!.usedTokens).toBe(50);
  });

  it("survives malformed metadata from a newer writer", () => {
    const junk = [
      assistant("a1", "reply", { input: "many", output: [] }),
      assistant("a2", "reply", null),
    ];
    expect(sessionContextUsage(junk, 1000)).toBeNull();
  });

  it("carries no fraction when the window is unknown", () => {
    const usage = sessionContextUsage(
      [assistant("a1", "x", { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 })],
      null,
    );
    expect(usage!.contextWindow).toBeNull();
    expect(usage!.fraction).toBeNull();
  });

  it("clamps the fraction: a spent window reads full, never overfull", () => {
    const usage = sessionContextUsage(
      [assistant("a1", "x", { input: 1500, output: 0, cacheRead: 0, cacheWrite: 0 })],
      1000,
    );
    expect(usage!.fraction).toBe(1);
  });

  it("segments sum exactly to the measured total, with the shortfall filed as system", () => {
    // 400 chars of user text ≈ 100 estimated tokens against a measured 1000:
    // the unexplained 900 is the system prompt and overhead.
    const usage = sessionContextUsage(
      [
        user("u1", "x".repeat(400)),
        assistant("a1", "y".repeat(200), { input: 900, output: 100, cacheRead: 0, cacheWrite: 0 }),
      ],
      null,
    )!;
    const total = usage.segments.reduce((sum, segment) => sum + segment.tokens, 0);
    expect(total).toBe(1000);
    const system = usage.segments.find((segment) => segment.id === "system");
    expect(system).toBeDefined();
    expect(system!.tokens).toBeGreaterThan(800);
    expect(usage.segments.map((segment) => segment.id)).toEqual(["system", "user", "assistant"]);
  });

  it("scales estimates down when they outclaim the measurement, and drops system", () => {
    // 4000 chars ≈ 1000 estimated tokens against a measured 100.
    const usage = sessionContextUsage(
      [
        user("u1", "x".repeat(2000)),
        assistant("a1", "y".repeat(2000), { input: 60, output: 40, cacheRead: 0, cacheWrite: 0 }),
      ],
      null,
    )!;
    const total = usage.segments.reduce((sum, segment) => sum + segment.tokens, 0);
    expect(total).toBe(100);
    expect(usage.segments.some((segment) => segment.id === "system")).toBe(false);
  });

  it("files reasoning and tool traffic in their own buckets", () => {
    const usage = sessionContextUsage(
      [
        assistant("a1", "short", { input: 400, output: 100, cacheRead: 0, cacheWrite: 0 }, [
          { type: "reasoning", text: "t".repeat(400), state: "done" },
          {
            type: "dynamic-tool",
            toolName: "read",
            toolCallId: "c1",
            state: "output-available",
            input: { path: "a/b.ts" },
            output: "line\n".repeat(80),
          },
        ]),
      ],
      null,
    )!;
    const ids = usage.segments.map((segment) => segment.id);
    expect(ids).toContain("reasoning");
    expect(ids).toContain("tools");
  });

  it("estimates only up to the metered reply — a question typed after it holds nothing yet", () => {
    const metered = assistant("a1", "y", { input: 90, output: 10, cacheRead: 0, cacheWrite: 0 });
    const withTrailing = sessionContextUsage([metered, user("u2", "z".repeat(4000))], null)!;
    const without = sessionContextUsage([metered], null)!;
    expect(withTrailing.usedTokens).toBe(without.usedTokens);
    expect(withTrailing.segments).toEqual(without.segments);
  });
});

describe("contextGridCells", () => {
  const usage = sessionContextUsage(
    [
      user("u1", "x".repeat(400)),
      assistant("a1", "y".repeat(200), { input: 900, output: 100, cacheRead: 0, cacheWrite: 0 }),
    ],
    10_000,
  )!;

  it("fills exactly the grid, segments first and free after", () => {
    const cells = contextGridCells(usage, 100);
    expect(cells).toHaveLength(100);
    // 1000 of 10000 used → about 90 free cells.
    expect(cells.filter((cell) => cell === "free").length).toBeGreaterThanOrEqual(88);
    // Segment order is stable: everything spent precedes everything free.
    expect(cells.lastIndexOf("system")).toBeLessThan(cells.indexOf("free"));
  });

  it("keeps a cell for every nonzero bucket, so every bucket can be hovered", () => {
    const cells = contextGridCells(usage, 100);
    for (const segment of usage.segments) {
      expect(cells).toContain(segment.id);
    }
  });

  it("windowless, the grid is the used total alone", () => {
    const bare = sessionContextUsage(
      [assistant("a1", "y", { input: 90, output: 10, cacheRead: 0, cacheWrite: 0 })],
      null,
    )!;
    const cells = contextGridCells(bare, 100);
    expect(cells).toHaveLength(100);
    expect(cells).not.toContain("free");
  });
});

describe("formatTokens", () => {
  it("compacts the way the pill needs", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(417)).toBe("417");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(9000)).toBe("9k");
    expect(formatTokens(41_200)).toBe("41k");
    expect(formatTokens(412_000)).toBe("412k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(-5)).toBe("0");
  });
});
