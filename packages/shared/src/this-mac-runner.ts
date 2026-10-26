/**
 * "This Mac" as one of the person's runners (VC-895), as the desktop window
 * sees it: the wire types of the desktop-only `runners.*` entries
 * (`./desktop-entries`).
 *
 * In a Volli Cloud launch, desktop main registers the Mac it runs on as one of
 * the signed-in person's runners, keeps its sealed credential, and keeps it
 * connected (heartbeats, `asleep` on sleep, back on wake). The window gets
 * this snapshot and nothing else: no credential, no token. Every other runner
 * of the person's (and renaming or removing one) the window reads and writes
 * through its own Volli Cloud client; only this Mac's own registration goes
 * through main, because only main holds its credential.
 *
 * With the `cloud` experiment off every `runners.*` entry answers
 * unavailable; in a launch that is not a Volli Cloud one the snapshot is `off`.
 */

/**
 * Where this Mac's runner stands.
 *
 * - `off`: not a Volli Cloud launch, or nobody is signed in: nothing runs.
 * - `unregistered`: signed in, not registered yet (a registration starts on its own).
 * - `registering`: asking Volli Cloud to add this Mac.
 * - `connecting`: registered; the connection is not up yet.
 * - `online`: connected and heartbeating.
 * - `offline`: registered, but Volli Cloud cannot be reached; work here keeps running.
 * - `asleep`: the Mac said it was going to sleep; it reconnects on wake.
 * - `removed`: this Mac is no longer one of the person's runners (`problem` says why);
 *   it never adds itself back without the person (`runners.addThisMac`).
 * - `failed`: the registration or the sealed credential failed (`problem` says how);
 *   `runners.addThisMac` tries again.
 */
export const THIS_MAC_RUNNER_STATES = [
  "off",
  "unregistered",
  "registering",
  "connecting",
  "online",
  "offline",
  "asleep",
  "removed",
  "failed",
] as const;
export type ThisMacRunnerState = (typeof THIS_MAC_RUNNER_STATES)[number];

/**
 * Why this Mac is `removed` or `failed`. Open on read: a reason this build
 * does not know is shown through the snapshot's `message`.
 *
 * - `removed`: the person removed it (on this Mac, or from another device).
 * - `credential_reuse`: its credential was used from two places, so Volli Cloud cut it off.
 * - `replaced`: another registration of this Mac took its place.
 * - `credentials_locked`: this Mac's sealed credential could not be read (the keychain).
 * - `unreachable`: Volli Cloud could not be reached to register it.
 * - `refused`: Volli Cloud refused to register it (the account is being deleted, …).
 */
export const THIS_MAC_RUNNER_PROBLEMS = [
  "removed",
  "credential_reuse",
  "replaced",
  "credentials_locked",
  "unreachable",
  "refused",
] as const;
export type ThisMacRunnerProblem = (typeof THIS_MAC_RUNNER_PROBLEMS)[number];

export interface ThisMacRunnerSnapshot {
  readonly state: ThisMacRunnerState;
  /** The runner's id once registered (to mark it in the runner list); never a secret. */
  readonly runnerId: string | null;
  /** Its name as Volli Cloud chose it when it registered. */
  readonly runnerName: string | null;
  /** When the current state began (`offline since 14:02`); `null` for `off`. */
  readonly since: number | null;
  /** Session facts kept on this Mac that Volli Cloud has not accepted yet. */
  readonly waitingFacts: number;
  /** Why it is `removed` or `failed`; `null` otherwise. */
  readonly problem: ThisMacRunnerProblem | null;
  /** The blocked state in one sentence; `null` when nothing is blocked. */
  readonly message: string | null;
}

export const THIS_MAC_RUNNER_OFF: ThisMacRunnerSnapshot = Object.freeze({
  state: "off",
  runnerId: null,
  runnerName: null,
  since: null,
  waitingFacts: 0,
  problem: null,
  message: null,
});
