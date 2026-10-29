/**
 * What the move sheet says: one durable journal row (`MoveRow`) folded into
 * the four person-facing fields of `CloudMoveStatus` — where a move stands,
 * which step is running, and what is happening in plain words.
 *
 * Two rules shape it, and both are traps if broken:
 *
 * - **A state is the last step that COMPLETED** (`states.ts`), so the step
 *   shown is the one still to run, and nothing reads as done until it is.
 *   `checked` is the person's "Check it", `confirmed` their finished move;
 *   a roll back never shows the last step complete, because the project did
 *   not stay where that step put it.
 * - **A failure is a code, never prose.** `MoveFailure.message` carries raw
 *   text (a thrown error's own message for `internal`, the backend's for a
 *   refusal) and `detail` names rows and Sessions, so every word here is
 *   chosen from `code` alone. Only a row that actually reached `rolled_back`
 *   may say the local copy is unchanged; after the commit the cloud copy
 *   stays, so nothing claims a roll back.
 *
 * Main's `createDesktopCloudMoves` adapter builds each `CloudMoveStatus` from
 * a journal row — the rest of it (actions, counts, checks, paths) from the
 * journal and the engine, these four fields from here. Nothing here reads the
 * database, grants an action, or imports Node or Electron.
 */
import { CLOUD_MOVE_STEPS, type CloudMoveStatus } from "@volli/shared";
import type { MoveFailure, MovePause, MoveRow, MoveState } from "@volli/host-core/cloud-move";

/** The fields of a `CloudMoveStatus` this module owns. */
export type MovePresentation = Pick<
  CloudMoveStatus,
  "state" | "step" | "completedSteps" | "message"
>;

/** The move sheet's steps, in the order it lists them. */
const STEPS = CLOUD_MOVE_STEPS;

const LAST = STEPS.length - 1;
/** Index of `check`: the one step a roll back may never report as complete. */
const CHECK = STEPS.indexOf("check");

/**
 * How far the sheet's steps got for a move in `state`: the index of its last
 * completed step, or -1 for none. The spill-overs are the plan's coarse
 * phases, not the engine's: a step the engine performs in one transition
 * (the backup and the freeze) completes together, and the read-back keeps
 * `verify` current through the commit, which re-checks the counts.
 * `returning` and `returned` report what the move had completed before it
 * went back; `rolling_back`, `rolled_back` and `superseded` are -1, because a
 * roll back leaves nothing complete and a replaced move starts over.
 */
const LAST_COMPLETED: Record<MoveState, number> = {
  queued: -1,
  frozen: 1,
  exported: 2,
  reserved: 2,
  staged: 2,
  objects: 3,
  rows: 4,
  history: 5,
  verified: 5,
  committed: 6,
  handed_over: 7,
  checked: 8,
  confirmed: 8,
  rolling_back: -1,
  rolled_back: -1,
  returning: 8,
  returned: 8,
  superseded: -1,
};

// ── recovery copy ────────────────────────────────────────────────────────────

/** Each pause in the engine's own terms, said as what the person sees next. */
const PAUSE_COPY: Record<MovePause, string> = {
  not_idle: "A Session is busy in this project. The move waits until it’s idle.",
  network: "Volli Cloud didn't answer. Nothing is lost; the move continues when it can.",
  disk_full: "This Mac needs more free disk space. Free some space, then retry.",
  signed_out: "Sign in as the person who started the move. It continues for them.",
  waiting_for_purge:
    "Volli Cloud is still removing this project's earlier copy. The move continues when that finishes.",
  paused: "Paused. Nothing is lost; the move continues when it resumes.",
};

/**
 * Why a move stopped, keyed by the codes the engine and the backend actually
 * record (`engine.ts` problems, `backend.ts` refusals, the plan's refusals).
 * Deliberately says nothing a raw message or a row count would have said.
 */
