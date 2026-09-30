/**
 * Micro-shot · usage limits, always in view.
 *
 * Real: the whole `AppShell` (ShellWindow), whose chrome band draws the real
 * `UsageLimitsPopover` trigger beside ⌘K, reading the invented snapshot below
 * through a fixture `ModelAccessProvider`. The popover is the REAL open
 * `UsageLimitsPopover`: its body portal is re-homed into a Surface lifted
 * above the window (see `PopoverLayer`), and `open` is driven from scene time
 * by clicking the real trigger. The wall clock is pinned to the fixture's NOW.
 *
 * Usage numbers are invented; no account labels or emails.
 */
import { Surface } from "@webprodigies/flute";
import * as React from "react";
import {
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type ModelAccessSnapshot,
  type UsageLimits,
} from "@volli/shared";

import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";

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

/** The window, in lab CSS px. The rig in scripts/film/shots/limits.mjs mirrors it. */
export const WINDOW = { width: 1440, height: 900 };
/** Where the popover hangs from: just under the usage icon, window-relative. */
export const POPOVER = { width: 320, left: WINDOW.width / 2 + 206 - 160, top: 38 };

/** Beats (scene ms). */
const T = { press: 220, open: 280 };
/** How far the popover's layer floats above the window. */
export const LIFT = 60;

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

/** Radix's popper wrapper: where the popover's portal content lands in body. */
const POPPER = "[data-radix-popper-content-wrapper]";

/**
 * The REAL `UsageLimitsPopover` (drawn by the shell's chrome bar) portals its
 * content into `<body>`. This layer adopts that portal root into a Surface
 * lifted above the window, pins it under the icon in window coordinates
 * (floating-ui measures the projected trigger, which is meaningless inside a
 * 3D stage), and drives `open` from scene time by clicking the real trigger.
 */
function PopoverLayer({ t }: { t: number }) {
  const host = React.useRef<HTMLDivElement | null>(null);
  const open = t >= T.open;
  React.useLayoutEffect(() => {
    const target = host.current;
    if (target === null) return;
    const adopt = () => {
      for (const node of document.body.querySelectorAll<HTMLElement>(`:scope > ${POPPER}`)) {
        target.append(node);
      }
    };
    adopt();
    const observer = new MutationObserver(adopt);
    observer.observe(document.body, { childList: true });
    return () => {
      observer.disconnect();
      for (const node of target.querySelectorAll<HTMLElement>(`:scope > ${POPPER}`)) {
        document.body.append(node);
      }
    };
  }, []);
  React.useLayoutEffect(() => {
    const shown = host.current?.querySelector(POPPER) ?? document.body.querySelector(POPPER);
    if (open && shown === null) {
      const trigger = document.querySelector<HTMLButtonElement>(
        'button[aria-label^="Usage limits"]',
      );
      trigger?.click();
    } else if (!open && shown !== null) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
  });
  // Opening focuses the content, which scrolls every overflow-hidden ancestor
  // to reveal it and would slide the stage sideways. Undo it every frame.
  React.useLayoutEffect(() => {
    for (let node = host.current?.parentElement; node; node = node.parentElement) {
      if (node.scrollLeft !== 0) node.scrollLeft = 0;
      if (node.scrollTop !== 0) node.scrollTop = 0;
    }
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  });
  return (
    <div
      ref={host}
      data-film-limits=""
      style={{ position: "relative", width: WINDOW.width, height: WINDOW.height }}
    >
      <style>{`[data-film-limits] > ${POPPER} {
        position: absolute !important;
        left: ${POPOVER.left}px !important;
        top: ${POPOVER.top}px !important;
        transform: none !important;
        min-width: 0 !important;
      }`}</style>
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
  landscape: [{ ...CUE, place: "upper" }],
  portrait: [{ ...CUE, place: "upper" }],
};

export function LimitsShot({ format }: { format: Format }) {
  const t = useFilm();
  useFilmTheme("gold");
  useFilmWallClock(t, NOW);
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
          </ShellWindow>
        }
      >
        <Surface
          id="popover"
          transform={{ z: LIFT }}
          style={{
            position: "absolute",
            left: 0,
            top: -WINDOW.height,
            width: WINDOW.width,
            height: WINDOW.height,
          }}
          content={<PopoverLayer t={t} />}
        />
      </Surface>
      <Backdrop t={t} theme="gold" focus={format === "landscape" ? [0.6, 0.3] : [0.5, 0.3]} />
      <FrameLayer format={format}>
        <Vignette strength={0.4} />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </ModelAccessProvider>
  );
}
