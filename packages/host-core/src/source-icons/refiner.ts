/** Optional background work, admitted ONLY by a successful live HTML read. */
import type {
  ReadSourceIconCandidate,
  SourceIconDecoder,
  SourceIconRaster,
} from "@volli/agent-runtime";
import { SourceIconCache } from "./cache";

const QUEUE_LIMIT = 16;
const NEGATIVE_LIMIT = 256;
const NEGATIVE_MS = 10 * 60 * 1_000;

interface Job {
  key: string;
  sessionId: string;
  authority: string;
  candidate: ReadSourceIconCandidate;
  signal: AbortSignal;
  stop: AbortController;
  detach(): void;
}

export class SourceIconRefiner {
  private readonly queue: Job[] = [];
  private readonly pending = new Set<string>();
  private readonly negative = new Map<string, number>();
  private active: Job | undefined;
  private running: Promise<void> | undefined;
  private closed = false;
  private scheduled: ReturnType<typeof setImmediate> | undefined;

  constructor(
    private readonly options: {
      cache: SourceIconCache;
      acquire(
        candidate: ReadSourceIconCandidate,
        signal: AbortSignal,
        stillAuthorized: () => boolean,
      ): Promise<SourceIconRaster | null>;
      decode: SourceIconDecoder;
      now?: () => number;
      log(message: string): void;
    },
  ) {}

  /** Called synchronously at the beginning of each foreground HTML read. */
  beginRead(
    sessionId: string,
    attachment: AbortSignal,
  ): ((candidate: ReadSourceIconCandidate, readSignal: AbortSignal) => void) | undefined {
    const authority = this.options.cache.grant(sessionId);
    if (this.closed || attachment.aborted || authority === null) return undefined;
    return (candidate, readSignal) =>
      this.observe(sessionId, authority, candidate, AbortSignal.any([attachment, readSignal]));
  }

  /** Stores at most two bounded strings + scope, never a page body or result. */
  private observe(
    sessionId: string,
    authority: string,
    candidate: ReadSourceIconCandidate,
    attachment: AbortSignal,
  ): void {
    if (this.closed || attachment.aborted || this.options.cache.grant(sessionId) !== authority)
      return;
    if (candidate.origin.length > 2048 || candidate.url.length > 2048) return;
    const key = JSON.stringify([authority, sessionId, candidate.origin]);
    const now = (this.options.now ?? Date.now)();
    for (const [failed, until] of this.negative) if (until <= now) this.negative.delete(failed);
    if (this.pending.has(key) || this.negative.has(key) || this.queue.length >= QUEUE_LIMIT) return;
    const stop = new AbortController();
    const signal = AbortSignal.any([attachment, stop.signal]);
    const job: Job = { key, sessionId, authority, candidate, signal, stop, detach: () => {} };
    const cancel = (): void => {
      const index = this.queue.indexOf(job);
      if (index !== -1) {
        this.queue.splice(index, 1);
        this.pending.delete(key);
        job.detach();
      }
    };
    job.detach = () => signal.removeEventListener("abort", cancel);
    signal.addEventListener("abort", cancel, { once: true });
    this.queue.push(job);
    this.pending.add(key);
    // Enqueue returns before networking/decoding starts; never await it in a tool.
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.active !== undefined || this.scheduled !== undefined) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      this.running = this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.active !== undefined || this.closed) return;
    const job = this.queue.shift();
    if (job === undefined) return;
    this.active = job;
    let failed = false;
    try {
      await this.options.cache.hydrated;
      if (
        job.signal.aborted ||
        this.options.cache.grant(job.sessionId) !== job.authority ||
        this.options.cache.has(job.sessionId, job.authority, job.candidate.origin)
      )
        return;
      const raster = await this.options.acquire(
        job.candidate,
        job.signal,
        () => !this.closed && this.options.cache.grant(job.sessionId) === job.authority,
      );
      if (
        job.signal.aborted ||
        this.closed ||
        this.options.cache.grant(job.sessionId) !== job.authority
      )
        return;
      const png = raster === null ? null : await this.options.decode(raster, job.signal);
      if (
        job.signal.aborted ||
        this.closed ||
        this.options.cache.grant(job.sessionId) !== job.authority
      )
        return;
      if (png === null) failed = true;
      else this.options.cache.put(job.sessionId, job.authority, job.candidate.origin, png);
    } catch {
      failed = !job.signal.aborted && !this.closed;
    } finally {
      if (failed) {
        this.negative.set(job.key, (this.options.now ?? Date.now)() + NEGATIVE_MS);
        while (this.negative.size > NEGATIVE_LIMIT) {
          const first = this.negative.keys().next().value;
          if (first === undefined) break;
          this.negative.delete(first);
        }
        try {
          this.options.log("A source icon refinement was omitted");
        } catch {
          /* Best-effort diagnostics. */
        }
      }
      // A logical timeout is not physical worker exit. Keep the queue's one
      // active slot until decoder teardown settles, including after cancellation.
      await this.options.decode.settled?.();
      job.detach();
      this.pending.delete(job.key);
      this.active = undefined;
      this.schedule();
    }
  }

  async settled(): Promise<void> {
    await this.running;
    await this.options.decode.settled?.();
  }

  close(): void {
    this.closed = true;
    if (this.scheduled !== undefined) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    this.active?.stop.abort();
    for (const job of this.queue.splice(0)) {
      job.stop.abort();
      job.detach();
    }
    this.pending.clear();
    this.negative.clear();
  }
}
