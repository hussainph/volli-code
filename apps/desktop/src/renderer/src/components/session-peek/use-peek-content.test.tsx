// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SESSION_PEEK_REFRESH_MS, type SessionPeekContent } from "@volli/shared";
import { usePeekContent, type PeekContentOptions, type PeekContentState } from "./use-peek-content";
import type { ReadPeekContent } from "./peek-content-cache";

const CONTENT: SessionPeekContent = {
  sessionId: "s",
  entries: [{ at: 1, role: "assistant", text: "Local progress stays readable", tools: [] }],
  question: {
    id: "q",
    attachmentId: "a",
    kind: "question",
    title: "Which fix first?",
    detail: null,
    options: [],
    multiple: false,
    native: { id: null, detail: null },
  },
  turns: 1,
  turnDepth: 0,
  unreadable: 0,
  lastActivityAt: 1,
  summary: null,
};
const REFINED = { ...CONTENT, summary: "Generated goal and progress" };
let root: Root;
let container: HTMLDivElement;
let latest: PeekContentState;
const read = vi.fn<ReadPeekContent>();
const PINNED_OPTIONS: PeekContentOptions = { refine: false, refreshOnActivity: true };
function Probe({
  id,
  token,
  options,
}: {
  id: string | null;
  token: number;
  options: PeekContentOptions;
}) {
  latest = usePeekContent(id, read, token, options);
  return null;
}
async function render(id: string | null, token = 1, options: PeekContentOptions = {}) {
  await act(async () => {
    root.render(<Probe id={id} token={token} options={options} />);
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(0);
  read.mockReset().mockImplementation(async (_id, refine) => (refine ? REFINED : CONTENT));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("two-stage peek content", () => {
  it("shows the local fallback and question before deferred refinement, then replaces the prose", async () => {
    const local = Promise.withResolvers<SessionPeekContent | null>();
    const refinement = Promise.withResolvers<SessionPeekContent | null>();
    read.mockImplementation((_id, refine) => (refine ? refinement.promise : local.promise));
    await render("s");
    expect(latest).toEqual({ content: null, loading: true, failed: false });
    expect(read.mock.calls).toEqual([["s", false]]);
    await act(async () => local.resolve(CONTENT));
    expect(latest).toEqual({ content: CONTENT, loading: false, failed: false });
    expect(latest.content?.entries[0].text).toBe("Local progress stays readable");
    expect(latest.content?.question?.title).toBe("Which fix first?");
    expect(read.mock.calls).toEqual([
      ["s", false],
      ["s", true],
    ]);
    await act(async () => refinement.resolve(REFINED));
    expect(latest.content?.summary).toBe("Generated goal and progress");
  });

  it.each(["reject", "null", "fallback"] as const)(
    "keeps real local data after a refinement %s",
    async (outcome) => {
      const refinement = Promise.withResolvers<SessionPeekContent | null>();
      read.mockImplementation((_id, refine) =>
        refine ? refinement.promise : Promise.resolve(CONTENT),
      );
      await render("s");
      expect(latest.content?.entries).toEqual(CONTENT.entries);
      await act(async () => {
        if (outcome === "reject") refinement.reject(new Error("Utility unavailable"));
        else refinement.resolve(outcome === "null" ? null : CONTENT);
      });
      expect(latest).toEqual({ content: CONTENT, loading: false, failed: false });
    },
  );

  it("does not start refinement after closing while the local read is pending", async () => {
    const local = Promise.withResolvers<SessionPeekContent | null>();
    read.mockReturnValueOnce(local.promise);
    await render("s");
    await render(null);
    await act(async () => local.resolve(CONTENT));
    expect(latest).toEqual({ content: null, loading: false, failed: false });
    expect(read.mock.calls).toEqual([["s", false]]);
    // The late local fold is cached, but only this new glance asks for prose.
    await render("s");
    expect(read.mock.calls).toEqual([
      ["s", false],
      ["s", true],
    ]);
    expect(latest.content?.summary).toBe(REFINED.summary);
  });

  it("pinning while local is pending prevents refinement; pinned activity reads remain local", async () => {
    const local = Promise.withResolvers<SessionPeekContent | null>();
    read.mockReturnValueOnce(local.promise);
    await render("s");
    await render("s", 1, PINNED_OPTIONS);
    await act(async () => local.resolve(CONTENT));
    expect(latest.content).toBe(CONTENT);
    await render("s", 2, PINNED_OPTIONS);
    expect(read.mock.calls).toEqual([
      ["s", false],
      ["s", false],
    ]);
    expect(latest.content?.entries).toEqual(CONTENT.entries);
  });

  it("unpinning refines the held local fold without reading it again", async () => {
    const refinement = Promise.withResolvers<SessionPeekContent | null>();
    read.mockImplementation((_id, refine) =>
      refine ? refinement.promise : Promise.resolve(CONTENT),
    );
    await render("s", 1, PINNED_OPTIONS);
    expect(latest.content).toBe(CONTENT);
    expect(read.mock.calls).toEqual([["s", false]]);
    await render("s", 1, { refine: true });
    expect(latest).toEqual({ content: CONTENT, loading: false, failed: false });
    expect(read.mock.calls).toEqual([
      ["s", false],
      ["s", true],
    ]);
    await act(async () => refinement.resolve(REFINED));
    expect(latest.content).toBe(REFINED);
  });

  it("reopening joins a pending refinement, retaining local data until the shared answer lands", async () => {
    const refinement = Promise.withResolvers<SessionPeekContent | null>();
    read.mockImplementation((_id, refine) =>
      refine ? refinement.promise : Promise.resolve(CONTENT),
    );
    await render("s");
    await render(null);
    await render("s");
    expect(latest.content).toBe(CONTENT);
    expect(read.mock.calls).toEqual([
      ["s", false],
      ["s", true],
    ]);
    await act(async () => refinement.resolve(REFINED));
    expect(latest.content).toBe(REFINED);
  });

  it("pinning observes existing work but starts none, including after cooldown", async () => {
    const refinement = Promise.withResolvers<SessionPeekContent | null>();
    read.mockImplementation((_id, refine) =>
      refine ? refinement.promise : Promise.resolve(CONTENT),
    );
    await render("s");
    await act(async () => vi.advanceTimersByTime(SESSION_PEEK_REFRESH_MS));
    await render("s", 1, PINNED_OPTIONS);
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => refinement.resolve(REFINED));
    expect(latest.content).toBe(REFINED);
  });

  it("holds an unpinned snapshot through activity and cooldown, then refreshes on reopening", async () => {
    await render("s");
    expect(latest.content).toBe(REFINED);
    read.mockImplementation(() => new Promise(() => {}));
    await act(async () => vi.advanceTimersByTime(SESSION_PEEK_REFRESH_MS));
    for (const token of [2, 3, 4]) {
      await render("s", token);
      expect(latest).toEqual({ content: REFINED, loading: false, failed: false });
    }
    expect(read).toHaveBeenCalledTimes(2);
    await render(null);
    await render("s", 4);
    expect(read.mock.calls.at(-1)).toEqual(["s", false]);
    expect(latest.loading).toBe(true);
  });

  it("holds local-only unpinned peeks too, without starting utility work", async () => {
    await render("s", 1, { refine: false });
    await render("s", 2, { refine: false });
    expect(latest).toEqual({ content: CONTENT, loading: false, failed: false });
    expect(read.mock.calls).toEqual([["s", false]]);
    await render(null);
    await render("s", 2, { refine: false });
    expect(read.mock.calls).toEqual([
      ["s", false],
      ["s", false],
    ]);
  });

  it("late old-activity refinement cannot overwrite a fresher pinned card or its cache", async () => {
    const old = Promise.withResolvers<SessionPeekContent | null>();
    read.mockImplementationOnce(async () => CONTENT).mockReturnValueOnce(old.promise);
    await render("s");
    const fresh = { ...REFINED, lastActivityAt: 2, summary: "New activity" };
    read.mockResolvedValue(fresh);
    await render("s", 2, PINNED_OPTIONS);
    await act(async () => old.resolve(REFINED));
    expect(latest.content).toBe(fresh);
    await render(null);
    await render("s", 2, PINNED_OPTIONS);
    expect(latest.content).toBe(fresh);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("a late reply for another Session never changes the visible one", async () => {
    const old = Promise.withResolvers<SessionPeekContent | null>();
    read.mockImplementationOnce(async () => CONTENT).mockReturnValueOnce(old.promise);
    await render("s");
    const other = { ...REFINED, sessionId: "other", summary: "Other Session" };
    read.mockResolvedValue(other);
    await render("other");
    await act(async () => old.resolve(REFINED));
    expect(latest.content).toBe(other);
  });

  it("retries a refused refinement only on a new glance after cooldown, never a timer", async () => {
    read.mockResolvedValue(CONTENT);
    await render(null);
    expect(read).not.toHaveBeenCalled();
    await render("s");
    await render(null);
    await render("s");
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(SESSION_PEEK_REFRESH_MS));
    expect(read).toHaveBeenCalledTimes(2);
    await render(null);
    read.mockImplementation(async (_id, refine) => (refine ? REFINED : CONTENT));
    await render("s");
    expect(read).toHaveBeenCalledTimes(4);
    expect(latest.content?.summary).toBe(REFINED.summary);
  });

  it("marks missing and failed local reads honestly, skips refinement, and retries bridge errors", async () => {
    read.mockResolvedValueOnce(null);
    await render("s");
    expect(latest.failed).toBe(true);
    expect(read.mock.calls).toEqual([["s", false]]);
    await render(null);
    read.mockRejectedValueOnce(new Error("Offline"));
    await render("other");
    expect(latest.failed).toBe(true);
    await render(null);
    await render("other");
    expect(latest.content).toBe(REFINED);
    expect(read).toHaveBeenCalledTimes(4);
  });
});
