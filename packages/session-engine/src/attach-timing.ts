/**
 * Where one executor attach spent its time (VC-1072).
 *
 * An attach crosses three packages — the Session runtime here, the host's
 * adapter, and the Agent Runtime behind it — and a slow one used to leave only
 * two timestamps in the ledger: the `executor.start` command and the
 * `attachment.opened` fact. Nothing said which of the dozen awaits between them
 * held the time, so a regression from a third of a second to five seconds sat
 * unexplained for a week. Each stage is marked as the attach passes it, and the
 * whole run is reported once, opened or failed, through
 * {@link SessionRuntimePorts.onAttachTiming}.
 *
 * Diagnostics only: a mark never throws into the attach, and a marker called
 * after the report — an adapter that keeps the spec it was handed — is ignored
 * rather than reopening a run already reported.
 */

/** One stage, as the time since the previous mark. */
export interface AttachStageTiming {
  /** The stage that just finished, e.g. `runtime-context` or `sidecar-ready`. */
  stage: string;
  /** Milliseconds this stage took: since the previous mark, or since the start. */
  ms: number;
}

/** One attach, reported once when it opens or fails. */
export interface AttachTimingReport {
  sessionId: string;
  attachmentId: string | null;
  commandId: string;
  adapterId: string;
  /** Whether this is a Session's first attach (the direct door), or a later one. */
  firstAttach: boolean;
  outcome: "opened" | "failed";
  /** The failure code an attach that failed recorded. */
  code?: string;
  totalMs: number;
  stages: readonly AttachStageTiming[];
}

/** Marks stages against a clock and reports the run once. */
export class AttachStageClock {
  readonly #now: () => number;
  readonly #startedAt: number;
  #last: number;
  readonly #stages: AttachStageTiming[] = [];
  #reported = false;

  constructor(now: () => number) {
    this.#now = now;
    this.#startedAt = now();
    this.#last = this.#startedAt;
  }

  /** Closes the stage running since the previous mark. Ignored once reported. */
  readonly mark = (stage: string): void => {
    if (this.#reported) return;
    const at = this.#now();
    this.#stages.push({ stage, ms: at - this.#last });
    this.#last = at;
  };

  /** The run so far, sealed: marks after it are ignored. */
  seal(): { totalMs: number; stages: readonly AttachStageTiming[] } {
    this.#reported = true;
    return { totalMs: this.#now() - this.#startedAt, stages: [...this.#stages] };
  }
}
