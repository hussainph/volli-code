/**
 * The drawings every remote-host flow shares: the host's tile, a step's mark,
 * text that resolves into a fact, a height that follows its content, a
 * command you can copy, a pairing code field and its QR.
 *
 * Motion rules for all of them (Emil's, and the app's): entrances ease out on
 * the app's `--ease-out` curve, UI motion stays under 300ms, only transform /
 * opacity / filter animate, and everything respects reduced motion through the
 * `MotionConfig reducedMotion="user"` each scratch mounts.
 */
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { AppleLogoIcon } from "@phosphor-icons/react/dist/csr/AppleLogo";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { DesktopTowerIcon } from "@phosphor-icons/react/dist/csr/DesktopTower";
import { GithubLogoIcon } from "@phosphor-icons/react/dist/csr/GithubLogo";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { LinuxLogoIcon } from "@phosphor-icons/react/dist/csr/LinuxLogo";

import { StatusDot } from "@renderer/components/ui/status-dot";
import { cn } from "@renderer/lib/utils";

import type { HostOs } from "./fixtures";

export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
/** The iOS sheet curve — fast start, long settle — for surfaces changing size. */
export const EASE_SWIFT = [0.32, 0.72, 0, 1] as const;

/* ── Host tile ──────────────────────────────────────────────────────────── */

const TILE = {
  sm: { box: "size-6 rounded-[7px]", icon: "size-3.5", badge: "size-2.5 -right-0.5 -bottom-0.5" },
  md: { box: "size-10 rounded-[11px]", icon: "size-5", badge: "size-4 -right-1 -bottom-1" },
  lg: { box: "size-14 rounded-[16px]", icon: "size-7", badge: "size-5 -right-1 -bottom-1" },
} as const;

export type GlyphBadge = "ok" | "fail" | "attention" | "offline" | null;

/**
 * A host is a machine, so it gets an object's drawing: a small squircle with
 * a soft top light, in the canvas's own card and muted tones so it sits in
 * any theme. The OS mark replaces the generic drive once the box says what it
 * is — the first fact the install learns, made visible on the object itself.
 */
