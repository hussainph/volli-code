import { describe, expect, test } from "vite-plus/test";

import type { AutomationTrigger } from "../automation";
import type { AutomationSchedule } from "../automation-schedule";
import {
  AUTOMATION_INSTRUCTIONS_MAX_CHARS,
  AUTOMATION_NAME_MAX_CHARS,
  decideArming,
  decideAutomationChange,
  decideAutomationRunRouting,
  decideScheduleArming,
  decideScheduleFire,
  type AutomationRunner,
  type CloudAutomationDefinition,
  type CloudAutomationSchedule,
  type PendingAutomationScheduleRun,
} from "./automations";
import { parseId } from "./ids";

const automationId = parseId("automation", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
const projectId = parseId("project", "11111111-2222-4333-8444-555555555555");
const otherProject = parseId("project", "22222222-2222-4333-8444-555555555555");
const userId = parseId("user", "99999999-8888-4777-8666-555555555555");
const otherUser = parseId("user", "88888888-8888-4777-8666-555555555555");
const runnerId = parseId("runner", "33333333-2222-4333-8444-555555555555");
const otherRunner = parseId("runner", "44444444-2222-4333-8444-555555555555");
const runner: AutomationRunner = {
  id: runnerId,
  ownerUserId: userId,
  status: "online",
  tools: ["automation.run"],
};
const daily: AutomationSchedule = { preset: "daily", hour: 9, minute: 30, timeZone: "UTC" };
const definition: CloudAutomationDefinition = {
  id: automationId,
  projectId,
  name: "Review",
  instructions: "Review the work",
  trigger: { kind: "columns", columns: ["doing"] },
  runtime: null,
  deletedAt: null,
};
const draft = {
  name: " Review ",
  instructions: "Review the work",
  runtime: null,
  trigger: definition.trigger,
};
const arm = {
  projectId,
  callerUserId: userId,
  canEdit: true,
  automation: definition,
  runner,
  disarm: false,
};
const at = (iso: string) => Date.parse(iso);
const due = at("2026-03-06T09:30:00Z");
const schedule: CloudAutomationSchedule = {
  automationId,
  spec: daily,
  timezone: "UTC",
  nextFireAt: due,
  pausedAt: null,
  automationDeleted: false,
  runnerId,
  runnerStatus: "online",
  armerActive: true,
  gapRunId: null,
};
const pending: PendingAutomationScheduleRun = {
  jobId: "job",
  runId: "run",
  dueAt: due,
  missedCount: 0,
  status: "queued",
  attempt: 0,
};

function change(patch: Partial<Parameters<typeof decideAutomationChange>[0]> = {}) {
  return decideAutomationChange({
    change: "create",
    automationId,
    projectId,
    existing: [],
    draft,
    ...patch,
  });
}

describe("Automation writes", () => {
  test("normalize and reuse local validators for create/update/delete", () => {
    expect(change()).toEqual({ kind: "save", draft: { ...draft, name: "Review" } });
    expect(change({ change: "update", existing: [definition] })).toMatchObject({ kind: "save" });
    expect(change({ change: "delete", existing: [definition] })).toEqual({ kind: "delete" });
    for (const trigger of [
      { kind: "none" },
      { kind: "schedule", schedule: daily },
      { kind: "columns", columns: ["doing", "doing", "future"] },
    ]) {
      expect(change({ draft: { ...draft, trigger } })).toMatchObject({ kind: "save" });
    }
    for (const runtime of [
      null,
      { kind: "tier", tier: "fast" },
      { providerId: "p", modelId: "m", reasoningLevel: "high" },
    ]) {
      expect(change({ draft: { ...draft, runtime } })).toMatchObject({ kind: "save" });
    }
  });

  test.each([
    ["update missing", { change: "update" as const }, "automation_not_found"],
    ["delete missing", { change: "delete" as const }, "automation_not_found"],
    [
      "deleted",
      { change: "update" as const, existing: [{ ...definition, deletedAt: 0 }] },
      "automation_not_found",
    ],
    [
      "wrong project",
      { existing: [{ ...definition, projectId: otherProject }] },
      "automation_not_in_project",
    ],
    ["create existing", { existing: [definition] }, "automation_exists"],
    ["missing draft", { draft: undefined }, "invalid_draft"],
    ["blank name", { draft: { ...draft, name: " " } }, "invalid_draft"],
    ["blank instructions", { draft: { ...draft, instructions: " " } }, "invalid_draft"],
    [
      "long name",
      { draft: { ...draft, name: "x".repeat(AUTOMATION_NAME_MAX_CHARS + 1) } },
      "draft_too_large",
    ],
    [
      "long instructions",
      { draft: { ...draft, instructions: "x".repeat(AUTOMATION_INSTRUCTIONS_MAX_CHARS + 1) } },
      "draft_too_large",
    ],
    [
      "duplicate name",
      {
        existing: [
          {
            ...definition,
            id: parseId("automation", "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
            name: " REVIEW ",
          },
        ],
      },
      "name_taken",
    ],
    [
      "bad runtime",
      { draft: { ...draft, runtime: { kind: "tier", tier: "utility" } } },
      "invalid_runtime",
    ],
    ["bad trigger", { draft: { ...draft, trigger: {} } }, "invalid_trigger"],
    ["null trigger", { draft: { ...draft, trigger: null } }, "invalid_trigger"],
    [
      "bad schedule",
      {
        draft: {
          ...draft,
          trigger: { kind: "schedule", schedule: { ...daily, timeZone: "Mars/Here" } },
        },
      },
      "invalid_trigger",
    ],
  ])("refuses %s", (_name, patch, code) => {
    expect(change(patch)).toEqual({ kind: "refused", code });
  });

  test("name uniqueness ignores other projects and tombstones; bounds are inclusive", () => {
    const id = parseId("automation", "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(
      change({
        existing: [
          { ...definition, id, projectId: otherProject },
          { ...definition, id, deletedAt: 0 },
        ],
      }),
    ).toMatchObject({ kind: "save" });
    expect(
      change({
        draft: {
          ...draft,
          name: "n".repeat(AUTOMATION_NAME_MAX_CHARS),
          instructions: "i".repeat(AUTOMATION_INSTRUCTIONS_MAX_CHARS),
        },
      }),
    ).toMatchObject({ kind: "save" });
  });
});

describe("arming and re-arming", () => {
  test("arms the column on the editor's live capable runner; disarm needs no live target", () => {
    expect(decideArming({ ...arm, status: "doing" })).toEqual({
      kind: "arm",
      automationId,
      runnerId,
      armedByUserId: userId,
    });
    expect(
      decideArming({ ...arm, status: "doing", runner: { ...runner, status: "degraded" } }),
    ).toMatchObject({ kind: "arm" });
    expect(
      decideArming({ ...arm, status: "doing", disarm: true, automation: null, runner: null }),
    ).toEqual({ kind: "disarm" });
    expect(decideScheduleArming({ ...arm, disarm: true, automation: null, now: due })).toEqual({
      kind: "disarm",
    });
  });

  test.each([
    [{ canEdit: false }, "forbidden"],
    [{ automation: null }, "automation_not_found"],
    [{ automation: { ...definition, deletedAt: 0 } }, "automation_not_found"],
    [{ automation: { ...definition, projectId: otherProject } }, "automation_not_in_project"],
    [{ runner: null }, "runner_unavailable"],
    [{ runner: { ...runner, status: "revoked" as const } }, "runner_unavailable"],
    [{ runner: { ...runner, ownerUserId: otherUser } }, "runner_not_yours"],
    [{ runner: { ...runner, tools: [] } }, "runner_needs_update"],
    [{ runner: { ...runner, status: "asleep" as const } }, "runner_not_live"],
  ])("refuses both arming doors with %j", (patch, code) => {
    expect(decideArming({ ...arm, status: "doing", ...patch })).toEqual({ kind: "refused", code });
    expect(decideScheduleArming({ ...arm, now: due, ...patch })).toEqual({ kind: "refused", code });
  });

  test("cannot arm a mismatched trigger or disarm without board edit access", () => {
    expect(decideArming({ ...arm, status: "done" })).toEqual({
      kind: "refused",
      code: "wrong_trigger",
    });
    expect(decideScheduleArming({ ...arm, now: due })).toEqual({
      kind: "refused",
      code: "wrong_trigger",
    });
    expect(decideArming({ ...arm, status: "doing", disarm: true, canEdit: false })).toMatchObject({
      code: "forbidden",
    });
    expect(decideScheduleArming({ ...arm, now: due, disarm: true, canEdit: false })).toMatchObject({
      code: "forbidden",
    });
  });
});

describe("routing", () => {
  test.each([
    [null, runner, { kind: "route", runnerId, onBehalfOf: userId }],
    [
      { ...runner, id: otherRunner },
      runner,
      { kind: "route", runnerId: otherRunner, onBehalfOf: userId },
    ],
    [
      { ...runner, ownerUserId: otherUser },
      runner,
      { kind: "route", runnerId, onBehalfOf: userId },
    ],
    [
      { ...runner, status: "asleep" as const },
      null,
      { kind: "route", runnerId, onBehalfOf: userId },
    ],
    [null, null, { kind: "refused", code: "runner_unavailable" }],
    [null, { ...runner, ownerUserId: otherUser }, { kind: "refused", code: "runner_not_yours" }],
    [
      { ...runner, status: "revoked" as const },
      runner,
      { kind: "refused", code: "runner_unavailable" },
    ],
    [{ ...runner, tools: [] }, runner, { kind: "refused", code: "runner_needs_update" }],
  ])(
    "routes owned Place or falls back without borrowing credentials",
    (ticketPlace, callerRunner, expected) => {
      expect(
        decideAutomationRunRouting({ callerUserId: userId, ticketPlace, callerRunner }),
      ).toEqual(expected);
    },
  );
});

describe("cloud clock: wait, coalesced", () => {
  test.each([
    [{ pausedAt: 0 }, "inactive"],
    [{ automationDeleted: true }, "inactive"],
    [{ nextFireAt: due + 1 }, "early"],
  ])("does nothing for %j", (patch, reason) => {
    expect(
      decideScheduleFire({ schedule: { ...schedule, ...patch }, pending: null, now: due }),
    ).toEqual({ kind: "ignore", reason });
  });

  test.each(["online", "asleep", "offline"] as const)(
    "enqueues a due occurrence even if %s, never early",
    (runnerStatus) => {
      expect(
        decideScheduleFire({ schedule: { ...schedule, runnerStatus }, pending: null, now: due }),
      ).toEqual({
        kind: "enqueue",
        dueAt: due,
        missedCount: 0,
        nextFireAt: at("2026-03-07T09:30:00Z"),
        gap: null,
      });
    },
  );

  test("one weekend skip and one latest Run, not replayed stale Runs", () => {
    expect(
      decideScheduleFire({ schedule, pending: null, now: at("2026-03-09T09:31:00Z") }),
    ).toEqual({
      kind: "enqueue",
      dueAt: at("2026-03-09T09:30:00Z"),
      missedCount: 3,
      nextFireAt: at("2026-03-10T09:30:00Z"),
      gap: {
        runId: null,
        dueAt: at("2026-03-08T09:30:00Z"),
        missedCount: 3,
        reason: { kind: "superseded" },
      },
    });
  });

  test("supersede chains patch one waiting job and merge the same skip row", () => {
    const cursor = {
      ...schedule,
      nextFireAt: at("2026-03-07T09:30:00Z"),
      runnerStatus: "asleep" as const,
    };
    const waiting = { ...pending };
    for (const [day, missedCount] of [
      ["07", 1],
      ["08", 2],
      ["09", 3],
    ] as const) {
      const now = at(`2026-03-${day}T09:30:00Z`);
      const result = decideScheduleFire({ schedule: cursor, pending: waiting, now });
      expect(result.kind).toBe("supersede");
      if (result.kind !== "supersede") throw new Error("expected supersede");
      expect(result).toMatchObject({
        jobId: "job",
        runId: "run",
        dueAt: now,
        missedCount,
        gap: {
          runId: missedCount === 1 ? null : "gap",
          dueAt: waiting.dueAt,
          missedCount,
          reason: { kind: "runner-asleep", runnerId },
        },
      });
      Object.assign(waiting, { dueAt: result.dueAt, missedCount: result.missedCount });
      Object.assign(cursor, { nextFireAt: result.nextFireAt, gapRunId: "gap" });
      expect(decideScheduleFire({ schedule: cursor, pending: waiting, now })).toEqual({
        kind: "ignore",
        reason: "early",
      });
    }
  });

  test("late cron coalesces all elapsed slots plus the waiting occurrence", () => {
    expect(
      decideScheduleFire({
        schedule: {
          ...schedule,
          nextFireAt: at("2026-03-07T09:30:00Z"),
          gapRunId: "gap",
          runnerStatus: "offline",
        },
        pending,
        now: at("2026-03-09T09:30:00Z"),
      }),
    ).toMatchObject({
      kind: "supersede",
      dueAt: at("2026-03-09T09:30:00Z"),
      missedCount: 3,
      gap: {
        runId: "gap",
        dueAt: at("2026-03-08T09:30:00Z"),
        missedCount: 3,
        reason: { kind: "superseded" },
      },
    });
  });

  test.each([
    { ...pending, status: "leased" as const },
    { ...pending, attempt: 1 },
  ])("never patches a job that has ever been leased", (waiting) => {
    expect(decideScheduleFire({ schedule, pending: waiting, now: due })).toMatchObject({
      kind: "enqueue",
      missedCount: 0,
      gap: null,
    });
  });

  test.each([
    [{ armerActive: false }, "armer_left"],
    [{ runnerStatus: "revoked" as const }, "runner_removed"],
    [{ runnerStatus: "removed" as const }, "runner_removed"],
  ])("pauses and records one true skip for %j", (patch, pauseReason) => {
    for (const waiting of [null, { ...pending, missedCount: 2 }]) {
      const result = decideScheduleFire({
        schedule: { ...schedule, gapRunId: "gap", ...patch },
        pending: waiting,
        now: due,
      });
      expect(result).toMatchObject({
        kind: "skip",
        pauseReason,
        gap: {
          runId: waiting === null ? null : "gap",
          dueAt: due,
          missedCount: waiting === null ? 1 : 4,
          reason: { kind: "runner-unavailable", code: pauseReason },
        },
      });
    }
  });
});

// Fixed instants, never Date.now() + DAY_MS. Minute 30 avoids the deliberate :00 stagger.
const ZONES: readonly [string, string, number, number, string, string][] = [
  ["London spring", "Europe/London", 1, 30, "2026-03-28T01:30:00Z", "2026-03-29T01:30:00Z"],
  ["London fall", "Europe/London", 1, 30, "2026-10-25T01:30:00Z", "2026-10-26T01:30:00Z"],
  ["NY spring missing", "America/New_York", 2, 30, "2026-03-07T07:30:00Z", "2026-03-08T07:30:00Z"],
  [
    "NY fall repeated once",
    "America/New_York",
    1,
    30,
    "2026-11-01T06:30:00Z",
    "2026-11-02T06:30:00Z",
  ],
  [
    "Lord Howe spring half hour",
    "Australia/Lord_Howe",
    2,
    15,
    "2026-10-02T15:45:00Z",
    "2026-10-03T15:45:00Z",
  ],
  ["Lord Howe fall", "Australia/Lord_Howe", 1, 45, "2026-04-04T15:15:00Z", "2026-04-05T15:15:00Z"],
  [
    "Chatham spring quarter hour",
    "Pacific/Chatham",
    3,
    30,
    "2026-09-25T14:45:00Z",
    "2026-09-26T14:45:00Z",
  ],
  ["Chatham fall", "Pacific/Chatham", 3, 30, "2026-04-04T14:45:00Z", "2026-04-05T14:45:00Z"],
  ["Kolkata no DST", "Asia/Kolkata", 9, 30, "2026-03-07T04:00:00Z", "2026-03-08T04:00:00Z"],
];

describe("stored zones and DST", () => {
  test.each(ZONES)(
    "%s: first sight is strictly after, and fire uses the stored zone",
    (_label, timeZone, hour, minute, after, expected) => {
      const spec: AutomationSchedule = { preset: "daily", hour, minute, timeZone };
      const trigger: AutomationTrigger = { kind: "schedule", schedule: spec };
      const armed = decideScheduleArming({
        ...arm,
        automation: { ...definition, trigger },
        now: at(after),
      });
      expect(armed).toEqual({
        kind: "arm",
        automationId,
        runnerId,
        armedByUserId: userId,
        timezone: timeZone,
        nextFireAt: at(expected),
      });
      const result = decideScheduleFire({
        schedule: {
          ...schedule,
          spec: { ...spec, timeZone: "UTC" },
          timezone: timeZone,
          nextFireAt: at(after),
        },
        pending: null,
        now: at(after),
      });
      expect(result).toMatchObject({ kind: "enqueue", dueAt: at(after), nextFireAt: at(expected) });
    },
  );

  test("coalescing counts DST occurrences, not multiples of 24 hours", () => {
    const result = decideScheduleFire({
      schedule: {
        ...schedule,
        spec: { preset: "daily", hour: 2, minute: 30, timeZone: "America/New_York" },
        timezone: "America/New_York",
        nextFireAt: at("2026-03-07T07:30:00Z"),
        runnerStatus: "asleep",
      },
      pending: null,
      now: at("2026-03-09T06:30:00Z"),
    });
    expect(result).toMatchObject({
      kind: "enqueue",
      dueAt: at("2026-03-09T06:30:00Z"),
      missedCount: 2,
      nextFireAt: at("2026-03-10T06:30:00Z"),
      gap: { dueAt: at("2026-03-08T07:30:00Z"), missedCount: 2 },
    });
  });
});
