import * as React from "react";

/** Hidden windows retain state, not perpetual indicator timelines. */
export function useDocumentMotionVisibility(): void {
  React.useEffect(() => {
    const sync = () => {
      document.documentElement.dataset.documentHidden = String(document.hidden);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      delete document.documentElement.dataset.documentHidden;
    };
  }, []);
}

/** One observer for the board's mounted window, not one observer per ring.
 * Native intersection accounts for each column's scroll clip. DOM attributes
 * pause CSS without publishing visibility through React or reading layout.
 */
export function useBoardMotionVisibility(ref: React.RefObject<HTMLElement | null>): void {
  React.useEffect(() => {
    const root = ref.current;
    if (root === null || typeof IntersectionObserver === "undefined") return;
    const slots = new Set<HTMLElement>();
    const intersection = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        (entry.target as HTMLElement).dataset.viewportHidden = String(!entry.isIntersecting);
      }
    });
    const add = (node: Node) => {
      if (!(node instanceof HTMLElement)) return;
      const candidates = [
        ...(node.matches("[data-board-ticket-slot]") ? [node] : []),
        ...node.querySelectorAll<HTMLElement>("[data-board-ticket-slot]"),
      ];
      for (const slot of candidates) {
        if (slots.has(slot)) continue;
        slots.add(slot);
        slot.dataset.viewportHidden = "true";
        intersection.observe(slot);
      }
    };
    add(root);
    const mutations = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) add(node);
      for (const slot of slots) {
        if (root.contains(slot)) continue;
        intersection.unobserve(slot);
        delete slot.dataset.viewportHidden;
        slots.delete(slot);
      }
    });
    mutations.observe(root, { childList: true, subtree: true });
    return () => {
      mutations.disconnect();
      intersection.disconnect();
      for (const slot of slots) delete slot.dataset.viewportHidden;
    };
  }, [ref]);
}
