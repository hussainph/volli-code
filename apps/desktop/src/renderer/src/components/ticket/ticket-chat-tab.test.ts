import { describe, expect, it } from "vite-plus/test";

import {
  chatTabId,
  chatTabStatus,
  parseChatTabId,
  resolveChatRelaunch,
} from "./ticket-chat-tab";

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
    expect(chatTabStatus("working")).toBe("working");
    expect(chatTabStatus("starting")).toBe("starting");
    expect(chatTabStatus("ready")).toBe("ready");
    expect(chatTabStatus("error")).toBe("error");
    expect(chatTabStatus(undefined)).toBe("idle");
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
