/**
 * Whether this launch has Automations at all (VC-952).
 *
 * A cloud launch does not. Its board, Tickets and Sessions live in Volli
 * Cloud, and nothing there can list, arm or run an Automation until VC-569
 * ports them; a local Automation service would write Runs against rows this
 * launch keeps only as machine shadows. So a cloud launch composes the
 * degraded Automation module, offers no new Session `automation.run` (direct
 * or through Code Mode), and refuses a Session already frozen with it.
 *
 * The `cloud` flag is NOT this answer: a local launch with the flag on still
 * runs its own Automations. The launch's chosen product store decides.
 */
export const AUTOMATIONS_UNAVAILABLE_IN_CLOUD =
  "Automations are not available in cloud launches yet.";
