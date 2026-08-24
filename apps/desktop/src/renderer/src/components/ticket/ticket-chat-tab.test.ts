import { describe, expect, it } from "vite-plus/test";

import type { ChatSessionLifecycle } from "@volli/session-presentation";

import {
  chatTabId,
  chatTabStatus,
  parseChatTabId,
  resolveChatRelaunch,
  type ChatTabReading,
} from "./ticket-chat-tab";

/** A Session with nothing open on it — the ordinary reading. */
function slice(lifecycle: ChatSessionLifecycle, asked = 0): ChatTabReading {
  return {
    lifecycle,
    projection: { interactions: { active: Array.from({ length: asked }, () => ({})) } },
  };
}

describe("chat tab identity", () => {
  it("round-trips a Session id through its prefixed tab id", () => {
    expect(chatTabId("sess-9")).toBe("chat:sess-9");
    expect(parseChatTabId(chatTabId("sess-9"))).toBe("sess-9");
  });

  /** A terminal tab's id is a bare session id; the prefix is what keeps them apart. */
  it("claims nothing that is not a chat tab", () => {
    expect(parseChatTabId("sess-9")).toBeNull();
    expect(parseChatTabId("doc")).toBeNull();
    expect(parseChatTabId("file:src/app.ts")).toBeNull();
    expect(parseChatTabId("chat:")).toBeNull();
  });
});

describe("chatTabStatus", () => {
  it("draws the slice's own lifecycle, and idle where there is no slice", () => {
    expect(chatTabStatus(slice("working"))).toBe("working");
    expect(chatTabStatus(slice("starting"))).toBe("starting");
    expect(chatTabStatus(slice("ready"))).toBe("ready");
    expect(chatTabStatus(slice("error"))).toBe("error");
    expect(chatTabStatus(undefined)).toBe("idle");
  });

  it("says a request is waiting on you, over the turn that is still open", () => {
    // The bug: `ask_user` blocks INSIDE a turn, so a Session with a question up
    // read as `working` — the one dot that tells a reader to leave it alone.
    expect(chatTabStatus(slice("working", 1))).toBe("waiting");
    expect(chatTabStatus(slice("ready", 2))).toBe("waiting");
  });

  it("keeps a failure louder than the question it may have stranded", () => {
    // The plane's own precedence: with the stream gone, the request we hold is
    // a memory, and a tab promising an answerable question over a dead
    // transport sends someone to a card that cannot be answered.
    expect(chatTabStatus(slice("error", 1))).toBe("error");
  });

  it("reads a Session whose first snapshot has not arrived as its lifecycle", () => {
    expect(chatTabStatus({ lifecycle: "starting", projection: null })).toBe("starting");
  });
});

describe("resolveChatRelaunch", () => {
  /** The bug this exists for: the reset that clobbered a chat tab on every boot. */
  it("waits while the ticket's durable Sessions have never been read", () => {
    expect(resolveChatRelaunch("chat:sess-9", undefined)).toEqual({ kind: "wait" });
  });

  it("adopts a chat Session the listing still names", () => {
    expect(resolveChatRelaunch("chat:sess-9", ["sess-1", "sess-9"])).toEqual({
      kind: "adopt",
      sessionId: "sess-9",
    });
  });

  it("falls back once the listing has answered and the Session is not in it", () => {
    expect(resolveChatRelaunch("chat:sess-9", [])).toEqual({ kind: "reset" });
    expect(resolveChatRelaunch("chat:sess-9", ["sess-1"])).toEqual({ kind: "reset" });
  });

  // A terminal session id, which does not survive a restart, resets without
  // waiting on anything — that listing has no bearing on it.
  it("resets anything that is not a chat tab, hydrated or not", () => {
    expect(resolveChatRelaunch("sess-9", undefined)).toEqual({ kind: "reset" });
    expect(resolveChatRelaunch("file:src/app.ts", ["sess-9"])).toEqual({ kind: "reset" });
  });
});
