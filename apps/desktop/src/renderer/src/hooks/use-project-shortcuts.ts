import { useEffect } from "react";

import { projectIndexForKeyEvent } from "@renderer/lib/project-shortcut";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";

/**
 * ⌘1–⌘9 select the Nth rail project. Reads the store at press time rather
 * than from a render closure, so the mapping tracks drag reorders.
 */
export function useProjectShortcuts() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        !event.defaultPrevented &&
        event.metaKey &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.repeat &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        useUiStore.getState().toggleProjectRailHidden();
        return;
      }
      const index = projectIndexForKeyEvent(event);
      if (index === null) return;
      event.preventDefault();
      useProjectsStore.getState().selectByIndex(index);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
