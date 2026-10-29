import { describe, expect, it } from "vite-plus/test";
import { MOVE_STATES } from "@volli/host-core/cloud-move";
import type { MoveFailure, MovePause, MoveRow, MoveState } from "@volli/host-core/cloud-move";
import type { CloudMoveStatus, CloudMoveStep } from "@volli/shared";
import { describeMove } from "./presentation";

const STEPS: readonly CloudMoveStep[] = [
  "backup",
  "freeze",
  "export",
  "upload",
  "copy",
  "history",
  "verify",
  "handover",
  "check",
];

/** Prose an engine row really holds: this must never reach the person. */
const RAW = "ENOENT: scandir '/Users/someone/Library/Application Support/Volli/volli.db'";
const SESSION = "0b7f0c52-2b4e-4a3e-9b0f-2a1b1c1d1e1f";

function row(over: Partial<MoveRow> = {}): MoveRow {
  return {
    moveId: "move",
    queueId: "queue",
    projectId: "project",
    position: 0,
    userId: "person",
    workspaceId: "workspace",
    runnerId: "runner",
    state: "queued",
    paused: null,
    journal: {},
    failure: null,
    report: null,
    appVersion: "0.3.0",
    mapperVersion: 1,
    manifestSha256: null,
    supersedes: null,
    createdAt: 1,
    updatedAt: 1,
    committedAt: null,
    confirmedAt: null,
    returnedAt: null,
    ...over,
  };
}

function failure(code: string, over: Partial<MoveFailure> = {}): MoveFailure {
  return {
    code,
    message: RAW,
    step: "objects",
    at: 2,
    detail: { stream: "sessionEvents", sessionId: SESSION, missingBodies: 3 },
    ...over,
  };
}

/** A failure the engine really records, for the states that are not about one. */
const RECORDED = failure("rows_refused");

/** Every code engine.ts, plan.ts and the backend's refusals can record. */
const FAILURE_CODES = [
  "unknown_project",
  "project_removed",
  "pending_runner_work",
  "export_source_unreadable",
  "export_schema_unsupported",
  "export_source_corrupt",
  "export_integrity",
  "export_io_failed",
  "export_worker_failed",
  "local_file_unreadable",
  "not_one_project",
  "row_refused",
  "row_unstorable",
  "duplicate_ticket_key",
  "orphan_event",
  "sequence_gap",
  "object_key",
  "legacy_outside_project",
  "object_conflict",
  "object_refused",
  "rows_refused",
  "history_incomplete",
  "verification_failed",
  "internal",
  "cancelled",
  "runner_replaced",
  "app_updated",
  "export_changed",
  "already_migrated",
  "import_in_progress",
  "move_conflict",
  "runner_unavailable",
  "import_closed",
  "import_committed",
  "manifest_mismatch",
  "changed_since_commit",
  "invalid_rescue_target",
  "invalid_key",
  "invalid_argument",
  "storage_unconfigured",
  "backend_error",
  "not_found",
  "not_a_member",
  "forbidden",
  "unauthenticated",
  "no_viewer",
  "account_deleted",
  "account_deletion_pending",
  "identity_conflict",
  "not_a_person",
  "preview_waitlisted",
  "preview_agreement_required",
] as const;

const PAUSES: readonly MovePause[] = [
  "not_idle",
  "network",
  "disk_full",
  "signed_out",
  "waiting_for_purge",
  "paused",
];

/** Words from the engine's inside that a person must never read on the sheet. */
const INTERNAL_WORDS =
  /\b(imports?|importing|importer|fold|folds|drain|drains|manifest|digest|journal)\b/i;

