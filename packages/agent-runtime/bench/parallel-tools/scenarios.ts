/**
 * The task shapes VC-245 asks the baseline to be established on, plus the two
 * shapes that decide whether the optimisation survives contact with Volli.
 *
 * Every scenario is a script of assistant replies. That is the honest place to
 * put the variable, because Pi can only overlap what arrived in one reply:
 * `batched: true` scenarios emit N tool calls in one message, and the control
 * emits one per message. The difference between those two scripts is the
 * difference between parallel mode mattering and parallel mode being
 * unreachable, so the bench states it per scenario rather than assuming it.
 *
 * Latencies come from {@link LatencyProfile}. The default is measured, not
 * guessed — see `probe.ts` and `profile.measured.json`.
 */

import type { BenchTool, ScriptedReply } from "./harness";

/**
 * Per-tool-class latency in milliseconds.
 *
 * Named after what the work reaches rather than after a product tool, because
 * that is what sets the number: anything crossing the network sits in the
 * hundreds, anything on local disk is single-digit, and anything waiting on
 * another Session is unbounded.
 */
export interface LatencyProfile {
  /** `read`, `edit`, `write` — local disk. */
  localFile: number;
  /** `execute` — spawn plus a trivial command. */
  subprocess: number;
  /** `web_fetch`, `web_search` — one HTTPS round trip plus parse. */
  network: number;
  /** `browser_navigate`, `browser_snapshot` — page load plus tree extraction. */
  browser: number;
  /** `session.start` — durable write, then return. */
  sessionStart: number;
  /**
   * `ticket.await` — parked until another Session moves a Ticket.
   *
   * Unbounded in principle. The real-Session audit measured a mean of ~131s
   * over 241 calls, which is the value used: modelling it at network latency
   * (as this file first did) made the `session-fanout` scenario look like a
   * fan-out of fast calls when it is really a fan-out of long parks.
   */
  ticketAwait: number;
  /** One provider round trip. */
  provider: number;
}

/** Placeholder only; `report.ts` loads the measured profile and overrides it. */
export const FALLBACK_PROFILE: LatencyProfile = {
  localFile: 2,
  subprocess: 25,
  network: 400,
  browser: 900,
  sessionStart: 40,
  // Measured: 130,600ms mean over 241 real calls (see the transcript audit).
  ticketAwait: 130_600,
  provider: 1_400,
};

export interface Scenario {
  id: string;
  /** What a person was trying to get done. */
  title: string;
  /** Whether the scripted model puts its independent calls in one reply. */
  batched: boolean;
  tools: (profile: LatencyProfile) => BenchTool[];
  replies: ScriptedReply[];
  /** Why this scenario is in the set. */
  note: string;
}

const done = (text: string): ScriptedReply => ({ text });

/**
 * How much the one genuinely long wait is shrunk so the bench stays runnable.
 *
 * `ticket.await` really does park for ~131s. Three of them, twice per repeat,
 * is over half an hour of sleeping per bench run, which is not a benchmark
 * anyone runs. The sensitivity sweep establishes that the saving is exactly
 * `(n-1) x latency` at every latency tested, so scaling this scenario down and
 * multiplying back is arithmetic rather than estimation — the `session-fanout`
 * row reports scaled milliseconds, and its note carries the real figure.
 */
export const LONG_WAIT_SCALE = 100;

/** N calls to one tool, all in a single assistant reply. */
function batch(name: string, count: number): ScriptedReply {
  return { toolCalls: Array.from({ length: count }, (_, index) => ({ name, args: { n: index } })) };
}

/** N calls to one tool, one per assistant reply — what sequential mode forces. */
function drip(name: string, count: number): ScriptedReply[] {
  return Array.from({ length: count }, (_, index) => ({
    toolCalls: [{ name, args: { n: index } }],
  }));
}

export const SCENARIOS: Scenario[] = [
  {
    id: "control-single-call",
    title: "One direct tool call",
    batched: false,
    note: "The control. One call cannot overlap anything, so any difference between modes here is bench noise and nothing else.",
    tools: (profile) => [{ name: "read", latencyMs: profile.localFile }],
    replies: [batch("read", 1), done("done")],
  },
  {
    id: "browser-tabs-batched",
    title: "Read four independent Browser Tabs",
    batched: true,
    note: "The best case in the product today: four slow, independent, read-only calls the model can legitimately ask for at once.",
    tools: (profile) => [
      { name: "browser_navigate", latencyMs: profile.browser },
      { name: "browser_snapshot", latencyMs: profile.browser },
    ],
    replies: [batch("browser_navigate", 4), done("compared the four tabs")],
  },
  {
    id: "browser-tabs-unbatched",
    title: "Read four Browser Tabs, one reply at a time",
    batched: false,
    note: "The same work the model declined to batch. This is the number to compare against when asking what parallel mode is worth in practice, because the mode cannot help here at all.",
    tools: (profile) => [{ name: "browser_navigate", latencyMs: profile.browser }],
    replies: [...drip("browser_navigate", 4), done("compared the four tabs")],
  },
  {
    id: "repeat-search-filter",
    title: "Six searches, then filter and combine",
    batched: true,
    note: "The fan-out/reduce shape. Parallel mode overlaps the six calls but every result still lands in model context, which is the half of the problem it does not touch.",
    tools: (profile) => [{ name: "web_search", latencyMs: profile.network }],
    replies: [batch("web_search", 6), done("filtered to two matches")],
  },
  {
    id: "session-fanout",
    title: "Start three Sessions, then await their tickets",
    batched: true,
    note: `Side-effecting fan-out, run at 1/${LONG_WAIT_SCALE} scale on the waits. The three starts are quick; the three waits are ~131s each in reality (measured over 241 real calls), so overlapping them would really save ~262s. Nearly all of this scenario's saving lands on calls Volli may not want overlapped at all.`,
    tools: (profile) => [
      { name: "session_start", latencyMs: profile.sessionStart },
      { name: "ticket_await", latencyMs: profile.ticketAwait / LONG_WAIT_SCALE },
    ],
    replies: [batch("session_start", 3), batch("ticket_await", 3), done("three tickets landed")],
  },
  {
    id: "mixed-batch-poisoned",
    title: "Three reads batched with one sequential-only tool",
    batched: true,
    note: "The design trap. One tool carrying executionMode:'sequential' forces Pi to run the WHOLE batch sequentially, so marking side-effecting tools sequential silently removes the win from every batch they appear in.",
    tools: (profile) => [
      { name: "read", latencyMs: profile.localFile },
      { name: "browser_navigate", latencyMs: profile.browser },
      { name: "session_start", latencyMs: profile.sessionStart, executionMode: "sequential" },
    ],
    replies: [
      {
        toolCalls: [
          { name: "browser_navigate", args: { n: 0 } },
          { name: "browser_navigate", args: { n: 1 } },
          { name: "browser_navigate", args: { n: 2 } },
          { name: "session_start", args: { n: 3 } },
        ],
      },
      done("done"),
    ],
  },
];

/** Builds the tool list a scenario needs at a given profile. */
export function scenarioTools(scenario: Scenario, profile: LatencyProfile): BenchTool[] {
  return scenario.tools(profile);
}
