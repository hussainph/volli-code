/**
 * The Automation acceptance's own rules, run with `node --test`:
 *
 *   node --test apps/desktop/e2e/volli-drive/lib/cloud-automation-acceptance.test.mjs
 *
 * Nothing here launches Electron, touches a keychain or reads a real profile.
 * Two things are worth asserting without a runner: that backdating by "the
 * last minute past the hour" can only ever make ONE occurrence due (otherwise
 * the acceptance would be measuring a fold, not coalescing), and that the copy
 * this driver waits for is the copy production prints — a paraphrase would
 * make the journey pass or fail on the test's words rather than the app's.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it } from "node:test";

import {
  AUTOMATION_RUN_TOOL,
  MINUTES,
  automationRunToolCall,
  coalescingProblems,
  noticeDeliveredCopy,
  noticeTurnFinishedCopy,
  writeFakeScript,
  hourlyBackdateAt,
  provenanceMarkCopy,
  runStatusCounts,
  runsOnRunner,
  skippedAsleepCopy,
  waitingForAsleepCopy,
} from "./cloud-automation-acceptance.mjs";

const REPO = fileURLToPath(new URL("../../../../..", import.meta.url));
const source = (path) => readFileSync(new URL(path, `file://${REPO}/`), "utf8");

/** The next instant the clock reads `minute` past the hour, strictly after `after`. */
function nextHourlyOccurrence(after, minute) {
  const slot = new Date(after);
  slot.setUTCSeconds(0, 0);
  slot.setUTCMinutes(minute);
  while (slot.getTime() <= after) slot.setUTCHours(slot.getUTCHours() + 1);
  return slot.getTime();
}

describe("hourlyBackdateAt", () => {
  const NOWS = [
    Date.parse("2026-03-07T12:00:00.000Z"),
    Date.parse("2026-03-07T12:00:00.999Z"),
    Date.parse("2026-03-07T12:16:59.999Z"),
    Date.parse("2026-03-07T12:17:00.000Z"),
    Date.parse("2026-03-07T12:17:00.500Z"),
    Date.parse("2026-03-07T12:59:59.999Z"),
    Date.parse("2026-12-31T23:59:59.999Z"),
    Date.parse("2028-02-29T00:17:00.001Z"),
  ];

  it("puts the cursor at or before now, so the occurrence is due", () => {
    for (const now of NOWS)
      for (const minute of [0, 1, 17, 30, 59])
        assert.ok(
          hourlyBackdateAt(now, minute) <= now,
          `${new Date(now).toISOString()} at :${minute} was not due`,
        );
  });

  it("puts the cursor on the schedule's own minute", () => {
    for (const now of NOWS)
      for (const minute of [0, 1, 17, 30, 59]) {
        const backdate = new Date(hourlyBackdateAt(now, minute));
        assert.equal(backdate.getUTCMinutes(), minute);
        assert.equal(backdate.getUTCSeconds(), 0);
        assert.equal(backdate.getUTCMilliseconds(), 0);
      }
  });

  it("leaves exactly one occurrence due: the next one is a full hour away", () => {
    for (const now of NOWS)
      for (const minute of [0, 1, 17, 30, 59]) {
        const backdate = hourlyBackdateAt(now, minute);
        const next = nextHourlyOccurrence(backdate, minute);
        assert.ok(
          next > now,
          `${new Date(now).toISOString()} at :${minute} would fold a second occurrence`,
        );
        assert.equal(next - backdate, 60 * MINUTES, "the next occurrence is not one hour later");
      }
  });

  it("refuses a value that is not a minute past the hour", () => {
    for (const bad of [-1, 60, 1.5, "17", null, undefined])
      assert.throws(() => hourlyBackdateAt(Date.now(), bad), /not a minute past the hour/);
  });
});

describe("runStatusCounts", () => {
  it("counts every status and ignores an unknown one", () => {
    assert.deepEqual(
      runStatusCounts([
        { status: "queued" },
        { status: "skipped" },
        { status: "started" },
        { status: "failed" },
        { status: "something-new" },
      ]),
      { queued: 1, started: 1, skipped: 1, failed: 1 },
    );
  });
});

describe("runsOnRunner", () => {
  it("names the Runs addressed to one Mac", () => {
    const runs = [{ runnerId: "a" }, { runnerId: "b" }, { runnerId: "a" }];
    assert.equal(runsOnRunner(runs, "a").length, 2);
    assert.equal(runsOnRunner(runs, "b").length, 1);
    assert.equal(runsOnRunner(runs, "c").length, 0);
  });
});

/** What `testAutomations.inspectSchedule` reports after two coalesced occurrences. */
function coalesced() {
  return {
    runs: [
      {
        id: "run-1",
        status: "queued",
        missedCount: 1,
        skipReason: null,
        sessionId: null,
      },
      {
        id: "gap-1",
        status: "skipped",
        missedCount: 1,
        skipReason: { kind: "runner-asleep", runnerId: "runner-a" },
        sessionId: null,
      },
    ],
    jobs: [{ id: "job-1", status: "queued", lease: null, payload: { missedCount: 1 } }],
  };
}