describe("a move's four person-facing fields", () => {
  it("projects every engine state, naming the step that has NOT finished yet", () => {
    // The engine's state is the last step COMPLETED, so the step shown is the
    // next one: a move at `frozen` has backed up and frozen, and is exporting.
    const expected: Record<
      MoveState,
      { state: CloudMoveStatus["state"]; step: CloudMoveStep; completed: number }
    > = {
      queued: { state: "queued", step: "backup", completed: 0 },
      frozen: { state: "moving", step: "export", completed: 2 },
      exported: { state: "moving", step: "upload", completed: 3 },
      reserved: { state: "moving", step: "upload", completed: 3 },
      staged: { state: "moving", step: "upload", completed: 3 },
      objects: { state: "moving", step: "copy", completed: 4 },
      rows: { state: "moving", step: "history", completed: 5 },
      history: { state: "moving", step: "verify", completed: 6 },
      // The read-back is done; the commit re-checks the counts, so `verify` is current until then.
      verified: { state: "moving", step: "verify", completed: 6 },
      committed: { state: "moving", step: "handover", completed: 7 },
      handed_over: { state: "moving", step: "check", completed: 8 },
      checked: { state: "check", step: "check", completed: 9 },
      confirmed: { state: "finished", step: "check", completed: 9 },
      rolling_back: { state: "moving", step: "copy", completed: 4 },
      rolled_back: { state: "problem", step: "backup", completed: 0 },
      returning: { state: "moving", step: "check", completed: 9 },
      returned: { state: "returned", step: "check", completed: 9 },
      superseded: { state: "queued", step: "backup", completed: 0 },
    };
    // Every state on the engine's list has a row here, so a new one cannot slip by.
    expect(Object.keys(expected).toSorted()).toEqual([...MOVE_STATES].toSorted());

    for (const state of MOVE_STATES) {
      const want = expected[state];
      const seen = describeMove(
        row({
          state,
          journal: state === "rolling_back" ? { rollbackFrom: "objects" } : {},
          failure: RECORDED,
        }),
      );
      expect(seen, state).toMatchObject({
        state: want.state,
        step: want.step,
        completedSteps: STEPS.slice(0, want.completed),
      });
    }
  });

  it("never reports a step complete that the engine has not reached", () => {
    for (const state of MOVE_STATES) {
      const seen = describeMove(
        row({
          state,
          journal: state === "rolling_back" ? { rollbackFrom: "rows" } : {},
          failure: RECORDED,
        }),
      );
      // Steps are a prefix in the plan's order, and the step shown is the first
      // one still to run (or the last one, never a tenth).
      const done = seen.completedSteps.length;
      expect(seen.completedSteps, state).toEqual(STEPS.slice(0, done));
      expect(seen.step, state).toBe(STEPS[Math.min(done, STEPS.length - 1)]);
    }
  });

  it("only reads as done once the project stayed where the move put it", () => {
    // `returning` finished its steps and is going back; the roll back below did not.
    const stayed = new Set<MoveState>(["checked", "confirmed", "returning", "returned"]);
    for (const state of MOVE_STATES) {
      const seen = describeMove(row({ state, journal: { rollbackFrom: "checked" } }));
      if (stayed.has(state)) {
        expect(seen.completedSteps, state).toEqual([...STEPS]);
        continue;
      }
      // A roll back from `checked` included: the project is not staying, so the
      // last step is never reported complete.
      expect(seen.completedSteps, state).not.toContain("check");
      expect(seen.completedSteps.length, state).toBeLessThan(STEPS.length);
    }
  });

  it("hands back these four fields and nothing it cannot know", () => {
    const seen = describeMove(row({ state: "objects" }));
    expect(Object.keys(seen).toSorted()).toEqual(["completedSteps", "message", "state", "step"]);
    expect(typeof seen.message).toBe("string");
    expect(seen.message.length).toBeGreaterThan(0);
  });
});

describe("waiting is recovery copy, in plain words", () => {
  it("says what each pause needs, and says something different for each", () => {
    const copy: Record<MovePause, string> = {
      not_idle: "A Session is busy in this project. The move waits until it’s idle.",
      network: "Volli Cloud didn't answer. Nothing is lost; the move continues when it can.",
      disk_full: "This Mac needs more free disk space. Free some space, then retry.",
      signed_out: "Sign in as the person who started the move. It continues for them.",
      waiting_for_purge:
        "Volli Cloud is still removing this project's earlier copy. The move continues when that finishes.",
      paused: "Paused. Nothing is lost; the move continues when it resumes.",
    };
    for (const pause of PAUSES) {
      const seen = describeMove(row({ state: "frozen", paused: pause }));
      expect(seen).toMatchObject({ state: "waiting", message: copy[pause] });
      expect(INTERNAL_WORDS.test(seen.message)).toBe(false);
      // A pause is not a fault and not a finish.
      expect(seen.completedSteps).toEqual(["backup", "freeze"]);
      expect(seen.step).toBe("export");
    }
    expect(new Set(PAUSES.map((pause) => copy[pause])).size).toBe(PAUSES.length);
  });

  it("keeps a queued move waiting for its turn rather than claiming work", () => {
    expect(describeMove(row({ state: "queued" }))).toEqual({
      state: "queued",
      step: "backup",
      completedSteps: [],
      message: "Waiting for its turn to move.",
    });
    expect(describeMove(row({ state: "queued", paused: "not_idle" }))).toMatchObject({
      state: "waiting",
      step: "backup",
      completedSteps: [],
    });
  });

  it("mentions an unexpected stop without repeating the engine's own text", () => {
    const seen = describeMove(
      row({ state: "objects", paused: "paused", failure: failure("internal") }),
    );
    expect(seen.state).toBe("waiting");
    expect(seen.message).toBe(
      "The move stopped unexpectedly. Nothing is lost; it continues when it resumes.",
    );
    expect(seen.message).not.toContain(RAW);
  });
});

