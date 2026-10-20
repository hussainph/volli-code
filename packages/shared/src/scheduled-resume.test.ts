import { describe, expect, it } from "vite-plus/test";

import {
  attentionResumeAt,
  pendingScheduledResume,
  presentedScheduledResume,
  SCHEDULED_RESUME_GRACE_MS,
  scheduledResumeFireAt,
  scheduledResumeRetryCommandId,
  scheduledResumeSettleCommandId,
  scheduledResumeVerdict,
  type ScheduledResumeSibling,
} from "./scheduled-resume";
import type {
  CommandReceipt,
  SessionAttachmentProjection,
  SessionCommand,
  SessionCommandIntent,
  SessionProjection,
} from "./session-ledger";

const SESSION_ID = "session-1";
const ATTACHMENT_ID = "attachment-1";
const RESET = 10_000;

const attachment: SessionAttachmentProjection = {
  id: ATTACHMENT_ID,
  sessionId: SESSION_ID,
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

type Row = { command: SessionCommand; receipt: CommandReceipt | null };

function row(
  id: string,
  createdAt: number,
  intent: SessionCommandIntent,
  status: "completed" | "rejected" | "accepted" | null = "completed",
): Row {
  const command: SessionCommand = { id, sessionId: SESSION_ID, createdAt, intent, route: null };
  const base = { id: `receipt-${id}`, commandId: id, sequence: createdAt, recordedAt: createdAt };
  const receipt: CommandReceipt | null =
    status === null
      ? null
      : status === "rejected"
        ? { ...base, status, code: "nope", detail: "Refused." }
        : status === "accepted"
          ? {
              ...base,
              status,
              acceptedAt: createdAt,
              result: { kind: "executor.retried", sessionId: SESSION_ID },
            }
          : { ...base, status, result: { kind: "resume.scheduled", sessionId: SESSION_ID } };
  return { command, receipt };
}

function schedule(
  id = "schedule-1",
  createdAt = 100,
  status: "completed" | "rejected" = "completed",
): Row {
  return row(
    id,
    createdAt,
    {
      kind: "resume.schedule",
      attentionId: "attention-1",
      attachmentId: ATTACHMENT_ID,
      resumeAt: RESET,
    },
    status,
  );
}

type ProjectionPart = Pick<
  SessionProjection,
  "session" | "commands" | "receipts" | "status" | "stopped" | "liveExecutor"
>;

function projection(rows: readonly Row[], overrides: Partial<ProjectionPart> = {}): ProjectionPart {
  return {
    session: {
      id: SESSION_ID,
      projectId: "project-1",
      ticketId: "ticket-1",
      role: "ticket",
      parentSessionId: null,
      title: "Implementer",
      createdAt: 0,
    },
    commands: rows.map(({ command }) => command),
    receipts: rows.flatMap(({ receipt }) => (receipt === null ? [] : [receipt])),
    status: "open",
    stopped: null,
    liveExecutor: attachment,
    ...overrides,
  };
}

function sibling(
  overrides: Partial<ScheduledResumeSibling> & { id?: string } = {},
): ScheduledResumeSibling {
  const { id = "session-2", ...rest } = overrides;
  return {
    session: { ...projection([]).session, id },
    turnActive: false,
    commands: [],
    receipts: [],
    ...rest,
  };
}

const RETRY_ID = scheduledResumeRetryCommandId("schedule-1");

describe("the frozen command id derivations", () => {
  it("scopes the retry and the settle by the schedule's own id", () => {
    expect(scheduledResumeRetryCommandId("abc")).toBe("abc:resume");
    expect(scheduledResumeSettleCommandId("abc")).toBe("abc:settle");
  });
});

describe("pendingScheduledResume", () => {
  it("reads an accepted schedule, with no retry and nothing after it", () => {
    expect(pendingScheduledResume(projection([schedule()]))).toEqual({
      id: "schedule-1",
      attentionId: "attention-1",
      attachmentId: ATTACHMENT_ID,
      resumeAt: RESET,
      scheduledAt: 100,
      retryCommandId: RETRY_ID,
      fired: false,
      continued: false,
    });
  });

  it("never counts a refused schedule, nor one with no receipt yet", () => {
    expect(pendingScheduledResume(projection([schedule("s", 1, "rejected")]))).toBeNull();
    expect(
      pendingScheduledResume(
        projection([
          row(
            "s",
            1,
            {
              kind: "resume.schedule",
              attentionId: "a",
              attachmentId: ATTACHMENT_ID,
              resumeAt: RESET,
            },
            null,
          ),
        ]),
      ),
    ).toBeNull();
  });

  it("ends a schedule on its accepted cancel or settle, and on nothing else", () => {
    const cancel = row("cancel-1", 200, { kind: "resume.cancel", scheduleId: "schedule-1" });
    const settle = row("settle-1", 200, {
      kind: "resume.settle",
      scheduleId: "schedule-1",
      outcome: { kind: "resumed", retryCommandId: RETRY_ID },
    });
    expect(pendingScheduledResume(projection([schedule(), cancel]))).toBeNull();
    expect(pendingScheduledResume(projection([schedule(), settle]))).toBeNull();
    // A refused cancel, and a cancel naming another schedule, leave it pending.
    const refused = row(
      "cancel-2",
      200,
      { kind: "resume.cancel", scheduleId: "schedule-1" },
      "rejected",
    );
    const other = row("cancel-3", 200, { kind: "resume.cancel", scheduleId: "schedule-0" });
    expect(pendingScheduledResume(projection([schedule(), refused, other]))?.id).toBe("schedule-1");
  });

  it("lets a later schedule replace an earlier one", () => {
    expect(pendingScheduledResume(projection([schedule("schedule-0", 50), schedule()]))?.id).toBe(
      "schedule-1",
    );
  });

  it("knows when its retry was issued, and when the Session was continued by hand", () => {
    const fired = pendingScheduledResume(
      projection([
        schedule(),
        row(RETRY_ID, 200, { kind: "executor.retry", attachmentId: ATTACHMENT_ID }, null),
      ]),
    );
    expect(fired).toMatchObject({ fired: true, continued: false });
    const continued = pendingScheduledResume(
      projection([
        // Before the schedule, so it does not count.
        row("m0", 50, {
          kind: "message.submit",
          reference: { id: "t0", mediaType: null, digest: null },
        }),
        schedule(),
        // Neither of these continues a Session.
        row("rename", 150, { kind: "session.retitle", title: "x" }),
        row("model", 160, {
          kind: "model.select",
          selection: { providerId: "zai", modelId: "glm", reasoningLevel: "high" },
        }),
      ]),
    );
    expect(continued).toMatchObject({ fired: false, continued: false });
    const byHand = pendingScheduledResume(
      projection([
        schedule(),
        row("m1", 200, {
          kind: "message.submit",
          reference: { id: "t1", mediaType: null, digest: null },
        }),
      ]),
    );
    expect(byHand).toMatchObject({ continued: true });
    // A command the engine refused continued nothing.
    const refused = pendingScheduledResume(
      projection([
        schedule(),
        row(
          "m2",
          200,
          { kind: "message.submit", reference: { id: "t2", mediaType: null, digest: null } },
          "rejected",
        ),
      ]),
    );
    expect(refused).toMatchObject({ continued: false });
  });
});

describe("presentedScheduledResume", () => {
  it("draws a schedule that is still going to run", () => {
    expect(presentedScheduledResume(projection([schedule()]))).toEqual({
      id: "schedule-1",
      attentionId: "attention-1",
      resumeAt: RESET,
    });
  });

  it("draws nothing for none, a fired one, a continued one, or an ended Session", () => {
    expect(presentedScheduledResume(projection([]))).toBeNull();
    expect(
      presentedScheduledResume(
        projection([
          schedule(),
          row(RETRY_ID, 200, { kind: "executor.retry", attachmentId: ATTACHMENT_ID }),
        ]),
      ),
    ).toBeNull();
    expect(
      presentedScheduledResume(
        projection([
          schedule(),
          row("i", 200, { kind: "executor.interrupt", attachmentId: ATTACHMENT_ID }),
        ]),
      ),
    ).toBeNull();
    expect(presentedScheduledResume(projection([schedule()], { status: "archived" }))).toBeNull();
    expect(
      presentedScheduledResume(
        projection([schedule()], { stopped: { at: 1, reason: null, by: { kind: "user" } } }),
      ),
    ).toBeNull();
    expect(presentedScheduledResume(projection([schedule()], { liveExecutor: null }))).toBeNull();
  });
});

const FIRE_AT = scheduledResumeFireAt(RESET);

describe("scheduledResumeVerdict", () => {
  const verdict = (
    rows: readonly Row[],
    options: {
      now?: number;
      overrides?: Partial<ProjectionPart>;
      ticketSessions?: readonly ScheduledResumeSibling[];
    } = {},
  ) =>
    scheduledResumeVerdict({
      projection: projection(rows, options.overrides),
      ticketSessions: options.ticketSessions ?? [],
      now: options.now ?? FIRE_AT,
    });

  it("has nothing to say without a pending schedule", () => {
    expect(verdict([])).toBeNull();
  });

  it("waits until the reset, judging nothing early", () => {
    // Already continued by hand — and still only a wait, because the person can
    // still act before the time and the skip is decided then.
    expect(
      verdict(
        [
          schedule(),
          row("m", 200, {
            kind: "message.submit",
            reference: { id: "t", mediaType: null, digest: null },
          }),
        ],
        { now: RESET - 1 },
      ),
    ).toEqual({ kind: "wait", at: FIRE_AT });
  });

  it("fires a grace period after the stated reset, not on it", () => {
    // A clock a few seconds fast would otherwise retry into the spent window.
    expect(FIRE_AT).toBe(RESET + SCHEDULED_RESUME_GRACE_MS);
    expect(verdict([schedule()], { now: RESET })).toEqual({ kind: "wait", at: FIRE_AT });
    expect(verdict([schedule()], { now: FIRE_AT })).toMatchObject({ kind: "resume" });
  });

  it("resumes a due schedule through its frozen retry id", () => {
    expect(
      verdict([schedule()], { ticketSessions: [sibling({ id: SESSION_ID, turnActive: true })] }),
    ).toEqual({
      kind: "resume",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      retryCommandId: RETRY_ID,
    });
  });

  it("settles an already-fired retry from its receipt instead of firing it again", () => {
    // Recorded, then the process died before delivery: nothing says it ran,
    // so it is issued again under the same id, which the engine replays.
    const unanswered = row(
      RETRY_ID,
      200,
      { kind: "executor.retry", attachmentId: ATTACHMENT_ID },
      null,
    );
    expect(verdict([schedule(), unanswered])).toEqual({
      kind: "resume",
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      retryCommandId: RETRY_ID,
    });
    // ...unless the person took the Session back since.
    expect(
      verdict([
        schedule(),
        unanswered,
        row("m", 300, {
          kind: "message.submit",
          reference: { id: "t", mediaType: null, digest: null },
        }),
      ]),
    ).toEqual({ kind: "settle", outcome: { kind: "skipped", reason: "continued", detail: null } });
    expect(
      verdict([
        schedule(),
        row(RETRY_ID, 200, { kind: "executor.retry", attachmentId: ATTACHMENT_ID }, "accepted"),
      ]),
    ).toEqual({ kind: "settle", outcome: { kind: "resumed", retryCommandId: RETRY_ID } });
    expect(
      verdict([
        schedule(),
        row(RETRY_ID, 200, { kind: "executor.retry", attachmentId: ATTACHMENT_ID }, "rejected"),
      ]),
    ).toEqual({
      kind: "settle",
      outcome: { kind: "skipped", reason: "refused", detail: "Refused." },
    });
  });

  it("skips an archived, stopped, or executor-less Session as ended", () => {
    const ended = { kind: "settle", outcome: { kind: "skipped", reason: "ended", detail: null } };
    expect(verdict([schedule()], { overrides: { status: "archived" } })).toEqual(ended);
    expect(
      verdict([schedule()], {
        overrides: { stopped: { at: 1, reason: null, by: { kind: "user" } } },
      }),
    ).toEqual(ended);
    expect(
      verdict([schedule()], { overrides: { liveExecutor: { ...attachment, id: "attachment-2" } } }),
    ).toEqual(ended);
  });

  it("skips a Session the person continued after scheduling", () => {
    expect(
      verdict([schedule(), row("r", 200, { kind: "executor.retry", attachmentId: ATTACHMENT_ID })]),
    ).toEqual({ kind: "settle", outcome: { kind: "skipped", reason: "continued", detail: null } });
  });

  it("skips a Session another on its Ticket has moved past", () => {
    const superseded = {
      kind: "settle",
      outcome: { kind: "skipped", reason: "superseded", detail: null },
    };
    const message = (id: string, createdAt: number): SessionCommand =>
      row(id, createdAt, {
        kind: "message.submit",
        reference: { id, mediaType: null, digest: null },
      }).command;
    // Running a turn right now.
    expect(verdict([schedule()], { ticketSessions: [sibling({ turnActive: true })] })).toEqual(
      superseded,
    );
    // Sent a message, or retried, after the schedule was made.
    expect(
      verdict([schedule()], { ticketSessions: [sibling({ commands: [message("m", 101)] })] }),
    ).toEqual(superseded);
    expect(
      verdict([schedule()], {
        ticketSessions: [
          sibling({
            commands: [row("r", 150, { kind: "executor.retry", attachmentId: "x" }).command],
          }),
        ],
      }),
    ).toEqual(superseded);
    // A refused message moved nothing on.
    expect(
      verdict([schedule()], {
        ticketSessions: [
          sibling({
            commands: [message("m", 101)],
            receipts: [row("m", 101, { kind: "session.retitle", title: "x" }, "rejected").receipt!],
          }),
        ],
      }),
    ).toMatchObject({ kind: "resume" });
    // A sibling resuming on its own schedule — the same spent allowance, the
    // same reset — is not it moving on, and neither is the turn that opened.
    const own = schedule("schedule-9", 90);
    const ownRetry = row(
      scheduledResumeRetryCommandId("schedule-9"),
      FIRE_AT,
      { kind: "executor.retry", attachmentId: "x" },
      "accepted",
    );
    const resuming = sibling({
      turnActive: true,
      commands: [own.command, ownRetry.command],
      receipts: [own.receipt!, ownRetry.receipt!],
    });
    expect(verdict([schedule()], { ticketSessions: [resuming] })).toMatchObject({
      kind: "resume",
    });
    // A person's message there after the schedule still supersedes it.
    expect(
      verdict([schedule()], {
        ticketSessions: [
          { ...resuming, commands: [...resuming.commands, message("m", FIRE_AT + 1)] },
        ],
      }),
    ).toEqual(superseded);
    // Idle siblings whose last word came before the schedule — or was not a
    // turn at all — leave the resume to run.
    expect(
      verdict([schedule()], {
        ticketSessions: [
          sibling({ commands: [message("m", 99)] }),
          sibling({
            id: "session-3",
            commands: [row("t", 500, { kind: "session.retitle", title: "later" }).command],
          }),
        ],
      }),
    ).toMatchObject({ kind: "resume" });
  });
});

describe("attentionResumeAt", () => {
  it("offers a future reset on a stopped run, and nothing else", () => {
    expect(attentionResumeAt({ kind: "adapter_unrecoverable", resetsAt: 5 }, 4)).toBe(5);
    expect(attentionResumeAt({ kind: "adapter_unrecoverable", resetsAt: 5 }, 5)).toBeNull();
    expect(attentionResumeAt({ kind: "adapter_unrecoverable", resetsAt: null }, 0)).toBeNull();
    expect(attentionResumeAt({ kind: "adapter_unrecoverable" }, 0)).toBeNull();
    expect(attentionResumeAt({ kind: "quota_exhausted", resetsAt: 5 }, 0)).toBeNull();
  });
});
