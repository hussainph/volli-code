/**
 * The product store this launch shows (VC-889): what main chose before the
 * window opened (`cloud.launch`), adopted once at boot and fixed for the life
 * of the process. `project-place.ts` explains what each answer means.
 */
import { LOCAL_LAUNCH, type CloudLaunch } from "@volli/shared";

let launch: CloudLaunch = LOCAL_LAUNCH;

/** Boot's one write: the launch main chose. Tests reset it with {@link LOCAL_LAUNCH}. */
export function adoptLaunch(next: CloudLaunch): void {
  launch = next;
}

/** The product store this launch shows. */
export function launchStore(): CloudLaunch["store"] {
  return launch.store;
}

/** Durable client Draft/preference ownership; never a Session or backend identity. */
export function cloudAccountScope(): string | null {
  return launch.store === "cloud" ? JSON.stringify([launch.backendUrl, launch.userId]) : null;
}

/** The cloud launch's facts (who, and which backend), or `null` in a local launch. */
export function cloudLaunchNow(): Extract<CloudLaunch, { store: "cloud" }> | null {
  return launch.store === "cloud" ? launch : null;
}
