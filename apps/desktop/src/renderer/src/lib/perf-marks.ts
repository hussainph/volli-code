/**
 * Phase marks for the performance harness — off unless a window asks for them.
 *
 * VC-385 needed a ticket switch broken into its parts (palette, workspace
 * rebuild, description editor) rather than one latency number, and the only
 * place that knows where those boundaries fall is the renderer that crosses
 * them. So each boundary stamps a `performance.mark`, and
 * `e2e/bench/performance/ticket-switch-breakdown.mjs` reduces the stamps into
 * segments.
 *
 * They are OFF by default, and the flag is set by the measuring page rather
 * than read from a build flag or an environment variable: marks nobody reads
 * are an unbounded buffer growing behind a person who never asked to be
 * measured, and a renderer in a packaged app has no environment to read
 * anyway. A harness turns them on with one `page.evaluate` before the window it
 * cares about; every other run pays a single property read per boundary.
 */

/**
 * The global a measuring page sets to `true` to switch phase marks on.
 *
 * Named like `vc353Capture`, the harness's other page-side hook, rather than
 * with an underscore prefix: same kind of thing, same spelling.
 */
export const PERF_MARKS_FLAG = "volliPerfMarks";

/**
 * The boundaries a ticket switch crosses.
 *
 * These strings are the contract with `TICKET_SWITCH_MARKS` in
 * `e2e/bench/performance/ticket-switch-breakdown.mjs`, which cannot import them
 * (that file runs under plain Node, this one under the renderer's bundler).
 * The reducer reports any mark it never saw and the harness fails the run on a
 * non-empty list, so a rename here surfaces as a failed measurement rather than
 * as a phase that silently reads as zero.
 */
export const PERF_PHASE = Object.freeze({
  ticketSwitchStart: "volli.ticket-switch.start",
  commandPaletteOpen: "volli.command-palette.open",
  commandPaletteSessionsListed: "volli.command-palette.sessions-listed",
  ticketSwitchCommit: "volli.ticket-switch.commit",
  ticketWorkspaceMount: "volli.ticket-workspace.mount",
  ticketDescriptionReady: "volli.ticket-description.ready",
});

/** Whether this window has been asked to stamp phase marks. */
export function perfPhaseMarksEnabled(): boolean {
  return (globalThis as Record<string, unknown>)[PERF_MARKS_FLAG] === true;
}

/** The slice of `Performance` a phase mark needs. */
export interface PerfMarkHost {
  mark(name: string): unknown;
}

/**
 * Stamps one phase boundary, when this window is being measured.
 *
 * `host` is injected for tests only; production callers pass nothing and get
 * the page's own timeline, which is where the harness looks.
 */
export function markPerfPhase(
  name: string,
  host: PerfMarkHost | undefined = globalThis.performance,
): void {
  if (!perfPhaseMarksEnabled() || host === undefined) return;
  host.mark(name);
}
