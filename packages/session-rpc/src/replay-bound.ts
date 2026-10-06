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
 * Admits what a source delivers while it replays (every durable frame handed
 * over before its subscribe call returns), in events and in UTF-8 bytes of
 * the JSON the wire will carry, BEFORE the frame is staged anywhere: the
 * first frame that would take either past its bound is refused, and the
 * caller stops staging, discards what it staged and cancels the source. So
 * no more than the bounds is ever held for one resume. Transient emissions
 * are not history and are not counted.
 */
export class ReplayMeter {
  readonly #bounds: SubscriptionReplayBounds;
  #events = 0;
  #bytes = 0;
  #replaying = true;

  constructor(bounds: SubscriptionReplayBounds) {
    this.#bounds = bounds;
  }

  /**
   * Whether one more emission of `bytes` may be staged; `durable` is whether
   * it is a history frame. Counted only when admitted.
   */
  admit(bytes: number, durable: boolean): boolean {
    if (!this.#replaying || !durable) return true;
    if (this.#events + 1 > this.#bounds.events || this.#bytes + bytes > this.#bounds.bytes) {
      return false;
    }
    this.#events += 1;
    this.#bytes += bytes;
    return true;
  }

  /** Whether the replay is still being delivered. */
  get replaying(): boolean {
    return this.#replaying;
  }

  /** The replay is over: what arrives from now on is live. */
  end(): void {
    this.#replaying = false;
  }
}
