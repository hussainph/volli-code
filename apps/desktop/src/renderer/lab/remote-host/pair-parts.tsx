/**
 * The pairing scratch's additions to the remote-host kit (VC-615 flows 2–3):
 * the box's terminal window, the sheet standing in place rather than over a
 * scrim (so two devices can share one stage), the route choice, device tiles,
 * a phone frame and a ticking expiry.
 *
 * Same motion rules as `parts.tsx`: ease-out entrances under 300ms, only
 * transform / opacity / filter animate, AutoHeight is the one height animator,
 * and the scratch root mounts `MotionConfig reducedMotion="user"`.
 */
import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react/dist/csr/ArrowsLeftRight";
import { BrowserIcon } from "@phosphor-icons/react/dist/csr/Browser";
import { DeviceMobileIcon } from "@phosphor-icons/react/dist/csr/DeviceMobile";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { KeyIcon } from "@phosphor-icons/react/dist/csr/Key";
import { LaptopIcon } from "@phosphor-icons/react/dist/csr/Laptop";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { cn } from "@renderer/lib/utils";

import type { PairedDevice } from "./fixtures";
import { AutoHeight, EASE_OUT } from "./parts";

/* ── Fixtures this flow adds ───────────────────────────────────────────── */

/** What a second `volli-hostd pair` prints — a fresh code, never the old one. */
export const NEXT_PAIRING_CODE = "M3VW-8QZB-2KFD";
/** A near miss: one character off, the mistake a person actually makes. */
export const MISTYPED_CODE = "RQ7K-4MXD-T9PN";
/** A restored box generates a new key; this is what it prints afterwards. */
export const NEW_HOST_KEY_FINGERPRINT = "SHA256:7Hc2Mv0RpQ4eYw1kZt8bNaL3xGf6sJd9uTq5iEoVrCm";
export const NEW_SHORT_FINGERPRINT = "7Hc2 Mv0R pQ4e";
/** The id the host gives this Mac's new device key. */
export const DEVICE_ID = "3c9e41a7";
export const PHONE_ID = "8b2f07d1";
export const SSH_TARGET = "hussain@203.0.113.24";
export const EXAMPLE_URL = "https://hetzner-1.hussain.dev";
/** This Mac's and the phone's addresses on the tailnet, as the host sees them. */
export const MAC_TAILNET_IP = "100.101.7.42";
export const PHONE_TAILNET_IP = "100.88.30.9";
/** How long a pairing code lives — the host prints the countdown. */
export const CODE_TTL_MS = 10 * 60 * 1000;

/** `RQ7K-4MXD-T9PH` → `RQ7K4MXDT9PH`, the shape `CodeInput` holds. */
export function bareCode(code: string): string {
  return code.replaceAll("-", "");
}

/* ── Time ──────────────────────────────────────────────────────────────── */

/** A clock that re-renders its reader every `interval` ms. */
export function useNow(interval = 1000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(id);
  }, [interval]);
  return now;
}

/** `599_000` → `9:59`. A fresh code reads 9:59, never 10:00 or a clock-skewed 10:01. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(Math.min(ms, CODE_TTL_MS - 1) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/* ── The box's terminal ────────────────────────────────────────────────── */

/**
 * A terminal window onto the box, in the box's colours (host-add's LogView
 * palette) rather than the app's. Its traffic lights are grey on purpose: the
 * Volli sheet beside it is the key window, and macOS draws an inactive
 * window's lights grey — the stage reads as one desk with one focus.
 */
