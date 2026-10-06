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
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { WifiSlashIcon } from "@phosphor-icons/react/dist/csr/WifiSlash";

import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import type { HostRecord } from "@renderer/stores/host-connection";

import { EASE_OUT, SwapText } from "./host-parts";
import { hostSurface, type HostSurface, type HostSurfaceTone } from "./host-surface-model";
import { runHostAction, useCloudEnabled, useCurrentHost, useGrace, useNow } from "./use-hosts";

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
  const host = useCurrentHost();
  const now = useNow(host.link.status === "offline");
  const shown = useGrace(hostSurface(host, now));
  return (
    <MotionConfig reducedMotion="user">
      <div
        data-slot="host-island"
        className="pointer-events-none absolute inset-x-0 bottom-22 z-40 flex justify-center"
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
