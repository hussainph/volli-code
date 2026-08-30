import { describe, expect, it, vi } from "vite-plus/test";
import type { SessionEngine } from "@volli/session-engine";
import { EMPTY_SESSION_USAGE_SUMMARY } from "@volli/shared";
import type { SessionAttachmentProjection, SessionProjection } from "@volli/shared";

import { watchSessionActivity } from "./activity-watch";

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
  };
}

function projection(overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    session: {
      id: "session-1",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: "Plan the migration",
      createdAt: 1,
    },
    status: "open",
    commands: [],
    receipts: [],
    pendingExecutorStart: null,
    attachments: [],
    liveExecutor: null,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    signal: null,
    stopped: null,
    turnActive: false,
    authorityDenials: 0,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    lastActivityAt: 1,
    bornTicketless: false,
    modelSelection: null,
    ...overrides,
  };
}

/**
 * A stub Engine whose reads answer from `current`, so a test can move a Session
 * and then trigger the watch by calling a write. Only the members the watch
 * touches are real; the rest exist to satisfy the interface and throw if used,
 * which is how a forwarding mistake surfaces as a failure rather than as
 * `undefined`.
 */
const unused = (name: string) => () => {
  throw new Error(`unexpected ${name}`);
};

function stubEngine(current: () => SessionProjection | null) {
  const engine = {
    createSession: vi.fn(async () => ({ session: { id: "session-1" } })),
    getOrRecordSessionInput: vi.fn(async () => ({})),
    observe: vi.fn(async () => ({ sessionId: "session-1" })),
    submit: vi.fn(async () => ({})),
    completeModelSelection: vi.fn(async () => ({})),
    getSession: vi.fn(async () => current()),
    getBaseSession: unused("getBaseSession"),
    listSessions: unused("listSessions"),
    countSessions: unused("countSessions"),
    listSessionStarts: unused("listSessionStarts"),
    listLatestTicketSignals: unused("listLatestTicketSignals"),
    listEvents: unused("listEvents"),
    reportUsage: unused("reportUsage"),
  } as unknown as SessionEngine;
  return engine;
}

