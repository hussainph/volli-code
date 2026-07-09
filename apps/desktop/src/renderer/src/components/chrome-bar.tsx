import { SidebarTrigger } from "@renderer/components/ui/sidebar";
import { useFullScreen } from "@renderer/hooks/use-fullscreen";
import { cn } from "@renderer/lib/utils";

/**
 * Full-width window chrome band — the ONLY drag-region owner for window
 * chrome (traffic lights, drag-to-move, the sidebar toggle). Everything
 * below it is ordinary layout. Its height (h-10, 40px) must stay in sync
 * with trafficLightPosition in main/index.ts, which centers the lights
 * inside it.
 */
export function ChromeBar() {
  const fullScreen = useFullScreen();

  return (
    <div className="app-region-drag flex h-10 shrink-0 items-center bg-rail">
      {/* Clears the traffic lights (start x:10, group renders ≈60px wide,
          ending ≈70px) plus breathing room so the trigger doesn't crowd them.
          Fullscreen hides the lights, so the spacer collapses and the trigger
          slides to the left edge — same animation the old rail-top-strip used. */}
      <div
        className={cn(
          "shrink-0 transition-[width] duration-300 ease-swift",
          fullScreen ? "w-2" : "w-[78px]",
        )}
      />
      {/* translate-y-px: the lights' optical center lands at ~20.5px (y:14 +
          half their ~13px diameter), just below the band's 20px flex center —
          nudge the trigger down to meet them. */}
      <SidebarTrigger className="app-region-no-drag translate-y-px" />
      {/* Reserved for a future ⌘K command-center pill. The content-area tab
          strip (if any) lives below in MainContent, not here. */}
      <div className="flex-1" />
    </div>
  );
}
