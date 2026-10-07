/**
 * The drawings the host surfaces share, ported from the VC-615 lab kit
 * (`lab/remote-host/parts.tsx` on PR #745): the host's tile, text that
 * changes in place, a height that follows its content, a progress line, a
 * running step's mark and a provider's monogram.
 *
 * Motion follows the kit's rules: entrances ease out on the app's curve, UI
 * motion stays under 300 ms, only transform / opacity / filter animate, and
 * reduced motion lands every value at once ({@link useMotionTiming}),
 * opacity and blur included: a surface's `MotionConfig reducedMotion="user"`
 * stops only transforms.
 */
import * as React from "react";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import { AppleLogoIcon } from "@phosphor-icons/react/dist/csr/AppleLogo";
import { DesktopTowerIcon } from "@phosphor-icons/react/dist/csr/DesktopTower";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { LinuxLogoIcon } from "@phosphor-icons/react/dist/csr/LinuxLogo";

import { cn } from "@renderer/lib/utils";
import type { HostOs } from "@renderer/stores/host-connection";

import type { HostBadge } from "./host-surface-model";

export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
/** The iOS sheet curve — fast start, long settle — for surfaces changing size. */
export const EASE_SWIFT = [0.32, 0.72, 0, 1] as const;

/** No motion: a value lands at once. */
export const INSTANT: Transition = { duration: 0, delay: 0 };

/**
 * The person's reduced motion, for every animated value. Motion's
 * `reducedMotion="user"` skips only transforms (opacity, blur and a drawn
 * path still animate), so each transition here goes through this: under
 * reduced motion it is {@link INSTANT}, otherwise its own timing, unchanged.
 */
export function useMotionTiming(): (transition: Transition) => Transition {
  const reduce = useReducedMotion() === true;
  return React.useCallback((transition) => (reduce ? INSTANT : transition), [reduce]);
}

/* ── Host tile ──────────────────────────────────────────────────────────── */

const TILE = {
  sm: {
    box: "size-6",
    radius: "rounded-sm",
    icon: "size-3.5",
    badge: "size-2.5 -right-0.5 -bottom-0.5",
  },
  /** The Add-a-host sheet's and a host page's header. */
  md: { box: "size-10", radius: "rounded-md", icon: "size-5", badge: "size-4 -right-1 -bottom-1" },
} as const;

/**
 * A host is a machine, so it gets an object's drawing: a small squircle with
 * a soft top light, in the canvas's own card and muted tones so it sits in
 * any theme. This Mac is drawn as the desktop, a remote host by its OS.
 */
