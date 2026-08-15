import { describe, expect, it, vi } from "vite-plus/test";
import type { FileChangedEvent, FilePathInput, Result } from "../../../../ipc/contract";

import {
  createTicketRecencyWatchOwner,
  EMPTY_TICKET_RECENCY_OWNER_STATE,
  reduceTicketRecencyOwner,
} from "./ticket-change-recency-owner";

const input: FilePathInput = {
  projectId: "project-1",
  ticketId: "ticket-1",
  relPath: "src/app.ts",
};

/** Drain every queued microtask (the owner's re-arm chain is several deep). */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Main's teardown signal: a final change event carrying no revision. */
/** Ordinary news from a watcher that is still armed — nobody should re-arm for it. */
function ordinaryEvent(overrides: Partial<FileChangedEvent> = {}): FileChangedEvent {
  return {
    projectId: "project-1",
    // Main reports `null` for a Main-resolved file even though the held watch
    // input carries the ticket id — the owner must still match it.
    ticketId: null,
    relPath: "src/app.ts",
    source: "main",
    revision: 12,
    ...overrides,
  };
}

/**
 * The one event main owes a subscription it has torn down (issue #134). The
 * dominant teardown loses the file with its directory, hence `revision: null` —
 * but `final` is what carries the meaning, not the missing revision.
 */
function tornDownEvent(overrides: Partial<FileChangedEvent> = {}): FileChangedEvent {
  return { ...ordinaryEvent(), revision: null, final: true, ...overrides };
}

describe("reduceTicketRecencyOwner", () => {
  it("marks only a later event with the deliberately inspected complete identity", () => {
    const inspected = reduceTicketRecencyOwner(EMPTY_TICKET_RECENCY_OWNER_STATE, {
      type: "inspect",
      identity: {
        projectId: "project-1",
        ticketId: "ticket-1",
        relPath: "src/app.ts",
        source: "worktree",
      },
      revision: 1,
    });

    const wrongTicket = reduceTicketRecencyOwner(inspected, {
      type: "file-changed",
      event: {
        projectId: "project-1",
        ticketId: "ticket-2",
        relPath: "src/app.ts",
        source: "worktree",
        revision: 2,
      },
    });
    const wrongMain = reduceTicketRecencyOwner(inspected, {
      type: "file-changed",
      event: {
        projectId: "project-1",
        ticketId: null,
        relPath: "src/app.ts",
        source: "main",
        revision: 2,
      },
    });
    const updated = reduceTicketRecencyOwner(inspected, {
      type: "file-changed",
      event: {
        projectId: "project-1",
        ticketId: "ticket-1",
        relPath: "src/app.ts",
        source: "worktree",
        revision: 2,
      },
    });

    expect(wrongTicket).toBe(inspected);
    expect(wrongMain).toBe(inspected);
    expect(updated.recency.paths["src/app.ts"]).toEqual({
      seenRevision: "1",
      updatedRevision: "2",
    });
  });

  it("keeps a known local-save revision quiet and consumes its watcher echo", () => {
    const identity = {
      projectId: "project-1",
      ticketId: "ticket-1",
      relPath: "src/app.ts",
      source: "worktree",
    } as const;
    const inspected = reduceTicketRecencyOwner(EMPTY_TICKET_RECENCY_OWNER_STATE, {
      type: "inspect",
      identity,
      revision: 1,
    });
    const saved = reduceTicketRecencyOwner(inspected, {
      type: "local-save",
      identity,
      revision: 2,
    });
    const echoed = reduceTicketRecencyOwner(saved, {
      type: "file-changed",
      event: { ...identity, revision: 2 },
    });

    expect(saved.recency.paths["src/app.ts"]).toEqual({
      seenRevision: "2",
      updatedRevision: null,
    });
    expect(saved.localSaveEchoes["src/app.ts"]).toBe("2");
    expect(echoed.recency.paths["src/app.ts"]).toEqual({
      seenRevision: "2",
      updatedRevision: null,
    });
    expect(echoed.localSaveEchoes["src/app.ts"]).toBeUndefined();
  });

  it("ignores a local save for a path no view ever reported loading", () => {
    expect(
      reduceTicketRecencyOwner(EMPTY_TICKET_RECENCY_OWNER_STATE, {
        type: "local-save",
        identity: {
          projectId: "project-1",
          ticketId: "ticket-1",
          relPath: "src/never-opened.ts",
          source: "worktree",
        },
        revision: 7,
      }),
    ).toBe(EMPTY_TICKET_RECENCY_OWNER_STATE);
  });

  it("stays quiet for a re-broadcast of the revision already seen, and for a torn-down watch", () => {
    const identity = {
      projectId: "project-1",
      ticketId: "ticket-1",
      relPath: "src/app.ts",
      source: "worktree",
    } as const;
    const inspected = reduceTicketRecencyOwner(EMPTY_TICKET_RECENCY_OWNER_STATE, {
      type: "inspect",
      identity,
      revision: 5,
    });

    // Same revision as the bytes on screen — a bare mtime re-broadcast, not news.
    expect(
      reduceTicketRecencyOwner(inspected, {
        type: "file-changed",
        event: { ...identity, revision: 5 },
      }),
    ).toBe(inspected);
    // `revision: null` is main's watch-teardown signal, never a content claim.
    expect(
      reduceTicketRecencyOwner(inspected, {
        type: "file-changed",
        event: { ...identity, revision: null },
      }),
    ).toBe(inspected);
  });

  it("keeps every path-keyed record on a null prototype", () => {
    const identity = {
      projectId: "project-1",
      ticketId: "ticket-1",
      relPath: "constructor",
      source: "worktree",
    } as const;
    const state = reduceTicketRecencyOwner(
      reduceTicketRecencyOwner(EMPTY_TICKET_RECENCY_OWNER_STATE, {
        type: "inspect",
        identity,
        revision: 1,
      }),
      { type: "local-save", identity, revision: 2 },
    );

    expect(Object.getPrototypeOf(state.inspected)).toBeNull();
    expect(Object.getPrototypeOf(state.localSaveEchoes)).toBeNull();
    expect(Object.getPrototypeOf(state.recency.paths)).toBeNull();
    expect(Object.getPrototypeOf(EMPTY_TICKET_RECENCY_OWNER_STATE.inspected)).toBeNull();
    expect(Object.getPrototypeOf(EMPTY_TICKET_RECENCY_OWNER_STATE.localSaveEchoes)).toBeNull();
  });
});

