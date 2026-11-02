import { describe, expect, test } from "vite-plus/test";

import { encodeSessionJson } from "../session-event-codec";
import { AUTOMATION_INSTRUCTIONS_MAX_CHARS } from "./automations";
import {
  INVALID_JOB_PAYLOAD,
  InvalidJobPayloadError,
  JOB_PAYLOAD_MAX_CHARS,
  SESSION_COMMAND_FORMAT,
  SESSION_FOLLOW_UP_FORMAT,
  SESSION_INTERRUPT_FORMAT,
  SESSION_NOTICE_FORMAT,
  SESSION_START_FORMAT,
  parseJobPayload,
  isExecutableAutomationRun,
} from "./job-payloads";
import { JOB_KINDS, type JobKind } from "./jobs";

const TICKET = "6f1c2a4e-8b3d-4c5e-9f60-718293a4b5c6";
const COPY = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const SESSION = "11111111-2222-4333-8444-555555555555";
const AUTOMATION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const USER = "99999999-8888-4777-8666-555555555555";

const message = encodeSessionJson({
  kind: "message.submit",
  reference: { id: "message-1", mediaType: "application/json", digest: null },
});

/** One valid payload per typed kind. */
const VALID: Partial<Record<JobKind, Record<string, unknown>>> = {
  "workingCopy.materialize": { ticketId: TICKET, reason: "checkout_mode_changed" },
  "workingCopy.trim": { ticketId: TICKET, workingCopyId: COPY, reason: "done" },
  "workingCopy.reclaim": { ticketId: TICKET, workingCopyId: COPY, reason: "retention" },
  "session.command": {
    format: SESSION_COMMAND_FORMAT,
    intent: encodeSessionJson({ kind: "session.retitle", title: "New" }),
  },
  "session.followUp": { format: SESSION_FOLLOW_UP_FORMAT, intent: message },
  "session.delegate": {
    parentSessionId: SESSION,
    toolCallId: "call-1",
    createCommandId: "op-1:create",
    depth: 1,
    kickoff: { id: "message-1", mediaType: "text/markdown", digest: null },
    title: "Review the diff",
    model: { providerId: "anthropic", modelId: "claude", reasoningLevel: null },
  },
  "session.start": {
    format: SESSION_START_FORMAT,
    projectId: USER,
    ticketId: TICKET,
    title: "Fix the flaky test",
    firstMessage: {
      commandId: COPY,
      body: {
        id: `sha256:${"a".repeat(64)}`,
        mediaType: "application/vnd.volli.ui-message+json",
        digest: `sha256:${"a".repeat(64)}`,
      },
    },
    model: { providerId: "anthropic", modelId: "claude", reasoningLevel: "high" },
  },
  "session.notice": {
    format: SESSION_NOTICE_FORMAT,
    notice: "watch",
    commandId: `watch:${SESSION}:${COPY}`,
    changes: [],
    overflow: 0,
  },
  "automation.run": {
    trigger: "arrival",
    automationId: AUTOMATION,
    ticketId: TICKET,
    from: "todo",
    status: "doing",
    origin: "armed",
    armedByUserId: USER,
  },
};

function refusal(kind: JobKind, value: unknown): string {
  try {
    parseJobPayload(kind, value);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidJobPayloadError);
    expect((error as InvalidJobPayloadError).code).toBe(INVALID_JOB_PAYLOAD);
    return (error as Error).message;
  }
  throw new Error(`${kind} accepted ${JSON.stringify(value)}`);
}

