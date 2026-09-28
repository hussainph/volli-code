/**
 * The wedge verdict (VC-86): whether one Session's open turn has been silent
 * long enough to self-report, decided from durable Session state plus the
 * runtime's process-local progress clock.
 *
 * This is the pure half of the session watchdog. The timer, the scan, the
 * process-local `lastProgressAt` clock, and the acts (a durable blocked signal,
 * a notification, an optional self-stop) live in the host beside the runtime
 * that owns the executors; what lives here is the one sentence they act on,
 * kept pure so ten minutes of policy is testable with numbers instead of a
 * clock.
 *
 * ## What counts as wedged
 *
 * A turn is OPEN and has emitted neither a token nor tool progress for the
 * threshold. `lastProgressAt` is deliberately not durable: streamed tokens are
 * transient, and the watchdog's own blocked signal must never make a wedged
 * Session look healthy.
 *
 * ## What deliberately does not count
 *
 * - **No open turn** — a quiet Session between turns is idle, and idleness is
 *   the orchestrator's business (`ticket.await` timeouts), not a malfunction.
 * - **Stopped** — its work was ended on purpose; there is nothing to rescue.
 * - **Awaiting a person** — a permission prompt or question can sit for an
 *   hour legitimately, and it already self-reports through Attention. Calling
 *   it wedged would turn the human's own pace into an agent malfunction,
 *   which is the exact inference the Attention doctrine forbids.
 * - **A tool that is slow, not stuck** — silence inside an open turn is most
 *   often a long tool call, not a wedge. Measured: of 1,066 in-turn silences
 *   over five minutes on ticket Sessions, 1,034 resumed on their own, and the
 *   silences were `ticket_await` waits, `gh pr checks --watch`, `sleep` poll
 *   loops, coverage runs and e2e smokes. So while a tool is in flight the
 *   allowance is the TOOL's, not the turn's: a tool that waits on another
 *   Session or on a person by design never trips; one that declared its own
 *   timeout trips only past that timeout plus a margin; any other trips past
 *   one generous in-flight ceiling — so a genuinely hung tool is still
 *   reported, just not at the pace of a stalled model call.
 * - **A machine that was asleep** — a laptop closed mid-turn comes back with
 *   hours on the wall clock and no progress in them. Suspended time is not
 *   silence: the host measures it and the verdict subtracts it.
 * - **A runtime waiting out the network** — while the runtime holds an active
 *   `transport_retrying` Attention it is doing exactly what it should: waiting
 *   for a machine with no network to get one, or backing off a provider that
 *   dropped it. That wait is unbounded offline by design, and the runtime owns
 *   its own bound online (a retry budget, then a dead-end Attention) and its
 *   own stall cut, so a second observer calling it wedged would only be noise.
 */

import type { RuntimeActivityValue, RuntimeObservation } from "./agent-runtime";
import type { NonCodingToolId } from "./authority";
import { sessionAwaitsUser } from "./session-ledger";
import type { SessionProjection } from "./session-ledger";
import { verbToolWireName } from "./verb-registry";

/**
 * How long an open turn may be silent before the watchdog speaks: one
 * app-wide threshold, the compaction precedent — a single switch, never
 * per-model knobs. Ten minutes is far beyond any healthy model call and far
 * under the three hours the rc-0.1.0 wedges cost to detect by hand.
 *
 * It is also the floor under every tool allowance below: a tool in flight can
 * only ever make the watchdog MORE patient than a bare turn, never less.
 */
export const DEFAULT_SESSION_WATCHDOG_SILENCE_MS = 10 * 60_000;

/**
 * The grace past a tool's own declared timeout before its silence counts.
 *
 * The runtime enforces the timeout itself and reports the call as failed when
 * it fires, so a call still in flight well past it is the runtime failing to
 * end it — the one case worth reporting. The margin covers the kill, the
 * process-group teardown and the result's trip back through the pipeline.
 */
export const SESSION_WATCHDOG_TOOL_TIMEOUT_MARGIN_MS = 2 * 60_000;

/**
 * How long a tool that declared no limit may run silent before it counts.
 *
 * An hour: past the long non-waiting tool calls the measured ledger holds
 * (coverage runs and e2e smoke lanes that ran over five minutes), and still
 * short enough that a genuinely hung command — a `--watch` whose run will
 * never finish — is reported inside the same working session, not the next
 * morning.
 */
export const SESSION_WATCHDOG_IN_FLIGHT_CEILING_MS = 60 * 60_000;

/**
 * The tools whose whole job is to wait, and which therefore never trip.
 *
 * - `ticket_await` / `session_await` park on OTHER Sessions and tickets, and
 *   every Session they can wait on has a watchdog of its own: a wedge there
 *   reports itself, and reporting it again from every waiter is noise.
 * - `ask_user` parks on a person. The open interaction already exempts the
 *   Session (`awaiting-user`); naming the tool too covers the instant between
 *   the call starting and its interaction becoming durable.
 *
 * The await names are read from the verb registry rather than retyped, so a
 * rename there cannot silently turn a by-design wait back into a wedge.
 */
