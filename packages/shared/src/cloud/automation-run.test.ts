import { describe, expect, test } from "vite-plus/test";

import { automationRunStart, automationRunVerdict } from "./automation-run";
import type { AutomationRunContext, CloudAutomationDefinition } from "./automations";
import { parseId } from "./ids";
import type { AutomationRunJobPayload } from "./job-payloads";

const automationId = parseId("automation", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
const otherAutomation = parseId("automation", "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee");
const projectId = parseId("project", "11111111-2222-4333-8444-555555555555");
const otherProject = parseId("project", "22222222-2222-4333-8444-555555555555");
const ticketId = parseId("ticket", "66666666-2222-4333-8444-555555555555");
const otherTicket = parseId("ticket", "77777777-2222-4333-8444-555555555555");
const userId = parseId("user", "99999999-8888-4777-8666-555555555555");
const runnerId = parseId("runner", "33333333-2222-4333-8444-555555555555");
const otherRunner = parseId("runner", "44444444-2222-4333-8444-555555555555");
const sessionId = parseId("session", "55555555-2222-4333-8444-555555555555");
const runId = "12121212-2222-4333-8444-555555555555";

const definition: CloudAutomationDefinition = {
  id: automationId,
  projectId,
  name: "Review",
  instructions: "Review the work",
  trigger: { kind: "columns", columns: ["doing"] },
  runtime: null,
  deletedAt: null,
};
const scheduled: CloudAutomationDefinition = {
  ...definition,
  trigger: {
    kind: "schedule",
    schedule: { preset: "daily", hour: 9, minute: 30, timeZone: "UTC" },
  },
};
const base = {
  runId,
  sessionId,
  dueAt: 1_000,
  missedCount: 0,
  attendance: "unattended",
  modelOverride: null,
  requestedBySessionId: null,
} as const;
const arrival: AutomationRunJobPayload = {
  ...base,
  trigger: "arrival",
  automationId,
  ticketId,
  from: "todo",
  status: "doing",
  origin: "armed",
  armedByUserId: userId,
};
const schedule: AutomationRunJobPayload = {
  ...base,
  trigger: "schedule",
  automationId,
  ticketId: null,
  armedByUserId: userId,
};
const manual: AutomationRunJobPayload = {
  ...base,
  attendance: "attended",
  trigger: "manual",
  automationId,
  ticketId,
  armedByUserId: null,
};
const unbound: AutomationRunJobPayload = {
  ...base,
  trigger: "manual",
  automationId: null,
  ticketId,
  armedByUserId: null,
  instructions: "Tidy the README",
};
const ticket = { id: ticketId, projectId, status: "doing" as const, archived: false };
const arming = { automationId, runnerId, pausedAt: null };

type Ready = Extract<AutomationRunContext, { kind: "ready" }>;
function context(payload: AutomationRunJobPayload, overrides: Partial<Ready> = {}): Ready {
  return {
    kind: "ready",
    payload,
    projectId,
    automation: payload.trigger === "schedule" ? scheduled : definition,
    ticket: payload.ticketId === null ? null : ticket,
    columnArming: arming,
    scheduleArming: arming,
    previousRunActive: false,
    ...overrides,
  };
}
const verdict = (payload: AutomationRunJobPayload, overrides: Partial<Ready> = {}) =>
  automationRunVerdict({ payload, context: context(payload, overrides), runnerId });
const abandon = (reason: string) => ({ kind: "abandon", reason });

describe("automationRunVerdict", () => {
  test("starts a still-armed arrival with the record's Instructions and Runtime", () => {
    expect(verdict(arrival)).toEqual({
      kind: "start",
      projectId,
      ticketId,
      automationName: "Review",
      instructions: "Review the work",
      runtime: null,
    });
  });

  test("refuses a context the backend read for another Run", () => {
    for (const other of [
      { ...arrival, runId: "13131313-2222-4333-8444-555555555555" },
      { ...arrival, sessionId: parseId("session", "56565656-2222-4333-8444-555555555555") },
      schedule,
    ])
      expect(
        automationRunVerdict({ payload: arrival, context: context(other), runnerId }),
      ).toMatchObject({ kind: "refuse", code: "context_mismatch" });
  });

  test.each([
    ["deleted", { automation: null }],
    ["soft-deleted", { automation: { ...definition, deletedAt: 5 } }],
    ["another Automation", { automation: { ...definition, id: otherAutomation } }],
    ["moved project", { automation: { ...definition, projectId: otherProject } }],
    ["no ticket", { ticket: null }],
    ["archived ticket", { ticket: { ...ticket, archived: true } }],
    ["another ticket", { ticket: { ...ticket, id: otherTicket } }],
    ["ticket in another project", { ticket: { ...ticket, projectId: otherProject } }],
  ] satisfies [string, Partial<Ready>][])("abandons as gone: %s", (_name, overrides) => {
    expect(verdict(arrival, overrides)).toEqual(abandon("gone"));
    expect(verdict(manual, overrides)).toEqual(abandon("gone"));
  });

  test("an arrival whose ticket left the column is skipped, armed or picked", () => {
    const moved = { ticket: { ...ticket, status: "needs_review" as const } };
    expect(verdict(arrival, moved)).toEqual(abandon("left-column"));
    expect(verdict({ ...arrival, origin: "chosen", armedByUserId: null }, moved)).toEqual(
      abandon("left-column"),
    );
  });

  test.each([
    ["disarmed", { columnArming: null }],
    [
      "re-armed with another Automation",
      { columnArming: { ...arming, automationId: otherAutomation } },
    ],
    ["re-armed on another runner", { columnArming: { ...arming, runnerId: otherRunner } }],
    ["paused", { columnArming: { ...arming, pausedAt: 9 } }],
    [
      "no longer triggered by that column",
      { automation: { ...definition, trigger: { kind: "columns", columns: ["done"] } } },
    ],
  ] satisfies [string, Partial<Ready>][])("an armed arrival is abandoned: %s", (_n, overrides) => {
    expect(verdict(arrival, overrides)).toEqual(abandon("disarmed"));
  });

  test("a pick needs only its ticket still in the column", () => {
    const picked: AutomationRunJobPayload = { ...arrival, origin: "chosen", armedByUserId: null };
    expect(verdict(picked, { columnArming: null })).toMatchObject({ kind: "start" });
  });

  test.each([
    ["disarmed", { scheduleArming: null }],
    ["another Automation", { scheduleArming: { ...arming, automationId: otherAutomation } }],
    ["another runner", { scheduleArming: { ...arming, runnerId: otherRunner } }],
    ["paused", { scheduleArming: { ...arming, pausedAt: 9 } }],
    ["trigger changed", { automation: definition }],
  ] satisfies [string, Partial<Ready>][])("a schedule Run is abandoned: %s", (_n, overrides) => {
    expect(verdict(schedule, overrides)).toEqual(abandon("schedule-disarmed"));
  });

  test("a schedule Run opens a project Run on the record", () => {
    expect(verdict(schedule)).toEqual({
      kind: "start",
      projectId,
      ticketId: null,
      automationName: "Review",
      instructions: "Review the work",
      runtime: null,
    });
  });

  test("a previous Run still working skips this one, after the target checks", () => {
    for (const payload of [arrival, schedule, manual])
      expect(verdict(payload, { previousRunActive: true })).toEqual(abandon("previous_run_active"));
    expect(verdict(arrival, { previousRunActive: true, columnArming: null })).toEqual(
      abandon("disarmed"),
    );
  });

  test("an invalid saved Runtime refuses, even under an invocation override", () => {
    const invalid = {
      automation: { ...definition, runtime: { kind: "invalid" as const, raw: "x" } },
    };
    expect(verdict(manual, invalid)).toMatchObject({ kind: "refuse", code: "invalid_runtime" });
    expect(
      verdict(
        {
          ...manual,
          modelOverride: { providerId: "p", modelId: "m", reasoningLevel: "low" },
        },
        invalid,
      ),
    ).toMatchObject({ kind: "refuse", code: "invalid_runtime" });
  });

  test("the invocation's override wins over the record's Runtime", () => {
    const pin = { providerId: "p", modelId: "m", reasoningLevel: "high" as const };
    const tier = { kind: "tier" as const, tier: "deep" as const };
    expect(
      verdict({ ...manual, modelOverride: pin }, { automation: { ...definition, runtime: tier } }),
    ).toMatchObject({ kind: "start", runtime: pin });
    expect(verdict(manual, { automation: { ...definition, runtime: tier } })).toMatchObject({
      kind: "start",
      runtime: tier,
    });
  });

  test("an Unbound Run carries its own text and inherits unless overridden", () => {
    expect(verdict(unbound, { automation: null, columnArming: null })).toEqual({
      kind: "start",
      projectId,
      ticketId,
      automationName: null,
      instructions: "Tidy the README",
      runtime: null,
    });
    // A context naming an Automation cannot rename an Unbound Run.
    expect(verdict(unbound)).toMatchObject({ automationName: null });
  });
});

describe("automationRunStart", () => {
  test("reads a resumed Run's Instructions whatever its target's state", () => {
    const moved = context(arrival, {
      ticket: { ...ticket, status: "done" },
      columnArming: null,
      previousRunActive: true,
    });
    expect(automationRunStart({ payload: arrival, context: moved })).toMatchObject({
      kind: "start",
      instructions: "Review the work",
    });
    expect(
      automationRunStart({ payload: unbound, context: context(unbound, { automation: null }) }),
    ).toMatchObject({ kind: "start", instructions: "Tidy the README", automationName: null });
  });

  test("refuses a Run with no Instructions left, a broken Runtime or another Run's context", () => {
    expect(
      automationRunStart({ payload: arrival, context: context(arrival, { automation: null }) }),
    ).toMatchObject({ kind: "refuse", code: "gone" });
    expect(
      automationRunStart({
        payload: arrival,
        context: context(arrival, {
          automation: { ...definition, runtime: { kind: "invalid", raw: "x" } },
        }),
      }),
    ).toMatchObject({ kind: "refuse", code: "invalid_runtime" });
    expect(automationRunStart({ payload: arrival, context: context(schedule) })).toMatchObject({
      kind: "refuse",
      code: "context_mismatch",
    });
  });
});
