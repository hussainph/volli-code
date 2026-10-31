import { compareVersions } from "@volli/shared";
import type { Doc } from "../_generated/dataModel.js";
import { literals } from "./validators";

/** Supported owner-selected channels; stored strings stay open for older readers. */
export const runnerUpdateChannel = literals(["stable", "canary"] as const);

/** Advisory target, not a directive: the updater applies enabled/idle/floor policy.
 * A stale explicit pin cannot override the compatibility floor. */
export function runnerTargetVersion(
  autoUpdate: Doc<"runners">["autoUpdate"],
  release: Doc<"releaseChannels"> | null,
): string | null {
  const pin = autoUpdate.pinnedVersion;
  return pin !== null && (release === null || compareVersions(pin, release.minVersion) >= 0)
    ? pin
    : (release?.version ?? null);
}
