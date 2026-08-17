import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  abandonAcceptedUpdateInstall,
  beginAcceptedUpdateInstall,
  clearUnsavedDocumentsOnWindowClosed,
  planUnsavedQuit,
  quitAlreadyRefused,
  quitConfirmDetail,
  recordUnsavedDocuments,
  registerAcceptedQuitCoordinator,
  refuseQuit,
  unsavedDocumentNames,
  updateInstallQuitInFlight,
} from "./quit-gate";
import { registerAgentSocketWillQuit } from "./agent-socket";

afterEach(() => {
  vi.useRealTimers();
});

describe("recordUnsavedDocuments", () => {
  beforeEach(() => {
    recordUnsavedDocuments({ names: [] });
  });

  it("remembers the latest report and forgets the one before it", () => {
    recordUnsavedDocuments({ names: ["train.py", "model.py"] });
    expect(unsavedDocumentNames()).toEqual(["train.py", "model.py"]);

    recordUnsavedDocuments({ names: ["model.py"] });
    expect(unsavedDocumentNames()).toEqual(["model.py"]);

    recordUnsavedDocuments({ names: [] });
    expect(unsavedDocumentNames()).toEqual([]);
  });

  it("ignores a malformed report rather than trusting it as 'nothing unsaved'", () => {
    recordUnsavedDocuments({ names: ["train.py"] });
    recordUnsavedDocuments({ names: [42, null] } as unknown as { names: string[] });
    expect(unsavedDocumentNames()).toEqual(["train.py"]);

    recordUnsavedDocuments(undefined as unknown as { names: string[] });
    expect(unsavedDocumentNames()).toEqual(["train.py"]);
  });

  it("clears the last renderer report when its window closes", () => {
    const handlers = new Map<string, () => void>();
    clearUnsavedDocumentsOnWindowClosed({
      on(event, listener) {
        handlers.set(event, listener);
      },
    });
    recordUnsavedDocuments({ names: ["train.py"] });

    handlers.get("closed")?.();

    expect(unsavedDocumentNames()).toEqual([]);
  });
});

describe("planUnsavedQuit", () => {
  it("lets a quit through when nothing is unsaved", () => {
    expect(planUnsavedQuit({ names: [], skipConfirm: false })).toBe("quit");
  });

  it("asks before a quit that would destroy a draft", () => {
    expect(planUnsavedQuit({ names: ["train.py"], skipConfirm: false })).toBe("confirm");
  });

  /**
   * The e2e smokes cannot answer a native modal, and they quit apps that were
   * deliberately left dirty. Same seam as the terminal gate's.
   */
  it("skips the confirm under the automation escape hatch", () => {
    expect(planUnsavedQuit({ names: ["train.py"], skipConfirm: true })).toBe("quit");
  });
});

describe("quitConfirmDetail", () => {
  it("names the single unsaved file", () => {
    expect(quitConfirmDetail(["train.py"])).toBe(
      "train.py has unsaved changes. Quitting will discard them.",
    );
  });

  it("counts and lists a handful", () => {
    expect(quitConfirmDetail(["train.py", "model.py"])).toBe(
      "2 files have unsaved changes (train.py, model.py). Quitting will discard them.",
    );
  });

  /** A 30-tab workbench must not produce a dialog taller than the screen. */
  it("truncates a long list", () => {
    const names = ["a.py", "b.py", "c.py", "d.py", "e.py", "f.py"];
    expect(quitConfirmDetail(names)).toBe(
      "6 files have unsaved changes (a.py, b.py, c.py, d.py, and 2 more). Quitting will discard them.",
    );
  });
});

describe("update-install quit latch (VC-59)", () => {
  afterEach(() => {
    abandonAcceptedUpdateInstall();
  });

  it("is down until the install dialog's confirm raises it", () => {
    expect(updateInstallQuitInFlight()).toBe(false);
    beginAcceptedUpdateInstall();
    expect(updateInstallQuitInFlight()).toBe(true);
  });

  it("abandon lowers it again — a failed quitAndInstall must not leave a plain ⌘Q gateless", () => {
    beginAcceptedUpdateInstall();
    abandonAcceptedUpdateInstall();
    expect(updateInstallQuitInFlight()).toBe(false);
  });
});