export const SESSION_WATCHDOG_WAITING_TOOLS: ReadonlySet<string> = new Set([
  verbToolWireName("ticket.await")!,
  verbToolWireName("session.await")!,
  "ask_user" satisfies NonCodingToolId,
]);

/**
 * The tools that declare their own limit, and the input field that carries it
 * in seconds. Only `bash` (Pi's name for the `execute` coding tool): a generic
 * `timeout` on an arbitrary MCP tool could be in any unit, and a wrong guess
 * there would either mute a hung call or trip a healthy one.
 */
const DECLARED_TIMEOUT_SECONDS_FIELD: Readonly<Record<string, string>> = { bash: "timeout" };

/** One tool call the runtime has started and not yet finished, as the watchdog sees it. */
export interface SessionInFlightTool {
  /** The runtime's id for this call. */
  activityId: string;
  /** The harness's own tool name, exactly as the activity descriptor carries it. */
  toolName: string;
  /** The call's own declared limit, when its tool declares one and the call gave one. */
  declaredTimeoutMs: number | null;
}

/** A call's declared limit in milliseconds, read from its normalized input. */
export function declaredToolTimeoutMs(
  toolName: string,
  input: RuntimeActivityValue,
): number | null {
  const field = Object.hasOwn(DECLARED_TIMEOUT_SECONDS_FIELD, toolName)
    ? DECLARED_TIMEOUT_SECONDS_FIELD[toolName]!
    : null;
  if (field === null || input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const seconds = (input as { readonly [key: string]: RuntimeActivityValue })[field];
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1_000
    : null;
}

/**
 * The in-flight tool set after one LIVE runtime observation.
 *
 * Fed only from the live path: replayed history may be days old, and a
 * `started` recovered from it is not a call that is running now. A turn
 * boundary or a closed attachment empties the set, so an end event that never
 * arrived cannot outlive the turn it belonged to. Returns the same array when
 * nothing changed, so the caller can keep it by reference.
 */
export function nextInFlightTools(
  current: readonly SessionInFlightTool[],
  observation: RuntimeObservation,
): readonly SessionInFlightTool[] {
  switch (observation.kind) {
    case "activity": {
      const known = current.some(({ activityId }) => activityId === observation.activityId);
      if (observation.state === "started" || observation.state === "progress") {
        if (known) return current;
        const toolName = observation.descriptor.nativeToolName;
        return [
          ...current,
          {
            activityId: observation.activityId,
            toolName,
            declaredTimeoutMs: declaredToolTimeoutMs(toolName, observation.input),
          },
        ];
      }
      return known
        ? current.filter(({ activityId }) => activityId !== observation.activityId)
        : current;
    }
    case "turn":
      return current.length === 0 ? current : [];
    case "attachment":
      return (observation.state === "closed" || observation.state === "failed") &&
        current.length > 0
        ? []
        : current;
    default:
      return current;
  }
}

/**
 * How long a turn may stay silent while this tool is in flight.
 *
 * Never less than the bare-turn threshold: a tool with a 30-second timeout
 * that is somehow still running is caught by the ordinary rule, not earlier.
 */
export function inFlightToolAllowanceMs(tool: SessionInFlightTool, thresholdMs: number): number {
  if (SESSION_WATCHDOG_WAITING_TOOLS.has(tool.toolName)) return Number.POSITIVE_INFINITY;
  const allowance =
    tool.declaredTimeoutMs === null
      ? SESSION_WATCHDOG_IN_FLIGHT_CEILING_MS
      : tool.declaredTimeoutMs + SESSION_WATCHDOG_TOOL_TIMEOUT_MARGIN_MS;
  return Math.max(thresholdMs, allowance);
}

/**
 * Why a Session is not wedged. `reconnecting` means the runtime reports it is
 * waiting out the network; `active` means a turn is open and recent;
 * `tool-running` means it is silent past the bare-turn threshold, but every
 * tool it is waiting on is still inside that tool's own allowance.
 */
export type SessionWedgeCalm =
  | "no-turn"
  | "stopped"
  | "awaiting-user"
  | "reconnecting"
  | "active"
  | "tool-running";

export type SessionWedgeVerdict =
  | { wedged: false; reason: SessionWedgeCalm }
  | {
      wedged: true;
      /** Awake silence: wall-clock silence less the time the machine was suspended. */
      silentForMs: number;
      /** The in-flight tool whose allowance ran out, or null for a turn with none in flight. */
      overdueTool: string | null;
    };

/** What the host knows beyond durable state and the progress clock. */
export interface SessionWedgeContext {
  /** Tool calls the live binding has seen start and not finish. */
  inFlightTools?: readonly SessionInFlightTool[];
  /** Milliseconds the machine was suspended between `lastProgressAt` and `now`. */
  suspendedMs?: number;
}

/** The wedge verdict for one Session and its runtime-observed progress. */
export function sessionWedge(
  projection: Pick<SessionProjection, "turnActive" | "stopped" | "interactions" | "attention">,
  now: number,
  thresholdMs: number,
  /** The process-local instant of the latest token or tool-progress observation. */
  lastProgressAt: number,
  context: SessionWedgeContext = {},
): SessionWedgeVerdict {
  if (!projection.turnActive) return { wedged: false, reason: "no-turn" };
  if (projection.stopped !== null) return { wedged: false, reason: "stopped" };
  if (sessionAwaitsUser(projection)) return { wedged: false, reason: "awaiting-user" };
  if (projection.attention.active.some(({ kind }) => kind === "transport_retrying")) {
    return { wedged: false, reason: "reconnecting" };
  }
  const silentForMs = Math.max(0, now - lastProgressAt - (context.suspendedMs ?? 0));
  if (silentForMs < thresholdMs) return { wedged: false, reason: "active" };
  // The tightest allowance among the calls in flight decides: the turn cannot
  // move until every one of them returns, so one hung call beside a by-design
  // wait is still the wedge — the wait does not shelter it.
  let overdueTool: string | null = null;
  let allowanceMs = thresholdMs;
  const tools = context.inFlightTools ?? [];
  if (tools.length > 0) {
    allowanceMs = Number.POSITIVE_INFINITY;
    for (const tool of tools) {
      const toolAllowanceMs = inFlightToolAllowanceMs(tool, thresholdMs);
      if (toolAllowanceMs < allowanceMs) {
        allowanceMs = toolAllowanceMs;
        overdueTool = tool.toolName;
      }
    }
  }
  return silentForMs >= allowanceMs
    ? { wedged: true, silentForMs, overdueTool }
    : { wedged: false, reason: "tool-running" };
}

/**
 * The machine's sleeps, as the watchdog needs them: enough to subtract
 * suspended time from a silence window, and nothing more.
 *
 * Wall-clock bookkeeping on purpose. A monotonic clock that stopped across
 * sleep would make this unnecessary, but on macOS `process.hrtime` (and so
 * `performance.now()`) was measured to KEEP counting across sleep — its
 * since-boot reading matched `kern.boottime` uptime on a machine with hours of
 * logged sleep — so the host records the OS's own suspend/resume
 * announcements instead.
 */
export interface SuspendLedger {
  /** Completed sleeps, oldest first, at most {@link MAX_SUSPEND_LEDGER_INTERVALS}. */
  readonly intervals: readonly { readonly from: number; readonly to: number }[];
  /** When the machine announced sleep and has not yet announced waking. */
  readonly suspendedSince: number | null;
}

/**
 * How many completed sleeps the ledger keeps. A laptop sleeps a handful of
 * times a day; a silence window that reaches back past the oldest kept sleep
 * is one the watchdog would have tripped on long before.
 */
export const MAX_SUSPEND_LEDGER_INTERVALS = 64;

export const EMPTY_SUSPEND_LEDGER: SuspendLedger = { intervals: [], suspendedSince: null };

/** The machine announced it is going to sleep. A repeat keeps the earliest instant. */
export function suspendLedgerSuspended(ledger: SuspendLedger, at: number): SuspendLedger {
  return ledger.suspendedSince === null ? { ...ledger, suspendedSince: at } : ledger;
}

/** The machine announced it woke. A wake with no sleep recorded changes nothing. */
export function suspendLedgerResumed(ledger: SuspendLedger, at: number): SuspendLedger {
  if (ledger.suspendedSince === null) return ledger;
  const interval = { from: ledger.suspendedSince, to: Math.max(ledger.suspendedSince, at) };
  return {
    intervals: [...ledger.intervals, interval].slice(-MAX_SUSPEND_LEDGER_INTERVALS),
    suspendedSince: null,
  };
}

/**
 * Suspended milliseconds inside `[from, to]`.
 *
 * A sleep still open counts up to `to`: a scan that runs in the instant after
 * wake, before the resume announcement has been delivered — or inside a dark
 * wake, which never announces one — must see the whole night as sleep, not as
 * silence.
 */
export function suspendedMsWithin(ledger: SuspendLedger, from: number, to: number): number {
  const overlap = (start: number, end: number): number =>
    Math.max(0, Math.min(end, to) - Math.max(start, from));
  let total = 0;
  for (const interval of ledger.intervals) total += overlap(interval.from, interval.to);
  if (ledger.suspendedSince !== null) total += overlap(ledger.suspendedSince, to);
  return total;
}
