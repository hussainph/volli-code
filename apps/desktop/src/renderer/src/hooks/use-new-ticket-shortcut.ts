import { useEffect } from "react";

import { isNewTicketKeyEvent, isTextEntryTarget } from "@renderer/lib/new-ticket-shortcut";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";

/**
 * Linear-style plain "c" opens the global New-ticket dialog from anywhere in
 * the app. Reads the stores at press time (not from a render closure) so the
 * guard tracks the latest settings/dialog/selection state. Bails when: the
 * event was already handled (`defaultPrevented`), the keypress itself isn't a
 * bare "c" (see {@link isNewTicketKeyEvent}), the keydown originated in text
 * entry / a live terminal / an already-open modal (see
 * {@link isTextEntryTarget}), Settings or the New-ticket dialog is already
 * open, or there is no selected project (the dialog needs one to attach the
 * ticket to).
 */
export function useNewTicketShortcut() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (!isNewTicketKeyEvent(event)) return;
      if (isTextEntryTarget(event.target)) return;

      const { settingsOpen, newTicketOpen, setNewTicketOpen } = useUiStore.getState();
      if (settingsOpen || newTicketOpen) return;

      const { projects, selectedProjectId } = useProjectsStore.getState();
      const selectedProject = projects.find((project) => project.id === selectedProjectId);
      if (selectedProject === undefined) return;

      event.preventDefault();
      setNewTicketOpen(true);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
