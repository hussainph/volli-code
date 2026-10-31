import { compareVersions } from "@volli/shared";
import type { Doc } from "../_generated/dataModel";

/** Neither an opt-out nor a stale explicit pin overrides the compatibility floor. */
export function runnerTargetVersion(
  autoUpdate: Doc<"runners">["autoUpdate"],
  release: Doc<"releaseChannels"> | null,
): string | null {
  const pin = autoUpdate.pinnedVersion;
  return pin !== null && (release === null || compareVersions(pin, release.minVersion) >= 0)
    ? pin
    : (release?.version ?? null);
}
