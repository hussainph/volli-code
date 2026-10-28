/** Viewer presence follows the visible chat surface, not the resident chat client. */
import * as React from "react";
import { launchStore } from "@renderer/stores/launch";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { followCloudSession, type CloudSession } from "./cloud-client";
import { showCloudSession } from "./cloud-session-transport";

export function useCloudSessionOnScreen(sessionId: string | null): void {
  const isDraft = useChatDraftsStore(
    (state) => sessionId !== null && state.drafts[sessionId]?.provisional?.phase === "draft",
  );
  React.useEffect(() => {
    // An untouched or refused Draft has no backend Session to watch. Begin
    // the bounded arrival window only once promotion actually created one.
    if (launchStore() !== "cloud" || sessionId === null || isDraft) return;
    let stopViewer: (() => void) | null = null;
    let current: CloudSession | null = null;
    const sync = () => {
      stopViewer?.();
      stopViewer =
        current === null || document.visibilityState === "hidden"
          ? null
          : showCloudSession(current, sessionId);
    };
    const stopFollowing = followCloudSession((session) => {
      current = session;
      sync();
    });
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      stopFollowing();
      stopViewer?.();
    };
  }, [sessionId, isDraft]);
}
