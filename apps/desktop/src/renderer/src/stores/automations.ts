/**
 * The renderer's cache of the Automations a project can list (its own plus
 * every global one — `api.automations.list`), its Run history, the
 * machine-local enabled set, and the one piece of app-level view state the
 * feature owns: whether the editor dialog is open, for which project, and on
 * which record.
 *
 * Read on demand — the command palette refreshes on open, the page on mount
 * and after every write — rather than subscribed: the record changes only
 * through this app's own doors today, and an open IS the moment staleness
 * would show.
 *
 * Two failure conventions, and the split is deliberate:
 *
 *  - **A save resolves the refusal STRING.** A rejected name, empty
 *    Instructions or an unspellable pin is a correction to what is still on
 *    screen in the dialog, not a failure behind the user's back.
 *  - **Everything else toasts**, per the surface-every-failure convention:
 *    a read, a delete, a duplicate and an enable all happen with no form open
 *    to correct, so the toast is the only place a person could learn.
 */
import { create } from "zustand";
import {
  errorMessage,
  isAutomationRuntimePin,
  type Automation,
  type AutomationRun,
} from "@volli/shared";

import type { AutomationCreateInput, AutomationUpdateInput } from "../../../ipc/contract";
import { duplicateName } from "@renderer/components/automations/automations-page-model";
import { toastError } from "@renderer/lib/toast";

type AutomationDraftInput = Omit<AutomationCreateInput, "commandId"> & {
  /** Kept by a caller across a transport retry; generated here when omitted. */
  commandId?: string;
};

type AutomationUpdateDraftInput = Omit<AutomationUpdateInput, "commandId"> & {
  commandId?: string;
};

/**
 * The open editor. `automation` is the record being edited, or `null` when
 * this is a create — one field rather than a `mode` discriminant because the
 * record IS the mode: there is no editing state without a record to edit, and
 * no create state that has one.
 */
export interface AutomationEditorTarget {
  projectId: string;
  automation: Automation | null;
}

interface AutomationsState {
  /** projectId → its listable Automations (own + global), name-ordered by main. */
  byProject: Record<string, readonly Automation[]>;
  /** projectId → every Run on its Tickets, newest first. */
  runsByProject: Record<string, readonly AutomationRun[]>;
  /**
   * Which Automations are switched on ON THIS MACHINE. Not keyed by project:
   * a global Automation is one record with one switch, and the set is a
   * property of this host rather than of any project it can be listed in.
   *
   * Absent means off (VC-112: a machine fires nothing until someone turns
   * something on there), so an id this set does not name has not been
   * switched on here — whether or not anyone ever asked.
   */
  enabledIds: readonly string[];
  editor: AutomationEditorTarget | null;
  /** Re-fetches one project's list and replaces the cache. Toasts on failure. */
  refresh(projectId: string): Promise<void>;
  /** Re-fetches one project's Run history, newest first. Toasts on failure. */
  refreshRuns(projectId: string): Promise<void>;
  /** Re-reads the machine-local enabled set. Toasts on failure. */
  refreshEnablement(): Promise<void>;
  openEditor(projectId: string): void;
  /** Opens the editor on an existing record. The only authoring surface (VC-112). */
  editAutomation(projectId: string, automation: Automation): void;
  closeEditor(): void;
  /**
   * Creates one Automation through main's validating door. Resolves `null` on
   * success (cache refreshed, dialog left to the caller to close), or the
   * refusal message for the dialog to show inline.
   */
  save(input: AutomationDraftInput): Promise<string | null>;
  /** Rewrites one Automation's editable fields, under the same refusal contract. */
  update(input: AutomationUpdateDraftInput): Promise<string | null>;
  /**
   * Copies one Automation under a distinguishable name and opens the editor
   * on the copy, so "same work, different Trigger" is one click.
   */
  duplicate(projectId: string, automation: Automation): Promise<void>;
  /** Deletes the record. There is no archive — for a Skill, git is the archive. */
  remove(projectId: string, automation: Automation): Promise<void>;
  /**
   * Switches one Automation on or off on this machine, through the same
   * command door every other write uses — only the projection it lands in is
   * machine-local.
   */
  setEnabled(automationId: string, enabled: boolean): Promise<void>;
}