describe("coalescingProblems", () => {
  it("accepts one skipped occurrence and the one Run still waiting", () => {
    assert.deepEqual(coalescingProblems(coalesced()), []);
  });

  it("rejects a second Run: waiting is one Run, never a pile", () => {
    const input = coalesced();
    input.runs.push({ ...input.runs[0], id: "run-2" });
    assert.match(coalescingProblems(input).join("; "), /2 queued Runs, expected 1/);
  });

  it("rejects a Run that started while the Mac was asleep", () => {
    const input = coalesced();
    input.runs[0].status = "started";
    assert.match(coalescingProblems(input).join("; "), /1 started/);
  });

  it("rejects a skip that hides how many occurrences it covers", () => {
    const input = coalesced();
    input.runs[1].missedCount = 2;
    assert.match(coalescingProblems(input).join("; "), /covers 2 occurrences, expected 1/);
  });

  it("rejects a skip whose reason is not the sleep", () => {
    const input = coalesced();
    input.runs[1].skipReason = { kind: "superseded" };
    assert.match(coalescingProblems(input).join("; "), /expected runner-asleep/);
  });

  it("rejects a leased job: a Mac awake enough to be handed it could not coalesce", () => {
    const input = coalesced();
    input.jobs[0].lease = { attempt: 1 };
    assert.match(coalescingProblems(input).join("; "), /was leased before the Mac woke/);
  });

  it("rejects a job that lost the occurrences it covers", () => {
    const input = coalesced();
    input.jobs[0].payload.missedCount = 0;
    assert.match(coalescingProblems(input).join("; "), /covers 0 occurrences, expected 1/);
  });

  it("rejects a second job for the same schedule", () => {
    const input = coalesced();
    input.jobs.push({ ...input.jobs[0], id: "job-2" });
    assert.match(coalescingProblems(input).join("; "), /2 jobs, expected 1/);
  });
});

describe("the copy this driver waits for is the copy production prints", () => {
  it("waiting for a sleeping Mac is the Run label's own words", () => {
    const state = source("apps/desktop/src/renderer/src/stores/cloud-automations/state.ts");
    assert.match(state, /Waiting for \$\{name\}/u);
    assert.match(state, /\? " \(asleep\)"/u);
    assert.equal(waitingForAsleepCopy("hp-mac"), "Waiting for hp-mac (asleep)");
    // The Session band's own place line is a different sentence ("asleep
    // since 14:02"), so this needle cannot be satisfied by an unrelated
    // surface that happens to be showing the same Mac.
    assert.ok(!waitingForAsleepCopy("hp-mac").includes("asleep since"));
  });

  it("a superseded occurrence is the Run history's own sentence", () => {
    const history = source(
      "apps/desktop/src/renderer/src/components/automations/cloud-run-history.tsx",
    );
    assert.match(history, /`Skipped · \$\{cause\}/u);
    assert.match(history, /\} was asleep/u);
    assert.equal(skippedAsleepCopy("hp-mac"), "Skipped · hp-mac was asleep");
  });

  it("a Run-started Session row carries the provenance mark's sentence", () => {
    const provenance = source("packages/shared/src/session-provenance.ts");
    assert.match(provenance, /`Started by the Automation \$\{provenance\.automationName\}`/u);
    assert.equal(provenanceMarkCopy("Doing sweep"), "Started by the Automation Doing sweep");
  });
});

describe("the agent's scripted turn", () => {
  it("asks for the saved Automation by name and the Ticket by id", () => {
    const turn = automationRunToolCall({ automationName: "Doing sweep", ticketId: "ticket-1" });
    assert.deepEqual(turn, {
      toolCalls: [
        { name: "automation_run", arguments: { automation: "Doing sweep", ticket: "ticket-1" } },
      ],
    });
    // A tool-only turn: no text, so the provider emits only the call.
    assert.equal(turn.text, undefined);
  });

  it("is the tool name production registers, with production's argument names", () => {
    const registry = source("packages/shared/src/verb-registry.ts");
    assert.match(registry, /name: "automation_run"/u);
    assert.match(registry, /name: "automation",/u);
    assert.match(registry, /name: "ticket",/u);
    assert.equal(AUTOMATION_RUN_TOOL, "automation_run");
  });

  it("writes the reply queue the launcher reads: a JSON array, in order", async () => {
    const directory = mkdtempSync(join(tmpdir(), "volli-fake-script-"));
    try {
      const replies = [
        { text: "first" },
        automationRunToolCall({ automationName: "A", ticketId: "t" }),
      ];
      const path = join(directory, "fake-script.json");
      const written = await writeFakeScript(directory, replies);
      assert.equal(written, path);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), replies);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("waits for the notice's own sentences, as production composes them", () => {
    const notice = source("packages/shared/src/session-notice.ts");
    assert.match(notice, /This notice is from Volli, not your user\.\]/u);
    assert.match(notice, /finished its turn\./u);
    assert.equal(noticeDeliveredCopy(), "This notice is from Volli, not your user.");
    assert.equal(noticeTurnFinishedCopy(), "finished its turn.");
  });
});
