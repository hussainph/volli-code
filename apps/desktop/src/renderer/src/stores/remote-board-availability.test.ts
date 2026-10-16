import { describe, expect, it, vi } from "vite-plus/test";

import {
  boardUnavailableOn,
  createRemoteBoardAvailabilityStore,
} from "./remote-board-availability";

describe("remote boards a host does not offer (VC-711)", () => {
  it("holds each project's reason, and lets it go", () => {
    const store = createRemoteBoardAvailabilityStore();
    const reason = boardUnavailableOn("old-host");
    expect(reason).toBe("The board isn’t available on old-host — update it to use it here");
    store.getState().setUnavailable("r1", reason);
    const held = store.getState().unavailable;
    // The same reason again changes nothing (no redraw).
    store.getState().setUnavailable("r1", reason);
    expect(store.getState().unavailable).toBe(held);
    store.getState().setUnavailable("r1", null);
    expect(store.getState().unavailable).toEqual({});
    const retry = vi.fn();
    store.getState().setRetry(retry);
    expect(store.getState().retry).toBe(retry);
    store.getState().setRetry(null);
    expect(store.getState().retry).toBeNull();
  });
});
