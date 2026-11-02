import { describe, expect, it } from "vite-plus/test";

import { KEPT_HIDDEN_CHAT_VIEWS, keepChatViews, type ChatViewPlace } from "./kept-chat-views";

const at = (sessionId: string, paneId = "root"): ChatViewPlace => ({ paneId, sessionId });

describe("keepChatViews", () => {
  it("keeps a chat a pane stops showing, behind the one now in front", () => {
    const first = keepChatViews([], [at("a")], [at("a"), at("b")]);
    expect(first).toEqual([at("a")]);
    const second = keepChatViews(first, [at("b")], [at("a"), at("b")]);
    expect(second).toEqual([at("a"), at("b")]);
  });

  it("returns the previous list itself when nothing changed", () => {
    const kept = keepChatViews([], [at("a")], [at("a"), at("b")]);
    const after = keepChatViews(kept, [at("b")], [at("a"), at("b")]);
    expect(keepChatViews(after, [at("b")], [at("a"), at("b")])).toBe(after);
  });

  it("keeps at most `cap` hidden views, dropping the least recently shown", () => {
    const present = ["a", "b", "c", "d", "e"].map((id) => at(id));
    let kept: readonly ChatViewPlace[] = [];
    for (const id of ["a", "b", "c", "d", "e"]) kept = keepChatViews(kept, [at(id)], present);
    expect(kept).toEqual([at("b"), at("c"), at("d"), at("e")]);
    expect(kept.length).toBe(KEPT_HIDDEN_CHAT_VIEWS + 1);
  });

  it("drops a kept view whose tab closed or whose pane went away", () => {
    const kept = keepChatViews(
      keepChatViews([], [at("a")], [at("a")]),
      [at("b")],
      [at("a"), at("b")],
    );
    expect(keepChatViews(kept, [at("b")], [at("b")])).toEqual([at("b")]);
    const split = keepChatViews(kept, [at("b")], [at("b"), at("a", "right")]);
    expect(split).toEqual([at("b")]);
  });

  it("never counts a shown view against the cap, however many panes show one", () => {
    const shown = [at("a", "left"), at("a", "right"), at("b", "third")];
    const kept = keepChatViews([], shown, shown, 0);
    expect(kept).toEqual(shown);
  });

  it("re-shows a kept view without duplicating it", () => {
    const present = [at("a"), at("b")];
    const kept = keepChatViews(keepChatViews([], [at("a")], present), [at("b")], present);
    expect(keepChatViews(kept, [at("a")], present)).toEqual([at("b"), at("a")]);
  });
});
