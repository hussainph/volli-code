// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SESSION_PEEK_REFRESH_MS, type SessionPeekContent } from "@volli/shared";
import { usePeekContent, type PeekContentState } from "./use-peek-content";

const CONTENT: SessionPeekContent = {
  sessionId: "s",
  entries: [],
  question: null,
  turns: 0,
  turnDepth: 0,
  unreadable: 0,
  lastActivityAt: 1,
  summary: null,
};
let root: Root;
let container: HTMLDivElement;
let latest: PeekContentState;
const read = vi.fn<(id: string) => Promise<SessionPeekContent | null>>();
function Probe({ id, token }: { id: string | null; token: number }) {
  latest = usePeekContent(id, read, token);
  return null;
}
async function render(id: string | null, token = 1) {
  await act(async () => {
    root.render(<Probe id={id} token={token} />);
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(0);
  read.mockReset().mockResolvedValue(CONTENT);
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

describe("peek content cache", () => {
  it("reads only visible peeks, reuses recent reads, and retries on a later hover after cooldown", async () => {
    await render(null);
    expect(read).not.toHaveBeenCalled();
    await render("s");
    expect(read).toHaveBeenCalledTimes(1);
    await render(null);
    await render("s");
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(SESSION_PEEK_REFRESH_MS);
    });
    // Even an expired visible card schedules no utility work.
    expect(read).toHaveBeenCalledTimes(1);
    await render(null);
    read.mockResolvedValue({ ...CONTENT, summary: "Refined on the later hover" });
    await render("s");
    expect(read).toHaveBeenCalledTimes(2);
    expect(latest.content?.summary).toBe("Refined on the later hover");
  });

  it("re-reads changed activity without waiting for a cache expiry", async () => {
    await render("s");
    await render("s", 2);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("drops late answers from the screen but caches them for the next glance", async () => {
    const pending = Promise.withResolvers<SessionPeekContent | null>();
    read.mockReturnValueOnce(pending.promise);
    await render("s");
    expect(latest.loading).toBe(true);
    await render(null);
    await act(async () => {
      pending.resolve(CONTENT);
    });
    expect(latest.content).toBeNull();
    await render("s");
    expect(latest.content).toBe(CONTENT);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("marks unavailable and failed reads honestly", async () => {
    read.mockResolvedValueOnce(null);
    await render("s");
    expect(latest.failed).toBe(true);
    await render(null);
    read.mockRejectedValueOnce(new Error("Offline"));
    await render("other");
    expect(latest.failed).toBe(true);
  });
});
