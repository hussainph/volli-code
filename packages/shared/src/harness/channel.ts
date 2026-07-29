/**
 * Is a harness's event channel working right now — and would we notice if it
 * stopped.
 *
 * {@link harnessEventStatus} (`trust.ts`) answers a different question and
 * answers it correctly: has this harness EVER delivered this event. It is
 * monotonic on purpose, because a capability once demonstrated was really
 * demonstrated. Freshness cannot be built on it: a Claude Code upgrade that
 * renames a hook field, a wrapper a dotfile sync removed, a `volli doctor
 * --fix` never run after a path change — each of those leaves a channel that
 * reads healthy for the rest of the install's life.
 *
 * So this is a second, deliberately forgetful question, asked of two integers
 * the app writes down (`harness_channel`, migration 017) and stored nowhere:
 * did the MOST RECENT launch report. A harness upgrade that breaks hooks flips
 * that on the very next launch, and a fix flips it back on the one after.
 * Non-monotonic by construction, which is the whole feature.
 */
import type { HarnessId } from "../ticket";

/** The two timestamps, as `harness_channel` holds them. `null` — never observed. */
export interface HarnessChannel {
  harnessId: HarnessId;
  /**
   * When the wrapper last called `volli session harness`, one step before it
   * exec'd the binary. The only honest launch signal: a PTY spawn would also
   * count a harness the user started by absolute path, outside our config.
   */
  lastLaunchAt: number | null;
  /** When a hook this harness fires last reached the app. */
  lastEventAt: number | null;
}

/**
 * What the two integers add up to.
 *
 * **reporting** — the most recent launch produced an event. **silent** — the
 * most recent launch went through our wrapper, the grace window has passed, and
 * nothing came: the config we injected did not take. **unproven** — nothing has
 * launched through the wrapper yet, or the newest launch is still inside the
 * window. Say nothing.
 */
export type HarnessChannelState = "reporting" | "silent" | "unproven";

/** One harness's derived state — what a catalog read carries to the renderer. */
export interface HarnessChannelStatus {
  harnessId: HarnessId;
  state: HarnessChannelState;
}

/**
 * The comparison, against an injected clock and an explicit window.
 *
 * `reporting` is tested before the window, and that ordering is load-bearing:
 * the window exists only to defer an ACCUSATION, never to withhold a fact. An
 * event that has already landed for this launch is proof the channel works,
 * whether it arrived in the first second or the last.
 *
 * `graceMs` is a parameter rather than an import because the constant lives
 * with the per-session model (`HARNESS_EVENT_GRACE_MS`, `session.ts`), which
 * depends on this module's neighbours; one window, passed in, beats two
 * definitions or a cycle.
 */
export function harnessChannelState(
  channel: Pick<HarnessChannel, "lastLaunchAt" | "lastEventAt">,
  now: number,
  graceMs: number,
): HarnessChannelState {
  const { lastLaunchAt, lastEventAt } = channel;
  // Nothing has ever proven Volli's configuration was in the loop, so there is
  // no launch for an event to be missing from.
  if (lastLaunchAt === null) return "unproven";
  if (lastEventAt !== null && lastEventAt >= lastLaunchAt) return "reporting";
  return now - lastLaunchAt < graceMs ? "unproven" : "silent";
}