describe("a failure is a code, never prose", () => {
  it("settles a deliberate cancellation quietly but keeps an unaddressed failed move visible", () => {
    expect(describeMove(row({ state: "rolled_back", failure: failure("cancelled") })).state).toBe(
      "rolled-back",
    );
    expect(describeMove(row({ state: "rolled_back" })).state).toBe("rolled-back");
    expect(
      describeMove(row({ state: "rolled_back", failure: failure("rows_refused") })).state,
    ).toBe("problem");
  });
  it("has plain words for every code the engine and the backend record", () => {
    for (const code of FAILURE_CODES) {
      const seen = describeMove(row({ state: "rolled_back", failure: failure(code) }));
      expect(seen.state, code).toBe(code === "cancelled" ? "rolled-back" : "problem");
      expect(seen.message, code).toContain("Nothing on this Mac changed.");
      // The failure's own message, its detail and its ids stay in the journal.
      expect(seen.message, code).not.toContain(RAW);
      expect(seen.message, code).not.toContain(SESSION);
      expect(seen.message, code).not.toContain("sessionEvents");
      expect(seen.message, code).not.toContain("missingBodies");
      expect(INTERNAL_WORDS.test(seen.message), code).toBe(false);
    }
  });

  it("tells a retry from an already-moved project and from ended preview access", () => {
    const copy = (code: string) =>
      describeMove(row({ state: "rolled_back", failure: failure(code) })).message;
    const already = copy("already_migrated");
    const waitlisted = copy("preview_waitlisted");
    const agreement = copy("preview_agreement_required");
    const internal = copy("internal");
    expect(already).toBe(
      "This project is already in Volli Cloud, possibly in another Workspace. Nothing on this Mac changed.",
    );
    expect(waitlisted).toBe(
      "Volli Cloud preview access has ended for this account. Nothing on this Mac changed.",
    );
    expect(agreement).toBe(
      "The Volli Cloud Preview Agreement needs accepting again. Nothing on this Mac changed.",
    );
    expect(new Set([already, waitlisted, agreement, internal]).size).toBe(4);
    expect(agreement).not.toBe(waitlisted);
    expect(internal).toBe("Something stopped the move on this Mac. Nothing on this Mac changed.");
  });

  it("keeps a code this build does not know generic, without its own words", () => {
    for (const code of ["a_later_builds_code", "constructor", "__proto__"]) {
      const seen = describeMove(row({ state: "rolled_back", failure: failure(code) }));
      expect(seen.message, code).toBe("The move stopped. Nothing on this Mac changed.");
      expect(seen.message, code).not.toContain(code);
    }
    const exportFallback = describeMove(
      row({ state: "rolled_back", failure: failure("export_unknown_reason") }),
    );
    expect(exportFallback.message).toBe("Preparing the copy stopped. Nothing on this Mac changed.");
  });

  it("claims an unchanged local copy only once the roll back actually finished", () => {
    for (const code of ["rows_refused", "row_refused", "verification_failed"]) {
      const rolled = describeMove(row({ state: "rolled_back", failure: failure(code) }));
      expect(rolled.state, code).toBe("problem");
      expect(rolled.message, code).toContain("Nothing on this Mac changed.");

      // Still rolling back: the copy holds no such promise.
      const rolling = describeMove(
        row({
          state: "rolling_back",
          journal: { rollbackFrom: "objects" },
          failure: failure(code),
        }),
      );
      expect(rolling.state, code).toBe("moving");
      expect(rolling.message, code).toBe("Rolling this project back to this Mac.");
      expect(rolling.message, code).not.toMatch(/unchanged|Nothing on this Mac changed/i);

      // Moved again: the project starts over, so it is not "rolled back" to the copy.
      const again = describeMove(row({ state: "superseded", failure: failure("runner_replaced") }));
      expect(again.message).not.toMatch(/unchanged|Nothing on this Mac changed/i);
    }
  });

  it("never claims a roll back once the project is in Volli Cloud", () => {
    for (const state of ["committed", "handed_over", "checked"] as const) {
      const seen = describeMove(
        row({
          state,
          committedAt: 5,
          paused: "paused",
          failure: failure("internal", { step: state }),
        }),
      );
      expect(seen.state, state).toBe("problem");
      expect(seen.message, state).toContain("The project stays in Volli Cloud");
      expect(seen.message, state).toContain("this local copy stays read-only.");
      expect(seen.message, state).not.toMatch(/rolled back|Nothing on this Mac changed/i);
      expect(seen.message, state).not.toContain(RAW);
    }
  });

  it("says the move starts again when a fresh move replaces it", () => {
    const causes: Record<string, string> = {
      runner_replaced: "This Mac is a different runner now.",
      app_updated: "Volli was updated after the move began.",
      export_changed: "The prepared copy changed after the move began.",
    };
    for (const [code, cause] of Object.entries(causes)) {
      const seen = describeMove(row({ state: "superseded", failure: failure(code) }));
      expect(seen).toEqual({
        state: "queued",
        step: "backup",
        completedSteps: [],
        message: `${cause} The move starts again from the beginning.`,
      });
    }
  });
});

