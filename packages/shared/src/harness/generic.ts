import { VOLLI_FENCED_INSTRUCTIONS } from "./skill-content";
import type { HarnessAdapter, InstallAction } from "./types";

/** Declarative fallback for a harness that only supports a global instructions file. */
export function genericHarnessActions(instructionsPath: string): InstallAction[] {
  return [
    {
      kind: "fenced",
      path: instructionsPath,
      content: VOLLI_FENCED_INSTRUCTIONS,
      version: 1,
      managed: true,
    },
  ];
}

/**
 * Resume metadata for a harness with no known adapter — a custom/undetected
 * harness id (session-scoped harness ids are plain strings precisely so
 * these round-trip, see `ticket.ts`). Neither flag is known, so
 * `buildHarnessResumeCommand` (`harness-command.ts`) falls through to `null`
 * for both resume paths (interrupt/resume, issue #78).
 */
export const GENERIC_RESUME_METADATA: Pick<HarnessAdapter, "resumeIdArgs" | "resumeLatestArgs"> = {
  resumeIdArgs: null,
  resumeLatestArgs: null,
};
