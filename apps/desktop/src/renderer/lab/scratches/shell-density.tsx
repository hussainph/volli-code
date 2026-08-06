/**
 * Shell density lab — IC-methods retune.
 *
 * User task: scan the board while the left chrome stays secondary — identity
 * (project), destination (nav), and attention (sessions) without competing
 * with ticket cards for visual mass.
 *
 * Sessions in Active stay TWO-LINE (long titles). Sort: interrupt first, then
 * agentic work. Previous is one-line, 1h+ since last interaction — no orbs.
 *
 * Probes (lab mock only; shipped sidebar untouched):
 *   Medium     — surgical v1, frozen (cards + type + mild chrome)
 *   Coherence  — Medium width; nav = pill default; two-line sessions, less air
 *   Width      — Medium row chrome; modestly narrower pane only
 */
import * as React from "react";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { ThinkingOrb, type OrbState } from "thinking-orbs";

import { AppShell } from "@renderer/components/app-shell";
import { TicketCardContent } from "@renderer/components/board/ticket-card";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

import { project, ticketById } from "../fixtures";
import { appApi, seedApp } from "../seed";

export const title = "Shell density";
export const note = "IC retune · sidebar Quiet vs Orbs · Active/Previous tiers — lab only";
export const viewport = "window" as const;

export const seed = seedApp;
export const api = appApi;

const CURRENT = {
  shellInset: "0.5rem",
  gutter: "1.5rem",
  radiusXl: "calc(var(--radius) + 4px)",
  shadowCard: null as string | null,
  foldPad: "6px",
  textUi: null as string | null,
  textUiLeading: null as string | null,
  textSm: null as string | null,
  textSmLeading: null as string | null,
} as const;

/** Medium = surgical v1 — frozen. */
const MEDIUM = {
  shellInset: "0.25rem",
  gutter: "1rem",
  radiusXl: "0.625rem",
  shadowCard: "var(--shadow-raised)" as string | null,
  foldPad: "2px",
  textUi: "0.75rem" as string | null,
  textUiLeading: "1rem" as string | null,
  textSm: "0.8125rem" as string | null,
  textSmLeading: "1.125rem" as string | null,
} as const;

/** Coherence + Width share Medium’s type/frame tokens; geometry differs in the mock. */
const COHERENCE = { ...MEDIUM } as const;
const WIDTH = { ...MEDIUM } as const;

type Preset = "current" | "medium" | "coherence" | "width";
type ProbePreset = "medium" | "coherence" | "width";
type View = "compare" | "live";

const PRESETS = {
  current: CURRENT,
  medium: MEDIUM,
  coherence: COHERENCE,
  width: WIDTH,
} as const;

const PRESET_META: Record<Preset, { title: string; blurb: string }> = {
  current: {
    title: "Current",
    blurb: "Shipped — dual rail, tall rows, session min-h-10",
  },
  medium: {
    title: "Medium",
    blurb: "Surgical v1 — cards + type locked",
  },
  coherence: {
    title: "Coherence",
    blurb: "Pill nav · header trim · two-line sessions (long titles kept)",
  },
  width: {
    title: "Width",
    blurb: "Medium rows · pane −24px only — board gains room, ink unchanged",
  },
};

const SAMPLE_TICKETS = ["tkt-14", "tkt-11", "tkt-12", "tkt-7", "tkt-9"] as const;

/**
 * Realistic session titles — long on purpose so two-line layout can be judged.
 * `orb` maps to thinking-orbs states (https://orbs.jakubantalik.com). Package is
 * monochrome; we recolor via an SVG luminance→flood filter. Only `live` (agent
 * working) rows animate — interrupt rows freeze via `paused` (no rAF).
 *
 * Tier probe — option 2 (one Active list, sorted; Previous = stale):
 *   Active    — interrupt first (question / allow / blocked), then agentic work
 *   Previous  — no interaction for 1h+ (flat one-line; no orbs)
 */