describe("the states the person acts on", () => {
  it("reads checked as check-it and confirmed as finished", () => {
    expect(describeMove(row({ state: "checked", committedAt: 5 }))).toEqual({
      state: "check",
      step: "check",
      completedSteps: [...STEPS],
      message: "In Volli Cloud. Check the project there.",
    });
    expect(describeMove(row({ state: "confirmed", committedAt: 5, confirmedAt: 9 }))).toEqual({
      state: "finished",
      step: "check",
      completedSteps: [...STEPS],
      message: "Moved to Volli Cloud. This local copy stays read-only.",
    });
    // A recorded problem still needs the person, even at the check.
    expect(
      describeMove(
        row({ state: "checked", committedAt: 5, paused: "paused", failure: failure("internal") }),
      ).state,
    ).toBe("problem");
  });

  it("keeps rolling back and going back to local active", () => {
    const rolling = describeMove(
      row({
        state: "rolling_back",
        committedAt: 5,
        journal: { rollbackFrom: "committed" },
        failure: { ...failure("cancelled"), step: "committed" },
      }),
    );
    expect(rolling).toEqual({
      state: "moving",
      step: "handover",
      completedSteps: ["backup", "freeze", "export", "upload", "copy", "history", "verify"],
      message: "Rolling this project back to this Mac.",
    });

    const returning = describeMove(row({ state: "returning", committedAt: 5, confirmedAt: 9 }));
    expect(returning).toEqual({
      state: "moving",
      step: "check",
      completedSteps: [...STEPS],
      message: "Going back to local. Volli Cloud keeps its copy.",
    });

    expect(describeMove(row({ state: "returned", committedAt: 5, confirmedAt: 9 }))).toEqual({
      state: "returned",
      step: "check",
      completedSteps: [...STEPS],
      message: "Back on this Mac. Volli Cloud keeps its copy.",
    });
  });

  it("needs a person when a roll back or a return stopped", () => {
    const rolling = describeMove(
      row({
        state: "rolling_back",
        committedAt: 5,
        paused: "paused",
        journal: { rollbackFrom: "verified" },
        failure: failure("internal"),
      }),
    );
    expect(rolling.state).toBe("problem");
    expect(rolling.message).toBe(
      "Rolling back stopped. Nothing more happens until the move resumes.",
    );
    expect(rolling.message).not.toMatch(/Nothing on this Mac changed/i);

    const returning = describeMove(row({ state: "returning", paused: "network", committedAt: 5 }));
    expect(returning.state).toBe("problem");
    expect(returning.message).toBe(
      "Going back to local stopped. It continues when the move resumes.",
    );
  });
});

describe("the sheet's copy", () => {
  it("stays plain for every state, pause and failure", () => {
    const messages = new Set<string>();
    for (const state of MOVE_STATES) {
      for (const paused of [null, ...PAUSES]) {
        for (const code of [null, ...FAILURE_CODES, "unknown_code"]) {
          const seen = describeMove(
            row({
              state,
              paused,
              committedAt: state === "committed" ? 5 : null,
              journal: { rollbackFrom: state === "rolling_back" ? "checked" : undefined },
              failure: code === null ? null : failure(code),
            }),
          );
          messages.add(seen.message);
          expect(seen.message.endsWith("."), seen.message).toBe(true);
          expect(INTERNAL_WORDS.test(seen.message), seen.message).toBe(false);
          expect(seen.message, seen.message).not.toContain(RAW);
          expect(seen.message, seen.message).not.toContain(SESSION);
          expect(STEPS).toContain(seen.step);
          for (const step of seen.completedSteps) expect(STEPS).toContain(step);
        }
      }
    }
    expect(messages.size).toBeGreaterThan(FAILURE_CODES.length);
  });
});
