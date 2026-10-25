/**
 * A Session's Place, as a person reads it: whether the runner it lives on is
 * running it now, or what it is waiting for ("Waiting for hp-mac — asleep
 * since 14:02"). One rule for every surface that names a Session's runner: the
 * Session header, listing rows, the composer's pending line and Settings.
 *
 * The facts come from `runners.places` (the backend's answer for the Places
 * of Sessions the viewer can see; never anyone's private runner list) and the
 * Session's own `turnActive`. A runner status this build does not know is
 * read as waiting, in the backend's own word: the status set is open on read.
 */

/** The most Sessions one `runners.places` read names. */
export const RUNNER_PLACES_MAX_SESSIONS = 64;

/** What `runners.places` says about the runner a Session lives on. */
export interface RunnerPlace {
  readonly id: string;
  readonly name: string;
  /** `mac` | `linux` | `cloud`, open on read. */
  readonly kind: string;
  /** A `RunnerStatus`, open on read. */
  readonly status: string;
  readonly statusChangedAt: number;
  readonly statusReason: string | null;
  /** The viewer owns this runner (it is one of their own machines). */
  readonly owned: boolean;
}

/** Why a Session's Place is not running it now. */
export type SessionPlaceReason =
  | "asleep"
  | "offline"
  | "closed"
  | "updating"
  | "needs_update"
  | "removed"
  | "cut_off"
  | "unknown";

export type SessionPlaceKind = "here" | "online" | "waiting" | "removed";

export interface SessionPlaceState {
  readonly kind: SessionPlaceKind;
  readonly label: string;
  /** When the runner entered the state the label names, when the label says "since". */
  readonly since: number | null;
  readonly reason: SessionPlaceReason | null;
  /** The runner's name, for surfaces that compose their own line. */
  readonly runnerName: string;
}

export interface SessionPlaceInput {
  /** The Session's own facts: whether a turn is in flight. */
  readonly session: { readonly turnActive: boolean };
  readonly runner: RunnerPlace;
  /** This machine's runner id in this launch, or `null` (no runner here). */
  readonly viewerRunnerId: string | null;
  readonly now: number;
  /** How "since" reads (`14:02` today, a date before): the surface's own, locale-aware. */
  readonly formatSince: (at: number, now: number) => string;
}

/** Statuses in which the runner is serving its Sessions. */
const SERVING = new Set(["online", "draining", "degraded"]);

/** Whether a runner is serving its Sessions, and if not, why: one rule for every surface. */
export type RunnerPlaceAvailability =
  | { readonly kind: "serving"; readonly reason: null }
  | {
      readonly kind: "waiting";
      readonly reason: Exclude<SessionPlaceReason, "removed" | "cut_off">;
    }
  | { readonly kind: "removed"; readonly reason: "removed" | "cut_off" };

/**
 * A runner's availability from its status (and why it was revoked): serving
 * (`online`, `draining`, `degraded`), removed (`revoked`: by its owner, or
 * cut off for being used from two places), or waiting with a reason. A status
 * this build does not know is waiting, `unknown`. Read by
 * {@link sessionPlaceState} and by Settings → Runners.
 */
export function runnerPlaceAvailability(
  runner: Pick<RunnerPlace, "status" | "statusReason">,
): RunnerPlaceAvailability {
  if (SERVING.has(runner.status)) return { kind: "serving", reason: null };
  switch (runner.status) {
    case "revoked":
      return {
        kind: "removed",
        reason: runner.statusReason === "credential_reuse" ? "cut_off" : "removed",
      };
    case "asleep":
      return { kind: "waiting", reason: "asleep" };
    case "offline":
      return { kind: "waiting", reason: "offline" };
    case "stopped":
      return { kind: "waiting", reason: "closed" };
    case "updating":
      return { kind: "waiting", reason: "updating" };
    case "upgrade_required":
      return { kind: "waiting", reason: "needs_update" };
    default:
      return { kind: "waiting", reason: "unknown" };
  }
}

/** "Volli is closed" is a Mac's words; another runner was stopped. */
function closedWords(runner: RunnerPlace): string {
  return runner.kind === "mac" ? "Volli is closed" : "stopped";
}

/**
 * Where a Session runs, in a person's words:
 *
 * - `here`: this machine is its Place ("Running on this Mac"); this machine
 *   runs it whatever the backend last heard about it.
 * - `online`: "Running on hp-mac".
 * - `waiting`: "Waiting for hp-mac — asleep since 14:02" (offline since,
 *   Volli is closed, updating, needs an update); with a turn in flight,
 *   "Paused — hp-mac is asleep".
 * - `removed`: "hp-mac was removed from your account" (a teammate's runner:
 *   "hp-mac was removed"), or cut off for being used from two places.
 */
export function sessionPlaceState(input: SessionPlaceInput): SessionPlaceState {
  const { runner, now } = input;
  const { formatSince } = input;
  const name = runner.name;
  const base = { runnerName: name };
  const availability = runnerPlaceAvailability(runner);
  if (availability.kind === "removed") {
    return {
      ...base,
      kind: "removed",
      reason: availability.reason,
      since: runner.statusChangedAt,
      label:
        availability.reason === "cut_off"
          ? `${name} was cut off: it was used from two places`
          : runner.owned
            ? `${name} was removed from your account`
            : `${name} was removed`,
    };
  }
  if (input.viewerRunnerId !== null && input.viewerRunnerId === runner.id) {
    return { ...base, kind: "here", reason: null, since: null, label: "Running on this Mac" };
  }
  if (availability.kind === "serving") {
    return { ...base, kind: "online", reason: null, since: null, label: `Running on ${name}` };
  }
  const reason = availability.reason;
  const since = formatSince(runner.statusChangedAt, now);
  const paused = input.session.turnActive;
  let detail: string;
  let pausedDetail: string;
  let hasSince = false;
  switch (reason) {
    case "asleep":
      detail = `asleep since ${since}`;
      pausedDetail = `${name} is asleep`;
      hasSince = true;
      break;
    case "offline":
      detail = `offline since ${since}`;
      pausedDetail = `${name} is offline`;
      hasSince = true;
      break;
    case "closed":
      detail = closedWords(runner);
      pausedDetail = runner.kind === "mac" ? `Volli is closed on ${name}` : `${name} was stopped`;
      break;
    case "updating":
      detail = "updating";
      pausedDetail = `${name} is updating`;
      break;
    case "needs_update":
      detail = "needs an update";
      pausedDetail = `${name} needs an update`;
      break;
    default:
      detail = runner.status;
      pausedDetail = `${name} is ${runner.status}`;
  }
  return {
    ...base,
    kind: "waiting",
    reason,
    since: hasSince ? runner.statusChangedAt : null,
    label: paused ? `Paused — ${pausedDetail}` : `Waiting for ${name} — ${detail}`,
  };
}

/**
 * The composer's line for a command the backend has queued for this Session's
 * runner: "Sent — waiting for hp-mac" while that runner is not running it;
 * `null` once it is (the command is being delivered) or for no Place.
 */
export function pendingCommandLabel(place: SessionPlaceState | null): string | null {
  if (place === null || place.kind === "here" || place.kind === "online") return null;
  if (place.kind === "removed") return `Not sent — ${place.label}`;
  return `Sent — waiting for ${place.runnerName}`;
}
