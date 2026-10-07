// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createRemoteSessionAvailabilityStore,
  useRemoteSessionAvailabilityStore,
  useRemoteSessionsUnavailable,
} from "./remote-session-availability";

afterEach(() => {
  useRemoteSessionAvailabilityStore.setState({ unavailable: {} });
  vi.unstubAllGlobals();
});

function Reason({ projectId }: { projectId: string | null }) {
  return <span data-slot="reason">{useRemoteSessionsUnavailable(projectId) ?? "available"}</span>;
}

describe("remote Session availability (VC-713, B3)", () => {
  it("names a project's host once, keeps the same map for the same reason, and clears it", () => {
    const store = createRemoteSessionAvailabilityStore();
    store.getState().setUnavailable("p", "Sessions aren’t available on box");
    const named = store.getState().unavailable;
    store.getState().setUnavailable("p", "Sessions aren’t available on box");
    expect(store.getState().unavailable).toBe(named);
    store.getState().setUnavailable("q", null);
    expect(store.getState().unavailable).toBe(named);
    store.getState().setUnavailable("p", null);
    expect(store.getState().unavailable).toEqual({});
  });

  it("reads one project's reason in a view, and nothing for none", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    useRemoteSessionAvailabilityStore.getState().setUnavailable("p", "not here");
    await act(async () => root.render(<Reason projectId="p" />));
    expect(container.textContent).toBe("not here");
    await act(async () => root.render(<Reason projectId="q" />));
    expect(container.textContent).toBe("available");
    await act(async () => root.render(<Reason projectId={null} />));
    expect(container.textContent).toBe("available");
    await act(async () => root.unmount());
  });
});
