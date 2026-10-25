import { describe, expect, it } from "vite-plus/test";
import {
  RECOVERED_TURN_INTERRUPTED_DETAIL,
  restartResumeCommandId,
  type ScheduledResumeSibling,
  type SessionCommand,
  type SessionCommandIntent,
} from "@volli/shared";

import { restartResumeVerdict, type RestartResumeVerdictInput } from "./restart-resume";

const TWELVE_HOURS = 12 * 60 * 60 * 1000;

const ATTACHMENT = "attachment-1";
const LOST_AT = 1_000;

const session = {
  id: "session-1",
  projectId: "project-1",
  ticketId: "ticket-1",
  role: "ticket" as const,
  parentSessionId: null,
  title: null,
  createdAt: 0,
};

function command(id: string, createdAt: number, intent: SessionCommandIntent): SessionCommand {
  return { id, sessionId: session.id, createdAt, intent, route: null };
}

const warning = {
  id: "pi:attention:attachment-1:partial-turn",
  kind: "partial_turn_interrupted" as const,
  attachmentId: ATTACHMENT,
  detail: RECOVERED_TURN_INTERRUPTED_DETAIL,
  diagnostic: null,
};

const message = (id: string, createdAt: number) =>
  command(id, createdAt, {
    kind: "message.submit",
    reference: { id, mediaType: null, digest: null },
  });

type Projection = RestartResumeVerdictInput["projection"];

function input(
  projection: Partial<Projection> = {},
  rest: Partial<Omit<RestartResumeVerdictInput, "projection">> = {},
): RestartResumeVerdictInput {
  return {
    projection: {
      session,
      status: "open",
      stopped: null,
      liveExecutor: { id: ATTACHMENT } as Projection["liveExecutor"],
      turnActive: false,
      latestTurnId: "turn-1",
      lastTurnOutcome: "interrupted",
      attention: { active: [warning] },
      commands: [message("m", 500)],
      receipts: [],
      ...projection,
    },
    attachmentId: ATTACHMENT,
    lostAt: LOST_AT,
    now: LOST_AT + 5_000,
    startPending: false,
    boundary: "settled",
    ticketSessions: [],
    ...rest,
  };
}

function sibling(overrides: Partial<ScheduledResumeSibling> = {}): ScheduledResumeSibling {
  return {
    session: { ...session, id: "session-2" },
    turnActive: false,
    commands: [],
    receipts: [],
    ...overrides,
  };
}

const skip = (reason: string) => ({ kind: "skip", reason });