export function TerminalWindow({
  title,
  children,
  className,
  scrollKey,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  /** Change it to follow new output to the bottom. */
  scrollKey?: React.Key;
}) {
  const body = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const element = body.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [scrollKey]);
  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-[14px] border border-white/10 bg-[#101012] shadow-overlay",
        className,
      )}
    >
      <div className="relative flex h-8 shrink-0 items-center border-b border-white/5 bg-[#17171a] px-3">
        <span className="flex gap-2" aria-hidden>
          {[0, 1, 2].map((dot) => (
            <span key={dot} className="size-3 rounded-full bg-white/12" />
          ))}
        </span>
        <span className="pointer-events-none absolute inset-x-0 text-center font-mono text-ui text-white/40">
          {title}
        </span>
      </div>
      <div
        ref={body}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3 font-mono text-ui leading-5 text-white/60 [scrollbar-width:none]"
      >
        {children}
      </div>
    </div>
  );
}

/** The braille spinner every CLI draws; still under reduced motion. */
export function TerminalSpinner({ className }: { className?: string }) {
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const reduced = useReducedMotion();
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => setFrame((value) => (value + 1) % frames.length), 80);
    return () => clearInterval(id);
  }, [reduced]);
  return (
    <span aria-hidden className={cn("inline-block w-[1ch]", className)}>
      {frames[frame]}
    </span>
  );
}

/* ── The sheet, standing in place ──────────────────────────────────────── */

/**
 * `SheetFrame`'s card without its fixed scrim: the same radius, ink, shadow
 * and entrance, laid out in the stage's flow so the box can stand beside it.
 */
export function InlineSheet({
  label,
  width,
  onClose,
  children,
  className,
  ref,
}: {
  label: string;
  width: number;
  onClose?: () => void;
  children: React.ReactNode;
  className?: string;
  /** Forwarded so a `popLayout` presence can pop the sheet out of flow as it leaves. */
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <motion.div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={cn(
        "relative w-full overflow-hidden rounded-container border border-border bg-background shadow-overlay",
        className,
      )}
      style={{ maxWidth: width }}
      initial={{ opacity: 0, scale: 0.96, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: 4, transition: { duration: 0.15, ease: EASE_OUT } }}
      transition={{ duration: 0.26, ease: EASE_OUT }}
    >
      {onClose ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Close"
          className="absolute top-4 right-4 z-10 text-muted-foreground"
          onClick={onClose}
        >
          <XIcon weight="bold" />
        </Button>
      ) : null}
      {children}
    </motion.div>
  );
}

/** A section's noun, in the sheet's label idiom ("Use this Mac's sign-ins"). */
export function SheetLabel({ children }: { children: React.ReactNode }) {
  return <p className="pb-2 font-mono text-label text-muted-foreground uppercase">{children}</p>;
}

/**
 * The host key, quietly: a short fingerprint a careful person can hold up
 * against the box's terminal. The full one is the tooltip.
 */
export function FingerprintTag({
  short,
  full,
  className,
}: {
  short: string;
  full: string;
  className?: string;
}) {
  return (
    <span
      title={full}
      className={cn(
        "inline-flex items-center gap-1 font-mono text-ui text-muted-foreground",
        className,
      )}
    >
      <KeyIcon aria-hidden className="size-3.5 shrink-0" />
      <span aria-label={`Host key ${full}`}>{short}</span>
    </span>
  );
}

/* ── Route ─────────────────────────────────────────────────────────────── */

export type Route = "tailscale" | "url" | "ssh";

export const ROUTE_NAME: Record<Route, string> = {
  tailscale: "Tailscale",
  url: "URL",
  ssh: "SSH tunnel",
};

/** `hetzner-1.hussain.dev` → `https://hetzner-1.hussain.dev`; null until it looks like an address. */
export function normalizeUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const withScheme = /^[a-z]+:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

const ROUTE_ICON = {
  tailscale: ArrowsLeftRightIcon,
  url: GlobeIcon,
  ssh: TerminalWindowIcon,
} as const satisfies Record<Route, unknown>;

function RouteMark({ route }: { route: Route }) {
  const Icon = ROUTE_ICON[route];
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-foreground/10 text-foreground">
      <Icon aria-hidden weight="bold" className="size-3.5" />
    </span>
  );
}

function RadioMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-full border transition-colors duration-150",
        checked ? "border-primary bg-primary" : "border-muted-foreground/40 bg-background",
      )}
    >
      <motion.span
        className="size-1.5 rounded-full bg-primary-foreground"
        initial={false}
        animate={{ scale: checked ? 1 : 0, opacity: checked ? 1 : 0 }}
        transition={{ duration: 0.16, ease: EASE_OUT }}
      />
    </span>
  );
}

/**
 * How this Mac reaches the host: one closed set, all on screen, radio rows in
 * the sign-in list's container. The URL row grows its field in place when
 * chosen. A route that is not available stays in the list, dimmed, with the
 * reason as its meta — hiding it would answer a question no one got to ask.
 */
export function RouteChoice({
  value,
  onChange,
  tailnet,
  url,
  onUrl,
  onSubmit,
  disabled = false,
}: {
  value: Route;
  onChange: (route: Route) => void;
  /** The host's tailnet name, or null when it is on no tailnet. */
  tailnet: string | null;
  url: string;
  onUrl: (url: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
}) {
  const rows: readonly { route: Route; meta: string; available: boolean }[] = [
    { route: "tailscale", meta: tailnet ?? "Not on a tailnet", available: tailnet !== null },
    {
      route: "url",
      // While its field is open the field is the value; the meta just names the protocol.
      meta: value === "url" ? "HTTPS" : url.trim() ? (normalizeUrl(url) ?? url) : "https://…",
      available: true,
    },
    { route: "ssh", meta: SSH_TARGET, available: true },
  ];
  const refs = React.useRef<Partial<Record<Route, HTMLButtonElement | null>>>({});
  const move = (from: Route, step: 1 | -1) => {
    const open = rows.filter((row) => row.available);
    const index = open.findIndex((row) => row.route === from);
    const next = open[(index + step + open.length) % open.length];
    if (!next) return;
    onChange(next.route);
    refs.current[next.route]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label="Route"
      className="rounded-row border border-border/70 bg-muted/30 p-1"
    >
      {rows.map((row) => {
        const checked = row.route === value;
        return (
          <div key={row.route} className={cn(!row.available && "opacity-50")}>
            <button
              ref={(element) => {
                refs.current[row.route] = element;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={disabled || !row.available}
              tabIndex={checked ? 0 : -1}
              onClick={() => onChange(row.route)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                  event.preventDefault();
                  move(row.route, 1);
                } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                  event.preventDefault();
                  move(row.route, -1);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  onSubmit();
                }
              }}
              className={cn(
                "flex w-full cursor-default items-center gap-2 rounded-[12px] px-2 py-2 text-left transition-colors duration-100 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring",
                row.available && !disabled && "hover:bg-accent/60",
                checked && "bg-accent/60",
              )}
            >
              <RouteMark route={row.route} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui font-medium text-foreground">
                  {ROUTE_NAME[row.route]}
                </span>
                <span
                  className={cn(
                    "block truncate text-ui text-muted-foreground",
                    row.available && row.route !== "url" && "font-mono",
                    row.route === "url" && !checked && url.trim() && "font-mono",
                  )}
                >
                  {row.meta}
                </span>
              </span>
              <RadioMark checked={checked} />
            </button>
            {row.route === "url" ? (
              <AutoHeight duration={0.24}>
                <AnimatePresence initial={false}>
                  {checked ? (
                    <motion.div
                      key="url"
                      className="px-2 pt-1 pb-2 pl-10"
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, transition: { duration: 0.1 } }}
                      transition={{ duration: 0.2, ease: EASE_OUT, delay: 0.06 }}
                    >
                      <Input
                        autoFocus
                        aria-label="Host URL"
                        value={url}
                        disabled={disabled}
                        placeholder={EXAMPLE_URL}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        className="h-9 font-mono text-sm"
                        onChange={(event) => onUrl(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") onSubmit();
                        }}
                      />
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </AutoHeight>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ── Devices ───────────────────────────────────────────────────────────── */

const DEVICE_TILE = {
  sm: { box: "size-6 rounded-[7px]", icon: "size-3.5" },
  md: { box: "size-10 rounded-[11px]", icon: "size-5" },
} as const;

const DEVICE_ICON = {
  mac: LaptopIcon,
  phone: DeviceMobileIcon,
  browser: BrowserIcon,
} as const satisfies Record<PairedDevice["kind"], unknown>;

/** A client's tile, drawn like `HostGlyph` so hosts and devices are one family of objects. */
export function DeviceGlyph({
  kind,
  size = "sm",
  className,
}: {
  kind: PairedDevice["kind"];
  size?: keyof typeof DEVICE_TILE;
  className?: string;
}) {
  const Icon = DEVICE_ICON[kind];
  const tile = DEVICE_TILE[size];
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
      <Icon aria-hidden className={cn("relative", tile.icon)} />
    </span>
  );
}

/* ── Phone ─────────────────────────────────────────────────────────────── */

/**
 * A phone, sketched: bezel, island, status bar, home indicator. The screen is
 * whatever the children draw; `ink` is the status bar's colour against it.
 */
export function PhoneFrame({
  children,
  ink = "light",
  homeInk = ink,
  className,
}: {
  children: React.ReactNode;
  ink?: "light" | "dark";
  /** The home indicator sits on whatever is at the bottom — often a sheet, not the status bar's backdrop. */
  homeInk?: "light" | "dark";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative h-[564px] w-[276px] shrink-0 rounded-[50px] bg-[#0b0b0c] p-[7px] shadow-overlay ring-1 ring-black/10 dark:ring-white/10",
        className,
      )}
    >
      <div className="relative isolate h-full w-full overflow-hidden rounded-[43px] bg-black">
        {children}
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 z-20 flex h-12 items-center justify-between px-8 pt-1 text-ui font-semibold transition-colors duration-200",
            ink === "light" ? "text-white" : "text-foreground",
          )}
        >
          <span className="tabular-nums">9:41</span>
          <span className="flex items-center gap-1" aria-hidden>
            <span className="flex h-2.5 items-end gap-px">
              {[0.4, 0.6, 0.8, 1].map((h) => (
                <span
                  key={h}
                  className="w-[3px] rounded-[1px] bg-current"
                  style={{ height: `${h * 100}%` }}
                />
              ))}
            </span>
            <span className="ml-1 h-[11px] w-[22px] rounded-[4px] border border-current/40 p-px">
              <span className="block h-full w-[70%] rounded-[2px] bg-current" />
            </span>
          </span>
        </div>
        <div className="pointer-events-none absolute top-[11px] left-1/2 z-30 h-[26px] w-[86px] -translate-x-1/2 rounded-full bg-black" />
        <div
          className={cn(
            "pointer-events-none absolute bottom-2 left-1/2 z-20 h-1 w-28 -translate-x-1/2 rounded-full transition-colors duration-200",
            homeInk === "light" ? "bg-white/70" : "bg-foreground/40",
          )}
        />
      </div>
    </div>
  );
}

/* ── Code, read aloud ──────────────────────────────────────────────────── */

/** A pairing code for reading, not typing: three groups, the dashes quiet. */
export function CodeGroups({ code, className }: { code: string; className?: string }) {
  const [first, second, third] = code.split("-");
  const dash = (
    <span className="opacity-35" aria-hidden>
      -
    </span>
  );
  return (
    <span className={cn("inline-flex items-center gap-2 font-mono tracking-wider", className)}>
      <span className="sr-only">{code}</span>
      <span aria-hidden>{first}</span>
      {dash}
      <span aria-hidden>{second}</span>
      {dash}
      <span aria-hidden>{third}</span>
    </span>
  );
}

/** "Lab" captions over each device on the stage — harness chrome, not product. */
export function StageCaption({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 px-1 pb-2 font-mono text-[10px] text-muted-foreground uppercase">
      {children}
    </p>
  );
}
