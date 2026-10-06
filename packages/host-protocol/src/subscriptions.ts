/**
 * How much history one WebSocket resume may replay before the host says
 * "resnapshot" instead (HP § Commands, subscriptions and errors).
 *
 * The one place these numbers live: the WebSocket listener enforces them.
 * VC-315 sized them to replace D9's 128 events / 1 MiB (T3 Code's
 * precedent): the busiest measured Session-day was 2,796 events and 9.3 MB
 * of frames, so a lid closed for a whole working day still resumes, with
 * ~1.7x headroom on bytes and ~1.5x on events. Bytes are the real bound; the
 * count caps floods of tiny events. Past either a subscription answers
 * `PRECONDITION_FAILED` / `subscription-resnapshot-required` before it yields
 * anything, never a silently truncated replay. Electron IPC is not bounded.
 */
export interface SubscriptionReplayBounds {
  /** Durable events one resume may replay. */
  readonly events: number;
  /** UTF-8 bytes of their JSON encoding. */
  readonly bytes: number;
}

export const SUBSCRIPTION_REPLAY_BOUNDS: SubscriptionReplayBounds = Object.freeze({
  events: 4096,
  bytes: 16 * 1024 * 1024,
});

/**
 * The largest single frame, in UTF-8 bytes, a WebSocket host sends: one
 * answer, or one subscription emission. An answer past it is refused with
 * `PAYLOAD_TOO_LARGE` / `response-too-large`, never truncated, and an
 * emission past it ends its stream with the same reason. It equals the replay
 * byte bound, so one frame alone never outweighs a whole resume; a bounded or
 * paged read (VC-315's `session.history`) is the way to anything larger.
 */
export const HOST_PROTOCOL_MAX_FRAME_BYTES = SUBSCRIPTION_REPLAY_BOUNDS.bytes;