describe("createTicketRecencyWatchOwner", () => {
  it("retains one ticket-level watch per inspected path and balances cleanup", async () => {
    const watch = vi.fn(async () => ({ ok: true }) as const);
    const unwatch = vi.fn(async () => ({ ok: true }) as const);
    const owner = createTicketRecencyWatchOwner({ watch, unwatch });

    await expect(owner.watch(input)).resolves.toEqual({ ok: true });
    await expect(owner.watch(input)).resolves.toEqual({ ok: true });
    owner.dispose();

    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledWith(input);
    expect(unwatch).toHaveBeenCalledTimes(1);
    expect(unwatch).toHaveBeenCalledWith(input);
  });

  it("dedupes arms that race the first in-flight install", async () => {
    const gate = deferred<Result>();
    const watch = vi.fn(() => gate.promise);
    const unwatch = vi.fn(async () => ({ ok: true }) as const);
    const owner = createTicketRecencyWatchOwner({ watch, unwatch });

    const first = owner.watch(input);
    const second = owner.watch(input);
    expect(watch).toHaveBeenCalledTimes(1);

    gate.resolve({ ok: true });
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    await expect(owner.watch(input)).resolves.toEqual({ ok: true });
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("releases a watch whose install lands after dispose", async () => {
    const gate = deferred<Result>();
    const watch = vi.fn(() => gate.promise);
    const unwatch = vi.fn(async () => ({ ok: true }) as const);
    const owner = createTicketRecencyWatchOwner({ watch, unwatch });

    const armed = owner.watch(input);
    owner.dispose();
    gate.resolve({ ok: true });
    await armed;

    // Nothing was held when dispose ran, so the late install has to clean up
    // after itself or main keeps a watcher for a torn-down ticket view.
    expect(unwatch).toHaveBeenCalledTimes(1);
    expect(unwatch).toHaveBeenCalledWith(input);
  });

  it("reports a rejected install as a typed failure and stays re-armable", async () => {
    const watch = vi
      .fn<(request: FilePathInput) => Promise<Result>>()
      .mockRejectedValueOnce(new Error("EMFILE"))
      .mockResolvedValueOnce({ ok: true });
    const unwatch = vi.fn(async () => ({ ok: true }) as const);
    const owner = createTicketRecencyWatchOwner({ watch, unwatch });

    await expect(owner.watch(input)).resolves.toEqual({ ok: false, error: "EMFILE" });
    // A failed install is never latched as held: the next load retries it.
    await expect(owner.watch(input)).resolves.toEqual({ ok: true });
    expect(watch).toHaveBeenCalledTimes(2);
  });

  it("re-arms a held watch main tore down, and reports a re-arm that fails", async () => {
    const watch = vi
      .fn<(request: FilePathInput) => Promise<Result>>()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "Directory is gone" });
    const unwatch = vi.fn(async () => ({ ok: true }) as const);
    const onWatchLost = vi.fn();
    const owner = createTicketRecencyWatchOwner({ watch, unwatch }, { onWatchLost });

    await owner.watch(input);

    owner.noteChangedEvent(tornDownEvent());
    await settle();
    // Our hold is released before re-arming so main's refCount stays balanced.
    expect(unwatch).toHaveBeenCalledWith(input);
    expect(watch).toHaveBeenCalledTimes(2);
    expect(onWatchLost).not.toHaveBeenCalled();

    owner.noteChangedEvent(tornDownEvent());
    await settle();
    expect(watch).toHaveBeenCalledTimes(3);
    expect(onWatchLost).toHaveBeenCalledWith(input);
  });

  it("re-arms on a teardown whose payload still reads like ordinary news", async () => {
    const watch = vi.fn(async () => ({ ok: true }) as const);
    const unwatch = vi.fn(async () => ({ ok: true }) as const);
    const owner = createTicketRecencyWatchOwner({ watch, unwatch });

    await owner.watch(input);
    // The `wireWatcher`-throw teardown (issue #134): the directory — and the
    // file with it — outlived the watcher, so the final event carries a real
    // mtime. Before `final` this was indistinguishable from a normal write, and
    // the held latch stranded silently for the rest of the ticket's life.
    owner.noteChangedEvent(tornDownEvent({ revision: 1_700_000_000_000 }));
    await settle();

    expect(unwatch).toHaveBeenCalledWith(input);
    expect(watch).toHaveBeenCalledTimes(2);
  });

  it("ignores teardown signals for paths it never armed, and after dispose", async () => {
    const watch = vi.fn(async () => ({ ok: true }) as const);
    const unwatch = vi.fn(async () => ({ ok: true }) as const);
    const onWatchLost = vi.fn();
    const owner = createTicketRecencyWatchOwner({ watch, unwatch }, { onWatchLost });

    await owner.watch(input);
    owner.noteChangedEvent(tornDownEvent({ relPath: "src/other.ts" }));
    owner.noteChangedEvent(tornDownEvent({ projectId: "project-2" }));
    // Unflagged events are ordinary news whatever the revision says: a file
    // deleted under a watcher that is still armed reports `revision: null` too,
    // and re-arming for it would only churn main's refCount.
    owner.noteChangedEvent(ordinaryEvent());
    owner.noteChangedEvent(ordinaryEvent({ revision: null }));
    await settle();
    expect(unwatch).not.toHaveBeenCalled();
    expect(watch).toHaveBeenCalledTimes(1);

    owner.dispose();
    unwatch.mockClear();
    owner.noteChangedEvent(tornDownEvent());
    await settle();
    expect(unwatch).not.toHaveBeenCalled();
    expect(watch).toHaveBeenCalledTimes(1);
    expect(onWatchLost).not.toHaveBeenCalled();
  });
});
