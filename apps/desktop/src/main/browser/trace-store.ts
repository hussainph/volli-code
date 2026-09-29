/**
 * Where a Session's Browser Traces live on this host (VC-453): the ordered,
 * bounded record of every navigate and act a Session ran in a tab it owns,
 * with a copy of the frame the host took after each one.
 *
 * WHY A SECOND STORE. {@link BrowserPictureStore} holds the per-action
 * captures in a 48-slot live set that forgets the oldest first, and writes
 * to disk only the screenshots a model asked for. That is right for the
 * transcript card, which shows the one picture its row names, and wrong for a
 * replay, which needs every frame in order long after the live set moved on.
 * So the trace copies each step's frame out of the picture store the moment
 * the step is recorded — while the live set certainly still holds it — into
 * its own sink under its own bounds. The picture id is kept as the frame's
 * name, so the card's picture and the replay's frame are one id: once the
 * live set has let a capture go, the host answers the card from here.
 *
 * WHO WRITES. Only the host, and only for a tab a Session created
 * ({@link BrowserTabHost.recordTraceStep} decides that, not this store). The
 * two page-derived strings — title and target name — are cleaned on the way
 * in with the shared rule, so no record here ever holds a control or bidi
 * character a page put there. Nothing typed into a page reaches a step.
 *
 * WHAT IT IS NOT. Not a Blob: a Blob linked to a Session is materialized
 * into its worktree and read as the next turn's image input, and a trace is
 * the person's evidence, never the model's input. Nothing here is reachable
 * from a tool.
 *
 * BOUNDED THE WAY THE PICTURE DISK IS. Every record is self-describing (the
 * trace JSON names its Session, tab and frames), so a new store rehydrates at
 * construction and sweeps what is past its bounds — by age, by trace count,
 * and by total frames kept, newest first — and does it again whenever a
 * write could have grown past them. A frame no trace names is an orphan a
 * crash left behind, and goes at construction.
 */
import {
  appendBrowserTraceStep,
  type BrowserTrace,
  type BrowserTraceAction,
  type BrowserTraceOutcome,
  browserTracePictureIds,
  cleanBrowserTraceText,
  newBrowserTrace,
} from "@volli/shared";

import { type BrowserPictureMime, pictureDataUrl } from "./picture-store";

/** How long a trace is kept after its last step. */
export const BROWSER_TRACE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
/** How many traces are kept at once, newest first. */
export const BROWSER_TRACE_LIMIT = 60;
/**
 * How many frames all kept traces may hold together. A frame is one JPEG of a
 * page, typically tens to a couple of hundred kilobytes, so this bounds the
 * directory at a size nobody has to think about.
 */
export const BROWSER_TRACE_FRAME_LIMIT = 800;

/** URLs are the host's record, not page prose, but still bounded. */
const URL_LIMIT = 2_048;
/** Volli's own words for a failure; bounded because a thrown message is not ours to size. */
const ERROR_LIMIT = 400;

export interface BrowserTraceFrameBytes {
  bytes: Uint8Array;
  mime: BrowserPictureMime;
}

export interface BrowserTracePersistence {
  writeTrace(trace: BrowserTrace): void;
  writeFrame(pictureId: string, frame: BrowserTraceFrameBytes): void;
  readFrame(pictureId: string): BrowserTraceFrameBytes | null;
  /** Every trace the sink still holds, for rehydration and the sweep. */
  listTraces(): readonly BrowserTrace[];
  /** Every frame id the sink holds, so a frame no trace names can be swept. */
  listFrames(): readonly string[];
  removeTrace(traceId: string): void;
  removeFrame(pictureId: string): void;
}

/** One settled tool call, as the host saw it. The store cleans and numbers it. */
export interface BrowserTraceStepInput {
  sessionId: string;
  tabId: string;
  action: BrowserTraceAction;
  target: string | null;
  url: string | null;
  title: string | null;
  generation: number | null;
  outcome: BrowserTraceOutcome;
  rule: string | null;
  error: string | null;
  pictureId: string | null;
}

export interface BrowserTraceStoreDependencies {
  createId: () => string;
  now: () => number;
  /** The frame a step's picture id names, from the picture store's live set. */
  frameOf: (pictureId: string) => BrowserTraceFrameBytes | null;
  /** Absent means traces live only as long as the process — tests and a build with no disk. */
  persist?: BrowserTracePersistence;
  stepLimit?: number;
  traceLimit?: number;
  frameLimit?: number;
  maxAgeMs?: number;
}

export class BrowserTraceStore {
  private readonly traces = new Map<string, BrowserTrace>();
  /** Which trace a (Session, tab) pair is writing THIS launch. Rehydrated traces are closed. */
  private readonly writing = new Map<string, string>();
  /** Which trace names each kept frame — the ownership check a frame read passes. */
  private readonly frames = new Map<string, string>();
  private readonly traceLimit: number;
  private readonly frameLimit: number;
  private readonly maxAgeMs: number;

