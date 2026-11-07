// @vitest-environment jsdom
/**
 * The kept chat views as React draws them (VC-1080): a pane that switches
 * between chat tabs reveals the view it drew before instead of building a new
 * one, and a hidden view holds no effect — which is what keeps it from counting
 * as SHOWN to the chat store's idle-client eviction (VC-515).
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { projectSplitView } from "@volli/shared";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";

import { KEPT_HIDDEN_CHAT_VIEWS, usePaneChatViews, type ChatViewPane } from "./kept-chat-views";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Mounts and effect lifetimes per Session, as a chat plane's would be. */
const mounts = new Map<string, number>();
const shown = new Set<string>();

function Probe({ sessionId }: { sessionId: string }) {
  // Counts constructions, not renders: state initialisers run once per mount.
  React.useState(() => mounts.set(sessionId, (mounts.get(sessionId) ?? 0) + 1));
  // Stands in for `showChatSession`: held while the effect is alive.
  React.useEffect(() => {
    shown.add(sessionId);
    return () => {
      shown.delete(sessionId);
    };
  }, [sessionId]);
  return <div data-probe={sessionId} />;
}

function Pane({ pane }: { pane: ChatViewPane }) {
  const views = usePaneChatViews([pane], null);
  return (
    <>
      {views(pane).map((view) => (
        <React.Activity key={view.sessionId} mode={view.shown ? "visible" : "hidden"}>
          <Probe sessionId={view.sessionId} />
        </React.Activity>
      ))}
    </>
  );
}

/**
 * A whole surface the way Home and the Ticket view draw it: the strip resolved
 * by the production `projectSplitView`, whose unsplit pane names only its front
 * tab, and the strip handed over as the solo pane's tabs (VC-1100).
 */
function Surface({ tabs, active }: { tabs: readonly string[]; active: string }) {
  const split = projectSplitView(null, tabs, active, "board");
  const views = usePaneChatViews(split.panes, split.groupId === null ? tabs : null);
  return (
    <>
      {split.panes.flatMap((pane) =>
        views(pane).map((view) => (
          <React.Activity key={view.sessionId} mode={view.shown ? "visible" : "hidden"}>
            <Probe sessionId={view.sessionId} />
          </React.Activity>
        )),
      )}
    </>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mounts.clear();
  shown.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const ids = ["a", "b", "c", "d", "e", "f"];
const tabIds = ids.map(chatTabId);

function show(sessionId: string, tabs: readonly string[] = tabIds): void {
  act(() =>
    root.render(<Pane pane={{ id: "root", tabIds: tabs, activeTabId: chatTabId(sessionId) }} />),
  );
}

const probe = (sessionId: string) =>
  container.querySelector<HTMLElement>(`[data-probe="${sessionId}"]`);

describe("kept chat views", () => {
  it("reveals the view it drew before rather than mounting a new one", () => {
    show("a");
    show("b");
    show("a");
    show("b");
    expect(mounts.get("a")).toBe(1);
    expect(mounts.get("b")).toBe(1);
    expect(probe("a")?.style.display).toBe("none");
    expect(probe("b")?.style.display).not.toBe("none");
  });

  it("holds no effect for a hidden view, so it never counts as shown", () => {
    show("a");
    show("b");
    expect([...shown]).toEqual(["b"]);
    show("a");
    expect([...shown]).toEqual(["a"]);
  });

  it("lets the least recently shown go past the cap, and rebuilds it on return", () => {
    for (const id of ids) show(id);
    const mounted = ids.filter((id) => probe(id) !== null);
    expect(mounted).toEqual(ids.slice(ids.length - KEPT_HIDDEN_CHAT_VIEWS - 1));
    show("a");
    expect(mounts.get("a")).toBe(2);
  });

  it("drops a kept view whose tab closed", () => {
    show("a");
    show("b");
    expect(probe("a")).not.toBeNull();
    show("b", [chatTabId("b")]);
    expect(probe("a")).toBeNull();
  });

  it("draws nothing for a pane whose front tab is not a chat, but keeps its chats", () => {
    show("a");
    act(() =>
      root.render(
        <Pane pane={{ id: "root", tabIds: [...tabIds, "board"], activeTabId: "board" }} />,
      ),
    );
    expect(probe("a")?.style.display).toBe("none");
    expect(shown.size).toBe(0);
    show("a");
    expect(mounts.get("a")).toBe(1);
  });

  it("keeps the chat an unsplit surface switched away from (VC-1100)", () => {
    const surface = (sessionId: string) =>
      act(() => root.render(<Surface tabs={tabIds} active={chatTabId(sessionId)} />));
    // The production projection really does resolve the unsplit pane to its
    // front tab alone — the shape that once dropped every chat on a switch.
    expect(projectSplitView(null, tabIds, chatTabId("a"), "board").panes).toEqual([
      expect.objectContaining({ tabIds: [chatTabId("a")] }),
    ]);
    surface("a");
    surface("b");
    expect(probe("a")?.style.display).toBe("none");
    surface("a");
    surface("b");
    expect(mounts.get("a")).toBe(1);
    expect(mounts.get("b")).toBe(1);
  });
});
