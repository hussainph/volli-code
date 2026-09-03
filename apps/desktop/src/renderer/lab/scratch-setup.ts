import { installFakeApi } from "./fake-api";
import type { ScratchModule } from "./scratch";

export type Scratch = ScratchModule & { slug: string };

/**
 * Installs one scratch's isolated bridge and store fixtures, then restores the
 * Lab-owned theme a seed such as `seedApp` may have reset.
 */
export function activateScratch(scratch: Scratch, reapplyTheme: () => void): void {
  // Installed wholesale, never merged: the previous scratch's stubs must not
  // survive into this one.
  installFakeApi(scratch.api ?? {});
  scratch.seed?.();
  // A scratch may reset the shared theme store while seeding (seedApp does).
  // The Lab choice wins after that isolated setup and before the scratch paints.
  reapplyTheme();
}
