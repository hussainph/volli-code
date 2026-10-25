import { runnerStaysAvailable, type ThisMacRunnerSnapshot } from "@volli/shared";

/** Only an enrolled, usable runner can stay to receive work. Removed/failed
 * registrations retain their preference, but use ordinary quit-when-done. */
export function keepCloudRunnerAvailable(
  runner: ThisMacRunnerSnapshot,
  preference: string | null | undefined,
): boolean {
  if (runner.runnerId === null || !runnerStaysAvailable(preference)) return false;
  return (
    runner.state === "online" ||
    runner.state === "offline" ||
    runner.state === "connecting" ||
    runner.state === "asleep"
  );
}
