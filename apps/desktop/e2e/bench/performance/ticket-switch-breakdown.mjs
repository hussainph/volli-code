/**
 * VC-385 — what a ticket switch is actually made of.
 *
 * The switch's latency has always been one number, and the ticket's own review
 * showed the number contains at least three unrelated things: opening the
 * command palette (which re-reads every project's Session listing), rebuilding
 * the ticket workspace, and creating the Monaco description editor for the
 * first time. A single figure cannot say which of those a change moved, so the
 * renderer stamps a mark at each boundary (`@renderer/lib/perf-marks`) and this
 * reducer turns those stamps into the segments between them.
 *
 * Segments, not overlapping spans: every millisecond of the measured window
 * belongs to exactly one of them, so they sum back to the latency the harness
 * reports and a regression cannot hide in the gap between two spans.
 * `sessionsListMs` is the one deliberate exception — it sits INSIDE
 * `paletteResolveMs` and is reported beside it, because the palette's
 * `sessions.list` fan-out is VC-388's cost showing up in our window and has to
 * be nameable without being double-counted.
 *
 * `missingMarks` is the drift guard. The renderer's mark names are string
 * literals on one side of a process boundary and this file's are on the other,
 * with no shared module able to reach both (the renderer is TypeScript behind
 * a bundler; `run.mjs` is plain Node). A renamed mark would otherwise turn its
 * segments quietly into `null` and read as "we did not measure that this time"
 * — so the run names what it never saw, and the harness refuses a sample that
 * was supposed to be instrumented and is not.
 */

/**
 * What each boundary means, since two of them are easy to misread:
 *
 * - `ticket-workspace.mount` is stamped from a LAYOUT EFFECT, so it lands once
 *   the workspace subtree is on the DOM. `workspaceRebuildMs` is therefore the
 *   cost of actually building the ticket page, its rail and its panels.
 *   Before VC-385's review it was stamped during render instead, where it
 *   landed at the START of the workspace's render and the segment measured
 *   only the scheduling gap ahead of it — the four reports published under
 *   `docs/performance-baselines/vc-385-*` carry that earlier meaning, and their
 *   `rebuild workspace` and `description editor` lines are not comparable to
 *   later runs (their sum, and the total, are).
 * - `ticket-description.ready` is stamped only by the ticket-body editor, not
 *   by any other Monaco surface.
 */

/** The marks the renderer stamps, in the order one switch crosses them. */
export const TICKET_SWITCH_MARKS = Object.freeze({
  start: "volli.ticket-switch.start",
  paletteOpen: "volli.command-palette.open",
  sessionsListed: "volli.command-palette.sessions-listed",
  commit: "volli.ticket-switch.commit",
  workspaceMount: "volli.ticket-workspace.mount",
  descriptionReady: "volli.ticket-description.ready",
});

/** The last stamp for `name`, or `null` when this switch never reached it. */
function stampOf(marks, name) {
  let latest = null;
  for (const mark of marks) {
    if (mark.name !== name) continue;
    if (latest === null || mark.startTime > latest) latest = mark.startTime;
  }
  return latest;
}

/** `to - from`, or `null` when either end is missing. */
function span(from, to) {
  return from === null || to === null ? null : to - from;
}

/**
 * One switch's phase split.
 *
 * `marks` is whatever `performance.getEntriesByType("mark")` returned for the
 * measured window; `latencyMs` is the harness's own total for it. A mark the
 * run never reached yields `null` for the segments that depend on it rather
 * than a zero, because "this phase did not happen" and "this phase was free"
 * are different findings.
 */
export function ticketSwitchBreakdown({ marks, latencyMs }) {
  const start = stampOf(marks, TICKET_SWITCH_MARKS.start);
  const paletteOpen = stampOf(marks, TICKET_SWITCH_MARKS.paletteOpen);
  const sessionsListed = stampOf(marks, TICKET_SWITCH_MARKS.sessionsListed);
  const commit = stampOf(marks, TICKET_SWITCH_MARKS.commit);
  const workspaceMount = stampOf(marks, TICKET_SWITCH_MARKS.workspaceMount);
  const descriptionReady = stampOf(marks, TICKET_SWITCH_MARKS.descriptionReady);
  const end = start === null ? null : start + latencyMs;
  const missingMarks = Object.values(TICKET_SWITCH_MARKS).filter(
    (name) => stampOf(marks, name) === null,
  );

  return {
    paletteOpenMs: span(start, paletteOpen),
    paletteResolveMs: span(paletteOpen, commit),
    workspaceRebuildMs: span(commit, workspaceMount),
    descriptionEditorMs: span(workspaceMount, descriptionReady),
    settleMs: span(descriptionReady, end),
    sessionsListMs: span(paletteOpen, sessionsListed),
    missingMarks,
  };
}
