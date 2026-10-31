/**
 * Starting a Session on any of the person's runners (C2): the picker's read,
 * its default rule, and what a runner reads back under its lease before it
 * starts the Session a `session.start` job asks for.
 *
 * - `runnerPicker.forComposer` answers {@link RunnerPickerAnswer}; the
 *   backend applies the server half of the default rule
 *   ({@link preferredRunnerId}) and the client the rest
 *   ({@link composerDefaultRunnerId}), because only the client knows which
 *   runner (if any) is the machine it runs on.
 * - `sessionStarts.startContext` answers {@link SessionStartContext} to the
 *   runner holding the job's current lease.
 * - `sessionStarts.status` answers {@link SessionStartStatus} to the person
 *   who started it, so a start queued for a sleeping runner can say "Waiting
 *   for hetzner-1" before its Session exists anywhere.
 *
 * Pure: no clock, no store.
 *
 * Receiving-task wiring: the composer's runner picker (VC-1037) reads
 * `runnerPicker.forComposer`, calls {@link composerDefaultRunnerId} with this
 * Mac's runner id, reads `sessionStarts.status` for a start's pending line,
 * and starts through `sessionStarts.startOn` when the runner is not this Mac.
 * C1's writer (VC-1035) owns the power report {@link runnerPowerOf} reads.
 */
import type { ProjectId, RunnerId, TicketId } from "./ids";
import type { JobStatus } from "./jobs";
import type { RunnerKind, RunnerStatus } from "./runners";

/**
 * `sessionStarts.startOn`'s arguments (C2).
 *
 * `body` is the first message as a UI message's JSON text:
 * `JSON.stringify({ id, role: "user", parts, metadata? })`, the same message a
 * client hands `cloudMessageSubmit` for `sessions.command`. It is NOT a staged
 * artifact: the client cannot bind one, because the backend mints the
 * Session id. The backend builds the canonical artifact for the new Session
 * and `clientRequestId` (`cloudMessageArtifact`), checks it as
 * `sessions.command` checks a body (`readCloudMessageBody`: a user message,
 * at most `INLINE_ARTIFACT_MAX_BYTES` of canonical JSON), stages it, and puts
 * its reference in the job (`firstMessage.body`).
 *
 * `clientRequestId` is a lowercase UUID the client mints once per start and
 * reuses on retry: it is also the job's id and the first message's command id
 * (`sessions.receipt({ sessionId, commandId: clientRequestId })` follows it
 * once the Session exists). `model: null` takes the runner's default;
 * `reasoningLevel` is a `ReasoningLevel` or `null` (the model's default).
 */
export interface SessionStartOnArgs {
  clientRequestId: string;
  runnerId: string;
  projectId: string;
  ticketId: string | null;
  body: string;
  model: { providerId: string; modelId: string; reasoningLevel: string | null } | null;
}

/** `sessionStarts.startOn`'s answer: the Session the runner will start under this id. */
export interface SessionStartOnResult {
  sessionId: string;
}

/** Where a runner draws power from, and whether it is kept working (C1). */
export interface RunnerPower {
  source: "ac" | "battery" | "unknown";
  /** A Mac with "Keep this Mac working" on, or a Linux runner under systemd. */
  alwaysOn: boolean;
}

/** An absent or unreadable power report: nothing is assumed. */
export const UNKNOWN_RUNNER_POWER: RunnerPower = { source: "unknown", alwaysOn: false };

/**
 * The power a stored capability report states (`capabilities.power`, C1),
 * read tolerantly: a report from a runner that predates it, or one this build
 * cannot read, is {@link UNKNOWN_RUNNER_POWER}.
 */
export function runnerPowerOf(capabilities: unknown): RunnerPower {
  if (capabilities === null || typeof capabilities !== "object") return UNKNOWN_RUNNER_POWER;
  const power = (capabilities as { power?: unknown }).power;
  if (power === null || typeof power !== "object") return UNKNOWN_RUNNER_POWER;
  const { source, alwaysOn } = power as { source?: unknown; alwaysOn?: unknown };
  return {
    source: source === "ac" || source === "battery" ? source : "unknown",
    alwaysOn: alwaysOn === true,
  };
}

/** The job kind a runner names in `capabilities.tools` when it executes `session.start`. */
export const SESSION_START_CAPABILITY = "session.start";