/** Factory so tests get isolated instances (the store module's own convention). */
export function createAutomationsStore() {
  return create<AutomationsState>()((set, get) => ({
    byProject: {},
    runsByProject: {},
    enabledIds: [],
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

    async refreshRuns(projectId) {
      try {
        const result = await window.api.automations.runsForProject({ projectId });
        if (!result.ok) {
          toastError(`Couldn't load run history: ${result.error}`);
          return;
        }
        set((state) => ({ runsByProject: { ...state.runsByProject, [projectId]: result.runs } }));
      } catch (error) {
        toastError(`Couldn't load run history: ${errorMessage(error)}`);
      }
    },

    async refreshEnablement() {
      try {
        const result = await window.api.automations.enablement();
        if (!result.ok) {
          toastError(`Couldn't read which automations are on: ${result.error}`);
          return;
        }
        set({ enabledIds: result.enabledAutomationIds });
      } catch (error) {
        toastError(`Couldn't read which automations are on: ${errorMessage(error)}`);
      }
    },

    openEditor(projectId) {
      set({ editor: { projectId, automation: null } });
    },

    editAutomation(projectId, automation) {
      set({ editor: { projectId, automation } });
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
        const refreshProjectId = input.projectId ?? get().editor?.projectId;
        if (refreshProjectId !== undefined) await get().refresh(refreshProjectId);
        return null;
      } catch (error) {
        return errorMessage(error);
      }
    },

    async update(input) {
      try {
        const { commandId, ...draft } = input;
        const result = await window.api.automations.update({
          ...draft,
          commandId: commandId ?? crypto.randomUUID(),
        });
        if (!result.ok) return result.error;
        const refreshProjectId = get().editor?.projectId;
        if (refreshProjectId !== undefined) await get().refresh(refreshProjectId);
        return null;
      } catch (error) {
        return errorMessage(error);
      }
    },

    async duplicate(projectId, automation) {
      const listed = get().byProject[projectId] ?? [];
      try {
        const result = await window.api.automations.create({
          commandId: crypto.randomUUID(),
          // Ownership is copied, never reset: a global Automation duplicated
          // into a project-owned one would quietly change where it is listed,
          // which is not what "duplicate" says.
          projectId: automation.projectId,
          name: duplicateName(
            automation.name,
            listed.map((listing) => listing.name),
          ),
          instructions: automation.instructions,
          // An unreadable stored Runtime is not copied as itself — the copy
          // inherits instead, which is the only Runtime we can promise is
          // valid. Its source keeps the corrupt row, visible on the page.
          runtime: isAutomationRuntimePin(automation.runtime) ? automation.runtime : null,
        });
        if (!result.ok) {
          toastError(`Couldn't duplicate automation: ${result.error}`);
          return;
        }
        await get().refresh(projectId);
        // Straight into the editor on the copy: the reason to duplicate is to
        // change something, so landing on the copy's own form is the second
        // half of the one click.
        set({ editor: { projectId, automation: result.automation } });
      } catch (error) {
        toastError(`Couldn't duplicate automation: ${errorMessage(error)}`);
      }
    },

    async remove(projectId, automation) {
      try {
        const result = await window.api.automations.delete({
          commandId: crypto.randomUUID(),
          automationId: automation.id,
        });
        if (!result.ok) {
          toastError(`Couldn't delete automation: ${result.error}`);
          return;
        }
        await get().refresh(projectId);
      } catch (error) {
        toastError(`Couldn't delete automation: ${errorMessage(error)}`);
      }
    },

    async setEnabled(automationId, enabled) {
      try {
        const result = await window.api.automations.setEnabled({
          // Durable intent, like every other write here: the projection this
          // lands in is machine-local, the command is not (BOUNDARIES rule 5).
          commandId: crypto.randomUUID(),
          automationId,
          enabled,
        });
        if (!result.ok) {
          toastError(`Couldn't change that automation: ${result.error}`);
          return;
        }
        set({ enabledIds: result.enabledAutomationIds });
      } catch (error) {
        toastError(`Couldn't change that automation: ${errorMessage(error)}`);
      }
    },
  }));
}

export const useAutomationsStore = createAutomationsStore();
