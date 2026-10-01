/**
 * Replay of a Code Mode run never repeats a completed call (VC-471).
 *
 * Every nested call's id is derived from the outer call: `<outer id>:<n>`,
 * where `n` counts the calls in the order the program issued them. A program
 * is deterministic given its inputs — the VM is single-threaded, has no timers
 * and no I/O, and `Date` and `Math.random` are pinned per run (see the
 * prelude) — so a run of the same outer call issues the same calls in the same
 * order for as long as it receives the same results.
 *
 * The journal holds those results. When the same outer call id runs again —
 * a host retry, a replayed drive, a run cancelled half-way and started over —
 * each call that completed the first time answers from the journal instead of
 * running, and the program carries on from where real work is needed. A call
 * that never completed (it was in flight when the run stopped) runs, because
 * nothing says it happened.
 *
 * If the program issues a DIFFERENT call at a position the journal already
 * holds — another tool, other arguments — the replay has diverged, and the run
 * stops there with nothing executed for that call. Continuing would either
 * hand the program another call's result or run a call whose position a
 * completed one already claimed; both are wrong in ways the program cannot see.
 *
 * Scope, stated plainly: the journal lives as long as the attachment. Pi's
 * `Agent` never runs a tool call twice within an attachment, and a relaunch
 * does not re-run an unfinished tool call at all, so the journal is the
 * guarantee for any future path that does replay, not a fix for a replay that
 * happens today. The durable half of replay safety is where it already was:
 * Volli verbs derive their operation id from the call id they are handed, so a
 * nested `session.start` replayed after a relaunch is still one start.
 */

import type { ShapedOutcome } from "./shape";

/** One completed nested call, as the journal remembers it. */
export interface JournaledCall {
  name: string;
  /** The arguments as canonical JSON, so the same call is recognised whatever its key order. */
  argumentsKey: string;
  outcome: ShapedOutcome;
}

/** One outer call's record. */
export interface RunJournal {
  /** The run's pinned clock, in epoch milliseconds. */
  epoch: number;
  calls: Map<number, JournaledCall>;
  /** How many times this outer call has been run before this one. */
  previousRuns: number;
}

/** Runs remembered per attachment; the oldest is forgotten first. */
export const JOURNAL_RUNS = 64;

export class CodeModeJournal {
  readonly #runs = new Map<string, RunJournal>();
  readonly #capacity: number;

  constructor(capacity = JOURNAL_RUNS) {
    this.#capacity = capacity;
  }

  /** The record for one outer call: the existing one on a replay, a fresh one otherwise. */
  open(outerId: string, now: number): RunJournal {
    const existing = this.#runs.get(outerId);
    if (existing !== undefined) {
      existing.previousRuns += 1;
      // Most recently used last, so eviction takes the stalest run.
      this.#runs.delete(outerId);
      this.#runs.set(outerId, existing);
      return existing;
    }
    const run: RunJournal = { epoch: now, calls: new Map(), previousRuns: 0 };
    this.#runs.set(outerId, run);
    while (this.#runs.size > this.#capacity) {
      this.#runs.delete(this.#runs.keys().next().value!);
    }
    return run;
  }
}

/** JSON with object keys sorted, so two spellings of the same arguments compare equal. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

/** A 32-bit seed from a string (FNV-1a), for the run's pinned `Math.random`. */
export function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * One line of JavaScript that pins `Math.random` and `Date` for a run.
 *
 * Prepended to the program's first line rather than given a line of its own,
 * so every line number a stack trace reports is the program's own. `Date` is
 * replaced by a function that answers the run's epoch for `Date.now()` and a
 * bare `new Date()`, and defers to the real one for any explicit date.
 */
export function determinismPrelude(seed: number, epoch: number): string {
  return (
    `(()=>{let s=${seed}|0;Math.random=()=>{s=(s+0x6D2B79F5)|0;let t=Math.imul(s^(s>>>15),1|s);` +
    `t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296};` +
    `const R=Date,T=${epoch};const D=function(...a){return new.target?(a.length===0?new R(T):new R(...a)):new R(T).toString()};` +
    `D.prototype=R.prototype;D.now=()=>T;D.parse=R.parse;D.UTC=R.UTC;globalThis.Date=D})();`
  );
}