const FAILURE_COPY: Readonly<Record<string, string>> = {
  // This Mac's own data and the export.
  unknown_project: "The project is no longer on this Mac.",
  project_removed: "The project was removed from this Mac's rail.",
  pending_runner_work: "This project still has work queued on this Mac.",
  export_source_unreadable: "This Mac's local data could not be read.",
  export_schema_unsupported: "This Mac's local data was written by a different Volli version.",
  export_source_corrupt: "This Mac's local data failed its integrity check.",
  export_integrity: "The prepared copy did not match its own check.",
  export_io_failed: "This Mac's disk refused a file the move needed.",
  export_worker_failed: "Preparing the copy stopped without finishing.",
  export_output_exists: "A prepared copy was already there.",
  local_file_unreadable: "A file this move reads on this Mac is gone or unreadable.",
  // The plan: what the export holds.
  not_one_project: "The prepared copy holds more than one project.",
  row_refused: "A record in this project cannot move.",
  row_unstorable: "Volli Cloud cannot store a record in this project.",
  duplicate_ticket_key: "Two tickets in this project share a number.",
  orphan_event: "A Session's history names a Session that is not in this project.",
  sequence_gap: "A Session's history has a gap in its events.",
  object_key: "A file in the prepared copy belongs to another project.",
  legacy_outside_project: "An older record in the prepared copy belongs to another project.",
  // The move itself.
  object_conflict: "A file did not match the one Volli Cloud already had.",
  rows_refused: "Volli Cloud refused some records.",
  history_incomplete: "A Session's history could not be copied whole.",
  verification_failed: "A check did not match.",
  internal: "Something stopped the move on this Mac.",
  cancelled: "You rolled this project back.",
  // Moved again under a fresh move.
  runner_replaced: "This Mac is a different runner now.",
  app_updated: "Volli was updated after the move began.",
  export_changed: "The prepared copy changed after the move began.",
  // Volli Cloud's answers.
  already_migrated: "This project is already in Volli Cloud, possibly in another Workspace.",
  import_in_progress: "Volli Cloud is still removing this project's earlier copy.",
  move_conflict: "Volli Cloud already knows a different version of this move.",
  runner_unavailable: "Volli Cloud does not know this Mac's runner any more.",
  import_closed: "Volli Cloud closed this move.",
  import_committed: "Volli Cloud already showed this project.",
  manifest_mismatch: "The prepared copy is not the one Volli Cloud expected.",
  changed_since_commit: "The cloud copy changed after the move finished.",
  invalid_rescue_target: "Volli Cloud refused where this project would go.",
  invalid_key: "Volli Cloud refused a file's location.",
  invalid_argument: "Volli Cloud refused the move's details.",
  storage_unconfigured: "Volli Cloud's file storage is not set up.",
  backend_error: "Volli Cloud did not accept the move.",
  not_found: "Volli Cloud no longer has this move.",
  not_a_member: "You are no longer a member of this Workspace.",
  forbidden: "Your role in this Workspace cannot move projects.",
  unauthenticated: "Volli Cloud did not accept the sign-in.",
  no_viewer: "This account is not set up in Volli Cloud yet.",
  account_deleted: "This account has been deleted.",
  account_deletion_pending: "This account is scheduled for deletion.",
  identity_conflict: "This sign-in belongs to a different account.",
  not_a_person: "Volli Cloud did not accept the sign-in.",
  preview_waitlisted: "Volli Cloud preview access has ended for this account.",
  preview_agreement_required: "The Volli Cloud Preview Agreement needs accepting again.",
};

/** A code this build does not know still reads as a stopped move, never as its message. */
const UNKNOWN_FAILURE = "The move stopped.";
const EXPORT_FAILED = "Preparing the copy stopped.";

/** What a rolled back move may promise: true only after the roll back finished. */
const LOCAL_UNCHANGED = "Nothing on this Mac changed.";
/** After the commit the cloud copy is the project; the local one stays the archive. */
const CLOUD_STAYS = "The project stays in Volli Cloud, and this local copy stays read-only.";
const STARTS_AGAIN = "The move starts again from the beginning.";
const ROLLING_BACK = "Rolling this project back to this Mac.";
const ROLLBACK_STOPPED = "Rolling back stopped. Nothing more happens until the move resumes.";
const RETURNING = "Going back to local. Volli Cloud keeps its copy.";
const RETURN_STOPPED = "Going back to local stopped. It continues when the move resumes.";
const RETURNED = "Back on this Mac. Volli Cloud keeps its copy.";
const WAITING_TURN = "Waiting for its turn to move.";
const CHECK_IT = "In Volli Cloud. Check the project there.";
const FINISHED = "Moved to Volli Cloud. This local copy stays read-only.";

