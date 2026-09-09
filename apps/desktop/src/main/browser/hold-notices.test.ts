import { describe, expect, it } from "vite-plus/test";

import {
  askToLeaveNotice,
  holdNoticeFor,
  holdNoticeMessage,
  relayHoldNotices,
  takeoverNotice,
  type HoldNotice,
} from "./hold-notices";
import type { BrowserHoldEvent } from "./tab-host";

const A = { sessionId: "ses-a", attachmentId: "att-a" };

describe("holdNoticeFor", () => {
  it("tells the displaced Session about a takeover, in one line naming the rule its next write will cite", () => {
    const notice = holdNoticeFor({
      kind: "person-took",
      tabId: "tab-1",
      tabTitle: "GitHub",
      tabHostname: "github.com",
      displaced: A,
    });
    expect(notice).toEqual({
      sessionId: "ses-a",
      text: takeoverNotice("tab-1"),
      metadata: {
        kind: "session-host-notice",
        notice: {
          kind: "browser-hold",
          tabId: "tab-1",
          tabTitle: "GitHub",
          tabHostname: "github.com",
          action: "person-took",
        },
      },
    });
    expect(notice?.text).toContain("browser.person-has-tab");
    expect(notice?.text).toContain("tab-1");
    expect(notice?.text.split("\n")).toHaveLength(1);
  });

  it("tells the holder it is asked to leave, and how", () => {
    const notice = holdNoticeFor({
      kind: "ask-to-leave",
      tabId: "tab-1",
      tabTitle: "",
      tabHostname: "",
      holder: A,
    });
    expect(notice).toEqual({
      sessionId: "ses-a",
      text: askToLeaveNotice("tab-1"),
      metadata: {
        kind: "session-host-notice",
        notice: {
          kind: "browser-hold",
          tabId: "tab-1",
          tabTitle: "",
          tabHostname: "",
          action: "ask-to-leave",
        },
      },
    });
    expect(notice?.text).toContain("browser_release");
    expect(notice?.text.split("\n")).toHaveLength(1);
  });

  it("owes nothing for a takeover that displaced nobody, or for the hold's own comings and goings", () => {
    const silent: BrowserHoldEvent[] = [
      { kind: "person-took", tabId: "tab-1", tabTitle: "", tabHostname: "", displaced: null },
      { kind: "taken", tabId: "tab-1", holder: A },
      { kind: "released", tabId: "tab-1", holder: A, why: "turn-end" },
      { kind: "person-handed-back", tabId: "tab-1" },
    ];
    for (const event of silent) expect(holdNoticeFor(event)).toBeNull();
  });
});

function fakeHost(): {
  emit(event: BrowserHoldEvent): void;
  listeners: number;
  host: Parameters<typeof relayHoldNotices>[0];
} {
  const listeners = new Set<(event: BrowserHoldEvent) => void>();
  return {
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    get listeners() {
      return listeners.size;
    },
    host: {
      onHoldChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

describe("holdNoticeMessage", () => {
  it("keeps the shared semantic metadata on the durable message", () => {
    const notice = holdNoticeFor({
      kind: "person-took",
      tabId: "tab-1",
      tabTitle: "GitHub",
      tabHostname: "github.com",
      displaced: A,
    });
    if (notice === null) throw new Error("expected a takeover notice");

    expect(holdNoticeMessage(notice, "message-1")).toEqual({
      id: "message-1",
      role: "user",
      metadata: {
        kind: "session-host-notice",
        notice: {
          kind: "browser-hold",
          tabId: "tab-1",
          tabTitle: "GitHub",
          tabHostname: "github.com",
          action: "person-took",
        },
      },
      parts: [{ type: "text", text: takeoverNotice("tab-1") }],
    });
  });
});

describe("relayHoldNotices", () => {
  it("steers each notice into the Session it is for, and nothing for silent events", async () => {
    const steered: HoldNotice[] = [];
    const fake = fakeHost();
    relayHoldNotices(fake.host, { steer: async (input) => void steered.push(input) });

    fake.emit({ kind: "taken", tabId: "tab-1", holder: A });
    fake.emit({ kind: "person-took", tabId: "tab-1", tabTitle: "", tabHostname: "", displaced: A });
    fake.emit({ kind: "ask-to-leave", tabId: "tab-2", tabTitle: "", tabHostname: "", holder: A });
    await Promise.resolve();

    expect(steered).toEqual([
      {
        sessionId: "ses-a",
        text: takeoverNotice("tab-1"),
        metadata: {
          kind: "session-host-notice",
          notice: {
            kind: "browser-hold",
            tabId: "tab-1",
            tabTitle: "",
            tabHostname: "",
            action: "person-took",
          },
        },
      },
      {
        sessionId: "ses-a",
        text: askToLeaveNotice("tab-2"),
        metadata: {
          kind: "session-host-notice",
          notice: {
            kind: "browser-hold",
            tabId: "tab-2",
            tabTitle: "",
            tabHostname: "",
            action: "ask-to-leave",
          },
        },
      },
    ]);
  });

  it("logs a failed delivery and keeps going: nobody is waiting on the notice", async () => {
    const logged: string[] = [];
    const fake = fakeHost();
    relayHoldNotices(fake.host, {
      steer: async () => {
        throw new Error("attachment closed");
      },
      log: (message) => logged.push(message),
    });
    fake.emit({ kind: "person-took", tabId: "tab-1", tabTitle: "", tabHostname: "", displaced: A });
    await Promise.resolve();
    await Promise.resolve();
    expect(logged).toEqual([
      "[volli] could not tell Session ses-a about Browser Tab tab-1: attachment closed",
    ]);

    // A failure with no logger and a non-Error reason is still swallowed.
    const quiet = fakeHost();
    relayHoldNotices(quiet.host, {
      steer: async () => {
        throw "gone";
      },
    });
    expect(() =>
      quiet.emit({
        kind: "ask-to-leave",
        tabId: "tab-1",
        tabTitle: "",
        tabHostname: "",
        holder: A,
      }),
    ).not.toThrow();
    await Promise.resolve();
  });

  it("unsubscribes", () => {
    const fake = fakeHost();
    const stop = relayHoldNotices(fake.host, { steer: async () => undefined });
    expect(fake.listeners).toBe(1);
    stop();
    expect(fake.listeners).toBe(0);
  });
});
