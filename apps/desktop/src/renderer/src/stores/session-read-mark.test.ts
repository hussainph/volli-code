import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";
import type { SessionReadState } from "@volli/shared";

import { remoteHostOfSession } from "@renderer/lib/session-project";
import { markSessionRead } from "./session-read-mark";
import type { SessionReadSetResult } from "../../../ipc/contract";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@renderer/lib/session-project", () => ({ remoteHostOfSession: vi.fn(() => null) }));

/** A one-row cache: what the two stores' ports do, without either store. */
function row(initial: SessionReadState = { unreadSince: null }) {
  let state = initial;
  const written: SessionReadState[] = [];
  return {
    written,
    /** Lands an authoritative row, as a `volli:session-activity` upsert would. */
    upsert: (read: SessionReadState) => {
      state = read;
    },
    ports: {
      readState: () => state,
      write: (read: SessionReadState) => {
        state = read;
        written.push(read);
      },
    },
    current: () => state,
  };
}

function stubSetRead(impl: () => Promise<SessionReadSetResult>) {
  vi.stubGlobal("window", { api: { sessions: { setRead: vi.fn(impl) } } });
  return vi.mocked(window.api.sessions.setRead);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(toast.error).mockClear();
});

describe("markSessionRead", () => {
  it("stamps the row before the door answers, and keeps it when the write sticks", async () => {
    const setRead = stubSetRead(() => Promise.resolve({ ok: true, read: { unreadSince: 5_000 } }));
    const cache = row();

    await markSessionRead({ sessionId: "s1", unread: true }, cache.ports);

    expect(setRead).toHaveBeenCalledWith({ sessionId: "s1", unread: true });
    expect(cache.current().unreadSince).toEqual(expect.any(Number));
    // One write only: a successful mark never touches the row twice.
    expect(cache.written).toHaveLength(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("clears to the resting state when the mark is 'read'", async () => {
    stubSetRead(() => Promise.resolve({ ok: true, read: { unreadSince: null } }));
    const cache = row({ unreadSince: 400 });

    await markSessionRead({ sessionId: "s1", unread: false }, cache.ports);

    expect(cache.current()).toEqual({ unreadSince: null });
  });

  it("reverts and toasts when the receipt is refused", async () => {
    stubSetRead(() => Promise.resolve({ ok: false, error: "db locked" }));
    const cache = row();

    await markSessionRead({ sessionId: "s1", unread: true }, cache.ports);

    expect(cache.current()).toEqual({ unreadSince: null });
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't mark the session: db locked",
      expect.anything(),
    );
  });

  it("reverts to whatever was there before when the door throws", async () => {
    stubSetRead(() => Promise.reject(new Error("ipc gone")));
    const cache = row({ unreadSince: 900 });

    await markSessionRead({ sessionId: "s1", unread: false }, cache.ports);

    // Not a fixed resting value: the row goes back to the stamp it held.
    expect(cache.current()).toEqual({ unreadSince: 900 });
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't mark the session: ipc gone",
      expect.anything(),
    );
  });

  it("leaves an authoritative row that landed mid-flight alone", async () => {
    const cache = row();
    stubSetRead(() => {
      // Main's own answer for this row arrives while the mark is in flight.
      cache.upsert({ unreadSince: 7_000 });
      return Promise.resolve({ ok: false, error: "db locked" });
    });

    await markSessionRead({ sessionId: "s1", unread: true }, cache.ports);

    // The revert would have overwritten a fact with a guess.
    expect(cache.current()).toEqual({ unreadSince: 7_000 });
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't mark the session: db locked",
      expect.anything(),
    );
  });

  it("leaves an authoritative CLEAR that landed mid-flight alone", async () => {
    const cache = row({ unreadSince: 100 });
    stubSetRead(() => {
      cache.upsert({ unreadSince: null });
      return Promise.reject(new Error("ipc gone"));
    });

    // The optimistic value here is a stamp; main's clear is the newer truth.
    await markSessionRead({ sessionId: "s1", unread: true }, cache.ports);

    expect(cache.current()).toEqual({ unreadSince: null });
  });
});

describe("a remote Session's read mark (VC-713)", () => {
  it("says it is not available on the host, and marks nothing", async () => {
    vi.mocked(remoteHostOfSession).mockReturnValueOnce("hetzner-1");
    const setRead = stubSetRead(async () => ({ ok: true }) as SessionReadSetResult);
    const cache = row();
    await markSessionRead({ sessionId: "remote-session", unread: true }, cache.ports);
    expect(setRead).not.toHaveBeenCalled();
    expect(cache.written).toEqual([]);
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't mark the session: Not available on hetzner-1 yet",
      expect.anything(),
    );
  });
});