export function HostGlyph({
  os,
  local = false,
  badge = null,
  size = "sm",
  className,
}: {
  os: HostOs | null;
  local?: boolean;
  /** A host's state, or `ready`: a green check, the add just finished. */
  badge?: HostBadge | "ready";
  size?: keyof typeof TILE;
  className?: string;
}) {
  const timed = useMotionTiming();
  const tile = TILE[size];
  const Icon = local
    ? DesktopTowerIcon
    : os === "linux"
      ? LinuxLogoIcon
      : os === "macos"
        ? AppleLogoIcon
        : HardDrivesIcon;
  return (
    <span
      data-slot="host-glyph"
      data-badge={badge ?? undefined}
      className={cn(
        "relative inline-grid shrink-0 place-items-center border border-border bg-gradient-to-b from-card to-muted text-foreground shadow-raised",
        tile.box,
        tile.radius,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-background/40 to-transparent",
          tile.radius,
        )}
      />
      <Icon
        aria-hidden
        weight={os === null && !local ? "regular" : "fill"}
        className={cn("relative", tile.icon)}
      />
      <AnimatePresence>
        {badge === null ? null : (
          <motion.span
            key={badge}
            aria-hidden
            className={cn(
              "absolute grid place-items-center rounded-full ring-2 ring-background",
              tile.badge,
              badge === "ready" && "bg-positive text-positive-foreground",
              badge === "fail" && "bg-destructive",
              badge === "attention" && "bg-attention",
              badge === "offline" && "bg-muted-foreground/50",
            )}
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.4, opacity: 0 }}
            transition={timed({ type: "spring", duration: 0.35, bounce: 0.3 })}
          >
            {badge === "ready" ? <CheckIcon weight="bold" className="size-[70%]" /> : null}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/* ── Text that changes in place ─────────────────────────────────────────── */

/**
 * A label that changes in place: the old words lift away and blur, the new
 * ones settle in from below. Keyed by the text, so "Reconnecting" becoming
 * "2 Sessions running" is one gesture, not a cut.
 */
export function SwapText({ children, className }: { children: string; className?: string }) {
  const timed = useMotionTiming();
  return (
    <span className={cn("relative inline-grid", className)}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={children}
          className="col-start-1 row-start-1 truncate"
          initial={{ opacity: 0, y: 5, filter: "blur(3px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -5, filter: "blur(3px)" }}
          transition={timed({ duration: 0.2, ease: EASE_OUT })}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/* ── Height that follows content ───────────────────────────────────────── */

/**
 * Animates its own height to whatever its child measures, so the switcher's
 * current-host row grows into an update's confirm and shrinks back rather
 * than snapping between heights.
 */
export function AutoHeight({ children }: { children: React.ReactNode }) {
  const timed = useMotionTiming();
  const inner = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState<number | "auto">("auto");
  React.useLayoutEffect(() => {
    const element = inner.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHeight(entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <motion.div
      className="overflow-hidden"
      // A focus landing below the animating edge scrolls an overflow-hidden
      // box, and the top of the content silently disappears. This box never
      // scrolls.
      onScroll={(event) => {
        event.currentTarget.scrollTop = 0;
      }}
      initial={false}
      animate={{ height }}
      transition={timed({ duration: 0.32, ease: EASE_SWIFT })}
    >
      <div ref={inner}>{children}</div>
    </motion.div>
  );
}

/* ── Progress ──────────────────────────────────────────────────────────── */

export function ProgressLine({ value, label }: { value: number; label: string }) {
  const timed = useMotionTiming();
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.max(0, Math.min(1, value)) * 100)}
      className="h-1 overflow-hidden rounded-full bg-muted"
    >
      <motion.div
        className="h-full origin-left rounded-full bg-foreground/80"
        initial={false}
        animate={{ scaleX: Math.max(0.02, Math.min(1, value)) }}
        transition={timed({ duration: 0.2, ease: "linear" })}
      />
    </div>
  );
}

/** A running step's mark: a ring with one arc turning. */
export function ActiveStepMark() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="size-4 shrink-0 animate-spin text-foreground [animation-duration:900ms] motion-reduce:animate-none"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.15"
        strokeWidth="1.75"
      />
      <path
        d="M8 2 a6 6 0 0 1 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ── Provider marks ────────────────────────────────────────────────────── */

const PROVIDER_TINT: Record<string, string> = {
  anthropic: "bg-[#d97757]/15 text-[#c4623f]",
  openai: "bg-foreground/10 text-foreground",
  openrouter: "bg-[#6467f2]/15 text-[#5558e3]",
};

/** A monogram, not a logo: no third-party marks are redistributed. */
export function ProviderMark({ id, name }: { id: string; name: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-sm font-mono text-ui font-semibold",
        PROVIDER_TINT[id] ?? "bg-muted text-foreground",
      )}
    >
      {name.slice(0, 1)}
    </span>
  );
}

/* ── A checklist step's mark ───────────────────────────────────────────── */

/** Each status a checklist row can be in; `attention` waits on the person. */
export type StepMarkStatus = "pending" | "active" | "done" | "failed" | "attention";

/**
 * A step's state as a mark (the lab's `StepMark`): a hollow dot waiting, the
 * running ring, a check drawn in, or a filled "!" — red for a failure, amber
 * for a question. The marks swap in place, so a row changes state without
 * moving.
 */
export function StepMark({ status }: { status: StepMarkStatus }) {
  const timed = useMotionTiming();
  return (
    <span
      aria-hidden
      data-slot="step-mark"
      data-status={status}
      className="relative grid size-4 shrink-0 place-items-center"
    >
      <AnimatePresence initial={false} mode="popLayout">
        {status === "pending" ? (
          <motion.span
            key="pending"
            className="size-2 rounded-full border border-muted-foreground/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={timed({ duration: 0.12 })}
          />
        ) : status === "active" ? (
          <motion.span
            key="active"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={timed({ duration: 0.16, ease: EASE_OUT })}
          >
            <ActiveStepMark />
          </motion.span>
        ) : status === "done" ? (
          <motion.svg
            key="done"
            viewBox="0 0 16 16"
            className="size-4 text-positive"
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={timed({ type: "spring", duration: 0.3, bounce: 0.35 })}
          >
            <circle cx="8" cy="8" r="7" fill="currentColor" />
            <motion.path
              d="M4.9 8.3 L7.1 10.4 L11.2 5.9"
              fill="none"
              stroke="var(--positive-foreground)"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={timed({ duration: 0.22, delay: 0.08, ease: EASE_OUT })}
            />
          </motion.svg>
        ) : (
          <motion.svg
            key={status}
            viewBox="0 0 16 16"
            className={cn("size-4", status === "failed" ? "text-destructive" : "text-attention")}
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={timed({ type: "spring", duration: 0.3, bounce: 0.35 })}
          >
            <circle cx="8" cy="8" r="7" fill="currentColor" />
            <path
              d="M8 4.6 V8.6"
              stroke={
                status === "failed"
                  ? "var(--destructive-foreground)"
                  : "var(--attention-foreground)"
              }
              strokeWidth="1.75"
              strokeLinecap="round"
            />
            <circle
              cx="8"
              cy="11.1"
              r="1"
              fill={
                status === "failed"
                  ? "var(--destructive-foreground)"
                  : "var(--attention-foreground)"
              }
            />
          </motion.svg>
        )}
      </AnimatePresence>
    </span>
  );
}