describe("parseJobPayload", () => {
  test("accepts a valid payload for every typed kind, unchanged", () => {
    for (const [kind, payload] of Object.entries(VALID)) {
      expect(parseJobPayload(kind as JobKind, payload)).toEqual(payload);
    }
  });

  test("accepts any JSON object for the kinds no ticket has typed yet", () => {
    const opaque = JOB_KINDS.filter((kind) => VALID[kind] === undefined);
    expect(opaque).toEqual(["session.release", "workingCopy.refresh", "environment.run"]);
    for (const kind of opaque) {
      expect(parseJobPayload(kind, { anything: [1, "two"] })).toEqual({ anything: [1, "two"] });
      expect(parseJobPayload(kind, Object.create(null))).toEqual({});
    }
  });

  test("refuses what is not a bounded JSON object", () => {
    for (const value of [null, "text", 3, []]) {
      expect(refusal("session.start", value)).toMatch(/not a JSON object/);
    }
    for (const value of [new Date(0), { big: 1n }, { bytes: new ArrayBuffer(8) }]) {
      expect(refusal("session.start", value)).toMatch(/not plain JSON/);
    }
    expect(refusal("session.start", { body: "x".repeat(JOB_PAYLOAD_MAX_CHARS) })).toMatch(
      /larger than 65536 characters/,
    );
  });

  test("reads a session.start: a Board Session, the runner's default model, no title", () => {
    const start = VALID["session.start"]!;
    const board = { ...start, ticketId: null, title: null, model: null };
    expect(parseJobPayload("session.start", board)).toEqual(board);
    const level = { ...start, model: { providerId: "a", modelId: "b", reasoningLevel: null } };
    expect(parseJobPayload("session.start", level)).toEqual(level);
    expect(refusal("session.start", { ...start, format: "volli.session-start.v2" })).toMatch(
      /format is not one of volli.session-start.v1/,
    );
    expect(refusal("session.start", { ...start, sessionId: SESSION })).toMatch(
      /unexpected field "sessionId"/,
    );
    expect(
      refusal("session.start", {
        ...start,
        firstMessage: { commandId: "cmd-1", body: start.firstMessage },
      }),
    ).toMatch(/firstMessage.commandId is not a UUID/);
    expect(
      refusal("session.start", {
        ...start,
        firstMessage: { ...(start.firstMessage as object), body: { id: "" } },
      }),
    ).toMatch(/firstMessage.body.id is not a non-empty id/);
    expect(
      refusal("session.start", {
        ...start,
        model: { providerId: "a", modelId: "b", reasoningLevel: "max-plus" },
      }),
    ).toMatch(/model.reasoningLevel is not one of/);
    expect(refusal("session.start", { ...start, projectId: "p-1" })).toMatch(
      /projectId is not a UUID/,
    );
  });

  test("refuses extra fields on typed kinds: writers are closed", () => {
    expect(
      refusal("workingCopy.trim", { ...VALID["workingCopy.trim"], path: "/Users/me/repo" }),
    ).toMatch(/unexpected field "path"/);
  });

  test("checks ids, enums and integers", () => {
    expect(
      refusal("workingCopy.materialize", { ticketId: "T-1", reason: "session_start" }),
    ).toMatch(/ticketId is not a UUID/);
    expect(refusal("workingCopy.materialize", { ticketId: TICKET, reason: "whim" })).toMatch(
      /reason is not one of checkout_mode_changed, session_start/,
    );
    expect(
      refusal("workingCopy.reclaim", { ticketId: TICKET, workingCopyId: COPY, reason: 1 }),
    ).toMatch(/reason is not one of/);
    const delegate = VALID["session.delegate"]!;
    expect(refusal("session.delegate", { ...delegate, toolCallId: "" })).toMatch(
      /toolCallId is not a non-empty id/,
    );
    expect(parseJobPayload("session.delegate", { ...delegate, title: null, model: null })).toEqual({
      ...delegate,
      title: null,
      model: null,
    });
    expect(refusal("session.delegate", { ...delegate, kickoff: "message-1" })).toMatch(
      /kickoff is not an object/,
    );
    expect(
      refusal("session.delegate", {
        ...delegate,
        kickoff: { id: "", mediaType: null, digest: null },
      }),
    ).toMatch(/kickoff\.id is not a non-empty id/);
    expect(
      refusal("session.delegate", {
        ...delegate,
        model: { providerId: "", modelId: "m", reasoningLevel: null },
      }),
    ).toMatch(/model\.providerId is not text of 1 to 200 characters/);
    expect(refusal("session.delegate", { ...delegate, title: "x".repeat(201) })).toMatch(
      /title is not text/,
    );
    for (const depth of [0, 1.5, "1"]) {
      expect(refusal("session.delegate", { ...delegate, depth })).toMatch(
        /depth is not a positive integer/,
      );
    }
  });

  test("session.command carries an encoded intent, never a create", () => {
    expect(
      refusal("session.command", { format: SESSION_COMMAND_FORMAT, intent: { kind: "x" } }),
    ).toMatch(/intent is not encoded JSON text/);
    expect(refusal("session.command", { format: SESSION_COMMAND_FORMAT, intent: "{" })).toMatch(
      /intent is not JSON/,
    );
    for (const intent of ["null", "[]", JSON.stringify({ kind: "" })]) {
      expect(refusal("session.command", { format: SESSION_COMMAND_FORMAT, intent })).toMatch(
        /intent is not a Session command intent/,
      );
    }
    const create = encodeSessionJson({
      kind: "session.create",
      projectId: "p",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: null,
    });
    expect(refusal("session.command", { format: SESSION_COMMAND_FORMAT, intent: create })).toMatch(
      /intent creates a Session; use session.start/,
    );
    expect(
      refusal("session.command", { format: "volli.session-command/2", intent: message }),
    ).toMatch(/format is not one of/);
  });

  test("session.command also carries the board's interrupt", () => {
    const interrupt = {
      format: SESSION_INTERRUPT_FORMAT,
      reason: "ticket_left_active_columns",
      from: "doing",
      to: "done",
    };
    expect(parseJobPayload("session.command", interrupt)).toEqual(interrupt);
    expect(refusal("session.command", { ...interrupt, to: "shipped" })).toMatch(/to is not one of/);
    expect(refusal("session.command", { ...interrupt, intent: message })).toMatch(
      /unexpected field "intent"/,
    );
  });

  test("a follow-up is a message, nothing else", () => {
    const retitle = encodeSessionJson({ kind: "session.retitle", title: null });
    expect(
      refusal("session.followUp", { format: SESSION_FOLLOW_UP_FORMAT, intent: retitle }),
    ).toMatch(/intent is not message.submit/);
    expect(
      refusal("session.followUp", { format: SESSION_COMMAND_FORMAT, intent: message }),
    ).toMatch(/format is not one of/);
  });

  test("an armed arrival names its armer; a pick may run as the armer's or the picker's", () => {
    const armed = VALID["automation.run"]!;
    const chosen = { ...armed, origin: "chosen", armedByUserId: null };
    expect(parseJobPayload("automation.run", chosen)).toEqual(chosen);
    expect(refusal("automation.run", { ...armed, armedByUserId: null })).toMatch(
      /an armed run names its armer/,
    );
    expect(parseJobPayload("automation.run", { ...chosen, armedByUserId: USER })).toEqual({
      ...chosen,
      armedByUserId: USER,
    });
    expect(refusal("automation.run", { ...armed, armedByUserId: "me" })).toMatch(
      /armedByUserId is not a UUID/,
    );
    expect(refusal("automation.run", { ...armed, trigger: "future" })).toMatch(
      /trigger is not one of arrival, schedule, manual/,
    );
  });
});