export function HostGlyph({
  os,
  size = "md",
  badge = null,
  local = false,
  className,
}: {
  os: HostOs | null;
  size?: keyof typeof TILE;
  badge?: GlyphBadge;
  /** This Mac — drawn as the desktop, not a server. */
  local?: boolean;
  className?: string;
}) {
  const tile = TILE[size];
  const Icon = local
    ? DesktopTowerIcon
    : os === "linux"
      ? LinuxLogoIcon
      : os === "macos"
        ? AppleLogoIcon
        : HardDrivesIcon;
  const iconKey = local ? "local" : (os ?? "unknown");
  return (
    <span
      className={cn(
        "relative inline-grid shrink-0 place-items-center border border-border bg-gradient-to-b from-card to-muted text-foreground shadow-raised",
        tile.box,
        className,
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-1/2 rounded-[inherit] bg-gradient-to-b from-background/40 to-transparent"
      />
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={iconKey}
          className="relative grid place-items-center"
          initial={{ opacity: 0, scale: 0.6, filter: "blur(4px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, scale: 0.6, filter: "blur(4px)" }}
          transition={{ duration: 0.24, ease: EASE_OUT }}
        >
          <Icon
            aria-hidden
            weight={os === null && !local ? "regular" : "fill"}
            className={tile.icon}
          />
        </motion.span>
      </AnimatePresence>
      <AnimatePresence>
        {badge === null ? null : (
          <motion.span
            key={badge}
            aria-hidden
            className={cn(
              "absolute grid place-items-center rounded-full ring-2 ring-background",
              tile.badge,
              badge === "ok" && "bg-positive text-positive-foreground",
              badge === "fail" && "bg-destructive text-destructive-foreground",
              badge === "attention" && "bg-attention text-attention-foreground",
              badge === "offline" && "bg-muted-foreground/50",
            )}
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.4, opacity: 0 }}
            transition={{ type: "spring", duration: 0.35, bounce: 0.3 }}
          >
            {badge === "ok" ? <CheckIcon weight="bold" className="size-[70%]" /> : null}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/* ── Step mark ──────────────────────────────────────────────────────────── */

export type StepStatus = "pending" | "active" | "done" | "failed" | "attention";

/**
 * 16px, one drawing per state. The check DRAWS rather than appears — the
 * stroke runs once, so five of them landing in sequence reads as progress you
 * can hear.
 */
export function StepMark({ status, className }: { status: StepStatus; className?: string }) {
  return (
    <span className={cn("relative grid size-4 shrink-0 place-items-center", className)} aria-hidden>
      <AnimatePresence initial={false} mode="popLayout">
        {status === "pending" ? (
          <motion.span
            key="pending"
            className="size-2 rounded-full border border-muted-foreground/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
          />
        ) : status === "active" ? (
          <motion.svg
            key="active"
            viewBox="0 0 16 16"
            className="size-4 animate-spin text-foreground [animation-duration:900ms]"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={{ duration: 0.16, ease: EASE_OUT }}
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
          </motion.svg>
        ) : status === "done" ? (
          <motion.svg
            key="done"
            viewBox="0 0 16 16"
            className="size-4 text-positive"
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: "spring", duration: 0.3, bounce: 0.35 }}
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
              transition={{ duration: 0.22, delay: 0.08, ease: EASE_OUT }}
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
            transition={{ type: "spring", duration: 0.3, bounce: 0.35 }}
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

/* ── Text that resolves ─────────────────────────────────────────────────── */

/**
 * A label that changes in place: the old words lift away and blur, the new
 * ones settle in from below. Keyed by the text, so a step's "Connecting…"
 * becoming "Connected as hussain" is one gesture, not a cut.
 */
export function SwapText({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn("relative inline-grid", className)}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={children}
          className="col-start-1 row-start-1 truncate"
          initial={{ opacity: 0, y: 5, filter: "blur(3px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -5, filter: "blur(3px)" }}
          transition={{ duration: 0.2, ease: EASE_OUT }}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/* ── Height that follows content ───────────────────────────────────────── */

/**
 * Animates its own height to whatever its child measures. The sheet changes
 * shape as a flow moves (one field → five steps → a result), and a sheet that
 * snaps between heights reads as three different dialogs.
 */
export function AutoHeight({
  children,
  className,
  duration = 0.32,
}: {
  children: React.ReactNode;
  className?: string;
  duration?: number;
}) {
  const inner = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState<number | "auto">("auto");
  React.useLayoutEffect(() => {
    const element = inner.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHeight(entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <motion.div
      className={cn("overflow-hidden", className)}
      // A focus landing below the animating edge (autoFocus on a fresh
      // button) scrolls an overflow-hidden box, and the top of the content
      // silently disappears. This box never scrolls.
      onScroll={(event) => {
        event.currentTarget.scrollTop = 0;
      }}
      initial={false}
      animate={{ height }}
      transition={{ duration, ease: EASE_SWIFT }}
    >
      <div ref={inner}>{children}</div>
    </motion.div>
  );
}

/* ── Copyable command ──────────────────────────────────────────────────── */

export function CommandLine({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <div
      className={cn(
        "flex h-8 items-center gap-2 rounded-control border border-border bg-muted/50 pr-1 pl-4 font-mono text-ui",
        className,
      )}
    >
      <span className="text-muted-foreground select-none">$</span>
      <span className="min-w-0 flex-1 truncate">{command}</span>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy command"}
        onClick={() => {
          void navigator.clipboard?.writeText(command).catch(() => {});
          setCopied(true);
        }}
        className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={copied ? "copied" : "copy"}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={{ duration: 0.14, ease: EASE_OUT }}
          >
            {copied ? (
              <CheckIcon weight="bold" className="size-3.5 text-positive" />
            ) : (
              <CopyIcon className="size-3.5" />
            )}
          </motion.span>
        </AnimatePresence>
      </button>
    </div>
  );
}

/* ── Progress ──────────────────────────────────────────────────────────── */

export function ProgressLine({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn("h-1 overflow-hidden rounded-full bg-muted", className)}>
      <motion.div
        className="h-full origin-left rounded-full bg-foreground/80"
        initial={false}
        animate={{ scaleX: Math.max(0.02, Math.min(1, value)) }}
        transition={{ duration: 0.2, ease: "linear" }}
      />
    </div>
  );
}

/* ── Provider marks ────────────────────────────────────────────────────── */

const PROVIDER_TINT: Record<string, string> = {
  anthropic: "bg-[#d97757]/15 text-[#c4623f]",
  openai: "bg-foreground/10 text-foreground",
  openrouter: "bg-[#6467f2]/15 text-[#5558e3]",
};

/** A monogram, not a logo: the lab redistributes no third-party marks. */
export function ProviderMark({ id, name }: { id: string; name: string }) {
  if (id === "github") {
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-foreground/10 text-foreground">
        <GithubLogoIcon weight="fill" className="size-3.5" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-[7px] font-mono text-ui font-semibold",
        PROVIDER_TINT[id] ?? "bg-muted text-foreground",
      )}
    >
      {name.slice(0, 1)}
    </span>
  );
}

/* ── QR ─────────────────────────────────────────────────────────────────── */

function seeded(seed: string) {
  let h = 2166136261;
  for (const char of seed) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 1000) / 1000;
  };
}

function finder(x: number, y: number) {
  return (
    <g key={`${x}-${y}`}>
      <rect x={x} y={y} width={7} height={7} rx={1.6} fill="currentColor" />
      <rect x={x + 1} y={y + 1} width={5} height={5} rx={1} fill="var(--qr-paper)" />
      <rect x={x + 2} y={y + 2} width={3} height={3} rx={0.8} fill="currentColor" />
    </g>
  );
}

/**
 * A drawing of a QR, not a scannable one: three finders, timing rows and a
 * deterministic field seeded by the payload. Lab fixture only — the real code
 * carries the host-key fingerprint (host-identity.md § Keys) and comes from
 * a real encoder.
 */
export function QrCode({
  payload,
  size = 168,
  className,
}: {
  payload: string;
  size?: number;
  className?: string;
}) {
  const modules = 29;
  const cells = React.useMemo(() => {
    const random = seeded(payload);
    const out: [number, number][] = [];
    const inFinder = (x: number, y: number) =>
      (x < 8 && y < 8) || (x >= modules - 8 && y < 8) || (x < 8 && y >= modules - 8);
    for (let y = 0; y < modules; y += 1) {
      for (let x = 0; x < modules; x += 1) {
        if (inFinder(x, y)) continue;
        if (y === 6 || x === 6) {
          if ((x + y) % 2 === 0) out.push([x, y]);
          continue;
        }
        if (x >= 20 && x <= 24 && y >= 20 && y <= 24) continue;
        if (random() > 0.52) out.push([x, y]);
      }
    }
    return out;
  }, [payload]);
  return (
    <svg
      viewBox={`-2 -2 ${modules + 4} ${modules + 4}`}
      width={size}
      height={size}
      className={cn("text-[#111] [--qr-paper:#fff]", className)}
      role="img"
      aria-label="Pairing QR code"
    >
      <rect x={-2} y={-2} width={modules + 4} height={modules + 4} rx={3} fill="var(--qr-paper)" />
      {cells.map(([x, y]) => (
        <rect
          key={`${x}:${y}`}
          x={x + 0.08}
          y={y + 0.08}
          width={0.84}
          height={0.84}
          rx={0.3}
          fill="currentColor"
        />
      ))}
      {finder(0, 0)}
      {finder(modules - 7, 0)}
      {finder(0, modules - 7)}
      <rect x={20} y={20} width={5} height={5} rx={1} fill="currentColor" />
      <rect x={21} y={21} width={3} height={3} rx={0.6} fill="var(--qr-paper)" />
      <rect x={22} y={22} width={1} height={1} fill="currentColor" />
    </svg>
  );
}

/* ── Pairing code field ────────────────────────────────────────────────── */

const CODE_ALPHABET = /[0-9A-HJKMNP-TV-Z]/;

/** Crockford's base32 forgiveness: the letters people mistype become digits. */
export function normalizeCodeChar(char: string): string {
  const upper = char.toUpperCase();
  if (upper === "O") return "0";
  if (upper === "I" || upper === "L") return "1";
  return CODE_ALPHABET.test(upper) ? upper : "";
}

/**
 * Twelve characters in three groups. Type, paste the whole thing (dashes,
 * spaces, lowercase and `O`-for-zero all forgiven) or backspace across groups;
 * focus travels by itself. One field to the accessibility tree.
 */
export function CodeInput({
  value,
  onChange,
  invalid = false,
  disabled = false,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  const [focused, setFocused] = React.useState(false);
  const chars = value.padEnd(12, " ").slice(0, 12).split("");
  const caret = Math.min(value.length, 11);
  return (
    <motion.div
      className="relative inline-flex items-center gap-2"
      animate={invalid ? { x: [0, -6, 6, -4, 4, 0] } : { x: 0 }}
      transition={{ duration: 0.32, ease: "easeOut" }}
      onPointerDown={(event) => {
        event.preventDefault();
        input.current?.focus();
      }}
    >
      <input
        ref={input}
        aria-label="Pairing code"
        autoFocus={autoFocus}
        disabled={disabled}
        value={value}
        autoComplete="one-time-code"
        spellCheck={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => {
          const next = Array.from(event.target.value).map(normalizeCodeChar).join("").slice(0, 12);
          onChange(next);
        }}
        className="absolute inset-0 opacity-0"
      />
      {[0, 1, 2].map((group) => (
        <React.Fragment key={group}>
          {group > 0 ? <span className="h-px w-2 bg-muted-foreground/50" aria-hidden /> : null}
          <span className="flex gap-1" aria-hidden>
            {[0, 1, 2, 3].map((slot) => {
              const index = group * 4 + slot;
              const char = chars[index]?.trim() ?? "";
              const isCaret = focused && !disabled && index === caret && value.length < 12;
              return (
                <span
                  key={slot}
                  className={cn(
                    "relative grid h-10 w-8 place-items-center rounded-[9px] border bg-background font-mono text-heading shadow-raised transition-colors duration-150",
                    invalid ? "border-destructive/60" : isCaret ? "border-ring" : "border-border",
                    disabled && "opacity-60",
                  )}
                >
                  <AnimatePresence initial={false}>
                    {char ? (
                      <motion.span
                        key={char + index}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.12, ease: EASE_OUT }}
                      >
                        {char}
                      </motion.span>
                    ) : null}
                  </AnimatePresence>
                  {isCaret ? (
                    <span className="absolute h-4 w-px animate-pulse bg-foreground [animation-duration:1s]" />
                  ) : null}
                </span>
              );
            })}
          </span>
        </React.Fragment>
      ))}
    </motion.div>
  );
}

export function formatCode(value: string): string {
  return [value.slice(0, 4), value.slice(4, 8), value.slice(8, 12)].filter(Boolean).join("-");
}

/* ── Venue ──────────────────────────────────────────────────────────────── */

/**
 * "Running on <host>" — the venue label VC-576 / VC-583 own, drawn the way
 * these prototypes assume it: a quiet pill whose dot is the host's state,
 * not the Session's.
 */
export function VenueChip({
  host,
  state,
  className,
}: {
  host: string;
  state: "ready" | "waiting" | "exited" | "starting" | "error";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full border border-border px-2 text-ui leading-5 text-muted-foreground",
        className,
      )}
    >
      <StatusDot state={state} />
      {host}
    </span>
  );
}

/* ── Keyboard hint ─────────────────────────────────────────────────────── */

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-grid h-4 min-w-4 place-items-center rounded-[5px] border border-border bg-muted/50 px-1 font-sans text-label text-muted-foreground normal-case">
      {children}
    </kbd>
  );
}
