/** This device's cloud runner availability; never a Workspace preference. */
export const RUNNER_RESIDENT_APP_STATE_KEY = "volli:runner-resident";

/** Default on. Only an explicit off opts into quit-when-done. */
export function runnerStaysAvailable(raw: string | null | undefined): boolean {
  return raw !== "false";
}
