import { useEffect } from "react";

import { useProjectsStore } from "@renderer/stores/projects";

/**
 * ⌘1–⌘9 select the Nth rail project. Reads the store at press time rather
 * than from a render closure, so the mapping tracks drag reorders.
 */
export function useProjectShortcuts() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.metaKey || event.ctrlKey || event.altKey) return;
      if (!/^[1-9]$/.test(event.key)) return;
      event.preventDefault();
      useProjectsStore.getState().selectByIndex(Number(event.key) - 1);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
