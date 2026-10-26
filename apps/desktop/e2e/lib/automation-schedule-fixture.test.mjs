import assert from "node:assert/strict";
import test from "node:test";

import { nextScheduleOccurrence } from "../../../../packages/shared/src/automation-schedule.ts";
import { automationScheduleFixture } from "./automation-schedule-fixture.mjs";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Use the real pure calendar rules, not a second implementation of DST.
function occurrencesThrough(schedule, cursor, now) {
  const due = [];
  let next = nextScheduleOccurrence({ schedule, staggerKey: "smoke", after: cursor });
  while (next <= now) {
    due.push(next);
    assert.ok(due.length < 10, "fixture must not manufacture a long backlog");
    next = nextScheduleOccurrence({ schedule, staggerKey: "smoke", after: next });
  }
  return { due, next };
}

for (const [boundary, now, oldCount] of [
  ["fall-back", "2026-10-25T20:45:00Z", 2],
  ["spring-forward", "2026-03-29T20:45:00Z", 4],
]) {
  test(`${boundary}: reproduces the elapsed-days fixture's wrong count`, () => {
    const instant = Date.parse(now);
    const schedule = { preset: "daily", hour: 21, minute: 30, timeZone: "Europe/London" };
    const { due } = occurrencesThrough(schedule, instant - 3 * DAY_MS - 60_000, instant);
    assert.equal(due.length, oldCount);

    const fixture = automationScheduleFixture(instant);
    assert.equal(occurrencesThrough(fixture.schedule, fixture.cursor, instant).due.length, 3);
  });
}

for (const [boundary, start] of [
  ["fall-back", "2026-10-24T00:00:00Z"],
  ["spring-forward", "2026-03-28T00:00:00Z"],
]) {
  test(`${boundary}: three missed slots at every wall-clock hour around the boundary`, () => {
    // Include the transition and the three following days, when the cursor
    // still crosses it. UTC iteration visits BOTH readings of the folded hour
    // and the midnight wrap. Probe either side of the slot's :30 minute too.
    for (let hour = 0; hour < 5 * 24; hour += 1) {
      for (const minute of [0, 29, 30, 31, 59]) {
        const now = Date.parse(start) + hour * HOUR_MS + minute * 60_000;
        const { schedule, cursor } = automationScheduleFixture(now);
        const { due, next } = occurrencesThrough(schedule, cursor, now);
        const label = new Date(now).toISOString();
        assert.equal(due.length, 3, label);
        assert.equal(schedule.preset, "daily");
        assert.ok(Number.isInteger(schedule.hour) && schedule.hour >= 0 && schedule.hour <= 23);
        assert.equal(schedule.minute, 30);
        assert.equal(schedule.timeZone, "Europe/London");
        assert.ok(next - now > 10 * HOUR_MS, `${label}: no live occurrence during the smoke`);
        // All three are older than both relaunch's watchingSince and its
        // two-minute grace floor, so every counted occurrence is an app-closed
        // miss in evaluateSchedulePass, not a runnable or not-observed slot.
        assert.ok(now - due.at(-1) > 10 * HOUR_MS, `${label}: all due before relaunch`);
        // Cursor and slot share one anchor even if closing/relaunching is slow.
        assert.equal(occurrencesThrough(schedule, cursor, now + HOUR_MS).due.length, 3, label);
      }
    }
  });
}