/**
 * Whether a runner's stored report says it cannot execute `session.start`: it
 * reported its job capabilities and this one is not among them (a build from
 * before this job had an executor). A runner that never reported is not
 * judged: its first report decides, and a job queued for it meanwhile waits.
 */
export function lacksSessionStart(capabilities: unknown): boolean {
  if (capabilities === null || typeof capabilities !== "object") return false;
  const tools = (capabilities as { tools?: unknown }).tools;
  return Array.isArray(tools) && !tools.includes(SESSION_START_CAPABILITY);
}

/** One of the person's runners, as the composer's picker shows it. */
export interface RunnerPickerRow {
  id: RunnerId;
  name: string;
  kind: RunnerKind;
  status: RunnerStatus;
  statusChangedAt: number;
  power: RunnerPower;
  /** Providers with a model credential signed in on the runner (never a value). */
  providers: string[];
  version: string;
  /** The runner is below the minimum version: it takes no new work until it updates. */
  upgradeRequired: boolean;
}

export interface RunnerPickerAnswer {
  runners: RunnerPickerRow[];
  /**
   * The server half of the default rule ({@link preferredRunnerId}); `null`
   * when no online runner is always on and plugged in, and the client
   * decides ({@link composerDefaultRunnerId}).
   */
  defaultRunnerId: RunnerId | null;
}

/**
 * The runner a new Session goes to unless the person picks another: among
 * `online` runners, one that is always on and on AC power, the most recently
 * active first (the latest to have come online: the backend's own record of
 * activity, since heartbeats are not something a client read may follow).
 * `null` when there is none.
 */
export function preferredRunnerId(
  runners: readonly Pick<RunnerPickerRow, "id" | "status" | "statusChangedAt" | "power">[],
): RunnerId | null {
  const preferred = runners
    .filter(
      (runner) =>
        runner.status === "online" && runner.power.alwaysOn && runner.power.source === "ac",
    )
    .toSorted((a, b) => b.statusChangedAt - a.statusChangedAt || (a.id < b.id ? -1 : 1));
  return preferred[0]?.id ?? null;
}

/**
 * The composer's default runner: the backend's preferred one, else this Mac
 * when it is one of the person's runners, else the first online runner, else
 * none (`null`: the composer starts here, as without the picker).
 */
export function composerDefaultRunnerId(
  answer: RunnerPickerAnswer,
  thisRunnerId: string | null,
): RunnerId | null {
  if (answer.defaultRunnerId !== null) return answer.defaultRunnerId;
  const here = answer.runners.find((runner) => runner.id === thisRunnerId);
  if (here !== undefined) return here.id;
  return answer.runners.find((runner) => runner.status === "online")?.id ?? null;
}

/**
 * What a runner reads, under the current lease of a `session.start` job,
 * before it starts the Session: the facts as they are NOW, never as they were
 * at enqueue.
 *
 * - `ready`: the project is still one the runner's owner may work in.
 *   `ticket` is `null` for a Board Session; `live` is false once the ticket is
 *   deleted or archived. `body` is the staged first message (`null` when
 *   nothing is staged under the reference any more). `runnerName` is how the
 *   person knows this runner, for a refusal they will read.
 * - `unavailable`: the lease is gone (`lease_lost`), or the project is no
 *   longer the owner's to work in (`project_unavailable`).
 */
export type SessionStartContext =
  | {
      kind: "ready";
      projectId: ProjectId;
      ticket: { id: TicketId; live: boolean } | null;
      runnerName: string;
      body: string | null;
    }
  | { kind: "unavailable"; reason: "lease_lost" | "project_unavailable" };

/**
 * A start as the person who asked for it reads it, before and after its
 * Session exists: `queued` (the runner has not picked it up; "Waiting for
 * <runner>" when the runner is not online), `starting` (a runner holds it),
 * `started`, or `failed` with the runner's or backend's reason.
 */
export interface SessionStartStatus {
  sessionId: string;
  state: "queued" | "starting" | "started" | "failed";
  runner: {
    id: RunnerId;
    name: string;
    kind: RunnerKind;
    status: RunnerStatus;
    statusChangedAt: number;
  } | null;
  failure: { code: string; detail: string | null } | null;
}

/** The job statuses as a start reads them. */
export function sessionStartState(jobStatus: JobStatus): SessionStartStatus["state"] {
  switch (jobStatus) {
    case "queued":
      return "queued";
    case "leased":
      return "starting";
    case "done":
      return "started";
    default:
      return "failed";
  }
}
