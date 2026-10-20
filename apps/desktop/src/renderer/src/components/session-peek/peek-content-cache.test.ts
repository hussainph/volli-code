import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SESSION_PEEK_REFRESH_MS, type SessionPeekContent } from "@volli/shared";
import { observePeekContent, PeekContentCache, type ReadPeekContent } from "./peek-content-cache";

const LOCAL: SessionPeekContent = {
  sessionId: "s",
  entries: [{ at: 2, role: "assistant", text: "Local fallback", tools: [] }],
  question: null,
  turns: 1,
  turnDepth: 1,
  unreadable: 0,
  lastActivityAt: 2,
  summary: null,
};
const GENERATED = { ...LOCAL, summary: "Generated prose" };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe("peek read coalescing and ordering", () => {
  it("shares pending reads by Session, activity, and mode even across cooldown", async () => {
    const local = Promise.withResolvers<SessionPeekContent | null>();
    const refine = Promise.withResolvers<SessionPeekContent | null>();
    const read = vi.fn<ReadPeekContent>((_id, refinement) =>
      refinement ? refine.promise : local.promise,
    );
    const cache = new PeekContentCache(read);
    const entry = cache.get("s", 1);
    const localRead = entry.pull(false);
    const refinement = entry.pull(true);
    expect(entry.pull(false)).toBe(localRead);
    expect(entry.pull(true)).toBe(refinement);
    vi.advanceTimersByTime(SESSION_PEEK_REFRESH_MS);
    expect(cache.get("s", 1)).toBe(entry);
    expect(cache.get("s", 2)).not.toBe(entry);
    expect(cache.get("other", 1)).not.toBe(entry);
    local.resolve(LOCAL);
    refine.resolve(GENERATED);
    await Promise.all([localRead, refinement]);
    expect(read.mock.calls).toEqual([
      ["s", false],
      ["s", true],
    ]);
    expect(entry.content).toBe(GENERATED);
  });

  it("a late local reply cannot erase generated prose of the same activity", async () => {
    const local = Promise.withResolvers<SessionPeekContent | null>();
    const read = vi.fn<ReadPeekContent>((_id, refine) =>
      refine ? Promise.resolve(GENERATED) : local.promise,
    );
    const entry = new PeekContentCache(read).get("s", 1);
    const pending = entry.pull(false);
    await entry.pull(true);
    local.resolve(LOCAL);
    await pending;
    expect(entry.content?.summary).toBe(GENERATED.summary);
    expect(entry.content?.entries).toBe(LOCAL.entries);
  });

  it("an older refinement cannot overwrite a fresher local fold", async () => {
    const read = vi.fn<ReadPeekContent>(async (_id, refine) =>
      refine ? { ...GENERATED, lastActivityAt: 1 } : LOCAL,
    );
    const entry = new PeekContentCache(read).get("s", 1);
    await entry.pull(false);
    await entry.pull(true);
    expect(entry.content).toBe(LOCAL);
  });

  it("completed reads expire only when acquired for a later glance", async () => {
    const read = vi.fn<ReadPeekContent>(async () => LOCAL);
    const cache = new PeekContentCache(read);
    const first = cache.get("s", 1);
    await first.pull(false);
    vi.advanceTimersByTime(SESSION_PEEK_REFRESH_MS - 1);
    expect(cache.get("s", 1)).toBe(first);
    vi.advanceTimersByTime(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(cache.get("s", 1)).not.toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("disposal while local is pending never starts utility work", async () => {
    const local = Promise.withResolvers<SessionPeekContent | null>();
    const read = vi.fn<ReadPeekContent>(() => local.promise);
    const entry = new PeekContentCache(read).get("s", 1);
    const publish = vi.fn();
    const dispose = observePeekContent(entry, true, publish);
    dispose();
    local.resolve(LOCAL);
    await entry.pull(false);
    expect(read.mock.calls).toEqual([["s", false]]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(entry.content).toBe(LOCAL);
  });

  it("a failed local fold is retried on acquisition rather than remembered as empty", async () => {
    const read = vi.fn<ReadPeekContent>().mockRejectedValue(new Error("Bridge failed"));
    const cache = new PeekContentCache(read);
    const entry = cache.get("s", 1);
    await expect(entry.pull(false)).rejects.toThrow("Bridge failed");
    expect(entry.failed).toBe(true);
    expect(cache.get("s", 1)).not.toBe(entry);
  });
});
