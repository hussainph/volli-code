/**
 * The renderer's cache of the Automations a project can list (its own plus
 * every global one — `api.automations.list`), keyed by projectId, plus the
 * one piece of app-level view state the feature owns in VC-126: whether the
 * editor dialog is open, and for which project.
 *
 * Read on demand — the command palette refreshes on open, the editor after a
 * save — rather than subscribed: the record changes only through this app's
 * own doors today, and the palette's open IS the moment staleness would show.
 *
 * A save resolves the refusal STRING rather than toasting it: a rejected
 * name, empty Instructions or an unspellable pin is a correction to what is
 * still on screen in the dialog, not a failure behind the user's back. Only
 * reads toast here, per the surface-every-failure convention.
 */
import { create } from "zustand";
import { errorMessage, type Automation } from "@volli/shared";

import type { AutomationCreateInput } from "../../../ipc/contract";

type AutomationDraftInput = Omit<AutomationCreateInput, "commandId"> & {
  /** Kept by a caller across a transport retry; generated here when omitted. */
  commandId?: string;
};
import { toastError } from "@renderer/lib/toast";

interface AutomationsState {
  /** projectId → its listable Automations (own + global), name-ordered by main. */
  byProject: Record<string, readonly Automation[]>;
  /** The editor dialog: closed, or creating under one project. */
  editor: { projectId: string } | null;
  /** Re-fetches one project's list and replaces the cache. Toasts on failure. */
  refresh(projectId: string): Promise<void>;
  openEditor(projectId: string): void;
  closeEditor(): void;
  /**
   * Creates one Automation through main's validating door. Resolves `null` on
   * success (cache refreshed, dialog left to the caller to close), or the
   * refusal message for the dialog to show inline.
   */
  save(input: AutomationDraftInput): Promise<string | null>;
}

/** Factory so tests get isolated instances (the store module's own convention). */
export function createAutomationsStore() {
  return create<AutomationsState>()((set, get) => ({
    byProject: {},
    editor: null,

    async refresh(projectId) {
      try {
        const result = await window.api.automations.list({ projectId });
        if (!result.ok) {
          toastError(`Couldn't load automations: ${result.error}`);
          return;
        }
        set((state) => ({ byProject: { ...state.byProject, [projectId]: result.automations } }));
      } catch (error) {
        toastError(`Couldn't load automations: ${errorMessage(error)}`);
      }
    },

    openEditor(projectId) {
      set({ editor: { projectId } });
    },

    closeEditor() {
      set({ editor: null });
    },

    async save(input) {
      try {
        const { commandId, ...draft } = input;
        const result = await window.api.automations.create({
          ...draft,
          // The renderer owns the durable retry identity. A caller can hold
          // this id across a transport retry; main never invents a host-local
          // counter or machine-derived substitute.
          commandId: commandId ?? crypto.randomUUID(),
        });
        if (!result.ok) return result.error;
        // A global Automation is listable everywhere, but the only cached list
        // guaranteed on screen is the project the dialog was opened under —
        // other projects re-read on their next palette open.
        const homeProjectId = input.projectId ?? get().editor?.projectId;
        if (homeProjectId !== undefined) await get().refresh(homeProjectId);
        return null;
      } catch (error) {
        return errorMessage(error);
      }
    },
  }));
}

export const useAutomationsStore = createAutomationsStore();