const ACTIVE_SESSION_ROWS = [
  // Interrupt cluster — sorted ahead of running work.
  {
    title: "Fix board filter chip overflow on narrow columns",
    ticket: "VC-11",
    state: "Waiting · allow edit",
    orb: "breathing" as const satisfies OrbState,
    live: false,
    kind: "interrupt" as const,
  },
  {
    title: "Clarify resume semantics for ticketless sessions",
    ticket: "VC-8",
    state: "Question · pick option",
    orb: "listening" as const satisfies OrbState,
    live: false,
    kind: "interrupt" as const,
  },
  // Agentic work — still Active, below interrupts.
  {
    title: "Wire session-engine resume + durable receipt projection",
    ticket: "VC-14",
    state: "Working · OpenCode",
    orb: "working" as const satisfies OrbState,
    live: true,
    kind: "working" as const,
  },
  {
    title: "Investigate PTY resize storm under UI zoom",
    ticket: "VC-12",
    state: "Working · Claude Code",
    orb: "working" as const satisfies OrbState,
    live: true,
    kind: "working" as const,
  },
] as const;

/**
 * Flat history — one line, no orb cost. Probe rule: last interaction ≥ 1h ago
 * (idle live, parked, or exited). Recency is a timestamp compare on data the
 * sidebar already holds (`lastOutputAt` / record times) — not a heavy scan.
 */
const PREVIOUS_SESSION_ROWS = [
  {
    title: "Ghostty config adapter: honor window-padding-balance",
    ticket: "VC-11",
    when: "2h",
  },
  {
    title: "Warm-park sessions after 10 minutes idle",
    ticket: "VC-12",
    when: "5h",
  },
  {
    title: "Command palette: fuzzy-match ticket titles",
    ticket: "VC-7",
    when: "Yesterday",
  },
  {
    title: "Persist harness picker last choice per project",
    ticket: "VC-9",
    when: "Sun",
  },
] as const;

/** Lab ink probes — package has no color prop; flood tracks CSS vars. */
type OrbInk =
  | "primary"
  | "primary-text"
  | "emerald"
  | "sky"
  | "destructive"
  | "foreground"
  | "muted"
  | "mono";

const ORB_INK_META: Record<OrbInk, { title: string; flood: string; swatch: string }> = {
  primary: {
    title: "Primary",
    flood: "var(--primary)",
    swatch: "var(--primary)",
  },
  "primary-text": {
    title: "Primary text",
    flood: "var(--primary-text)",
    swatch: "var(--primary-text)",
  },
  emerald: {
    title: "Emerald",
    flood: "#10b981",
    swatch: "#10b981",
  },
  sky: {
    title: "Sky",
    flood: "#0ea5e9",
    swatch: "#0ea5e9",
  },
  destructive: {
    title: "Destructive",
    flood: "var(--destructive)",
    swatch: "var(--destructive)",
  },
  foreground: {
    title: "Foreground",
    flood: "var(--foreground)",
    swatch: "var(--foreground)",
  },
  muted: {
    title: "Muted",
    flood: "var(--muted-foreground)",
    swatch: "var(--muted-foreground)",
  },
  mono: {
    title: "Mono",
    flood: "transparent",
    swatch: "linear-gradient(135deg, #a1a1aa 0%, #a1a1aa 45%, #52525b 45%, #52525b 100%)",
  },
};

const ORB_INK_ORDER = [
  "primary",
  "primary-text",
  "emerald",
  "sky",
  "destructive",
  "foreground",
  "muted",
  "mono",
] as const satisfies readonly OrbInk[];

const ORB_TINT_FILTER_ID = "lab-shell-density-orb-tint";

function OrbTintDefs({ ink }: { ink: OrbInk }) {
  // feFlood resolves var() against this SVG tree — set --lab-orb-ink here so
  // every canvas filtered with url(#…) picks up the active probe colour.
  return (
    <svg
      aria-hidden
      width={0}
      height={0}
      className="absolute"
      style={{ ["--lab-orb-ink" as string]: ORB_INK_META[ink].flood }}
    >
      <defs>
        <filter
          id={ORB_TINT_FILTER_ID}
          colorInterpolationFilters="sRGB"
          x="-25%"
          y="-25%"
          width="150%"
          height="150%"
        >
          <feColorMatrix
            in="SourceGraphic"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.2126 0.7152 0.0722 0 0"
            result="alpha"
          />
          <feFlood floodColor="var(--lab-orb-ink)" result="color" />
          <feComposite in="color" in2="alpha" operator="in" />
        </filter>
      </defs>
    </svg>
  );
}