describe("restartResumeVerdict (VC-450)", () => {
  it("resumes a settled, still-wanted interrupted turn under its frozen command", () => {
    expect(restartResumeVerdict(input())).toEqual({
      kind: "resume",
      sessionId: session.id,
      attachmentId: ATTACHMENT,
      commandId: restartResumeCommandId(ATTACHMENT, "turn-1"),
    });
    // A sibling that was itself only ever this Session is no reason to skip.
    expect(
      restartResumeVerdict(input({}, { ticketSessions: [{ ...sibling(), session }] })),
    ).toMatchObject({ kind: "resume" });
  });

  // VC-889 (B4 D9): a launch showing Volli Cloud leaves this Mac's Sessions be.
  it("leaves every turn for a launch that shows this Mac's board", () => {
    expect(restartResumeVerdict(input({}, { cloudLaunch: true }))).toEqual(skip("cloud-launch"));
    expect(restartResumeVerdict(input({}, { cloudLaunch: false }))).toMatchObject({
      kind: "resume",
    });
  });

  it("has nothing to resume into once the Session ended or moved off the attachment", () => {
    expect(restartResumeVerdict(input({ status: "archived" }))).toEqual(skip("ended"));
    expect(
      restartResumeVerdict(input({ stopped: { at: 1, reason: null, by: { kind: "user" } } })),
    ).toEqual(skip("ended"));
    expect(restartResumeVerdict(input({ liveExecutor: null }))).toEqual(skip("ended"));
  });

  it("leaves a turn that is running, or about to, alone", () => {
    expect(restartResumeVerdict(input({ turnActive: true }))).toEqual(skip("running"));
    expect(restartResumeVerdict(input({}, { startPending: true }))).toEqual(skip("running"));
  });

  it("only continues an interrupted latest turn", () => {
    expect(restartResumeVerdict(input({ latestTurnId: null }))).toEqual(skip("not-interrupted"));
    expect(restartResumeVerdict(input({ lastTurnOutcome: "completed" }))).toEqual(
      skip("not-interrupted"),
    );
  });

  it("continues only the plain process-loss warning, never a diagnosis", () => {
    expect(restartResumeVerdict(input({ attention: { active: [] } }))).toEqual(
      skip("not-a-process-loss"),
    );
    expect(
      restartResumeVerdict(
        input({ attention: { active: [{ ...warning, detail: "History disagreed." }] } }),
      ),
    ).toEqual(skip("not-a-process-loss"));
  });

  it("honours a Stop the lost process never carried out", () => {
    const interrupt = command("i", 600, { kind: "executor.interrupt", attachmentId: ATTACHMENT });
    expect(restartResumeVerdict(input({ commands: [message("m", 500), interrupt] }))).toEqual(
      skip("stopped"),
    );
    // A refused Stop stopped nothing; bookkeeping after the start is no act.
    expect(
      restartResumeVerdict(
        input({
          commands: [
            message("m", 500),
            interrupt,
            command("t", 700, { kind: "session.retitle", title: "x" }),
          ],
          receipts: [
            {
              id: "r",
              commandId: "i",
              sequence: 1,
              recordedAt: 600,
              status: "rejected",
              code: "nope",
              detail: null,
            },
          ],
        }),
      ),
    ).toMatchObject({ kind: "resume" });
  });

  it("makes one automatic attempt per interruption, never a loop", () => {
    const resumed = command(restartResumeCommandId(ATTACHMENT, "turn-0"), 600, {
      kind: "executor.retry",
      attachmentId: ATTACHMENT,
    });
    expect(restartResumeVerdict(input({ commands: [message("m", 500), resumed] }))).toEqual(
      skip("already-resumed"),
    );
    // A person's retry after it is theirs to have lost again.
    const retry = command("r", 700, { kind: "executor.retry", attachmentId: ATTACHMENT });
    expect(
      restartResumeVerdict(input({ commands: [message("m", 500), resumed, retry] })),
    ).toMatchObject({ kind: "resume" });
    // Nothing on record at all is no act either way.
    expect(restartResumeVerdict(input({ commands: [] }))).toMatchObject({ kind: "resume" });
  });

  it("skips a Session the person picked up after the loss", () => {
    expect(
      restartResumeVerdict(input({ commands: [message("m", 500), message("later", 2_000)] })),
    ).toEqual(skip("continued"));
  });

  it("skips a Session another on its Ticket moved past after the loss", () => {
    expect(
      restartResumeVerdict(
        input({}, { ticketSessions: [sibling({ commands: [message("s", 2_000)] })] }),
      ),
    ).toEqual(skip("superseded"));
    // Input there before the loss is not moving past it.
    expect(
      restartResumeVerdict(
        input({}, { ticketSessions: [sibling({ commands: [message("s", 500)] })] }),
      ),
    ).toMatchObject({ kind: "resume" });
  });

  it("leaves a loss too long ago, or at an unknown time, for the person", () => {
    expect(restartResumeVerdict(input({}, { lostAt: null }))).toEqual(skip("loss-unknown"));
    expect(restartResumeVerdict(input({}, { now: LOST_AT + TWELVE_HOURS + 1 }))).toEqual(
      skip("expired"),
    );
    expect(restartResumeVerdict(input({}, { now: LOST_AT + TWELVE_HOURS }))).toMatchObject({
      kind: "resume",
    });
  });

  it("never guesses about a tool in flight, or a boundary the executor cannot state", () => {
    expect(restartResumeVerdict(input({}, { boundary: "tool-in-flight" }))).toEqual(
      skip("tool-in-flight"),
    );
    expect(restartResumeVerdict(input({}, { boundary: "none" }))).toEqual(
      skip("nothing-to-continue"),
    );
    expect(restartResumeVerdict(input({}, { boundary: null }))).toEqual(
      skip("nothing-to-continue"),
    );
  });
});
