/**
 * Micro-shot · usage limits, always in view.
 *
 * Real: the whole `AppShell` (ShellWindow), whose chrome band draws the real
 * `UsageLimitsPopover` trigger beside ⌘K, reading the invented snapshot below
 * through a fixture `ModelAccessProvider`. The popover's own content portals to
 * `document.body` (outside any Surface), so the open state is drawn in-window:
 * the popover's chrome mirrored from usage-limits-popover.tsx around the real
 * `AccountUsage` rows, with the bars filling from scene time.
 *
 * Usage numbers are invented; no account labels or emails.
 */
import { Surface } from "@webprodigies/flute";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import {
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type ModelAccessSnapshot,
  type UsageLimits,
} from "@volli/shared";

import { AccountUsage } from "@renderer/components/usage-limits/account-usage";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";

import { ease, mix, progress } from "../kit/clock";
import {
  FrameLayer,
  Supers,
  useFilm,
  useFixtures,
  Vignette,
  type Cue,
  type Format,
} from "../kit/film";
import { seedShell, shellApi, ShellWindow } from "../kit/split-shell";
import { Backdrop, useFilmTheme } from "../kit/world";

/** The window, in lab CSS px. The rig in scripts/film/shots/limits.mjs mirrors it. */
export const WINDOW = { width: 1440, height: 900 };
/** Where the popover hangs from: just under the usage icon, window-relative. */
export const POPOVER = { width: 320, left: WINDOW.width / 2 + 206 - 160, top: 38 };

/** Beats (scene ms). */
const T = { press: 220, open: 280, fillFrom: 360, fillTo: 1050 };

const NOW = Date.parse("2026-03-01T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

const CODEX_LIMITS: UsageLimits = {
  checkedAt: NOW - 60_000,
  windows: [
    {
      id: "session",
      kind: "session",
      label: "Session",
      usedPercent: 46,
      resetsAt: iso(NOW + 2 * HOUR + 10 * 60_000),
      windowDurationMins: 300,
    },
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 31,
      resetsAt: iso(NOW + 3 * DAY + 19 * HOUR),
      windowDurationMins: 10_080,
    },
  ],
};

const CLAUDE_LIMITS: UsageLimits = {
  checkedAt: NOW - 60_000,
  windows: [
    {
      id: "session",
      kind: "session",
      label: "Session",
      usedPercent: 22,
      resetsAt: iso(NOW + 3 * HOUR),
      windowDurationMins: 300,
    },
  ],
};

const provider = (id: string, label: string, usageLimits: UsageLimits) => ({
  id,
  label,
  state: "available" as const,
  accountLabel: null,
  billingSource: "subscription" as const,
  recovery: null,
  hasStoredCredential: true,
  signIn: [],
  usageLimits,
});

const SNAPSHOT: ModelAccessSnapshot = {
  observedAt: NOW,
  models: [],
  providers: [
    provider("openai-codex", "OpenAI Codex", CODEX_LIMITS),
    provider("anthropic", "Anthropic", CLAUDE_LIMITS),
  ],
};

const CLIENT: ModelAccessClient = {
  inspect: async () => SNAPSHOT,
  defaults: async () => EMPTY_MODEL_ACCESS_DEFAULTS,
  setDefault: async (_purpose, selection) => ({
    ...EMPTY_MODEL_ACCESS_DEFAULTS,
    global: selection,
  }),
  hiddenModels: async () => [],
  setHiddenModels: async (hidden) => hidden,
  compactionPolicy: async () => ({ autoCompaction: true }),
  setCompactionPolicy: async (policy) => policy,
  pickerView: async () => "all",
  setPickerView: async (view) => view,
  beginSignIn: async () => {
    throw new Error("Sign-in is not part of this fixture.");
  },
  signOut: async () => undefined,
};

const API = shellApi();

