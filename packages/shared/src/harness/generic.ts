import { VOLLI_FENCED_INSTRUCTIONS } from "./skill-content";
import type { InstallAction } from "./types";

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
