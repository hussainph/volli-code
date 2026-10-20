import { afterEach, describe, expect, it } from "vite-plus/test";
import type { LogRecord, SessionEvent, SessionEventPayload } from "@volli/shared";

import { withLogContext } from "../log/context";
import { installHostLog } from "../log/root";
import { logSessionEvents, sessionEventFields } from "./session-event-log";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
let undo: (() => void) | null = null;
afterEach(() => undo?.());

function capture(level: "debug" | "info") {
  const records: LogRecord[] = [];
  undo = installHostLog({ level, sink: { write: (record) => records.push(record) } });
  return records;
}

function event(
  sequence: number,
  payload: unknown,
  extra: Partial<SessionEvent> = {},
): SessionEvent {
  return {
    id: `e-${sequence}`,
    sessionId: "s-1",
    sequence,
    occurredAt: 1,
    recordedAt: 1,
    provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
    payload: payload as SessionEventPayload,
    ...extra,
  };
}

describe("a Session's committed facts as log lines (VC-699)", () => {
  it("writes turns, commands and Attention at info inside the operation's trace, and the rest at debug", () => {
    const records = capture("info");
    withLogContext({ traceId: TRACE }, () =>
      logSessionEvents([
        event(
          1,
          { kind: "turn.started", attachmentId: "a-1", turnId: "t-1" },
          { attachmentId: "a-1" },
        ),
        event(2, { kind: "session.retitled", title: "a secret title" }),
        event(
          3,
          { kind: "turn.completed", attachmentId: "a-1", turnId: "t-1" },
          { commandId: "c-1" },
        ),
      ]),
    );
    expect(
      records.map(({ msg, traceId, turnId, sessionId }) => ({ msg, traceId, turnId, sessionId })),
    ).toEqual([
      { msg: "session turn.started", traceId: TRACE, turnId: "t-1", sessionId: "s-1" },
      { msg: "session turn.completed", traceId: TRACE, turnId: "t-1", sessionId: "s-1" },
    ]);
    expect(records[1]).toMatchObject({ commandId: "c-1", attachmentId: "a-1", sequence: 3 });
    expect(JSON.stringify(records)).not.toContain("secret title");
  });

  it("writes debug facts by kind alone, when debug is on", () => {
    const records = capture("debug");
    logSessionEvents([event(1, { kind: "session.retitled", title: "never logged" })]);
    expect(records).toMatchObject([
      { level: "debug", msg: "session session.retitled", sequence: 1 },
    ]);
    expect(JSON.stringify(records)).not.toContain("never logged");
  });

  it("names each fact by its identifiers, never by what a person wrote", () => {
    expect(
      sessionEventFields(
        event(1, {
          kind: "command.recorded",
          command: { id: "c-1", intent: { kind: "message.submit", text: "x" } },
        }),
      ),
    ).toEqual({ sessionId: "s-1", sequence: 1, commandId: "c-1", intent: "message.submit" });
    expect(
      sessionEventFields(
        event(2, {
          kind: "command.receipt.recorded",
          receipt: { commandId: "c-1", status: "completed" },
        }),
      ),
    ).toEqual({ sessionId: "s-1", sequence: 2, commandId: "c-1", status: "completed" });
    expect(
      sessionEventFields(
        event(3, {
          kind: "attention.raised",
          attention: { id: "at-1", kind: "rate_limited", message: "m" },
        }),
      ),
    ).toEqual({ sessionId: "s-1", sequence: 3, attentionId: "at-1", attention: "rate_limited" });
    expect(
      sessionEventFields(
        event(4, {
          kind: "session.created",
          session: { projectId: "p-1", ticketId: "tk-1", role: "ticket", title: "private" },
        }),
      ),
    ).toEqual({
      sessionId: "s-1",
      sequence: 4,
      projectId: "p-1",
      ticketId: "tk-1",
      role: "ticket",
    });
    expect(
      sessionEventFields(
        event(5, {
          kind: "session.created",
          session: { projectId: "p-1", ticketId: null, role: "project" },
        }),
      ),
    ).toEqual({ sessionId: "s-1", sequence: 5, projectId: "p-1", role: "project" });
    expect(
      sessionEventFields(event(6, { kind: "attachment.opened", attachment: { id: "a-2" } })),
    ).toEqual({
      sessionId: "s-1",
      sequence: 6,
      attachmentId: "a-2",
    });
    expect(
      sessionEventFields(
        event(7, { kind: "interaction.opened", interaction: { id: "i-1", title: "t" } }),
      ),
    ).toEqual({
      sessionId: "s-1",
      sequence: 7,
      interactionId: "i-1",
    });
    expect(
      sessionEventFields(event(8, { kind: "attachment.exited", attachmentId: "a-3", exitCode: 1 })),
    ).toEqual({
      sessionId: "s-1",
      sequence: 8,
      attachmentId: "a-3",
      exitCode: 1,
    });
  });
});
