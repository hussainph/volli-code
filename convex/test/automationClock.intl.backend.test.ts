/**
 * Time-zone parity: the Automation clock computes `nextFireAt` only inside
 * Convex, with the shared `nextScheduleOccurrence` and `Intl` alone. This runs
 * that function inside the pinned backend's runtime and compares it, row by
 * row, with Node's answer and with the instant each row must produce.
 *
 * Every row is a fixed instant (no `Date.now()` arithmetic), and each DST
 * transition is its own explicit row, so no answer depends on the day CI runs.
 */
import { describe, expect, test } from "vite-plus/test";
import { nextScheduleOccurrence, type AutomationSchedule } from "@volli/shared";

import { internal } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";

const backend = connectBackend();

interface Row {
  name: string;
  schedule: AutomationSchedule;
  after: string;
  /** The instant the row must produce, or null where only parity is asserted (a stagger). */
  expected: string | null;
}

const STAGGER_KEY = "0b3c7d2e-1f00-4a00-8000-000000000001";

const ROWS: Row[] = [
  {
    name: "New York spring forward: 02:30 does not exist, fires at 03:30 EDT",
    schedule: { preset: "daily", hour: 2, minute: 30, timeZone: "America/New_York" },
    after: "2026-03-07T12:00:00Z",
    expected: "2026-03-08T07:30:00.000Z",
  },
  {
    name: "New York fall back: 01:30 happens twice, fires once at the later one",
    schedule: { preset: "daily", hour: 1, minute: 30, timeZone: "America/New_York" },
    after: "2026-10-31T12:00:00Z",
    expected: "2026-11-01T06:30:00.000Z",
  },
  {
    name: "New York fall back: after the repeated hour, the next day",
    schedule: { preset: "daily", hour: 1, minute: 30, timeZone: "America/New_York" },
    after: "2026-11-01T06:30:00Z",
    expected: "2026-11-02T06:30:00.000Z",
  },
  {
    name: "New York hourly across spring forward",
    schedule: { preset: "hourly", minute: 30, timeZone: "America/New_York" },
    after: "2026-03-08T06:45:00Z",
    expected: "2026-03-08T07:30:00.000Z",
  },
  {
    name: "London spring forward: 01:30 does not exist, fires at 02:30 BST",
    schedule: { preset: "daily", hour: 1, minute: 30, timeZone: "Europe/London" },
    after: "2026-03-28T12:00:00Z",
    expected: "2026-03-29T01:30:00.000Z",
  },
  {
    name: "London fall back: 01:30 happens twice, fires at 01:30 GMT",
    schedule: { preset: "daily", hour: 1, minute: 30, timeZone: "Europe/London" },
    after: "2026-10-24T12:00:00Z",
    expected: "2026-10-25T01:30:00.000Z",
  },
  {
    name: "London weekly on the hour (staggered) across fall back",
    schedule: {
      preset: "weekly",
      weekday: "sunday",
      hour: 9,
      minute: 0,
      timeZone: "Europe/London",
    },
    after: "2026-10-24T12:00:00Z",
    expected: null,
  },
  {
    name: "Lord Howe 30-minute spring forward: 02:15 does not exist",
    schedule: { preset: "daily", hour: 2, minute: 15, timeZone: "Australia/Lord_Howe" },
    after: "2026-10-03T00:00:00Z",
    expected: "2026-10-03T15:45:00.000Z",
  },
  {
    name: "Lord Howe 30-minute fall back: 01:45 happens twice",
    schedule: { preset: "daily", hour: 1, minute: 45, timeZone: "Australia/Lord_Howe" },
    after: "2026-04-04T00:00:00Z",
    expected: "2026-04-04T15:15:00.000Z",
  },
  {
    name: "Chatham +12:45 → +13:45: 03:00 (staggered) does not exist",
    schedule: { preset: "daily", hour: 3, minute: 0, timeZone: "Pacific/Chatham" },
    after: "2026-09-26T00:00:00Z",
    expected: null,
  },
  {
    name: "Chatham fall back +13:45 → +12:45",
    schedule: { preset: "daily", hour: 3, minute: 15, timeZone: "Pacific/Chatham" },
    after: "2026-04-04T00:00:00Z",
    expected: null,
  },
  {
    name: "Kolkata (no DST) weekdays skip the weekend",
    schedule: { preset: "weekdays", hour: 9, minute: 30, timeZone: "Asia/Kolkata" },
    after: "2026-10-30T06:00:00Z",
    expected: "2026-11-02T04:00:00.000Z",
  },
];

describe("Automation clock time zones in the Convex runtime", () => {
  test("nextScheduleOccurrence answers as Node does, and as each row requires", async () => {
    const { icu, occurrences } = await backend.admin(internal.testAutomations.scheduleOccurrences, {
      cases: ROWS.map((row) => ({
        schedule: row.schedule,
        staggerKey: STAGGER_KEY,
        after: Date.parse(row.after),
      })),
    });
    // A runtime without zone data fails here with the count, not as a wrong instant.
    expect(icu.supportedZones === null || icu.supportedZones > 300).toBe(true);
    ROWS.forEach((row, index) => {
      const node = nextScheduleOccurrence({
        schedule: row.schedule,
        staggerKey: STAGGER_KEY,
        after: Date.parse(row.after),
      });
      const convex = occurrences[index];
      expect({ row: row.name, convex }).toEqual({ row: row.name, convex: node });
      if (row.expected !== null) expect(new Date(node).toISOString()).toBe(row.expected);
      expect(node).toBeGreaterThan(Date.parse(row.after));
    });
  });
});