function OrbInkPanel({ ink, onChange }: { ink: OrbInk; onChange(next: OrbInk): void }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border/70 bg-background/90 px-2.5 py-2 shadow-lg backdrop-blur">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-label uppercase text-muted-foreground">Orb ink</p>
        <p className="text-label text-muted-foreground">{ORB_INK_META[ink].title}</p>
      </div>
      <div role="radiogroup" aria-label="Orb ink" className="flex flex-wrap items-center gap-1">
        {ORB_INK_ORDER.map((option) => {
          const meta = ORB_INK_META[option];
          const pressed = ink === option;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={pressed}
              aria-label={meta.title}
              title={meta.title}
              onClick={() => onChange(option)}
              className={cn(
                "flex size-6 items-center justify-center rounded-full border transition-shadow",
                pressed
                  ? "border-foreground shadow-[0_0_0_2px_color-mix(in_oklab,var(--foreground)_18%,transparent)]"
                  : "border-border/70 hover:border-foreground/40",
              )}
            >
              <span
                aria-hidden
                className="size-3.5 rounded-full"
                style={{ background: meta.swatch }}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Sidebar signal chrome — orbs (chat-grade) vs quiet (sidebar-grade).
 * Quiet: colour chips only (no title recolour); working titles shimmer slowly.
 */
type SessionChrome = "orbs" | "quiet";

const SESSION_CHROME_META: Record<SessionChrome, { title: string; blurb: string }> = {
  orbs: {
    title: "Orbs",
    blurb: "Canvas orbs in the list — chat-grade motion",
  },
  quiet: {
    title: "Quiet",
    blurb: "Colour chips · slow title shimmer · orbs for chat",
  },
};

function SessionChromePanel({
  chrome,
  onChange,
}: {
  chrome: SessionChrome;
  onChange(next: SessionChrome): void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border/70 bg-background/90 px-2.5 py-2 shadow-lg backdrop-blur">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-label uppercase text-muted-foreground">Sidebar signal</p>
        <p className="text-label text-muted-foreground">{SESSION_CHROME_META[chrome].title}</p>
      </div>
      <div className="flex items-center gap-0.5">
        {(["quiet", "orbs"] as const).map((option) => (
          <ModePill key={option} pressed={chrome === option} onClick={() => onChange(option)}>
            {SESSION_CHROME_META[option].title}
          </ModePill>
        ))}
      </div>
      <p className="max-w-[14rem] text-label text-muted-foreground">
        {SESSION_CHROME_META[chrome].blurb}
      </p>
    </div>
  );
}

/**
 * Lab-only shimmer — opaque layers, no background-clip.
 *
 * Plain-language colours (pinned hex — sidebar remaps foreground tokens):
 *   base  — near-white, slightly darkened (#c9c4c0)
 *   peak  — normal white (#ffffff)
 *
 * Solid base text + identical bright copy, both ellipsis-truncated to the
 * same box so overflow behind "…" never picks up the white. Peak is masked
 * to a wide moving band (~half the period lit). Mask travels exactly one
 * period for a hitch-free loop.
 */
const SESSION_SHIMMER_CSS = `
@keyframes lab-session-title-shimmer {
  from {
    -webkit-mask-position: 0 center;
    mask-position: 0 center;
  }
  to {
    -webkit-mask-position: calc(-1 * var(--lab-shimmer-period)) center;
    mask-position: calc(-1 * var(--lab-shimmer-period)) center;
  }
}
.lab-session-title-shimmer {
  --lab-shimmer-period: 7.5rem;
  --lab-shimmer-base: #c9c4c0;
  --lab-shimmer-peak: #ffffff;
  position: relative;
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--lab-shimmer-base);
}
.lab-session-title-shimmer > .lab-session-title-shimmer-peak {
  position: absolute;
  inset: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--lab-shimmer-peak);
  pointer-events: none;
  /* Wide plateau — white spans more glyphs at once. */
  -webkit-mask-image: linear-gradient(
    90deg,
    transparent 0%,
    transparent 18%,
    #000 30%,
    #000 70%,
    transparent 82%,
    transparent 100%
  );
  mask-image: linear-gradient(
    90deg,
    transparent 0%,
    transparent 18%,
    #000 30%,
    #000 70%,
    transparent 82%,
    transparent 100%
  );
  -webkit-mask-size: var(--lab-shimmer-period) 100%;
  mask-size: var(--lab-shimmer-period) 100%;
  -webkit-mask-repeat: repeat-x;
  mask-repeat: repeat-x;
  -webkit-mask-position: 0 center;
  mask-position: 0 center;
  animation: lab-session-title-shimmer 3.5s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .lab-session-title-shimmer > .lab-session-title-shimmer-peak {
    animation: none;
    opacity: 0;
  }
}
`;

function SessionOrb({ state, live, ink }: { state: OrbState; live: boolean; ink: OrbInk }) {
  // Inline preset is 20px — larger than the old 6px dot on purpose so the
  // animation reads. Vertically centered on the whole two-line row.
  return (
    <span
      aria-hidden
      className={cn(
        "shrink-0 self-center",
        // Waiting/idle: dim a touch so the live orb carries attention.
        !live && "opacity-70",
      )}
    >
      <ThinkingOrb
        state={state}
        size={20}
        theme="dark"
        speed={0.85}
        paused={!live}
        style={{
          filter: ink === "mono" ? undefined : `url(#${ORB_TINT_FILTER_ID})`,
        }}
      />
    </span>
  );
}

function presetVars(preset: Preset): React.CSSProperties {
  const tokens = PRESETS[preset];
  return {
    "--shell-inset": tokens.shellInset,
    "--spacing-gutter": tokens.gutter,
    "--radius-xl": tokens.radiusXl,
    ["--lab-fold-pad" as string]: tokens.foldPad,
    ...(tokens.shadowCard !== null ? { "--shadow-card": tokens.shadowCard } : {}),
    ...(tokens.textUi !== null
      ? {
          "--text-ui": tokens.textUi,
          "--text-ui--line-height": tokens.textUiLeading,
          "--text-sm": tokens.textSm,
          "--text-sm--line-height": tokens.textSmLeading,
        }
      : {}),
  } as React.CSSProperties;
}

function mediumCardClass(preset: Preset): string | false {
  if (preset === "current") return false;
  return "[&_article]:gap-1 [&_article]:rounded-md [&_article]:px-2.5 [&_article]:py-1.5 [&_article_p]:text-ui [&_article_p]:font-normal";
}

/**
 * Control pairing (visual-surfaces + DESIGN pill scale):
 *   current    → shipped h-8 / text-sm
 *   medium     → h-6 / text-ui
 *   coherence  → h-7 / text-ui — matches Button default; sessions stay two-line
 *   width      → same as medium (width probe only)
 */
function NavRow({
  icon,
  label,
  active = false,
  preset,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  preset: Preset;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md px-2 text-sidebar-foreground",
        preset === "current" && "h-8 text-sm",
        (preset === "medium" || preset === "width") && "h-6 text-ui",
        preset === "coherence" && "h-7 text-ui",
        active && "bg-sidebar-accent-veil font-medium text-sidebar-accent-foreground",
      )}
    >
      <span className={cn(preset === "current" ? "[&_svg]:size-4" : "[&_svg]:size-3.5")}>
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </div>
  );
}

function SessionRow({
  title: sessionTitle,
  ticket,
  state,
  orb,
  live,
  kind,
  ink,
  chrome,
  preset,
}: {
  title: string;
  ticket: string;
  state: string;
  orb: OrbState;
  live: boolean;
  kind: "interrupt" | "working";
  ink: OrbInk;
  chrome: SessionChrome;
  preset: Preset;
}) {
  const quiet = chrome === "quiet";
  const interrupt = kind === "interrupt";
  const working = kind === "working";

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md",
        // Shipped ≈ size=lg + min-h-10 + py-2
        preset === "current" && "px-2 py-2",
        // Medium: two-line, slightly less pad
        (preset === "medium" || preset === "width") && "px-2 py-1.5",
        // Coherence: still two-line for long titles; tighten pad + leading only
        preset === "coherence" && "px-2 py-1",
      )}
    >
      {quiet ? (
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            interrupt && "bg-amber-500",
            working && "bg-emerald-500",
          )}
        />
      ) : (
        <SessionOrb state={orb} live={live} ink={ink} />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {quiet && working ? (
          <span
            className={cn(
              "lab-session-title-shimmer",
              preset === "current" && "text-xs",
              preset !== "current" && "text-ui",
            )}
          >
            {sessionTitle}
            <span className="lab-session-title-shimmer-peak" aria-hidden>
              {sessionTitle}
            </span>
          </span>
        ) : (
          <span
            className={cn(
              "truncate text-sidebar-foreground",
              preset === "current" && "text-xs",
              preset !== "current" && "text-ui",
            )}
          >
            {sessionTitle}
          </span>
        )}
        <span className="flex min-w-0 items-center gap-1 text-label text-muted-foreground">
          <span className="shrink-0 font-mono">{ticket}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{state}</span>
        </span>
      </span>
    </div>
  );
}

