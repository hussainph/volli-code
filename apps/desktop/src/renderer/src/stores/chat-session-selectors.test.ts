import { describe, expect, it } from "vite-plus/test";

import { paletteResidentTitlesSelector, selectSettleSignal } from "./chat-session-selectors";
import type { ChatSessionsState } from "./chat-sessions";

function stateWith(titles: Record<string, string | null>, settleRevision = 0): ChatSessionsState {
  const sessions = Object.fromEntries(
    Object.entries(titles).map(([sessionId, title]) => [
      sessionId,
      { projection: title === null ? null : { session: { title } } },
    ]),
  );
  return { sessions, settleRevision } as unknown as ChatSessionsState;
}

describe("chat-session selectors (VC-515)", () => {
  it("labels resident Sessions only while the palette is open", () => {
    const state = stateWith({ a: "Alpha", b: null });

    expect(paletteResidentTitlesSelector(true)(state)).toEqual({ a: "Alpha" });
    // A closed palette answers the same frozen map without walking anything.
    const closed = paletteResidentTitlesSelector(false);
    expect(closed(state)).toEqual({});
    expect(closed(stateWith({ c: "Gamma" }))).toBe(closed(state));
  });

  it("reads the store's settle count as the usage rail's signal", () => {
    expect(selectSettleSignal(stateWith({}, 7))).toBe("7");
  });
});
