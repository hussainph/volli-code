/**
 * What the Browser replay (VC-453) says and where it moves, as pure rules
 * beside the dialog that draws them — the `browser-plane-freeze.ts` split:
 * the view is glue, and these decide which step a key lands on, which step a
 * drag lands on, whether a growing trace pulls the person along, and what a
 * frame's caption reads. None of that shows in a screenshot, so it is gated.
 *
 * The record itself — its order, where a replay opens — is `@volli/shared`'s,
 * and a step's words are `@volli/session-presentation`'s `browseCaption`, the
 * transcript row's own, so a cloud or mobile client replays the same trace the
 * same way. What is here is only what a desktop keyboard and pointer add.
 */
import type { BrowserTraceFrame, BrowserTraceOutcome } from "@volli/shared";
import { browseCaption } from "@volli/session-presentation";

/** Which Session's replay to open, and the step to open it at. */
export interface BrowserTraceRequest {
  sessionId: string;
  /** The tab the person opened it from; its latest step is where it starts. */
  tabId: string | null;
  /** The frame the card showed; that exact step is where it starts. */
  pictureId: string | null;
}

/** An index inside a replay of `length` steps; 0 for an empty one. */
export function clampTraceIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, Math.round(index)));
}

/**
 * Where a key moves the replay, or null for a key it does not own. Arrows
 * step, Home and End jump, and PageUp/PageDown stride ten steps — the
 * slider's own keys, since the scrub track IS a slider.
 */
export function traceIndexForKey(key: string, index: number, length: number): number | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowUp":
      return clampTraceIndex(index - 1, length);
    case "ArrowRight":
    case "ArrowDown":
      return clampTraceIndex(index + 1, length);
    case "PageUp":
      return clampTraceIndex(index - 10, length);
    case "PageDown":
      return clampTraceIndex(index + 10, length);
    case "Home":
      return 0;
    case "End":
      return clampTraceIndex(length - 1, length);
    default:
      return null;
  }
}

/**
 * The step under a pointer at `offset` px along a track `width` px wide with
 * one equal segment per step. Outside the track clamps to its ends.
 */
export function traceIndexAtOffset(offset: number, width: number, length: number): number {
  if (length <= 0 || width <= 0) return 0;
  return clampTraceIndex(Math.floor((offset / width) * length), length);
}

/**
 * Where the replay stands after the trace was re-read. A person watching the
 * newest step follows the Session as it adds more; one who scrubbed back
 * stays on the SAME step — found by its trace and number, since a trace at
 * its bound lets its oldest steps go and every position shifts under them.
 * A step that was itself let go leaves the replay at the nearest position.
 */
export function followTraceIndex(
  index: number,
  before: readonly BrowserTraceFrame[],
  after: readonly BrowserTraceFrame[],
): number {
  if (before.length > 0 && index >= before.length - 1) {
    return clampTraceIndex(after.length - 1, after.length);
  }
  const standing = before[index];
  const kept =
    standing === undefined
      ? -1
      : after.findIndex(
          (frame) => frame.traceId === standing.traceId && frame.step.seq === standing.step.seq,
        );
  return kept >= 0 ? kept : clampTraceIndex(index, after.length);
}

/**
 * The picture a step shows. A step that took one shows its own; a read, a
 * refusal or a failure changed nothing and took none, so it shows the tab as
 * its last picture left it — `asOf` names that step (1-based) so the replay
 * can say the frame is an earlier one. Null when the tab has no picture yet.
 */
export function traceFrameShown(
  timeline: readonly BrowserTraceFrame[],
  index: number,
): { pictureId: string; asOf: number | null } | null {
  const frame = timeline[index];
  if (frame === undefined) return null;
  for (let at = index; at >= 0; at -= 1) {
    const earlier = timeline[at];
    if (earlier?.tabId !== frame.tabId || earlier.step.pictureId === null) continue;
    return { pictureId: earlier.step.pictureId, asOf: at === index ? null : at + 1 };
  }
  return null;
}

/** What one frame of the replay reads. */
export interface BrowserTraceFacts {
  verb: string;
  object: string | null;
  url: string | null;
  title: string | null;
  outcome: BrowserTraceOutcome;
  /** `refused by browser.x`, or Volli's words for a failure or a page that did not load. */
  trouble: string | null;
  /** Wall-clock time the step settled. */
  time: string;
  /** How long after the replay's first step, as `+1m 05s`. */
  offset: string;
  /** `Tab 2`, when the replay spans more than one tab; null otherwise. */
  tab: string | null;
}

export function browserTraceFacts(
  timeline: readonly BrowserTraceFrame[],
  index: number,
  formatTime: (at: number) => string = defaultTime,
): BrowserTraceFacts | null {
  const [first] = timeline;
  const frame = timeline[index];
  if (first === undefined || frame === undefined) return null;
  const { step } = frame;
  const caption = browseCaption(step.action, step.target);
  const tabs = [...new Set(timeline.map((one) => one.tabId))];
  return {
    ...caption,
    url: step.url,
    title: step.title,
    outcome: step.outcome,
    trouble:
      step.outcome === "refused"
        ? step.rule === null
          ? "refused"
          : `refused by ${step.rule}`
        : step.error,
    time: formatTime(step.at),
    offset: elapsed(step.at - first.step.at),
    tab: tabs.length > 1 ? `Tab ${tabs.indexOf(frame.tabId) + 1}` : null,
  };
}

/** `+0s`, `+42s`, `+3m 07s`, `+1h 02m`. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `+${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `+${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `+${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const TIME = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function defaultTime(at: number): string {
  return TIME.format(at);
}
