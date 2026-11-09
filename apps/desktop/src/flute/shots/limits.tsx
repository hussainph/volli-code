/**
 * Usage limits, always in view — the real AppShell and its real popover.
 *
 * Simulated wiring: an invented Model Access snapshot, anchored to scene time.
 * The actual Radix popover is warmed from frame zero and its portal wrapper is
 * staged inside the filmed window (as the palette shot stages its dialog).
 * Nothing inside the popover is redrawn: provider marks, accordion, readings,
 * pace bars, pins, glass and refresh control all come from current main.
 */
import * as React from "react";
import { Surface } from "@webprodigies/flute";
import {
  DEFAULT_CODE_MODE_POLICY,
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type ModelAccessSnapshot,
  type UsageLimits,
} from "@volli/shared";

import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";
import { overlayLayer } from "@renderer/components/ui/overlay-layer";

import { ease, mix, progress } from "../kit/clock";
import {
  FrameLayer,
  Supers,
  useFilm,
  useFilmWallClock,
  useFixtures,
  Vignette,
  type Cue,
  type Format,
} from "../kit/film";
import { seedShell, shellApi, ShellWindow } from "../kit/split-shell";
import { Backdrop, useFilmTheme } from "../kit/world";

/** Mirrored by scripts/film/shots/limits.mjs. */
export const WINDOW = { width: 1440, height: 900 };
export const POPOVER = { width: 320, left: WINDOW.width / 2 + 166 - 160, top: 50 };
const T = { press: 220, open: 280 };

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
  compactionPolicy: async () => DEFAULT_COMPACTION_POLICY,
  setCompactionPolicy: async (policy) => policy,
  codeModePolicy: async () => DEFAULT_CODE_MODE_POLICY,
  setCodeModePolicy: async (policy) => policy,
  pickerView: async () => "all",
  setPickerView: async (view) => view,
  beginSignIn: async () => {
    throw new Error("Sign-in is not part of this fixture.");
  },
  signOut: async () => undefined,
};

const API = shellApi();

/**
 * Film staging only: keep the real portal subtree mounted so a direct or
 * backwards seek cannot flash a pending read. Return it to its original
 * overlay layer before React unmounts it. Production keeps its body portal.
 */
function PopoverStage({ t }: { t: number }) {
  const host = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const target = host.current;
    const layer = overlayLayer();
    const shell = target?.closest(".film-shell");
    if (!target || !layer || !shell) return;
    const adopted = new Set<HTMLElement>();
    const sync = () => {
      const trigger = shell.querySelector<HTMLButtonElement>('button[aria-label^="Usage limits"]');
      if (trigger && trigger.getAttribute("data-state") !== "open") trigger.click();
      const content = layer.querySelector<HTMLElement>(
        '[data-slot="popover-content"][aria-label="Usage limits"]',
      );
      const wrapper = content?.closest<HTMLElement>("[data-radix-popper-content-wrapper]");
      if (wrapper && wrapper.parentElement === layer) {
        adopted.add(wrapper);
        target.append(wrapper);
      }
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(layer, { childList: true, subtree: true });
    observer.observe(shell, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const wrapper of adopted) {
        if (wrapper.isConnected) layer.append(wrapper);
      }
    };
  }, []);
  const open = progress(t, T.open, T.open + 160, ease.outCubic);
  return (
    <div
      ref={host}
      data-film-limits-overlay
      className="pointer-events-none absolute inset-0 z-50"
      style={{ visibility: t >= T.open ? "visible" : "hidden", opacity: open }}
    >
      <style>{`
        [data-film-limits-overlay] > [data-radix-popper-content-wrapper] {
          position: absolute !important;
          left: ${POPOVER.left}px !important;
          top: ${POPOVER.top}px !important;
          transform: none !important;
          width: ${POPOVER.width}px;
          --radix-popper-available-width: ${WINDOW.width}px !important;
          --radix-popper-available-height: ${WINDOW.height - POPOVER.top}px !important;
        }
      `}</style>
    </div>
  );
}

function Press({ t }: { t: number }) {
  const p = progress(t, T.press - 60, T.press + 260, ease.outCubic);
  if (p <= 0 || p >= 1) return null;
  return (
    <div
      className="pointer-events-none absolute rounded-full"
      style={{
        left: WINDOW.width / 2 + 166 - 16,
        top: 23 - 16,
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
  useFilmWallClock(t, NOW);
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
            <PopoverStage t={t} />
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
