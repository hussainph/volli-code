/**
 * VC-263 / VC-350 / VC-376 · the usage-limits control and its real window rows.
 * AccountUsage is the shipped breakdown component; the values it reads are
 * time-derived fixture props, not a live provider response.
 */
import { Surface } from "@webprodigies/flute";
import {
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type ModelAccessSnapshot,
  type UsageLimits,
} from "@volli/shared";

import { AccountUsage } from "@renderer/components/usage-limits/account-usage";
import { UsageLimitsPopover } from "@renderer/components/usage-limits/usage-limits-popover";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";
import { appApi, seedApp } from "../../renderer/lab/seed";

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

const NOW = Date.parse("2026-03-01T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

/** A calm Session window beside a weekly window already running ahead of pace. */
const CODEX_LIMITS: UsageLimits = {
  checkedAt: NOW - 60_000,
  windows: [
    {
      id: "session",
      kind: "session",
      label: "Session",
      usedPercent: 49,
      resetsAt: iso(NOW + 45 * 60_000),
      windowDurationMins: 300,
    },
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 62,
      resetsAt: iso(NOW + 3 * DAY + 19 * HOUR),
      windowDurationMins: 10_080,
    },
  ],
};

const SNAPSHOT: ModelAccessSnapshot = {
  observedAt: NOW,
  models: [],
  providers: [
    {
      id: "openai-codex",
      label: "OpenAI Codex",
      state: "available",
      accountLabel: null,
      billingSource: "subscription",
      recovery: null,
      hasStoredCredential: true,
      signIn: [],
      usageLimits: CODEX_LIMITS,
    },
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

/** Real components rendered at `zoom` so the macro stays crisp at 4K. */
const BUTTON_ZOOM = 11;
const BUTTON = { width: 80 * BUTTON_ZOOM, height: 72 * BUTTON_ZOOM, x: -1100, y: -380 };
const PANEL_ZOOM = 2.2;
const PANEL = { width: 380 * PANEL_ZOOM, height: 200 * PANEL_ZOOM, x: 0, y: 60 };

const CUES: Record<Format, Cue[]> = {
  landscape: [
    {
      at: 500,
      until: 2050,
      lines: ["See your limits", "coming."],
      place: "lower",
    },
  ],
  portrait: [
    {
      at: 500,
      until: 2050,
      lines: ["See your limits", "coming."],
      place: "upper",
    },
  ],
};

/**
 * Bars fill from the empty end: every window starts at 0% left and only ever
 * grows toward its reading, so no frame shows a fuller bar than the truth.
 */
function animatedLimits(t: number): UsageLimits {
  const fill = progress(t, 300, 1050, ease.outCubic);
  return {
    ...CODEX_LIMITS,
    // oxlint-disable-next-line no-map-spread -- a two-window fixture, per frame
    windows: CODEX_LIMITS.windows.map((window) => ({
      ...window,
      usedPercent: mix(100, window.usedPercent, fill),
    })),
  };
}

/**
 * The popover's account row (AccountItem / BindingReading) is not exported, so
 * the header reading is derived from the same animated windows the bars draw:
 * the binding window's `% left`, rounded exactly as AccountUsage rounds it.
 */
function bindingLeft(limits: UsageLimits): number {
  return Math.min(...limits.windows.map((window) => Math.round(100 - window.usedPercent)));
}

export function LimitsShot({ format }: { format: Format }) {
  const t = useFilm();
  useFixtures({ api: appApi, seed: seedApp });
  const limits = animatedLimits(t);

  return (
    <ModelAccessProvider client={CLIENT}>
      <Surface
        id="usage-limits-trigger"
        style={{
          position: "absolute",
          left: `calc(50% + ${BUTTON.x - BUTTON.width / 2}px)`,
          top: `calc(50% + ${BUTTON.y - BUTTON.height / 2}px)`,
          width: BUTTON.width,
          height: BUTTON.height,
        }}
        content={
          <div
            className="flex items-center justify-center"
            style={{ width: 80, height: 72, zoom: BUTTON_ZOOM }}
          >
            <UsageLimitsPopover now={NOW} />
          </div>
        }
      />
      <Surface
        id="usage-limits-breakdown"
        style={{
          position: "absolute",
          left: `calc(50% + ${PANEL.x - PANEL.width / 2}px)`,
          top: `calc(50% + ${PANEL.y - PANEL.height / 2}px)`,
          width: PANEL.width,
          height: PANEL.height,
        }}
        content={
          <div
            className="flex flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-overlay"
            style={{ width: 380, height: 200, zoom: PANEL_ZOOM }}
          >
            <div className="border-b border-border/50 px-3 py-2 text-ui font-medium">
              Usage limits
            </div>
            <div className="flex items-center justify-between gap-2 border-b border-border/40 px-3 py-2">
              <span className="truncate text-ui font-medium">OpenAI Codex</span>
              <span className="shrink-0 text-ui tabular-nums text-attention">
                {bindingLeft(limits)}% left
              </span>
            </div>
            <div className="min-h-0 flex-1 px-3 py-3">
              <AccountUsage limits={limits} now={NOW} />
            </div>
          </div>
        }
      />
      <FrameLayer format={format}>
        <Vignette />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </ModelAccessProvider>
  );
}
