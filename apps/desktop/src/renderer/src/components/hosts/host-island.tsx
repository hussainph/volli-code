/**
 * The connection Island (VC-576; the owner's VC-615 decision 5): a capsule
 * floating over the bottom of the content card while the current project's
 * host is in a state the page has to say — one line, at most one action, and
 * the board under it never moves.
 *
 * Blocking states (offline, a host that cannot serve this app) say so at
 * once and carry "Read-only"; "Reconnecting" waits out the 1.5 s grace so a
 * blip never flashes it; an update in flight says so quietly. Everything
 * non-blocking — an update on offer, an expired sign-in — stays a badge on
 * the title bar's chip, never here.
 *
 * Renders nothing with the `cloud` flag off.
 */
import * as React from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { WifiSlashIcon } from "@phosphor-icons/react/dist/csr/WifiSlash";

import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import type { HostRecord } from "@renderer/stores/host-connection";

import { EASE_OUT, SwapText } from "./host-parts";
import { hostSurface, type HostSurface, type HostSurfaceTone } from "./host-surface-model";
import {
  runHostAction,
  useCloudEnabled,
  useGrace,
  useNow,
  useCurrentProjectHostView,
} from "./use-hosts";

const TONE: Record<HostSurfaceTone, string> = {
  quiet: "text-muted-foreground",
  attention: "text-attention",
  error: "text-destructive",
};

const ICON = {
  reconnect: ArrowClockwiseIcon,
  offline: WifiSlashIcon,
  warning: WarningIcon,
} as const;

export function HostIsland() {
  const cloud = useCloudEnabled();
  if (!cloud) return null;
  return <EnabledHostIsland />;
}

function EnabledHostIsland() {
  // The current PROJECT's link, not the host's aggregate: a fence on another
  // project of the same box never takes this board's controls away.
  const host = useCurrentProjectHostView();
  const now = useNow(host.link.status === "offline");
  const shown = useGrace(hostSurface(host, now));
  const lane = React.useRef<HTMLDivElement>(null);
  const bottom = useComposerClearance(lane, shown !== null);
  return (
    <MotionConfig reducedMotion="user">
      <div
        ref={lane}
        data-slot="host-island"
        className="pointer-events-none absolute inset-x-0 z-40 flex justify-center"
        style={{ bottom }}
      >
        <AnimatePresence>
          {shown ? (
            <motion.div
              key="island"
              role="status"
              layout
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.16 } }}
              transition={{ duration: 0.28, ease: EASE_OUT }}
              className="pointer-events-auto flex h-11 items-center gap-2 rounded-full border border-border bg-popover pr-1.5 pl-4 shadow-overlay"
            >
              <SurfaceBody host={host} surface={shown} />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}

/** The lab's resting place: 88px above the content card's foot. */
export const ISLAND_BOTTOM_PX = 88;
/** Air between the Island and a composer it rises above. */
const ISLAND_COMPOSER_GAP_PX = 12;
/** Half the widest capsule, so a composer under either end of it counts. */
const ISLAND_HALF_WIDTH_PX = 240;

/**
 * Where the Island floats (px above the card's foot): the lab's 88px, or —
 * on a chat page — just above the composer, so it never covers the input. A
 * composer counts when it sits under the Island's lane inside the same card;
 * re-measured while the Island shows, as composers grow and panes resize.
 */
export function islandBottom(card: DOMRect, docks: readonly DOMRect[]): number {
  const center = card.left + card.width / 2;
  let bottom = ISLAND_BOTTOM_PX;
  for (const dock of docks) {
    if (dock.width === 0 || dock.height === 0) continue;
    if (dock.right < center - ISLAND_HALF_WIDTH_PX || dock.left > center + ISLAND_HALF_WIDTH_PX) {
      continue;
    }
    if (dock.top < card.top || dock.bottom > card.bottom + 1) continue;
    bottom = Math.max(bottom, card.bottom - dock.top + ISLAND_COMPOSER_GAP_PX);
  }
  return bottom;
}

function useComposerClearance(
  lane: React.RefObject<HTMLDivElement | null>,
  active: boolean,
): number {
  const [bottom, setBottom] = React.useState(ISLAND_BOTTOM_PX);
  React.useEffect(() => {
    if (!active) return;
    const measure = () => {
      const card = lane.current?.parentElement;
      if (!card) return;
      const docks = [...card.querySelectorAll<HTMLElement>('[data-slot="chat-composer-dock"]')].map(
        (dock) => dock.getBoundingClientRect(),
      );
      setBottom(islandBottom(card.getBoundingClientRect(), docks));
    };
    measure();
    // A composer grows as it is typed into and panes split and resize; a slow
    // poll while the Island shows is cheaper than observing every dock.
    const id = window.setInterval(measure, 500);
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("resize", measure);
    };
  }, [active, lane]);
  return bottom;
}

function SurfaceBody({ host, surface }: { host: HostRecord; surface: HostSurface }) {
  const Icon = ICON[surface.icon];
  const action = surface.action;
  return (
    <>
      <Icon
        aria-hidden
        weight={surface.tone === "quiet" ? "regular" : "fill"}
        className={cn(
          "size-4 shrink-0",
          TONE[surface.tone],
          surface.icon === "reconnect" && "animate-spin [animation-duration:1.4s]",
        )}
      />
      <SwapText className="text-ui text-foreground">{surface.line}</SwapText>
      {surface.meta ? (
        <span className="text-ui text-muted-foreground tabular-nums">· {surface.meta}</span>
      ) : null}
      {action ? (
        <Button
          size="sm"
          variant={surface.tone === "quiet" ? "secondary" : "default"}
          className="ml-2"
          onClick={() => runHostAction(action, host)}
        >
          {action.label}
        </Button>
      ) : (
        <span className="w-2" />
      )}
    </>
  );
}