const runMeta = {
  runId: COPY,
  sessionId: SESSION,
  dueAt: 123,
  missedCount: 0,
  attendance: "unattended",
  modelOverride: null,
  requestedBySessionId: null,
};
const scheduled = {
  ...runMeta,
  trigger: "schedule",
  automationId: AUTOMATION,
  ticketId: null,
  armedByUserId: USER,
};
const manual = {
  ...runMeta,
  trigger: "manual",
  automationId: AUTOMATION,
  ticketId: TICKET,
  armedByUserId: null,
};
const unbound = { ...manual, automationId: null, instructions: "Review this" };

describe("executable Automation job contract", () => {
  test("legacy arrivals are readable but not executable", () => {
    expect(
      isExecutableAutomationRun(parseJobPayload("automation.run", VALID["automation.run"])),
    ).toBe(false);
  });

  test("escaped instructions still obey the whole serialized payload bound", () => {
    expect(
      refusal("automation.run", {
        ...unbound,
        instructions: "\u0000".repeat(AUTOMATION_INSTRUCTIONS_MAX_CHARS),
      }),
    ).toMatch(/larger than 65536 characters/);
  });

  test.each([
    { ...VALID["automation.run"], ...runMeta },
    scheduled,
    manual,
    { ...manual, ticketId: null, attendance: "attended" },
    {
      ...manual,
      requestedBySessionId: SESSION,
      modelOverride: { providerId: "p", modelId: "m", reasoningLevel: "high" },
    },
    unbound,
    { ...unbound, instructions: "x".repeat(AUTOMATION_INSTRUCTIONS_MAX_CHARS) },
  ])("round-trips complete identities and each trigger through JSON", (payload) => {
    const parsed = parseJobPayload("automation.run", JSON.parse(JSON.stringify(payload)));
    expect(parsed).toEqual(payload);
    expect(isExecutableAutomationRun(parsed)).toBe(true);
  });

  test.each([
    [scheduled, { runId: "bad" }],
    [scheduled, { sessionId: "bad" }],
    [scheduled, { dueAt: -1 }],
    [scheduled, { missedCount: 0.5 }],
    [scheduled, { attendance: "future" }],
    [scheduled, { requestedBySessionId: "bad" }],
    [scheduled, { ticketId: TICKET }],
    [scheduled, { armedByUserId: null }],
    [scheduled, { attendance: "attended" }],
    [scheduled, { requestedBySessionId: SESSION }],
    [scheduled, { modelOverride: { providerId: "p", modelId: "m", reasoningLevel: "high" } }],
    [manual, { armedByUserId: USER }],
    [manual, { modelOverride: { providerId: "", modelId: "m", reasoningLevel: "high" } }],
    [manual, { modelOverride: { providerId: "p", modelId: "m", reasoningLevel: "unknown" } }],
    [
      manual,
      { modelOverride: { providerId: "p", modelId: "m", reasoningLevel: "high", secret: "never" } },
    ],
    [manual, { instructions: "not allowed on a bound Run" }],
    [unbound, { instructions: " " }],
    [unbound, { instructions: "x".repeat(AUTOMATION_INSTRUCTIONS_MAX_CHARS + 1) }],
    [unbound, { ticketId: null }],
    [unbound, { status: "doing" }],
    [unbound, { extra: "closed" }],
    [VALID["automation.run"]!, { sessionId: SESSION }],
    [VALID["automation.run"]!, { runId: COPY }],
  ])("refuses malformed or cross-trigger fields", (payload, patch) => {
    expect(() => parseJobPayload("automation.run", { ...payload, ...patch })).toThrow(
      InvalidJobPayloadError,
    );
  });
});
