import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useSessionsStore } from "../stores/sessions";
import { disposeEngine } from "./registry";
import { closeTerminalSession, killProjectSessions } from "./session-lifecycle";

// The registry constructs real GPU-backed engines; the lifecycle contract under
// test is only that it disposes through the registry, so stub the seam.
vi.mock("./registry", () => ({ disposeEngine: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const killMock = vi.fn<(sessionId: string) => Promise<{ ok: boolean; error?: string }>>();

/** Flush the kill promise's .then/.catch chain. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  killMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("window", { api: { terminal: { kill: killMock } } });
  useSessionsStore.setState({ byProject: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("closeTerminalSession", () => {
  it("drops the tab, disposes its engine, and kills its live PTY", () => {
    useSessionsStore.getState().addSession("p", "s1");

    closeTerminalSession("p", "s1");

    expect(useSessionsStore.getState().byProject["p"]?.tabs).toEqual([]);
    expect(vi.mocked(disposeEngine)).toHaveBeenCalledWith("s1");
    expect(killMock).toHaveBeenCalledWith("s1");
  });

  it("does not kill an already-exited tab — main has no PTY left for it", () => {
    useSessionsStore.getState().addSession("p", "s1");
    useSessionsStore.getState().markExited("s1", 0);

    closeTerminalSession("p", "s1");

    expect(useSessionsStore.getState().byProject["p"]?.tabs).toEqual([]);
    expect(vi.mocked(disposeEngine)).toHaveBeenCalledWith("s1");
    expect(killMock).not.toHaveBeenCalled();
  });

  it("does not kill for an unknown session", () => {
    closeTerminalSession("p", "ghost");

    expect(killMock).not.toHaveBeenCalled();
  });

  it("toasts when the kill reports a failure", async () => {
    killMock.mockResolvedValue({ ok: false, error: "boom" });
    useSessionsStore.getState().addSession("p", "s1");

    closeTerminalSession("p", "s1");
    await flush();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Terminal close failed: boom");
  });

  it("toasts when the kill invocation rejects", async () => {
    killMock.mockRejectedValue(new Error("ipc down"));
    useSessionsStore.getState().addSession("p", "s1");

    closeTerminalSession("p", "s1");
    await flush();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Terminal close failed: ipc down");
  });
});

describe("killProjectSessions", () => {
  it("kills live tabs, skips exited ones, disposes every engine, and forgets the project", () => {
    useSessionsStore.getState().addSession("p", "s1");
    useSessionsStore.getState().addSession("p", "s2");
    useSessionsStore.getState().markExited("s1", 130);
    useSessionsStore.getState().addSession("other", "o1");

    killProjectSessions("p");

    expect(killMock).toHaveBeenCalledTimes(1);
    expect(killMock).toHaveBeenCalledWith("s2");
    expect(vi.mocked(disposeEngine)).toHaveBeenCalledWith("s1");
    expect(vi.mocked(disposeEngine)).toHaveBeenCalledWith("s2");
    expect(useSessionsStore.getState().byProject["p"]).toBeUndefined();
    expect(useSessionsStore.getState().byProject["other"]?.tabs).toHaveLength(1);
  });

  it("is a no-op for a project with no sessions", () => {
    killProjectSessions("never-added");

    expect(killMock).not.toHaveBeenCalled();
    expect(vi.mocked(disposeEngine)).not.toHaveBeenCalled();
  });
});
