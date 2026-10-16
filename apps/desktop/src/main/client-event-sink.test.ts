import { describe, expect, it, vi } from "vite-plus/test";
import type { WebContents } from "electron";
import { clientEventSink } from "./client-event-sink";

function contents(id: number) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    once: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  };
}

describe("one client's addressed host stream", () => {
  it("sends to exactly its WebContents on the unchanged channel", () => {
    const first = contents(1);
    const second = contents(2);
    const sink = clientEventSink(first as unknown as WebContents);
    sink.publish("worktree-changed", { ticketId: "t" });
    sink.publish("worktree-watch-error", { ticketId: "t", error: "gone" });
    expect(sink.id).toBe("1");
    expect(first.send.mock.calls).toEqual([
      ["volli:worktree-changed", { ticketId: "t" }],
      ["volli:worktree-watch-error", { ticketId: "t", error: "gone" }],
    ]);
    expect(second.send).not.toHaveBeenCalled();
    expect(clientEventSink(first as unknown as WebContents).id).toBe(sink.id);
  });

  it("reads and observes that same client's lifetime, removing only its hook", () => {
    const first = contents(1);
    const sink = clientEventSink(first as unknown as WebContents);
    const listener = vi.fn();
    expect(sink.isClosed()).toBe(false);
    first.isDestroyed.mockReturnValue(true);
    expect(sink.isClosed()).toBe(true);
    sink.onceClosed(listener);
    expect(first.once).toHaveBeenCalledExactlyOnceWith("destroyed", listener);
    sink.removeCloseListener(listener);
    expect(first.removeListener).toHaveBeenCalledExactlyOnceWith("destroyed", listener);
  });
});
