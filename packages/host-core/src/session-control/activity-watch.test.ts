import { describe, expect, it, vi } from "vite-plus/test";
import { EMPTY_SESSION_USAGE_SUMMARY } from "@volli/shared";
import type { SessionAttachmentProjection, SessionEvent, SessionProjection } from "@volli/shared";

import { watchSessionActivity } from "./activity-watch";
import type { SessionWakeListener } from "./session-wake";

/** No executor binding is open: these rows rest at not-live. */
const noOpenBindings = () => [];

/** An open structured attachment — what turns `turnActive` into a `working` row. */
function openAttachment(): SessionAttachmentProjection {
  return {
    id: "attach-1",
    sessionId: "session-1",
    adapterId: "pi",
    venue: { id: "local", kind: "local" },
    continuity: "fresh",
    native: null,
    authority: null,
    status: "open",
    openedAt: 1,
    closedAt: null,
    outcome: null,
    failure: null,
    exitCode: null,
  };
}

function projection(overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    session: {
      id: "session-1",
      projectId: "project-1",
      ticketId: "ticket-1",
      role: "ticket",
      parentSessionId: null,
      title: "Plan the migration",
      createdAt: 1,
    },
    status: "open",
    commands: [],
    resumptions: [],
    latestTurnId: null,
    latestTurnOrigin: null,
    resumedAfterStop: false,
    receipts: [],
    pendingExecutorStart: null,
    attachments: [],
    liveExecutor: null,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    signal: null,
    stopped: null,
    turnActive: false,
    lastTurnOutcome: null,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    lastActivityAt: 1,
    bornTicketless: false,
    modelSelection: null,
    modelTier: null,
    ...overrides,
  };
}

/**
 * A stub wake bus: `commit` announces one committed Session Event to every
 * subscriber, the way `session-wake.ts` does after a write's transaction, and
 * the Engine half answers the fold's one read from `current`.
 */
