import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { scratchScope, ticketScope, useSessionsStore } from "../stores/sessions";
import { disposeEngine } from "./registry";
import {
  closeTerminalPane,
  closeTerminalSession,
  closeTicketSession,
  killProjectSessions,
  killProjectTicketSessions,
  killTicketSessions,
  renameTerminalSession,
} from "./session-lifecycle";

// The registry constructs real GPU-backed engines; the lifecycle contract under
// test is only that it disposes through the registry, so stub the seam.
vi.mock("./registry", () => ({ disposeEngine: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const killMock = vi.fn<(sessionId: string) => Promise<{ ok: boolean; error?: string }>>();
const renameMock =
  vi.fn<
    (input: { sessionId: string; title: string }) => Promise<{ ok: boolean; error?: string }>
  >();

/** Flush a fire-and-forget promise's .then/.catch chain. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  killMock.mockResolvedValue({ ok: true });
  renameMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("window", {
    api: { terminal: { kill: killMock }, sessions: { rename: renameMock } },
  });
  useSessionsStore.setState({ byOwner: {}, sessionOwner: {}, lastOutputAt: {}, starting: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("closeTerminalSession", () => {
  it("drops the tab, disposes its engine, and kills its live PTY", () => {
    useSessionsStore.getState().addSession(scratchScope("p"), "s1", "Terminal 1");

    closeTerminalSession("p", "s1");

    expect(useSessionsStore.getState().byOwner["p"]?.tabs).toEqual([]);
    expect(vi.mocked(disposeEngine)).toHaveBeenCalledWith("s1");
    expect(killMock).toHaveBeenCalledWith("s1");
  });

  it("disposes and kills every independent pane owned by the tab", () => {
    useSessionsStore.getState().addSession(scratchScope("p"), "s1", "Terminal 1");
    useSessionsStore.getState().addSplit("p", "s1", "s1", "s2", "vertical");

    closeTerminalSession("p", "s1");

    expect(vi.mocked(disposeEngine)).toHaveBeenCalledWith("s1");
    expect(vi.mocked(disposeEngine)).toHaveBeenCalledWith("s2");
    expect(killMock).toHaveBeenCalledWith("s1");
    expect(killMock).toHaveBeenCalledWith("s2");
  });

  it("does not kill an already-exited tab — main has no PTY left for it", () => {
    useSessionsStore.getState().addSession(scratchScope("p"), "s1", "Terminal 1");
    useSessionsStore.getState().markExited("s1", 0);

    closeTerminalSession("p", "s1");

    expect(useSessionsStore.getState().byOwner["p"]?.tabs).toEqual([]);
    expect(vi.mocked(disposeEngine)).toHaveBeenCalledWith("s1");
    expect(killMock).not.toHaveBeenCalled();
  });

  it("does not kill for an unknown session", () => {
    closeTerminalSession("p", "ghost");

    expect(killMock).not.toHaveBeenCalled();
  });

  it("toasts when the kill reports a failure", async () => {
    killMock.mockResolvedValue({ ok: false, error: "boom" });
    useSessionsStore.getState().addSession(scratchScope("p"), "s1", "Terminal 1");

    closeTerminalSession("p", "s1");
    await flush();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Terminal close failed: boom");
  });

  it("toasts when the kill invocation rejects", async () => {
    killMock.mockRejectedValue(new Error("ipc down"));
    useSessionsStore.getState().addSession(scratchScope("p"), "s1", "Terminal 1");

    closeTerminalSession("p", "s1");
    await flush();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Terminal close failed: ipc down");
  });
});

describe("closeTerminalPane", () => {
  it("removes and tears down only the selected split leaf", () => {
    useSessionsStore.getState().addSession(scratchScope("p"), "s1", "Terminal 1");
    useSessionsStore.getState().addSplit("p", "s1", "s1", "s2", "vertical");

    closeTerminalPane("p", "s1", "s2");

    expect(useSessionsStore.getState().byOwner["p"]?.tabs).toHaveLength(1);
    expect(vi.mocked(disposeEngine)).toHaveBeenCalledWith("s2");
    expect(killMock).toHaveBeenCalledWith("s2");
    expect(killMock).not.toHaveBeenCalledWith("s1");
  });

  it("closes the containing tab when its final pane is closed", () => {
    useSessionsStore.getState().addSession(scratchScope("p"), "s1", "Terminal 1");

    closeTerminalPane("p", "s1", "s1");

    expect(useSessionsStore.getState().byOwner["p"]?.tabs).toEqual([]);
    expect(vi.mocked(disposeEngine)).toHaveBeenCalledWith("s1");
    expect(killMock).toHaveBeenCalledWith("s1");
  });

  it("is a no-op for an unknown tab or pane", () => {
    useSessionsStore.getState().addSession(scratchScope("p"), "s1", "Terminal 1");

    closeTerminalPane("p", "missing", "s1");
    closeTerminalPane("p", "s1", "missing");

    expect(vi.mocked(disposeEngine)).not.toHaveBeenCalled();
    expect(killMock).not.toHaveBeenCalled();
  });
});

describe("killProjectSessions", () => {
  it("kills live tabs, skips exited ones, disposes every engine, and forgets the project", () => {
    useSessionsStore.getState().addSession(scratchScope("p"), "s1", "Terminal 1");
    useSessionsStore.getState().addSession(scratchScope("p"), "s2", "Terminal 2");
    useSessionsStore.getState().markExited("s1", 130);
    useSessionsStore.getState().addSession(scratchScope("other"), "o1", "Terminal 1");

    killProjectSessions("p");

    expect(killMock).toHaveBeenCalledTimes(1);
    expect(killMock).toHaveBeenCalledWith("s2");
    expect(vi.mocked(disposeEngine)).toHaveBeenCalledWith("s1");
    expect(vi.mocked(disposeEngine)).toHaveBeenCalledWith("s2");
    expect(useSessionsStore.getState().byOwner["p"]).toBeUndefined();
    expect(useSessionsStore.getState().byOwner["other"]?.tabs).toHaveLength(1);
  });

  it("tears down every pane inside split tabs", () => {
    useSessionsStore.getState().addSession(scratchScope("p"), "s1", "Terminal 1");
    useSessionsStore.getState().addSplit("p", "s1", "s1", "s2", "horizontal");

    killProjectSessions("p");

    expect(vi.mocked(disposeEngine)).toHaveBeenCalledTimes(2);
    expect(killMock).toHaveBeenCalledTimes(2);
  });

  it("is a no-op for a project with no sessions", () => {
    killProjectSessions("never-added");

    expect(killMock).not.toHaveBeenCalled();
    expect(vi.mocked(disposeEngine)).not.toHaveBeenCalled();
  });
});

describe("closeTicketSession", () => {
  it("drops the ticket tab, disposes its engine, and kills its live PTY", () => {
    useSessionsStore.getState().addSession(ticketScope("p", "t1"), "s1", "Session 1");

    closeTicketSession("t1", "s1");

    expect(useSessionsStore.getState().byOwner["t1"]?.tabs).toEqual([]);
    expect(vi.mocked(disposeEngine)).toHaveBeenCalledWith("s1");
    expect(killMock).toHaveBeenCalledWith("s1");
  });

  it("does not kill an already-exited ticket session", () => {
    useSessionsStore.getState().addSession(ticketScope("p", "t1"), "s1", "Session 1");
    useSessionsStore.getState().markExited("s1", 0);

    closeTicketSession("t1", "s1");

    expect(vi.mocked(disposeEngine)).toHaveBeenCalledWith("s1");
    expect(killMock).not.toHaveBeenCalled();
  });

  it("does not kill for an unknown ticket session", () => {
    closeTicketSession("t1", "ghost");

    expect(killMock).not.toHaveBeenCalled();
  });
});

describe("killTicketSessions", () => {
  it("kills every live session of a ticket, disposes engines, and forgets the ticket", () => {
    useSessionsStore.getState().addSession(ticketScope("p", "t1"), "s1", "Session 1");
    useSessionsStore.getState().addSession(ticketScope("p", "t1"), "s2", "Session 2");
    useSessionsStore.getState().markExited("s1", 130);

    killTicketSessions("t1");

    expect(killMock).toHaveBeenCalledTimes(1);
    expect(killMock).toHaveBeenCalledWith("s2");
    expect(vi.mocked(disposeEngine)).toHaveBeenCalledWith("s1");
    expect(vi.mocked(disposeEngine)).toHaveBeenCalledWith("s2");
    expect(useSessionsStore.getState().byOwner["t1"]).toBeUndefined();
  });

  it("is a no-op for a ticket with no sessions", () => {
    killTicketSessions("never-added");

    expect(killMock).not.toHaveBeenCalled();
    expect(vi.mocked(disposeEngine)).not.toHaveBeenCalled();
  });
});

describe("renameTerminalSession", () => {
  it("optimistically retitles the tab and persists the trimmed title", async () => {
    useSessionsStore.getState().addSession(scratchScope("p"), "s1", "Terminal 1");

    void renameTerminalSession("s1", "  Renamed  ");

    expect(useSessionsStore.getState().byOwner["p"]?.tabs[0]?.title).toBe("Renamed");
    expect(renameMock).toHaveBeenCalledWith({ sessionId: "s1", title: "Renamed" });
    await flush();
    expect(useSessionsStore.getState().byOwner["p"]?.tabs[0]?.title).toBe("Renamed");
  });

  it("rolls the title back and toasts when the persist fails", async () => {
    renameMock.mockResolvedValue({ ok: false, error: "nope" });
    useSessionsStore.getState().addSession(scratchScope("p"), "s1", "Terminal 1"); // "Terminal 1"

    void renameTerminalSession("s1", "Renamed");
    await flush();

    expect(useSessionsStore.getState().byOwner["p"]?.tabs[0]?.title).toBe("Terminal 1");
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Rename failed: nope");
  });

  it("rolls the title back and toasts when the persist invocation rejects", async () => {
    renameMock.mockRejectedValue(new Error("ipc down"));
    useSessionsStore.getState().addSession(scratchScope("p"), "s1", "Terminal 1"); // "Terminal 1"

    void renameTerminalSession("s1", "Renamed");
    await flush();

    expect(useSessionsStore.getState().byOwner["p"]?.tabs[0]?.title).toBe("Terminal 1");
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Rename failed: ipc down");
  });

  it("is a no-op for a blank or unchanged title, and never calls main", async () => {
    useSessionsStore.getState().addSession(scratchScope("p"), "s1", "Session 1");

    expect(await renameTerminalSession("s1", "   ")).toBe(false);
    expect(await renameTerminalSession("s1", "Session 1")).toBe(false);

    expect(renameMock).not.toHaveBeenCalled();
  });

  it("skips the rollback when a newer rename replaced the title while the write was in flight", async () => {
    // The first write (to "A") is left pending; a second rename to "B" lands and
    // succeeds before it fails. Rolling "A" back to its captured `previous` would
    // clobber the newer "B" — so the stale rollback must be skipped.
    let failA!: (result: { ok: false; error: string }) => void;
    renameMock.mockImplementation(({ title }) =>
      title === "A" ? new Promise((resolve) => (failA = resolve)) : Promise.resolve({ ok: true }),
    );
    useSessionsStore.getState().addSession(scratchScope("p"), "s1", "Terminal 1");

    const first = renameTerminalSession("s1", "A");
    expect(await renameTerminalSession("s1", "B")).toBe(true);
    failA({ ok: false, error: "stale" });

    expect(await first).toBe(false);
    expect(useSessionsStore.getState().byOwner["p"]?.tabs[0]?.title).toBe("B");
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Rename failed: stale");
  });

  it("persists directly for an ended session (no live tab) and resolves true", async () => {
    // No tab added for "ended" — the panel renames a past/durable session row.
    expect(await renameTerminalSession("ended", "  New name  ")).toBe(true);
    expect(renameMock).toHaveBeenCalledWith({ sessionId: "ended", title: "New name" });
  });

  it("still no-ops on a blank title for an ended session, and never calls main", async () => {
    expect(await renameTerminalSession("ended", "   ")).toBe(false);
    expect(renameMock).not.toHaveBeenCalled();
  });

  it("toasts and resolves false when an ended-session persist fails", async () => {
    renameMock.mockResolvedValue({ ok: false, error: "gone" });

    expect(await renameTerminalSession("ended", "New")).toBe(false);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Rename failed: gone");
  });
});

describe("killProjectTicketSessions", () => {
  it("kills a project's ticket sessions (including ones the board no longer lists) and leaves other projects and scratch alone", () => {
    useSessionsStore.getState().addSession(ticketScope("p", "t1"), "s1", "Session 1");
    useSessionsStore.getState().addSession(ticketScope("p", "t2"), "s2", "Session 1");
    useSessionsStore.getState().addSession(ticketScope("q", "t3"), "s3", "Session 1");
    useSessionsStore.getState().addSession(scratchScope("p"), "sp", "Terminal 1");

    killProjectTicketSessions("p");

    expect(useSessionsStore.getState().byOwner["t1"]).toBeUndefined();
    expect(useSessionsStore.getState().byOwner["t2"]).toBeUndefined();
    // A ticket under a different project is untouched, as is p's scratch session.
    expect(useSessionsStore.getState().byOwner["t3"]?.tabs).toHaveLength(1);
    expect(useSessionsStore.getState().byOwner["p"]?.tabs).toHaveLength(1);
    expect(killMock).toHaveBeenCalledWith("s1");
    expect(killMock).toHaveBeenCalledWith("s2");
    expect(killMock).not.toHaveBeenCalledWith("s3");
    expect(killMock).not.toHaveBeenCalledWith("sp");
  });

  it("is a no-op when the project has no ticket sessions", () => {
    useSessionsStore.getState().addSession(scratchScope("p"), "sp", "Terminal 1");

    killProjectTicketSessions("p");

    expect(killMock).not.toHaveBeenCalled();
    expect(useSessionsStore.getState().byOwner["p"]?.tabs).toHaveLength(1);
  });
});
