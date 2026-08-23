import type { CliToolStatus } from "../../../ipc/contract";

/**
 * The app-level faults a launch-wide banner is allowed to interrupt someone
 * for. A KIND, not a sentence: dismissal is stored against this word, so
 * rewording the copy never resurrects a notice the user has already put away,
 * and a fault of a different kind is never silenced by a dismissal that was
 * about something else (VC-159/R7).
 */
export type SessionEnvironmentFaultKind = "login-path-unreadable";

/** The one launch-wide fault a Session user must hear without opening Settings. */
export interface SessionEnvironmentAlertState {
  /**
   * The app fault this notice reports, or `null` for the project-readiness
   * notice — a project's own onboarding shortfall, not a fault of the app, and
   * dismissed for the view rather than durably.
   */
  fault: SessionEnvironmentFaultKind | null;
  /**
   * Dismissal identity for a notice with no fault kind behind it. Derived from
   * what was MEASURED, never from how it was worded: a readiness notice used to
   * be put away by comparing its exact sentence, so rewording the copy revived
   * a notice the user had already dismissed. A genuine change in what the
   * project is missing still produces a new key, which is the point — that is
   * news, where a copy edit is not. Faults key on their kind instead and are
   * dismissed durably (see `stores/ui.ts`).
   */
  key: string;
  title: string;
  detail: string;
}

/**
 * Everything one status read found — not just the single notice it renders.
 *
 * The two are deliberately separate. `faults` is the authority on which app
 * faults still exist, and the durable dismissals are reconciled against it; if
 * that reconciliation were fed the notice actually on screen, a dismissed
 * lower-ranked fault would look repaired for as long as a higher-ranked one
 * outranked it, and would speak again the moment that one cleared — the exact
 * defect per-kind dismissal exists to prevent (VC-159/R7).
 */
export interface SessionEnvironmentMeasurement {
  /** Every app fault this read measured, whether or not its notice is the visible one. */
  faults: SessionEnvironmentFaultKind[];
  /** The notices this read raised, most important first. */
  notices: SessionEnvironmentAlertState[];
}

/** A notice that IS an app fault — so its kind reads without a cast or a null check. */
type SessionEnvironmentFaultNotice = SessionEnvironmentAlertState & {
  fault: SessionEnvironmentFaultKind;
};

/** The one project fact the shared alert needs; Configure owns future repair UI. */
export interface ProjectEnvironmentScope {
  name: string;
}

/**
 * The required tools this Session PATH cannot resolve — the one place that is
 * judged. Only what this project implies (VC-157): a Python repo is never
 * short of `node`, a yarn workspace is never short of `pnpm`, and no project
 * is short of `gh` before a PR action asks for it. The wider `tools` record
 * stays measured and reported — in Settings and `volli identify` — without
 * any of it becoming a fault here.
 */
function missingSessionTools(status: Pick<CliToolStatus, "environment">): string[] {
  const { tools, requiredTools } = status.environment.session;
  return requiredTools.filter((tool) => tools[tool] === null);
}

/**
 * "git", "git and gh", "git, gh and node" — a sentence, never a CSV.
 *
 * The readiness notice below renders the SAME list as a plain comma list on
 * purpose, and the difference is not an oversight: it prints under a `Missing
 * from the Session PATH:` label, where a conjunction would read as prose
 * inside a field. This one is spoken mid-sentence, where a CSV would not.
 */
function plainList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The genuine app-level fault, and only it (VC-159/R7).
 *
 * Two conditions, both required. BOTH login-shell passes failed — a boot
 * failure the later interactive pass recovered from left Sessions with a
 * working PATH, and a launch-wide banner about a repair that already happened
 * is noise. AND something a Session needs is consequently unresolvable: a
 * short PATH that still resolves every contract tool has cost the user
 * nothing they can see, so it belongs in Settings → CLI with the rest of the
 * evidence, not above their board.
 *
 * `pending` is not a failure (see `SessionEnvInteractiveProvenance`): the
 * second pass runs after the first window precisely so nothing waits on it.
 *
 * The copy names what a person lost, not how the app measured it. "Login-shell
 * passes", "adoption" and "provenance" are Settings → CLI and `volli doctor`
 * vocabulary; this sentence is somebody's first minute in the product.
 */
function loginPathFault(
  status: Pick<CliToolStatus, "environment">,
): SessionEnvironmentFaultNotice | null {
  const { provenance, interactiveProvenance } = status.environment.session;
  if (provenance !== "probe-failed" || interactiveProvenance !== "probe-failed") return null;
  const missing = missingSessionTools(status);
  if (missing.length === 0) return null;
  return {
    fault: "login-path-unreadable",
    key: "login-path-unreadable",
    title: "Volli couldn't read your terminal's PATH",
    detail: `Sessions can't find ${plainList(missing)}, so some commands may be missing. Fix now asks your terminal again — Sessions you start afterwards get the result.`,
  };
}

/**
 * The project readiness sentence: what was measured, plus the one step it
 * implies. `null` when the project has nothing missing.
 *
 * Missing PATH tools, and NOT missing dependencies (VC-156). A checkout
 * without its `node_modules` is a normal state of the world, not a fault:
 * the agent carries that fact in its own prompt (`RuntimeWorkspaceEnvironment`),
 * with a neutral offer beside the project for whoever would rather run it
 * themselves (`workspace-dependencies-offer.tsx`). What is left here is what
 * the word "fault" still fits: a required tool the Session PATH cannot resolve.
 */
function readinessDetail(status: Pick<CliToolStatus, "environment">): string | null {
  const missingTools = missingSessionTools(status);
  if (missingTools.length === 0) return null;
  // No CLI incantation: a first-run reader is pointed at the door that holds
  // the evidence and the repair button, not handed a command to type.
  return `Missing from the Session PATH: ${missingTools.join(", ")}. If they are installed, open Settings → CLI to repair the Session PATH.`;
}

/**
 * The project-onboarding half of the shared alert.
 *
 * It deliberately returns facts and copy rather than a Configure pane: VC-109
 * owns the project's Git/repair surface. This is its hand-off seam — the add
 * flow can warn now, and Configure can later reuse the exact same report.
 */
export function projectEnvironmentReadiness(
  status: Pick<CliToolStatus, "environment">,
  project: ProjectEnvironmentScope | null,
): SessionEnvironmentAlertState | null {
  if (project === null) return null;
  const detail = readinessDetail(status);
  if (detail === null) return null;
  return {
    fault: null,
    // The measured facts, not the sentence built from them.
    key: `readiness:${project.name}:${missingSessionTools(status).join(",")}`,
    title: `Sessions aren't ready for ${project.name}`,
    detail,
  };
}

/**
 * What one status read found, ranked: the app fault first, the project's own
 * readiness behind it.
 *
 * They are not merged any more (VC-159): the fault already explains why those
 * tools are unreachable, and a banner that appends a second diagnosis to the
 * first is how the error budget was spent in the first place. Only the first
 * notice a reader has not dismissed is drawn — so putting the fault away does
 * not also bury what the project is still missing, which a reader never
 * dismissed and which no repair to the PATH would fix.
 */
export function sessionEnvironmentMeasurement(
  status: Pick<CliToolStatus, "environment">,
  project: ProjectEnvironmentScope | null = null,
): SessionEnvironmentMeasurement {
  const fault = loginPathFault(status);
  const readiness = projectEnvironmentReadiness(status, project);
  return {
    faults: fault === null ? [] : [fault.fault],
    notices: [fault, readiness].filter((notice) => notice !== null),
  };
}
