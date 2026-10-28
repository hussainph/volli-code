/**
 * Whether a launch composes the LOCAL Automation service: its SQLite command
 * engine, Run door, scheduler and armed-arrival timers.
 *
 * Only a local store does. A cloud launch's Automations live in Volli Cloud:
 * the backend owns the records and the clock and queues each due Run as an
 * `automation.run` job, which this runner executes when it is the one the
 * armer chose (`cloud-store/automation-jobs.ts`). A local Automation service
 * in a cloud launch would write Runs against rows that launch keeps only as
 * machine shadows, so it is not composed; the agent's `automation_run` routes
 * to the backend instead (`cloud-agent/session-verbs.ts`).
 *
 * The `cloud` flag is NOT this answer: a local launch with the flag on still
 * runs its own Automations. The launch's chosen product store decides.
 */
export function composesLocalAutomations(store: "local" | "cloud"): boolean {
  return store === "local";
}
