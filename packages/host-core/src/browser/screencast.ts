/**
 * One screencast attachment (VC-619): a viewer's frame source for one tab, by
 * host-protocol.md's rules for screencast images (§ Binary framing). VC-571
 * carries it over the binary channel; nothing here touches a transport, and
 * raw bytes never enter the event bus or a tRPC subscription.
 *
 * - **Attach metadata.** Encoding, viewport and device scale factor are stated
 *   at attach and again only when they change; a frame is image bytes and a
 *   sequence, nothing else.
 * - **Latest wins.** At most one unsent frame is held. A newer frame replaces
 *   it whole, and the stale one is dropped before it is given a sequence, so
 *   the sequence a consumer sees has no gaps and never goes backwards.
 * - **Cancellation.** A pending `next` honours its signal; `detach` ends the
 *   attachment, and the tab closing or going headless ends it from the host's
 *   side. An ended attachment answers `null`.
 */
import type { BrowserScreencastMetadata } from "@volli/shared";

/** One frame as a consumer takes it: the next sequence, and the image's bytes. */
export interface BrowserScreencastFrame {
  /** Starts at 1 per attachment and strictly increases. */
  seq: number;
  bytes: Uint8Array;
}

/** A viewer's attachment to one tab's screencast. */
export interface BrowserScreencastAttachment {
  /** What every frame is right now. */
  metadata(): BrowserScreencastMetadata;
  /** Told when the metadata changes; frames taken after it are drawn to it. Returns the unsubscribe. */
  onMetadata(listener: (metadata: BrowserScreencastMetadata) => void): () => void;
  /**
   * The newest frame not yet taken, waiting for one if none is held. `null`
   * once the attachment has ended. One `next` at a time.
   */
  next(signal?: AbortSignal): Promise<BrowserScreencastFrame | null>;
  /** Frames replaced before anyone took them. */
  readonly dropped: number;
  /** Ends this attachment. Idempotent. */
  detach(): void;
}

/** The host's side of one attachment: what the backend feeds and ends. */
export class ScreencastAttachment implements BrowserScreencastAttachment {
  #metadata: BrowserScreencastMetadata;
  #pending: Uint8Array | null = null;
  #waiter: ((frame: BrowserScreencastFrame | null) => void) | null = null;
  #seq = 0;
  #dropped = 0;
  #ended = false;
  readonly #listeners = new Set<(metadata: BrowserScreencastMetadata) => void>();

  constructor(
    metadata: BrowserScreencastMetadata,
    /** The device scale factor this viewer asked for; the host may draw higher. */
    readonly requestedScale: number,
    private readonly onDetach: (attachment: ScreencastAttachment) => void,
  ) {
    this.#metadata = { ...metadata };
  }

  get dropped(): number {
    return this.#dropped;
  }

  get ended(): boolean {
    return this.#ended;
  }

  metadata(): BrowserScreencastMetadata {
    return { ...this.#metadata };
  }

  onMetadata(listener: (metadata: BrowserScreencastMetadata) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** A new frame from the engine: handed to a waiting consumer, or held in place of the last. */
  offer(bytes: Uint8Array): void {
    if (this.#ended) return;
    const waiter = this.#waiter;
    if (waiter !== null) {
      this.#waiter = null;
      waiter({ seq: ++this.#seq, bytes });
      return;
    }
    if (this.#pending !== null) this.#dropped += 1;
    this.#pending = bytes;
  }

  /** The frames change shape: a frame held from before is stale and goes. */
  setMetadata(metadata: BrowserScreencastMetadata): void {
    if (this.#ended) return;
    const same =
      metadata.width === this.#metadata.width &&
      metadata.height === this.#metadata.height &&
      metadata.deviceScaleFactor === this.#metadata.deviceScaleFactor &&
      metadata.encoding === this.#metadata.encoding;
    if (same) return;
    this.#metadata = { ...metadata };
    if (this.#pending !== null) {
      this.#pending = null;
      this.#dropped += 1;
    }
    for (const listener of this.#listeners) listener(this.metadata());
  }

  next(signal?: AbortSignal): Promise<BrowserScreencastFrame | null> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#waiter !== null) {
      return Promise.reject(new Error("A screencast attachment serves one next() at a time"));
    }
    const held = this.#pending;
    if (held !== null) {
      this.#pending = null;
      return Promise.resolve({ seq: ++this.#seq, bytes: held });
    }
    if (this.#ended) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        if (this.#waiter !== deliver) return;
        this.#waiter = null;
        reject(signal?.reason ?? new Error("Screencast wait cancelled"));
      };
      const deliver = (frame: BrowserScreencastFrame | null): void => {
        signal?.removeEventListener("abort", abort);
        resolve(frame);
      };
      this.#waiter = deliver;
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  /** Ends the attachment from the host's side: the tab closed or went headless. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#pending = null;
    this.#listeners.clear();
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.(null);
  }

  detach(): void {
    if (this.#ended) return;
    this.end();
    this.onDetach(this);
  }
}