function stubBus(current: () => SessionProjection | null) {
  const listeners = new Set<SessionWakeListener>();
  let sequence = 0;
  const getSession = vi.fn(async () => current());
  const bus = {
    engine: { getSession },
    subscribe(listener: SessionWakeListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  function commit(
    kind: SessionEvent["payload"]["kind"] = "turn.started",
    sessionId = "session-1",
  ): SessionEvent {
    sequence += 1;
    const event = {
      id: `event-${sequence}`,
      sessionId,
      sequence,
      occurredAt: sequence,
      recordedAt: sequence,
      provenance: {
        source: { kind: "system", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
      commandId: null,
      payload: { kind },
    } as unknown as SessionEvent;
    // A snapshot, as the real bus takes: a listener may stop the watch mid-wake.
    const settled = [...listeners];
    for (const listener of settled) listener({ event, cursor: `cursor-${sequence}` });
    return event;
  }
  return { bus, getSession, commit, listeners };
}

describe("watchSessionActivity", () => {
  it("publishes the changed Session's listing row after a committed fact", async () => {
    const publish = vi.fn();
    const { bus, commit } = stubBus(() => projection());
    const watch = watchSessionActivity(bus, { listOpenNativeBindings: noOpenBindings, publish });

    // `session.retitled` is what `submit` appends and does not return; the
    // wake bus announces it all the same.
    commit("session.retitled");
    await watch.flush();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toMatchObject({
      projectId: "project-1",
      ticketId: "ticket-1",
      row: { kind: "chat", record: { sessionId: "session-1", activity: "idle" } },
    });
    // No provenance port, so the row reads as person-started — the quiet answer
    // a caller that cannot ask gets, never a mark it did not earn.
    expect(publish.mock.calls[0]![0].row.provenance).toEqual({ kind: "user" });
    watch.stop();
  });

  // A pushed row is applied by the renderer as a whole-row upsert, so a push
  // that dropped provenance would take a Run's bolt off the row the first time
  // that Run did anything (VC-131). The port is asked for the SAME Session the
  // fold is about, which is what lets a Run started after this window opened
  // arrive marked without a second fetch.
  it("carries who started the Session on the pushed row", async () => {
    const publish = vi.fn();
    const provenanceOf = vi.fn(() => ({
      kind: "automation" as const,
      automationName: "Nightly sweep",
      automationRunId: null,
    }));
    const { bus, commit } = stubBus(() => projection());
    const watch = watchSessionActivity(bus, {
      listOpenNativeBindings: noOpenBindings,
      publish,
      provenanceOf,
    });

    commit();
    await watch.flush();

    expect(provenanceOf).toHaveBeenCalledWith({
      sessionId: "session-1",
      ticketId: "ticket-1",
    });
    expect(publish.mock.calls[0]![0].row.provenance).toEqual({
      kind: "automation",
      automationName: "Nightly sweep",
      automationRunId: null,
    });
    watch.stop();
  });

  // The same argument as provenance one test up, for the second per-Session
  // fact a row carries (VC-30): the renderer upserts the whole row, so a push
  // that dropped the receipt would clear the unread dot on the very fold that
  // earned it.
  it("carries the Session's unread state on the pushed row", async () => {
    const publish = vi.fn();
    const readOf = vi.fn(() => ({ unreadSince: 4_000 }));
    const { bus, commit } = stubBus(() => projection());
    const watch = watchSessionActivity(bus, {
      listOpenNativeBindings: noOpenBindings,
      publish,
      readOf,
    });

    commit();
    await watch.flush();

    expect(readOf).toHaveBeenCalledWith("session-1");
    expect(publish.mock.calls[0]![0].row.read).toEqual({ unreadSince: 4_000 });
    watch.stop();
  });

  it("leaves a read Session's row exactly as it was before unread existed", async () => {
    const publish = vi.fn();
    const { bus, commit } = stubBus(() => projection());
    const watch = watchSessionActivity(bus, { listOpenNativeBindings: noOpenBindings, publish });

    commit();
    await watch.flush();

    // The resting state is the field's ABSENCE, not a value: no receipt reader
    // means nothing to say, and `sessionReadStateOf` answers the miss.
    expect(publish.mock.calls[0]![0].row).not.toHaveProperty("read");
    watch.stop();
  });

  it("republishes when only the read state moved, and not when it did not", async () => {
    const publish = vi.fn();
    let read = { unreadSince: null as number | null };
    const { bus, commit } = stubBus(() => projection());
    const watch = watchSessionActivity(bus, {
      listOpenNativeBindings: noOpenBindings,
      publish,
      readOf: () => read,
    });
    const write = async () => {
      commit();
      await watch.flush();
    };

    await write();
    await write();
    // Nothing moved: the difference gate still holds with the receipt threaded
    // through it.
    expect(publish).toHaveBeenCalledTimes(1);

    read = { unreadSince: 4_000 };
    await write();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]![0].row.read).toEqual({ unreadSince: 4_000 });

    read = { unreadSince: null };
    await write();
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls[2]![0].row).not.toHaveProperty("read");

    watch.stop();
  });

  it("republishes only when the row actually changed", async () => {
    const publish = vi.fn();
    let live = projection();
    let liveBindings: { attachmentId: string }[] = [];
    const { bus, commit } = stubBus(() => live);
    const watch = watchSessionActivity(bus, {
      publish,
      listOpenNativeBindings: () => liveBindings,
    });
    const write = async () => {
      commit();
      await watch.flush();
    };

    await write();
    // Same Session, same row: a turn writing durable facts that move nothing a
    // listing shows must produce no traffic at all.
    await write();
    expect(publish).toHaveBeenCalledTimes(1);

    live = projection({ turnActive: true });
    await write();
    expect(publish).toHaveBeenCalledTimes(1); // no OPEN attachment yet — still idle

    const attachment = openAttachment();
    live = projection({ turnActive: true, attachments: [attachment], liveExecutor: attachment });
    await write();
    // The adapter identity is newly visible, so the row republishes, but a
    // relaunch with no executor binding stays honestly non-live and idle.
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]![0].row.record).toMatchObject({
      adapterId: "pi",
      live: false,
      activity: "idle",
    });

    liveBindings = [{ attachmentId: attachment.id }];
    await write();
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls[2]![0].row.record).toMatchObject({
      live: true,
      activity: "working",
    });

    watch.stop();
  });

  it("coalesces a burst of committed facts into one fold", async () => {
    const publish = vi.fn();
    const { bus, commit, getSession } = stubBus(() => projection());
    const watch = watchSessionActivity(bus, { listOpenNativeBindings: noOpenBindings, publish });

    // What one `submit` announces: its command, its effect and its receipt.
    commit("command.recorded");
    commit("session.signaled");
    commit("command.receipt.recorded");
    await watch.flush();

    expect(getSession).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("folds each Session a burst touched, once each", async () => {
    const publish = vi.fn();
    const { bus, commit, getSession } = stubBus(() => projection());
    const watch = watchSessionActivity(bus, { listOpenNativeBindings: noOpenBindings, publish });

    commit("turn.started", "session-1");
    commit("turn.started", "session-2");
    commit("turn.completed", "session-1");
    await watch.flush();

    expect(getSession.mock.calls).toEqual([
      [{ sessionId: "session-1" }],
      [{ sessionId: "session-2" }],
    ]);
    watch.stop();
  });

  it("swallows a fold failure without throwing into the bus", async () => {
    const publish = vi.fn();
    const onError = vi.fn();
    const { bus, commit, getSession } = stubBus(() => projection());
    getSession.mockRejectedValue(new Error("ledger gone"));
    const watch = watchSessionActivity(bus, {
      listOpenNativeBindings: noOpenBindings,
      publish,
      onError,
    });

    expect(() => commit()).not.toThrow();
    await watch.flush();

    expect(publish).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("says nothing about a Session the ledger no longer has", async () => {
    const publish = vi.fn();
    const onError = vi.fn();
    const { bus, commit } = stubBus(() => null);
    const watch = watchSessionActivity(bus, {
      listOpenNativeBindings: noOpenBindings,
      publish,
      onError,
    });

    commit();
    await watch.flush();

    expect(publish).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    watch.stop();
  });

  it("stops listening once stopped", async () => {
    const publish = vi.fn();
    const observeEvent = vi.fn();
    const { bus, commit, listeners } = stubBus(() => projection());
    const watch = watchSessionActivity(bus, {
      listOpenNativeBindings: noOpenBindings,
      publish,
      observeEvent,
    });

    watch.stop();
    expect(listeners.size).toBe(0);
    commit();
    await watch.flush();

    expect(publish).not.toHaveBeenCalled();
    expect(observeEvent).not.toHaveBeenCalled();
  });

  it("ignores the rest of a wake it was stopped during", async () => {
    // The bus snapshots its listeners per wake, so a watch stopped by an
    // earlier listener is still handed that one event.
    const publish = vi.fn();
    const observeEvent = vi.fn();
    const { bus, commit } = stubBus(() => projection());
    let watch: ReturnType<typeof watchSessionActivity> | undefined;
    bus.subscribe(() => watch?.stop());
    watch = watchSessionActivity(bus, {
      listOpenNativeBindings: noOpenBindings,
      publish,
      observeEvent,
    });

    commit();
    await watch.flush();

    expect(observeEvent).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes on its own timer, with no one calling flush", async () => {
    const publish = vi.fn();
    const { bus, commit } = stubBus(() => projection());
    const watch = watchSessionActivity(bus, {
      listOpenNativeBindings: noOpenBindings,
      publish,
      coalesceMs: 0,
    });

    commit();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    watch.stop();
  });

  it("cancels a pending flush when stopped mid-window", async () => {
    const publish = vi.fn();
    const { bus, commit } = stubBus(() => projection());
    const watch = watchSessionActivity(bus, {
      listOpenNativeBindings: noOpenBindings,
      publish,
      coalesceMs: 5,
    });

    commit();
    watch.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(publish).not.toHaveBeenCalled();
  });

  it("reports a fold failure to the host log when given no diagnostics seam", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bus, commit, getSession } = stubBus(() => projection());
    getSession.mockRejectedValue(new Error("ledger gone"));
    const watch = watchSessionActivity(bus, {
      listOpenNativeBindings: noOpenBindings,
      publish: vi.fn(),
    });

    commit();
    await watch.flush();

    expect(warn).toHaveBeenCalledWith("[activity-watch] session activity watch failed", {
      error: expect.objectContaining({ name: "Error", message: "ledger gone" }),
    });
    warn.mockRestore();
    watch.stop();
  });

  it("hands every folded projection to the observer, before the row gate (VC-133)", async () => {
    // The notification rule hangs off this port. It must see the projection —
    // the listing row cannot spell `error` at all — and it must see every fold,
    // because "did this LISTING change" is a different question from "did this
    // Session change".
    const state = projection();
    const { bus, commit } = stubBus(() => state);
    const observe = vi.fn();
    const publish = vi.fn();
    const watch = watchSessionActivity(bus, {
      listOpenNativeBindings: noOpenBindings,
      publish,
      observe,
      coalesceMs: 0,
    });

    commit("command.recorded");
    await watch.flush();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]?.[0]).toBe(state);

    // A second fold that leaves the row byte-identical still reaches the
    // observer, though the publish gate correctly swallows it.
    const publishes = publish.mock.calls.length;
    commit("command.recorded");
    await watch.flush();
    expect(observe).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls.length).toBe(publishes);

    watch.stop();
  });

  it("hands every committed fact over synchronously, before any fold (VC-577)", async () => {
    const { bus, commit, getSession } = stubBus(() => projection());
    const observeEvent = vi.fn();
    const onError = vi.fn();
    const watch = watchSessionActivity(bus, {
      listOpenNativeBindings: noOpenBindings,
      publish: vi.fn(),
      observeEvent,
      onError,
    });
    const started = commit("turn.started");
    // Every kind, not only the ones `observe` returns: a `submit`'s own
    // events reach the reader too, and it picks what it counts.
    const signaled = commit("session.signaled");
    expect(observeEvent.mock.calls).toEqual([[started], [signaled]]);
    expect(getSession).not.toHaveBeenCalled();
    // A throwing reader is reported, and the Session is still marked.
    const failure = new Error("reader");
    observeEvent.mockImplementation(() => {
      throw failure;
    });
    expect(() => commit("turn.completed")).not.toThrow();
    expect(onError).toHaveBeenCalledWith(failure);
    await watch.flush();
    expect(getSession).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("does not require an observer", async () => {
    // Optional for the reason `provenanceOf` is: a test that only asks whether
    // a write was noticed has no notification channel to hand in.
    const { bus, commit } = stubBus(() => projection());
    const watch = watchSessionActivity(bus, {
      listOpenNativeBindings: noOpenBindings,
      publish: vi.fn(),
      coalesceMs: 0,
    });
    commit("command.recorded");
    commit("session.created");
    await expect(watch.flush()).resolves.toBeUndefined();
    watch.stop();
  });

  it("announces a Session it just minted, before any fold can read it (VC-133)", async () => {
    // The notification rule speaks on ENTERING a need, which means it needs a
    // baseline. A create is the one moment the baseline is knowable outright,
    // and it has to be told synchronously: the coalescing timer can merge the
    // create with the write that puts the Session in `error`, and by then a
    // first fold cannot tell "it just broke" from "it was already broken".
    const { bus, commit } = stubBus(() => projection());
    const observeBirth = vi.fn();
    const observe = vi.fn(() => {
      expect(observeBirth).toHaveBeenCalledWith("session-1");
    });
    const watch = watchSessionActivity(bus, {
      listOpenNativeBindings: noOpenBindings,
      publish: vi.fn(),
      observe,
      observeBirth,
      coalesceMs: 0,
    });

    // What one `createSession` commits.
    commit("command.recorded");
    commit("session.created");
    commit("command.receipt.recorded");
    expect(observeBirth).toHaveBeenCalledTimes(1);
    await watch.flush();
    expect(observe).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("reports a throwing birth observer and still marks the Session", async () => {
    const onError = vi.fn();
    const failure = new Error("birth");
    const { bus, commit, getSession } = stubBus(() => projection());
    const watch = watchSessionActivity(bus, {
      listOpenNativeBindings: noOpenBindings,
      publish: vi.fn(),
      observeBirth: () => {
        throw failure;
      },
      onError,
    });

    expect(() => commit("session.created")).not.toThrow();
    expect(onError).toHaveBeenCalledWith(failure);
    await watch.flush();
    expect(getSession).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("announces no birth for a fact about a Session that already existed", async () => {
    // Every other kind reaches a Session this process did not necessarily
    // create, so none of them may claim a baseline.
    const { bus, commit } = stubBus(() => projection());
    const observeBirth = vi.fn();
    const watch = watchSessionActivity(bus, {
      listOpenNativeBindings: noOpenBindings,
      publish: vi.fn(),
      observeBirth,
      coalesceMs: 0,
    });

    commit("command.recorded");
    commit("turn.started");
    commit("session.input.recorded");
    commit("model.selected");
    await watch.flush();

    expect(observeBirth).not.toHaveBeenCalled();
    watch.stop();
  });
});