/** One-line history row — ticket + title + when; no orb, no second line. */
function PreviousSessionRow({
  title: sessionTitle,
  ticket,
  when,
  preset,
}: {
  title: string;
  ticket: string;
  when: string;
  preset: Preset;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-md text-muted-foreground",
        preset === "current" && "h-7 px-2 text-xs",
        preset !== "current" && "h-6 px-2 text-ui",
      )}
    >
      <span className="shrink-0 font-mono text-label">{ticket}</span>
      <span className="min-w-0 flex-1 truncate">{sessionTitle}</span>
      <span className="shrink-0 text-label tabular-nums opacity-80">{when}</span>
    </div>
  );
}

function MiniFramedShell({
  preset,
  ink,
  chrome,
  className,
}: {
  preset: Preset;
  ink: OrbInk;
  chrome: SessionChrome;
  className?: string;
}) {
  const tickets = SAMPLE_TICKETS.map((id) => ticketById(id));
  const cardClass = mediumCardClass(preset);
  const boardMedium = preset !== "current";

  return (
    <div
      data-volli-shell="framed"
      data-density={preset}
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden bg-transparent",
        className,
      )}
      style={presetVars(preset)}
    >
      <div
        className={cn(
          "flex shrink-0 items-center gap-2 px-3",
          preset === "current" ? "h-10" : "h-9",
        )}
      >
        <div className="flex gap-1.5 pl-1">
          <span className="size-2.5 rounded-full bg-foreground/20" />
          <span className="size-2.5 rounded-full bg-foreground/20" />
          <span className="size-2.5 rounded-full bg-foreground/20" />
        </div>
        <div
          className={cn(
            "mx-auto flex w-[42%] max-w-[280px] items-center rounded-md border border-border/60 bg-foreground/6 px-2 text-muted-foreground",
            preset === "current" ? "h-[26px] text-ui" : "h-6 text-xs",
          )}
        >
          Search…
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          data-workspace-rail
          className={cn(
            "flex shrink-0 flex-col items-center",
            preset === "current" && "w-[60px] gap-2 pt-3",
            // Keep rail usable — do not crush tiles.
            preset !== "current" && "w-[52px] gap-1.5 pt-2",
          )}
        >
          <div
            className={cn(
              "flex items-center justify-center font-semibold text-primary-foreground",
              preset === "current"
                ? "size-9 rounded-[10px] bg-primary text-sm"
                : "size-8 rounded-lg bg-primary text-xs",
            )}
          >
            V
          </div>
          <div
            className={cn(
              "flex items-center justify-center font-semibold text-muted-foreground",
              preset === "current"
                ? "size-9 rounded-[10px] bg-muted text-xs"
                : "size-8 rounded-lg bg-muted text-xs",
            )}
          >
            +
          </div>
        </div>

        <div
          data-volli-sidebar
          data-slot="sidebar"
          className={cn(
            "flex shrink-0 flex-col bg-transparent",
            preset === "current" && "w-[200px]",
            (preset === "medium" || preset === "coherence") && "w-[176px]",
            preset === "width" && "w-[152px]",
          )}
          style={{ paddingRight: "var(--lab-fold-pad)" }}
        >
          <div
            className={cn(
              "border-b border-border/50",
              preset === "current" && "px-3 py-2.5",
              preset === "coherence" && "px-2.5 py-1.5",
              (preset === "medium" || preset === "width") && "px-2.5 py-2",
            )}
          >
            <div
              className={cn(
                "truncate font-semibold text-sidebar-foreground",
                preset === "current" ? "text-sm" : "text-ui",
              )}
            >
              {project.name}
            </div>
            <div className="text-label text-muted-foreground">demo / voltaic</div>
          </div>

          <div
            className={cn(
              "flex flex-col",
              preset === "current" && "gap-0.5 p-2",
              preset !== "current" && "gap-px p-1.5",
            )}
          >
            <NavRow icon={<SquaresFourIcon weight="fill" />} label="Board" active preset={preset} />
            <NavRow icon={<TerminalWindowIcon weight="fill" />} label="Sessions" preset={preset} />
            <NavRow icon={<GearSixIcon weight="fill" />} label="Settings" preset={preset} />
          </div>

          <div
            className={cn(
              "mt-auto min-h-0 flex-1 overflow-y-auto border-t border-border/50",
              preset === "current" && "p-2",
              preset !== "current" && "p-1.5",
            )}
          >
            <div className="px-2 py-1 font-mono text-label uppercase text-muted-foreground">
              Active
            </div>
            <div className="flex flex-col gap-0.5">
              {ACTIVE_SESSION_ROWS.map((row) => (
                <SessionRow
                  key={row.ticket}
                  title={row.title}
                  ticket={row.ticket}
                  state={row.state}
                  orb={row.orb}
                  live={row.live}
                  kind={row.kind}
                  ink={ink}
                  chrome={chrome}
                  preset={preset}
                />
              ))}
            </div>

            <div className="mt-2 flex items-baseline justify-between gap-2 px-2 py-1">
              <span className="font-mono text-label uppercase text-muted-foreground">Previous</span>
              <span className="text-label text-muted-foreground/80">1h+</span>
            </div>
            <div className="flex flex-col">
              {PREVIOUS_SESSION_ROWS.map((row) => (
                <PreviousSessionRow
                  key={`${row.ticket}-${row.when}`}
                  title={row.title}
                  ticket={row.ticket}
                  when={row.when}
                  preset={preset}
                />
              ))}
            </div>
          </div>
        </div>

        <div
          data-slot="sidebar-inset"
          className="flex min-w-0 flex-1 flex-col overflow-hidden border border-border bg-background"
        >
          <header
            className={cn(
              "flex shrink-0 flex-wrap items-center border-b border-border/60 px-gutter",
              preset === "current" ? "gap-x-3 gap-y-2 py-3" : "gap-x-2 gap-y-1.5 py-2",
            )}
          >
            <h2
              className={cn("shrink-0 font-semibold", preset === "current" ? "text-sm" : "text-ui")}
            >
              Board
            </h2>
            <Button size={preset === "current" ? "default" : "xs"} variant="outline">
              Filter
            </Button>
            <Button size={preset === "current" ? "default" : "xs"}>New ticket</Button>
          </header>

          <div
            className={cn(
              "flex min-h-0 flex-1 overflow-auto px-gutter",
              boardMedium ? "gap-2 py-2" : "gap-3 py-3",
            )}
          >
            <div
              className={cn(
                "flex flex-none flex-col rounded-lg",
                boardMedium ? "w-64 bg-transparent" : "w-72 bg-muted/40",
              )}
            >
              <div
                className={cn(
                  "flex items-center gap-2",
                  boardMedium ? "px-2 pt-2 pb-1.5" : "px-3 pt-2.5 pb-2",
                )}
              >
                <span className="text-ui font-medium">Doing</span>
                <span className="font-mono text-xs text-muted-foreground">{tickets.length}</span>
              </div>
              <div
                className={cn("flex flex-col pb-2", boardMedium ? "gap-1.5 px-1.5" : "gap-2 px-2")}
              >
                {tickets.map((ticket) => (
                  <div key={ticket.id} className={cn(cardClass)}>
                    <TicketCardContent ticket={ticket} ticketPrefix={project.ticketPrefix} />
                  </div>
                ))}
              </div>
            </div>

            <div
              className={cn(
                "flex flex-none flex-col rounded-lg opacity-60",
                boardMedium ? "w-64 bg-transparent" : "w-72 bg-muted/40",
              )}
            >
              <div
                className={cn(
                  "flex items-center gap-2",
                  boardMedium ? "px-2 pt-2 pb-1.5" : "px-3 pt-2.5 pb-2",
                )}
              >
                <span className="text-ui font-medium">Todo</span>
                <span className="font-mono text-xs text-muted-foreground">2</span>
              </div>
              <div
                className={cn("flex flex-col pb-2", boardMedium ? "gap-1.5 px-1.5" : "gap-2 px-2")}
              >
                <div className={cn(cardClass)}>
                  <TicketCardContent
                    ticket={ticketById("tkt-9")}
                    ticketPrefix={project.ticketPrefix}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TokenReadout({ preset }: { preset: Preset }) {
  const rows: Record<Preset, { label: string; value: string; note: string }[]> = {
    current: [
      { label: "lever", value: "shipped", note: "all axes" },
      { label: "nav row", value: "h-8 · text-sm", note: "32px" },
      { label: "sessions", value: "min-h-10", note: "two-line lg" },
      { label: "pane", value: "200px mock", note: "~318 real" },
    ],
    medium: [
      { label: "lever", value: "balanced", note: "frozen v1" },
      { label: "nav row", value: "h-6 · text-ui", note: "24px" },
      { label: "sessions", value: "two-line", note: "less pad" },
      { label: "pane", value: "176px", note: "cards medium" },
    ],
    coherence: [
      { label: "lever", value: "pill pairing", note: "IC preferred" },
      { label: "nav row", value: "h-7 · text-ui", note: "= pill default" },
      { label: "sessions", value: "two-line · py-1", note: "long titles kept" },
      { label: "pane", value: "176px", note: "same as medium" },
    ],
    width: [
      { label: "lever", value: "horizontal", note: "modest only" },
      { label: "nav row", value: "h-6 · text-ui", note: "as medium" },
      { label: "sessions", value: "two-line", note: "as medium" },
      { label: "pane", value: "152px", note: "−24 vs medium" },
    ],
  };

  return (
    <dl className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 font-mono text-label">
      {rows[preset].map((row) => (
        <React.Fragment key={row.label}>
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="truncate text-foreground">{row.value}</dd>
          <dd className="text-muted-foreground">{row.note}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function ModePill({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className="rounded-full px-2.5 py-0.5 text-label text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
    >
      {children}
    </button>
  );
}

export default function ShellDensityScratch() {
  const [view, setView] = React.useState<View>("compare");
  const [compareRight, setCompareRight] = React.useState<ProbePreset>("coherence");
  const [livePreset, setLivePreset] = React.useState<Preset>("medium");
  const [orbInk, setOrbInk] = React.useState<OrbInk>("primary");
  const [sessionChrome, setSessionChrome] = React.useState<SessionChrome>("quiet");

  if (view === "live") {
    return (
      <div className="relative h-svh w-full" style={presetVars(livePreset)}>
        <AppShell />
        <div className="fixed top-3 right-3 z-[9998] flex max-w-[min(100vw-1.5rem,28rem)] flex-col items-end gap-1">
          <div className="flex flex-wrap items-center justify-end gap-1 rounded-full border border-border bg-background/90 p-1 shadow-lg backdrop-blur">
            <ModePill pressed={false} onClick={() => setView("compare")}>
              Compare
            </ModePill>
            <ModePill pressed={livePreset === "current"} onClick={() => setLivePreset("current")}>
              Current
            </ModePill>
            <ModePill pressed={livePreset === "medium"} onClick={() => setLivePreset("medium")}>
              Medium
            </ModePill>
          </div>
          <p className="rounded-md border border-border/60 bg-background/90 px-2.5 py-1 text-label text-muted-foreground shadow-lg backdrop-blur">
            Live = real AppShell + frame/type tokens. Coherence/Width are compare mocks only —
            shipped sidebar untouched.
          </p>
        </div>
      </div>
    );
  }

  const rightMeta = PRESET_META[compareRight];

  return (
    <div className="relative flex h-svh w-full flex-col bg-transparent text-foreground">
      <style>{SESSION_SHIMMER_CSS}</style>
      {sessionChrome === "orbs" ? <OrbTintDefs ink={orbInk} /> : null}
      <header className="flex shrink-0 flex-wrap items-start gap-3 border-b border-border/60 bg-background/80 px-4 py-2 backdrop-blur">
        <div className="min-w-0 flex-1">
          <h1 className="text-ui font-medium">Shell density</h1>
          <p className="max-w-xl text-label text-muted-foreground">
            Sessions stay two-line (long titles). Prefer{" "}
            <span className="text-foreground">Coherence</span> — pill nav + tighter session padding
            — or a modest <span className="text-foreground">Width</span> nudge.
          </p>
        </div>
        <div className="flex flex-wrap items-start justify-end gap-2">
          <SessionChromePanel chrome={sessionChrome} onChange={setSessionChrome} />
          {sessionChrome === "orbs" ? <OrbInkPanel ink={orbInk} onChange={setOrbInk} /> : null}
          <div className="flex items-center gap-1 rounded-full border border-border/60 bg-background/70 p-1">
            <ModePill pressed onClick={() => setView("compare")}>
              Compare
            </ModePill>
            <ModePill
              pressed={false}
              onClick={() => {
                setLivePreset("medium");
                setView("live");
              }}
            >
              Live · medium tokens
            </ModePill>
          </div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-2">
        <section className="flex min-h-0 flex-col border-b border-border/60 lg:border-r lg:border-b-0">
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border/40 bg-background/50 px-4 py-2">
            <div>
              <p className="font-mono text-label uppercase text-muted-foreground">
                {PRESET_META.current.title}
              </p>
              <p className="text-label text-muted-foreground">{PRESET_META.current.blurb}</p>
            </div>
            <TokenReadout preset="current" />
          </div>
          <div className="min-h-0 flex-1">
            <MiniFramedShell preset="current" ink={orbInk} chrome={sessionChrome} />
          </div>
        </section>

        <section className="flex min-h-0 flex-col">
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border/40 bg-background/50 px-4 py-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1">
                <p className="font-mono text-label uppercase text-primary">{rightMeta.title}</p>
                <div className="flex flex-wrap items-center gap-0.5">
                  {(["medium", "coherence", "width"] as const).map((preset) => (
                    <ModePill
                      key={preset}
                      pressed={compareRight === preset}
                      onClick={() => setCompareRight(preset)}
                    >
                      {PRESET_META[preset].title}
                    </ModePill>
                  ))}
                </div>
              </div>
              <p className="text-label text-muted-foreground">{rightMeta.blurb}</p>
            </div>
            <TokenReadout preset={compareRight} />
          </div>
          <div className="min-h-0 flex-1">
            <MiniFramedShell preset={compareRight} ink={orbInk} chrome={sessionChrome} />
          </div>
        </section>
      </div>
    </div>
  );
}
