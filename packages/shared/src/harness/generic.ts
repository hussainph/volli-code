import { VOLLI_FENCED_INSTRUCTIONS } from "./skill-content";
import type { InstallAction } from "./types";

/** Declarative fallback for a harness that only supports a global instructions file. */
export function genericHarnessActions(instructionsPath: string): InstallAction[] {
  return [
    {
      kind: "fenced",
      path: instructionsPath,
      content: VOLLI_FENCED_INSTRUCTIONS,
      // v2: the block now gates itself on the Volli env vars, so a session the
      // harness starts OUTSIDE Volli reads it and stands down (VC-42 F18).
      version: 2,
      managed: true,
    },
  ];
}