function failureCopy(code: string): string {
  if (Object.hasOwn(FAILURE_COPY, code)) return FAILURE_COPY[code]!;
  // An export that stopped for a reason this build has no words for.
  return code.startsWith("export_") ? EXPORT_FAILED : UNKNOWN_FAILURE;
}

function failureWhat(failure: MoveFailure | null): string {
  return failure === null ? UNKNOWN_FAILURE : failureCopy(failure.code);
}

/** What the running move is doing, by the state it last completed. */
function forwardCopy(state: MoveState): string {
  switch (state) {
    case "frozen":
      return "Preparing the files to move.";
    case "exported":
    case "reserved":
    case "staged":
      return "Uploading files.";
    case "objects":
      return "Copying records.";
    case "rows":
      return "Uploading Session history.";
    case "history":
      return "Checking every record.";
    case "verified":
      return "Adding the project to Volli Cloud.";
    case "committed":
      return "In Volli Cloud. Finishing this Mac's part.";
    case "handed_over":
      return "In Volli Cloud. Checking the project there.";
    default:
      return "Moving.";
  }
}

// ── projection ───────────────────────────────────────────────────────────────

function present(
  state: MovePresentation["state"],
  last: number,
  message: string,
): MovePresentation {
  return {
    state,
    step: STEPS[Math.min(last + 1, LAST)]!,
    completedSteps: STEPS.slice(0, last + 1),
    message,
  };
}

/**
 * A roll back shows how far the project got before it began undoing it, and
 * never the last step: the project is not staying where that step put it.
 */
function rollbackProgress(row: MoveRow): number {
  const origin = row.journal.rollbackFrom ?? row.failure?.step;
  if (origin === undefined) return -1;
  return Math.min(LAST_COMPLETED[origin], CHECK - 1);
}

/** How far this row's steps got: its own state, or where its roll back started. */
function progressOf(row: MoveRow): number {
  return row.state === "rolling_back" ? rollbackProgress(row) : LAST_COMPLETED[row.state];
}

/**
 * The four fields of a move's status. Every engine state, pause and recorded
 * failure code answers here; `row.journal`, `row.failure` and `row.committedAt`
 * are the only facts used, and none of their prose reaches the person.
 */
export function describeMove(row: MoveRow): MovePresentation {
  const state = row.state;

  // A move that went back: settled, never read-only and never "done".
  if (state === "rolled_back")
    return present(
      row.failure === null || row.failure.code === "cancelled" ? "rolled-back" : "problem",
      -1,
      `${failureWhat(row.failure)} ${LOCAL_UNCHANGED}`,
    );
  if (state === "returned") return present("returned", CHECK, RETURNED);
  if (state === "superseded")
    return present("queued", -1, `${failureWhat(row.failure)} ${STARTS_AGAIN}`);

  // The person's own resting points: the finished move and the check they make.
  if (state === "confirmed") return present("finished", CHECK, FINISHED);

  // A roll back or a return is active work on the move's own record, so it is
  // never the "needs you" answer below, and its copy holds no unchanged claim.
  const undoing = state === "rolling_back" || state === "returning";

  // After the commit a problem leaves the cloud copy in place: the person
  // decides, so it needs them, and the copy claims no roll back. `committedAt`
  // is the row's own record that Volli Cloud showed the project.
  if (!undoing && row.failure !== null && row.committedAt !== null)
    return present("problem", progressOf(row), `${failureWhat(row.failure)} ${CLOUD_STAYS}`);
  if (state === "checked") return present("check", CHECK, CHECK_IT);

  // A roll back or a return that stopped is not active: it waits on a person.
  if (undoing && row.paused !== null)
    return present(
      "problem",
      progressOf(row),
      state === "returning" ? RETURN_STOPPED : ROLLBACK_STOPPED,
    );
  if (row.paused !== null)
    return present(
      "waiting",
      progressOf(row),
      row.paused === "paused" && row.failure !== null
        ? "The move stopped unexpectedly. Nothing is lost; it continues when it resumes."
        : PAUSE_COPY[row.paused],
    );

  if (state === "rolling_back") return present("moving", progressOf(row), ROLLING_BACK);
  if (state === "returning") return present("moving", CHECK, RETURNING);
  // The first step runs before any state advances past `queued`, so a queued
  // move is either waiting its turn or in its snapshot: say the honest one.
  if (state === "queued") return present("queued", -1, WAITING_TURN);
  return present("moving", progressOf(row), forwardCopy(state));
}