/** Bars (which draw what is LEFT) fill from empty up to their real reading. */
function animatedLimits(t: number): UsageLimits {
  const fill = progress(t, T.fillFrom, T.fillTo, ease.outCubic);
  return {
    ...CODEX_LIMITS,
    // oxlint-disable-next-line no-map-spread -- a two-window fixture, per frame
    windows: CODEX_LIMITS.windows.map((window) => ({
      ...window,
      usedPercent: mix(100, window.usedPercent, fill),
    })),
  };
}

const left = (limits: UsageLimits): number =>
  Math.min(...limits.windows.map((window) => Math.round(100 - window.usedPercent)));

/** The open popover, drawn in-window (see header). */
function OpenPopover({ t }: { t: number }) {
  const open = progress(t, T.open, T.open + 160, ease.outCubic);
  if (open <= 0) return null;
  const limits = animatedLimits(t);
  return (
    <div
      className="absolute z-50 rounded-container border bg-popover text-foreground shadow-overlay"
      style={{
        left: POPOVER.left,
        top: POPOVER.top,
        width: POPOVER.width,
        opacity: open,
        transform: `translateY(${mix(-8, 0, open)}px) scale(${mix(0.95, 1, open)})`,
        transformOrigin: "50% 0",
      }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-2 py-1">
        <span className="text-ui font-medium">Usage limits</span>
        <span className="flex size-6 items-center justify-center text-muted-foreground">
          <ArrowClockwiseIcon />
        </span>
      </div>
      <div className="p-1">
        <div className="border-b border-border/40">
          <div className="flex items-center justify-between gap-2 px-2 py-2">
            <span className="truncate text-ui font-medium">OpenAI Codex</span>
            <span className="flex shrink-0 items-center gap-1">
              <span className="text-ui tabular-nums text-muted-foreground">
                {left(limits)}% left
              </span>
              <CaretDownIcon className="size-3 rotate-180 text-muted-foreground" />
            </span>
          </div>
          <div className="px-2 pb-3">
            <AccountUsage limits={limits} now={NOW} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 px-2 py-2">
          <span className="truncate text-ui font-medium">Anthropic</span>
          <span className="flex shrink-0 items-center gap-1">
            <span className="text-ui tabular-nums text-muted-foreground">78% left</span>
            <CaretDownIcon className="size-3 text-muted-foreground" />
          </span>
        </div>
      </div>
    </div>
  );
}

/** The click on the icon: a soft ring that lands just before the popover. */
function Press({ t }: { t: number }) {
  const p = progress(t, T.press - 60, T.press + 260, ease.outCubic);
  if (p <= 0 || p >= 1) return null;
  return (
    <div
      className="pointer-events-none absolute rounded-full"
      style={{
        left: WINDOW.width / 2 + 206 - 16,
        top: 19 - 16,
        width: 32,
        height: 32,
        boxShadow: "0 0 0 2px var(--ring)",
        opacity: 1 - p,
        transform: `scale(${mix(0.7, 1.5, p)})`,
      }}
    />
  );
}

const CUE: Cue = {
  at: 100,
  until: 1500,
  lines: ["Your limits,", "always in view."],
  weights: [320, 800],
};

const CUES: Record<Format, Cue[]> = {
  landscape: [{ ...CUE, place: "lower" }],
  portrait: [{ ...CUE, place: "upper" }],
};

export function LimitsShot({ format }: { format: Format }) {
  const t = useFilm();
  useFilmTheme("gold");
  useFixtures({ api: API, seed: seedShell });

  return (
    <ModelAccessProvider client={CLIENT}>
      <Surface
        id="window"
        style={{
          position: "absolute",
          left: `calc(50% - ${WINDOW.width / 2}px)`,
          top: `calc(50% - ${WINDOW.height / 2}px)`,
          width: WINDOW.width,
          height: WINDOW.height,
        }}
        content={
          <ShellWindow width={WINDOW.width} height={WINDOW.height}>
            <Press t={t} />
            <OpenPopover t={t} />
          </ShellWindow>
        }
      />
      <Backdrop t={t} theme="gold" focus={format === "landscape" ? [0.6, 0.3] : [0.5, 0.3]} />
      <FrameLayer format={format}>
        <Vignette strength={0.4} />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </ModelAccessProvider>
  );
}
