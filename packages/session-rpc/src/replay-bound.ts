/**
 * Enforces one subscription's replay bounds (D9; `SUBSCRIPTION_REPLAY_BOUNDS`
 * in `@volli/host-protocol`), for a door that sets `replayBounds` in its
 * context: the WebSocket listener. Past either bound the stream ends with
 * `PRECONDITION_FAILED` / `subscription-resnapshot-required` before it yields
 * anything, so the client re-reads the snapshot instead of receiving a
 * history the host chose to cut.
 */
import type { SubscriptionReplayBounds } from "@volli/host-protocol";

import { HostProcedureError } from "./catalog";

const RESNAPSHOT_MESSAGE =
  "This cursor is too far behind to resume; re-read the snapshot and subscribe from its cursor";

export function resnapshotRequired(): HostProcedureError {
  return new HostProcedureError("subscription-resnapshot-required", RESNAPSHOT_MESSAGE);
}

/**
 * Whether a resume from `afterSequence` would replay more durable events than
 * the bounds allow, given the stream's current head. Asked before the source
 * is opened, so an over-long replay is never read at all.
 */
export function replayExceedsEvents(
  bounds: SubscriptionReplayBounds,
  afterSequence: number,
  headSequence: number,
): boolean {
  return headSequence - afterSequence > bounds.events;
}

/**
 * Counts what a source delivers while it replays (every durable frame handed
 * over before its subscribe call returns), in events and in UTF-8 bytes of
 * the JSON the wire will carry. Transient emissions are not history and are
 * not counted.
 */
export class ReplayMeter {
  readonly #bounds: SubscriptionReplayBounds;
  readonly #encoder = new TextEncoder();
  #events = 0;
  #bytes = 0;
  #replaying = true;

  constructor(bounds: SubscriptionReplayBounds) {
    this.#bounds = bounds;
  }

  /** One emission the source delivered; `durable` is whether it is a history frame. */
  measure(emission: unknown, durable: boolean): void {
    if (!this.#replaying || !durable) return;
    this.#events += 1;
    this.#bytes += this.#encoder.encode(JSON.stringify(emission)).byteLength;
  }

  /** The replay is over: what arrives from now on is live. */
  end(): void {
    this.#replaying = false;
  }

  get exceeded(): boolean {
    return this.#events > this.#bounds.events || this.#bytes > this.#bounds.bytes;
  }
}