  constructor(private readonly deps: BrowserTraceStoreDependencies) {
    this.traceLimit = deps.traceLimit ?? BROWSER_TRACE_LIMIT;
    this.frameLimit = deps.frameLimit ?? BROWSER_TRACE_FRAME_LIMIT;
    this.maxAgeMs = deps.maxAgeMs ?? BROWSER_TRACE_MAX_AGE_MS;
    for (const trace of deps.persist?.listTraces() ?? []) {
      this.traces.set(trace.traceId, trace);
      for (const pictureId of browserTracePictureIds(trace)) {
        this.frames.set(pictureId, trace.traceId);
      }
    }
    for (const pictureId of deps.persist?.listFrames() ?? []) {
      if (!this.frames.has(pictureId)) deps.persist?.removeFrame(pictureId);
    }
    this.sweep();
  }

  /**
   * Appends one step to the trace the Session is writing for the tab, opening
   * one on its first step. The frame is copied now or never: a picture the
   * live set no longer holds is recorded as no frame, not as a dangling id.
   */
  record(input: BrowserTraceStepInput): void {
    const key = JSON.stringify([input.sessionId, input.tabId]);
    const now = this.deps.now();
    const openId = this.writing.get(key);
    const current =
      (openId === undefined ? undefined : this.traces.get(openId)) ??
      newBrowserTrace({
        traceId: this.deps.createId(),
        sessionId: input.sessionId,
        tabId: input.tabId,
        startedAt: now,
      });
    this.writing.set(key, current.traceId);

    let pictureId = input.pictureId;
    if (pictureId !== null && this.deps.persist !== undefined) {
      const frame = this.deps.frameOf(pictureId);
      if (frame === null) pictureId = null;
      else this.deps.persist.writeFrame(pictureId, frame);
    }

    const { trace, dropped } = appendBrowserTraceStep(
      current,
      {
        action: input.action,
        target: cleanBrowserTraceText(input.target),
        url: cleanBrowserTraceText(input.url, URL_LIMIT),
        title: cleanBrowserTraceText(input.title),
        generation: input.generation,
        at: now,
        outcome: input.outcome,
        rule: input.outcome === "refused" ? input.rule : null,
        error: cleanBrowserTraceText(input.error, ERROR_LIMIT),
        pictureId,
      },
      this.deps.stepLimit,
    );
    this.traces.set(trace.traceId, trace);
    if (pictureId !== null) this.frames.set(pictureId, trace.traceId);
    for (const gone of dropped) this.forgetFrame(gone.pictureId);
    this.deps.persist?.writeTrace(trace);
    this.sweep();
  }

  /** Every kept trace of one Session, oldest first. */
  tracesOf(sessionId: string): BrowserTrace[] {
    return [...this.traces.values()]
      .filter((trace) => trace.sessionId === sessionId)
      .toSorted((left, right) => left.startedAt - right.startedAt);
  }

  /**
   * A kept frame as an `<img src>`, or null. Only an id a kept trace names is
   * ever looked up, so no renderer string reaches the sink unvetted.
   */
  frameDataUrl(pictureId: string): string | null {
    if (!this.frames.has(pictureId)) return null;
    const frame = this.deps.persist?.readFrame(pictureId) ?? null;
    return frame === null ? null : pictureDataUrl(frame.bytes, frame.mime);
  }

  /** Drops traces past the age, count or total-frame bound, newest kept. */
  private sweep(): void {
    const cutoff = this.deps.now() - this.maxAgeMs;
    const ordered = [...this.traces.values()].toSorted(
      (left, right) => right.updatedAt - left.updatedAt,
    );
    let frames = 0;
    let full = false;
    for (const [index, trace] of ordered.entries()) {
      const count = browserTracePictureIds(trace).length;
      // The newest trace is never dropped for frames: it is bounded by its own
      // step limit, and dropping the trace being written would lose its steps.
      full ||= index > 0 && frames + count > this.frameLimit;
      if (!full && index < this.traceLimit && trace.updatedAt >= cutoff) {
        frames += count;
        continue;
      }
      this.remove(trace);
    }
  }

  private remove(trace: BrowserTrace): void {
    this.traces.delete(trace.traceId);
    for (const [key, traceId] of this.writing) {
      if (traceId === trace.traceId) this.writing.delete(key);
    }
    for (const pictureId of browserTracePictureIds(trace)) this.forgetFrame(pictureId);
    this.deps.persist?.removeTrace(trace.traceId);
  }

  private forgetFrame(pictureId: string | null): void {
    if (pictureId === null) return;
    this.frames.delete(pictureId);
    this.deps.persist?.removeFrame(pictureId);
  }
}
