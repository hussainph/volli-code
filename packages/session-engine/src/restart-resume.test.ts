import { describe, expect, it } from "vite-plus/test";
import {
  restartResumeCommandId,
  type ScheduledResumeSibling,
  type SessionCommand,
  type SessionCommandIntent,
} from "@volli/shared";

import {
  RESTART_RESUME_MAX_AGE_MS,
  restartResumeVerdict,
  type RestartResumeVerdictInput,
} from "./restart-resume";

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
      latestTurnOrigin: { kind: "user" },
      lastTurnOutcome: "interrupted",
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

  it("makes one automatic attempt per interruption, never a loop", () => {
    expect(
      restartResumeVerdict(
        input({ latestTurnOrigin: { kind: "volli", reason: "relaunch-recovery" } }),
      ),
    ).toEqual(skip("already-resumed"));
    // Another host origin is not a restart resume.
    expect(
      restartResumeVerdict(input({ latestTurnOrigin: { kind: "volli", reason: "watch-notice" } })),
    ).toMatchObject({ kind: "resume" });
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

  it("leaves a loss too long ago for the person", () => {
    expect(
      restartResumeVerdict(input({}, { now: LOST_AT + RESTART_RESUME_MAX_AGE_MS + 1 })),
    ).toEqual(skip("expired"));
    expect(
      restartResumeVerdict(input({}, { now: LOST_AT + RESTART_RESUME_MAX_AGE_MS })),
    ).toMatchObject({ kind: "resume" });
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