describe("refuseQuit", () => {
  it("cancels the event and marks it refused for every listener behind it", () => {
    const event = { preventDefault: vi.fn() };
    refuseQuit(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    // Read by each remaining listener, so it must survive being asked twice.
    expect(quitAlreadyRefused(event)).toBe(true);
    expect(quitAlreadyRefused(event)).toBe(true);
  });

  it("reports no refusal when no gate objected", () => {
    expect(quitAlreadyRefused({ preventDefault: vi.fn() })).toBe(false);
  });

  /**
   * The refusal belongs to one quit attempt. Scoping it to the event is what
   * makes that true without anyone having to remember to clear a flag — a flag
   * left set would swallow the next quit the user actually meant.
   */
  it("does not carry a refusal over to the next quit attempt", () => {
    refuseQuit({ preventDefault: vi.fn() });

    expect(quitAlreadyRefused({ preventDefault: vi.fn() })).toBe(false);
  });
});

describe("registerAcceptedQuitCoordinator", () => {
  it("forces one accepted quit after the shutdown deadline and observes late settlements", async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, (event: { preventDefault(): void }) => void>();
    let finishSessions!: () => void;
    let failSocket!: (error: unknown) => void;
    const shutdownNativeSessions = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSessions = resolve;
        }),
    );
    const shutdownAgentSocket = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          failSocket = reject;
        }),
    );
    const reportFailure = vi.fn();
    const exit = vi.fn();
    registerAcceptedQuitCoordinator({
      lifecycle: {
        on(event, listener) {
          handlers.set(event, listener);
        },
        exit,
      },
      shutdownNativeSessions,
      shutdownAgentSocket,
      shutdownDeadlineMs: 25,
      reportFailure,
    });

    const first = { preventDefault: vi.fn() };
    handlers.get("before-quit")?.(first);
    await vi.advanceTimersByTimeAsync(0);
    const repeated = { preventDefault: vi.fn() };
    handlers.get("before-quit")?.(repeated);

    expect(first.preventDefault).toHaveBeenCalledExactlyOnceWith();
    expect(repeated.preventDefault).toHaveBeenCalledExactlyOnceWith();
    expect(shutdownNativeSessions).toHaveBeenCalledTimes(1);
    expect(shutdownAgentSocket).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);

    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(
      new Error("Application shutdown did not settle within 25ms."),
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);

    finishSessions();
    failSocket(new Error("late socket failure"));
    await vi.advanceTimersByTimeAsync(0);
    handlers.get("before-quit")?.({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(25);

    expect(reportFailure).toHaveBeenNthCalledWith(2, new Error("late socket failure"));
    expect(reportFailure).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(shutdownNativeSessions).toHaveBeenCalledTimes(1);
    expect(shutdownAgentSocket).toHaveBeenCalledTimes(1);
  });

  it("still forces an accepted quit when deadline failure reporting throws", async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, (event: { preventDefault(): void }) => void>();
    const exit = vi.fn();
    registerAcceptedQuitCoordinator({
      lifecycle: {
        on(event, listener) {
          handlers.set(event, listener);
        },
        exit,
      },
      shutdownNativeSessions: () => new Promise<void>(() => undefined),
      shutdownAgentSocket: () => new Promise<void>(() => undefined),
      shutdownDeadlineMs: 25,
      reportFailure() {
        throw new Error("reporter failed");
      },
    });

    handlers.get("before-quit")?.({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(25);

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("holds every repeated accepted quit until the full shutdown settles", async () => {
    type QuitEvent = { preventDefault(): void };
    const handlers = new Map<"before-quit" | "will-quit", (event: QuitEvent) => void>();
    const exit = vi.fn();
    const lifecycle = {
      on(event: "before-quit" | "will-quit", listener: (event: QuitEvent) => void) {
        handlers.set(event, listener);
      },
      exit,
    };
    let finishSessions: (() => void) | undefined;
    const shutdownNativeSessions = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSessions = resolve;
        }),
    );
    const shutdownAgentSocket = vi.fn(() => Promise.resolve());
    let willQuitReached = false;
    const attemptQuit = (): QuitEvent => {
      let prevented = false;
      const event = {
        preventDefault: vi.fn(() => {
          prevented = true;
        }),
      };
      handlers.get("before-quit")?.(event);
      if (!prevented) {
        willQuitReached = true;
        handlers.get("will-quit")?.({ preventDefault: vi.fn() });
      }
      return event;
    };

    registerAgentSocketWillQuit({
      lifecycle,
      shutdownAgentSocket,
      reportFailure: vi.fn(),
    });
    registerAcceptedQuitCoordinator({
      lifecycle,
      shutdownNativeSessions,
      shutdownAgentSocket,
      reportFailure: vi.fn(),
    });

    const first = attemptQuit();
    await vi.waitFor(() => expect(shutdownAgentSocket).toHaveBeenCalledTimes(1));
    const second = attemptQuit();

    expect(first.preventDefault).toHaveBeenCalledExactlyOnceWith();
    expect(second.preventDefault).toHaveBeenCalledExactlyOnceWith();
    expect(willQuitReached).toBe(false);
    expect(shutdownNativeSessions).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    finishSessions?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
  });

  it("closes the agent socket before forcing an accepted quit", async () => {
    const handlers = new Map<string, (event: { preventDefault(): void }) => void>();
    const order: string[] = [];
    let finishSessions: (() => void) | undefined;
    let finishSocket: (() => void) | undefined;
    const shutdownAgentSocket = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSocket = () => {
            order.push("socket");
            resolve();
          };
        }),
    );
    const exit = vi.fn(() => {
      order.push("exit");
    });
    registerAcceptedQuitCoordinator({
      lifecycle: {
        on(event, listener) {
          handlers.set(event, listener);
        },
        exit,
      },
      shutdownNativeSessions: () =>
        new Promise<void>((resolve) => {
          finishSessions = () => {
            order.push("sessions");
            resolve();
          };
        }),
      shutdownAgentSocket,
      reportFailure: vi.fn(),
    });

    const event = { preventDefault: vi.fn() };
    handlers.get("before-quit")?.(event);

    expect(event.preventDefault).toHaveBeenCalledExactlyOnceWith();
    expect(exit).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(shutdownAgentSocket).toHaveBeenCalledTimes(1));
    expect(exit).not.toHaveBeenCalled();

    finishSocket?.();
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();

    finishSessions?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
    expect(order).toEqual(["socket", "sessions", "exit"]);
  });

  it("reports synchronous and asynchronous shutdown failures before forcing quit", async () => {
    const handlers = new Map<string, (event: { preventDefault(): void }) => void>();
    const nativeFailure = new Error("native close threw");
    const socketFailure = new Error("socket close rejected");
    const reportFailure = vi.fn();
    const exit = vi.fn();
    registerAcceptedQuitCoordinator({
      lifecycle: {
        on(event, listener) {
          handlers.set(event, listener);
        },
        exit,
      },
      shutdownNativeSessions() {
        throw nativeFailure;
      },
      shutdownAgentSocket: () => Promise.reject(socketFailure),
      reportFailure,
    });

    const event = { preventDefault: vi.fn() };
    handlers.get("before-quit")?.(event);

    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
    expect(event.preventDefault).toHaveBeenCalledExactlyOnceWith();
    expect(reportFailure).toHaveBeenNthCalledWith(1, nativeFailure);
    expect(reportFailure).toHaveBeenNthCalledWith(2, socketFailure);
    expect(reportFailure).toHaveBeenCalledTimes(2);
  });

  it("preserves the agent socket when an earlier quit gate cancels", () => {
    const handlers = new Map<string, (event: { preventDefault(): void }) => void>();
    const shutdownNativeSessions = vi.fn(() => Promise.resolve());
    const shutdownAgentSocket = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    registerAcceptedQuitCoordinator({
      lifecycle: {
        on(event, listener) {
          handlers.set(event, listener);
        },
        exit,
      },
      shutdownNativeSessions,
      shutdownAgentSocket,
      reportFailure: vi.fn(),
    });

    const event = { preventDefault: vi.fn() };
    refuseQuit(event);
    handlers.get("before-quit")?.(event);

    expect(event.preventDefault).toHaveBeenCalledExactlyOnceWith();
    expect(shutdownNativeSessions).not.toHaveBeenCalled();
    expect(shutdownAgentSocket).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("lets a later destructive-work gate cancel before shutdown starts", async () => {
    type QuitEvent = { preventDefault(): void };
    const handlers: Array<(event: QuitEvent) => void> = [];
    const shutdownNativeSessions = vi.fn(() => Promise.resolve());
    const shutdownAgentSocket = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    const lifecycle = {
      on(_event: "before-quit", listener: (event: QuitEvent) => void) {
        handlers.push(listener);
      },
      exit,
    };
    registerAcceptedQuitCoordinator({
      lifecycle,
      shutdownNativeSessions,
      shutdownAgentSocket,
      reportFailure: vi.fn(),
    });
    lifecycle.on("before-quit", (event) => refuseQuit(event));

    const event = { preventDefault: vi.fn() };
    for (const handler of handlers) handler(event);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(event.preventDefault).toHaveBeenCalled();
    expect(shutdownNativeSessions).not.toHaveBeenCalled();
    expect(shutdownAgentSocket).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
