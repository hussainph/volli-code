/**
 * The renderer's view of the self-updater (VC-59): the one snapshot main
 * pushes over `volli:update-state`, plus the install dialog's open/dismissed
 * bookkeeping. The sidebar's download icon and the install dialog both render
 * from here and nowhere else.
 *
 * Two rules carry the ticket's owner preference:
 *
 *  - **The dialog pops itself exactly once per downloaded version.** A
 *    `downloaded` snapshot auto-opens it the first time that version is seen;
 *    a dismissal is remembered (per version, per run) so re-broadcasts of the
 *    same staged download never nag. A NEWER version is a new offer and
 *    prompts once again.
 *  - **A dismissal never hides the update.** The badge derives from
 *    `state.phase === "downloaded"`, which a dismissal does not touch —
 *    clicking the badged icon re-opens the dialog through {@link
 *    UpdateStoreState.openDialog}.
 *
 * Memory-only, deliberately: install-on-quit means any relaunch is either the
 * new version (nothing to prompt about) or a fresh run where one more prompt
 * is the right behavior anyway.
 */
import { create } from "zustand";

import type { UpdateUiState } from "../../../ipc/contract";

export interface UpdateStoreState {
  /** The last snapshot main sent; null until the boot read or first push lands. */
  state: UpdateUiState | null;
  /** Whether the install dialog is showing right now. */
  dialogOpen: boolean;
  /** Versions whose one auto-open already happened this run. */
  promptedVersions: readonly string[];
  /** Accepts a snapshot (boot read or push) and applies the once-per-version auto-open. */
  receive(state: UpdateUiState): void;
  /** The badged icon's click — re-offers the install the user dismissed. Inert unless downloaded. */
  openDialog(): void;
  /** Closes the dialog, leaving the badge lit — the update stays visible. */
  dismissDialog(): void;
}

export function createUpdateStore() {
  return create<UpdateStoreState>()((set, get) => ({
    state: null,
    dialogOpen: false,
    promptedVersions: [],

    receive: (state) => {
      const { promptedVersions, dialogOpen } = get();
      const ready = state.phase === "downloaded" && state.targetVersion !== null;
      if (
        ready &&
        state.targetVersion !== null &&
        !promptedVersions.includes(state.targetVersion)
      ) {
        set({
          state,
          dialogOpen: true,
          promptedVersions: [...promptedVersions, state.targetVersion],
        });
        return;
      }
      // A dialog left open over a state that is no longer "downloaded" would
      // promise an install main can no longer perform — close it with the
      // state that invalidated it.
      set({ state, dialogOpen: dialogOpen && ready });
    },

    openDialog: () => {
      if (get().state?.phase !== "downloaded") return;
      set({ dialogOpen: true });
    },

    dismissDialog: () => set({ dialogOpen: false }),
  }));
}

/** The app's one update store — components subscribe here. */
export const useUpdateStore = createUpdateStore();
