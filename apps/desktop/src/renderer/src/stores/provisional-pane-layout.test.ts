import { afterEach, describe, expect, it } from "vite-plus/test";

import { useChatSessionsStore } from "./chat-sessions";
import {
  createProvisionalPaneLayoutStore,
  useProvisionalPaneLayoutStore,
} from "./provisional-pane-layout";

afterEach(() => {
  useChatSessionsStore.setState({ openTabs: {}, provisionalActive: {}, starting: {} });
  useProvisionalPaneLayoutStore.setState({ byOwner: new Map() });
});

describe("provisional pane layout", () => {
  it("owns multiple draft locations and one foreground draft per pane", () => {
    const store = createProvisionalPaneLayoutStore();
    store.getState().place("owner", "a", "left");
    const unchanged = store.getState();
    store.getState().place("owner", "a", "left");
    expect(store.getState()).toBe(unchanged);
    store.getState().place("owner", "b", "right");
    store.getState().place("owner", "c", "left");
    expect([...store.getState().byOwner.get("owner")!]).toEqual([
      ["a", { paneId: "left", front: false }],
      ["b", { paneId: "right", front: true }],
      ["c", { paneId: "left", front: true }],
    ]);
    store.getState().place("owner", "a", "right");
    expect(store.getState().byOwner.get("owner")?.get("b")?.front).toBe(false);
    expect(store.getState().byOwner.get("owner")?.get("c")?.front).toBe(true);
    store.getState().place("other", "d", "left");
    expect(store.getState().byOwner.size).toBe(2);
  });

  it("releases a pane's foreground without forgetting any location", () => {
    const store = createProvisionalPaneLayoutStore();
    store.getState().deactivatePanes("missing", new Set(["left"]));
    store.getState().place("owner", "a", "left");
    store.getState().place("owner", "b", "left");
    store.getState().place("owner", "c", "right");
    store.getState().deactivatePanes("owner", new Set(["left"]));
    expect(store.getState().byOwner.get("owner")?.get("b")).toEqual({
      paneId: "left",
      front: false,
    });
    expect(store.getState().byOwner.get("owner")?.get("c")?.front).toBe(true);
    const unchanged = store.getState();
    store.getState().deactivatePanes("owner", new Set(["left"]));
    store.getState().deactivatePanes("owner", new Set(["missing"]));
    expect(store.getState()).toBe(unchanged);
  });

  it("removes saved claims or closed drafts and drops empty owners", () => {
    const store = createProvisionalPaneLayoutStore();
    const empty = store.getState();
    store.getState().remove("owner", "missing");
    expect(store.getState()).toBe(empty);
    store.getState().place("owner", "a", "left");
    store.getState().place("owner", "b", "right");
    const unchanged = store.getState();
    store.getState().remove("owner", "missing");
    expect(store.getState()).toBe(unchanged);
    store.getState().remove("owner", "a");
    expect([...store.getState().byOwner.get("owner")!.keys()]).toEqual(["b"]);
    store.getState().remove("owner", "b");
    expect(store.getState().byOwner.size).toBe(0);
  });

  it("retires closed and re-homed tabs atomically without disturbing survivors", () => {
    const store = createProvisionalPaneLayoutStore();
    store.getState().retainOpenTabs({});
    store.getState().place("owner", "a", "left");
    store.getState().place("owner", "b", "right");
    store.getState().place("other", "c", "left");
    const unchanged = store.getState();
    store.getState().retainOpenTabs({ owner: ["a", "b"], other: ["c"] });
    expect(store.getState()).toBe(unchanged);
    store.getState().retainOpenTabs({ owner: ["b"] });
    expect([...store.getState().byOwner.keys()]).toEqual(["owner"]);
    expect([...store.getState().byOwner.get("owner")!.keys()]).toEqual(["b"]);
    store.getState().retainOpenTabs({ owner: [] });
    expect(store.getState().byOwner.size).toBe(0);
  });

  it("tracks tab lifetime, not the active-overlay selection", () => {
    useChatSessionsStore.setState({ openTabs: { owner: ["a"] } });
    useProvisionalPaneLayoutStore.getState().place("owner", "a", "left");
    const settled = useProvisionalPaneLayoutStore.getState();
    useChatSessionsStore.getState().setProvisionalActive("owner", "a");
    useChatSessionsStore.getState().setProvisionalActive("owner", null);
    useChatSessionsStore.setState({ starting: { owner: true } });
    expect(useProvisionalPaneLayoutStore.getState()).toBe(settled);
    useChatSessionsStore.setState({ openTabs: {} });
    expect(useProvisionalPaneLayoutStore.getState().byOwner.size).toBe(0);
  });
});
