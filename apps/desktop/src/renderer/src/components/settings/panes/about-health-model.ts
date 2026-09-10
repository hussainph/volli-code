/**
 * What Settings → About is allowed to SAY about this install, given what it
 * has actually managed to measure (VC-293).
 *
 * The pane used to compute one boolean — `faults.length === 0` — over state
 * that starts EMPTY and is refilled by two independent async reads. Empty is
 * indistinguishable from healthy under that rule, so the panel opened on
 * "Everything's working" before it had asked anything, and returned to it
 * whenever a read failed: the fault lists were empty then too. A person
 * looking at a broken install was told it was fine, by a surface whose entire
 * job is to answer that one question.
 *
 * So the answer is a STATE, not a boolean, and each of the four states is
 * reachable only from evidence:
 *
 *  - `checking` — at least one read is still in flight. Nothing measured is
 *    presented as current, including findings from the read this one replaces.
 *  - `unavailable` — a read failed. The panel says the checks could not be
 *    completed, keeps whatever the OTHER read did establish, and never offers
 *    a repair for a picture it does not have.
 *  - `attention` — both reads landed and found something wrong.
 *  - `healthy` — both reads landed and found nothing. The only path to
 *    "Everything's working", and it requires two completed reads to reach.
 *
 * Pure, and tested at 100%, for the reason the rest of this directory is: the
 * decision is invisible in a screenshot of the happy case, which is exactly
 * how the original defect survived.
 */
import { doctorCheckHeadline, LEGACY_DOCTOR_REMEDY, type DoctorCheck } from "@volli/shared";

import {
  cliStatusDisclosure,
  cliStatusFaultTitle,
  type CliStatusRow,
} from "@renderer/components/pages/cli-status-model";

import type { CopyReportAvailability } from "./copy-report-dialog";

/** One measured input's own progress. Shared with the report gate's vocabulary. */
export type AboutFactState = CopyReportAvailability;

/** What About may claim, in ascending order of confidence. */
export type AboutHealthState = "checking" | "unavailable" | "attention" | "healthy";

/** One thing that is wrong, as the panel draws it. */
export interface AboutFault {
  id: string;
  /** States the problem on its own — a reader must not need the detail to understand it. */
  headline: string;
  /** The one thing to do about it; the measurement behind it lives in the report. */
  detail: string;
}

export interface AboutHealth {
  state: AboutHealthState;
  headline: string;
  faults: readonly AboutFault[];
  /**
   * Whether a repair may be offered. Only from `attention`: Fix re-runs the
   * doctor probe against the picture the fault list came from, and a picture
   * that is half-measured or still arriving is not one a repair can answer.
   * Re-check remains available in every state, which is what a failed read
   * actually needs.
   */
  canFix: boolean;
}

export interface AboutHealthInput {
  /** The CLI status read for the current project. */
  status: AboutFactState;
  /** The Doctor probe for the current project. */
  doctor: AboutFactState;
  rows: readonly CliStatusRow[];
  checks: readonly DoctorCheck[];
}

/**
 * A Doctor finding, headed by what went WRONG rather than by the check's
 * positive claim, and detailed by the remedy the check computed. An older
 * producer may not have sent a remedy; that compatibility path gets generic
 * repair guidance rather than putting its diagnostic measurement on the page.
 */
function doctorFaults(checks: readonly DoctorCheck[]): AboutFault[] {
  return checks
    .filter((check) => check.status !== "ok")
    .map((check) => ({
      id: check.id,
      headline: doctorCheckHeadline(check),
      detail: check.remedy ?? LEGACY_DOCTOR_REMEDY,
    }));
}

/**
 * Warning-toned STATUS rows are faults too, and the split comes from
 * `cliStatusDisclosure` (VC-64) rather than being re-derived here.
 *
 * Without it the two halves of "is this install healthy" disagree: the Doctor
 * decides the headline while a warning discovered by detection sits inside a
 * collapsed disclosure, so the panel can say "Everything's working" over a
 * hidden row that says the CLI is not on PATH. Its diagnostic measurement
 * stays in the report; the page gets the corrective action assigned by the
 * status model. The fallback exists only for an older caller.
 */
function statusFaults(rows: readonly CliStatusRow[]): AboutFault[] {
  return cliStatusDisclosure(rows).attentionRows.map((row) => ({
    id: `cli-status:${row.key}`,
    headline: cliStatusFaultTitle(row),
    detail: row.remedy ?? "Select Re-check for current repair guidance.",
  }));
}

/** The panel's whole answer, from the two reads and what they found. */
export function aboutHealth({ status, doctor, rows, checks }: AboutHealthInput): AboutHealth {
  // Each read contributes findings only while it is the CURRENT, completed
  // one: a read in flight would otherwise present the previous project's
  // answer as this project's, which is the stale-result failure this pane's
  // scope guard exists to prevent.
  const faults = [
    ...(doctor === "ready" ? doctorFaults(checks) : []),
    ...(status === "ready" ? statusFaults(rows) : []),
  ];

  // A known failure outranks a concurrent read: this set of checks can no
  // longer complete, so continuing to say "Checking…" would hide the recovery
  // action behind work whose answer cannot make the set whole.
  if (status === "unavailable" || doctor === "unavailable") {
    return {
      state: "unavailable",
      headline: "Couldn't complete these checks",
      faults,
      canFix: false,
    };
  }
  if (status === "loading" || doctor === "loading") {
    return { state: "checking", headline: "Checking…", faults: [], canFix: false };
  }
  if (faults.length === 0) {
    return { state: "healthy", headline: "Everything's working", faults, canFix: false };
  }
  return {
    state: "attention",
    headline: `${faults.length} thing${faults.length === 1 ? "" : "s"} need${faults.length === 1 ? "s" : ""} attention`,
    faults,
    canFix: true,
  };
}

/**
 * The report gate. A support report is only worth sending when it is whole, so
 * one missing input disables Copy — and a failed input says so instead of
 * spinning forever, because a hole left by a failure will not fill itself.
 */
export function aboutReportAvailability(inputs: readonly AboutFactState[]): CopyReportAvailability {
  if (inputs.includes("unavailable")) return "unavailable";
  return inputs.includes("loading") ? "loading" : "ready";
}

/**
 * Whether a landed read answers the project currently on screen.
 *
 * A read is about the directory it was made in (VC-157), so one that lands
 * after the selection moved is not a slow answer to the current question — it
 * is an answer to a different one, and presenting it would show an earlier
 * read as the current result. It reads as still loading, which is what it is:
 * the read for THIS scope is in flight.
 */
export function scopedFactState(
  loadedScope: string | null | undefined,
  currentScope: string | null,
  state: AboutFactState,
): AboutFactState {
  return loadedScope === currentScope ? state : "loading";
}