describe("watchSessionActivity", () => {
  it("publishes the changed Session's listing row after a write", async () => {
    const publish = vi.fn();
    const watch = watchSessionActivity(
      stubEngine(() => projection()),
      { publish },
    );

    await watch.engine.submit({
      commandId: "command-1",
      sessionId: "session-1",
      intent: { kind: "session.retitle", title: "Renamed" },
      provenance: {
        source: { kind: "user", id: "renderer", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });
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
    }));
    const watch = watchSessionActivity(
      stubEngine(() => projection()),
      { publish, provenanceOf },
    );

    await watch.engine.observe({} as never);
    await watch.flush();

    expect(provenanceOf).toHaveBeenCalledWith({
      sessionId: "session-1",
      ticketId: "ticket-1",
    });
    expect(publish.mock.calls[0]![0].row.provenance).toEqual({
      kind: "automation",
      automationName: "Nightly sweep",
    });
    watch.stop();
  });

  it("republishes only when the row actually changed", async () => {
    const publish = vi.fn();
    let live = projection();
    const watch = watchSessionActivity(
      stubEngine(() => live),
      { publish },
    );
    const write = async () => {
      await watch.engine.observe({} as never);
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

    live = projection({ turnActive: true, attachments: [openAttachment()] });
    await write();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]![0].row.record.activity).toBe("working");

    watch.stop();
  });

  it("coalesces a burst of writes into one fold", async () => {
    const publish = vi.fn();
    const engine = stubEngine(() => projection());
    const watch = watchSessionActivity(engine, { publish });

    await watch.engine.observe({} as never);
    await watch.engine.observe({} as never);
    await watch.engine.observe({} as never);
    await watch.flush();

    expect(engine.getSession).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("swallows a fold failure without failing the write that triggered it", async () => {
    const publish = vi.fn();
    const onError = vi.fn();
    const engine = stubEngine(() => projection());
    (engine.getSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ledger gone"));
    const watch = watchSessionActivity(engine, { publish, onError });

    await expect(watch.engine.observe({} as never)).resolves.toBeDefined();
    await watch.flush();

    expect(publish).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("says nothing about a Session the ledger no longer has", async () => {
    const publish = vi.fn();
    const onError = vi.fn();
    const watch = watchSessionActivity(
      stubEngine(() => null),
      { publish, onError },
    );

    await watch.engine.observe({} as never);
    await watch.flush();

    expect(publish).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    watch.stop();
  });

  it("stops publishing once stopped", async () => {
    const publish = vi.fn();
    const watch = watchSessionActivity(
      stubEngine(() => projection()),
      { publish },
    );

    watch.stop();
    await watch.engine.observe({} as never);
    await watch.flush();

    expect(publish).not.toHaveBeenCalled();
  });

  it("marks the Session behind every mutating method, not only the two obvious ones", async () => {
    const publish = vi.fn();
    const engine = stubEngine(() => projection());
    const watch = watchSessionActivity(engine, { publish });

    await watch.engine.createSession({} as never);
    await watch.engine.getOrRecordSessionInput({ sessionId: "session-1" } as never);
    await watch.engine.completeModelSelection({ sessionId: "session-1" } as never);
    await watch.flush();

    // All three reach the same Session, so they coalesce into one publish — the
    // point of the assertion is that none of them was forgotten, which a
    // `getSession` that never ran would have hidden.
    expect(engine.getSession).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("publishes on its own timer, with no one calling flush", async () => {
    const publish = vi.fn();
    const watch = watchSessionActivity(
      stubEngine(() => projection()),
      {
        publish,
        coalesceMs: 0,
      },
    );

    await watch.engine.observe({} as never);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    watch.stop();
  });

  it("cancels a pending flush when stopped mid-window", async () => {
    const publish = vi.fn();
    const watch = watchSessionActivity(
      stubEngine(() => projection()),
      {
        publish,
        coalesceMs: 5,
      },
    );

    await watch.engine.observe({} as never);
    watch.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(publish).not.toHaveBeenCalled();
  });

  it("reports a fold failure through console.warn when given no diagnostics seam", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = stubEngine(() => projection());
    (engine.getSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ledger gone"));
    const watch = watchSessionActivity(engine, { publish: vi.fn() });

    await watch.engine.observe({} as never);
    await watch.flush();

    expect(warn).toHaveBeenCalledWith("[volli] session activity watch:", expect.any(Error));
    warn.mockRestore();
    watch.stop();
  });

  it("forwards every read to the wrapped engine untouched", async () => {
    const engine = stubEngine(() => projection());
    const reads = {
      getSession: vi.fn(async () => null),
      getBaseSession: vi.fn(async () => null),
      listSessions: vi.fn(async () => []),
      countSessions: vi.fn(async () => 0),
      listSessionStarts: vi.fn(async () => []),
      listLatestTicketSignals: vi.fn(async () => []),
      listEvents: vi.fn(async () => []),
      // A cost read is a read: it must pass straight through, and must never
      // be mistaken for a write that marks a Session dirty.
      reportUsage: vi.fn(async () => ({
        total: EMPTY_SESSION_USAGE_SUMMARY,
        groups: [],
        meteredSessionCount: 0,
      })),
    };
    Object.assign(engine, reads);
    const watch = watchSessionActivity(engine, { publish: vi.fn() });

    await watch.engine.getSession({ sessionId: "session-1" });
    await watch.engine.getBaseSession({ sessionId: "session-1" });
    await watch.engine.listSessions({ projectId: "project-1", scope: "all" });
    await watch.engine.countSessions({ projectId: "project-1", scope: "all" });
    await watch.engine.listSessionStarts({ sinceMs: 0 });
    await watch.engine.listLatestTicketSignals({ projectId: "project-1" });
    await watch.engine.listEvents({ sessionId: "session-1" });
    await watch.engine.reportUsage({ scope: { kind: "all" } });

    for (const read of Object.values(reads)) expect(read).toHaveBeenCalledTimes(1);
    watch.stop();
  });
});
