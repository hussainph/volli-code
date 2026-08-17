/**
 * The window chrome band — the real `ChromeBar`, twice: at its shipped 40px and
 * at a 36px trial, with switches for every state that changes either one.
 *
 * WHY TWO. The band's height is not a renderer decision on its own. macOS draws
 * the traffic lights, and `main/index.ts` tells it where by centring the 12px
 * group inside the band: `trafficLightPosition: { x: 10, y: 14 }` is literally
 * `(40 - 12) / 2`. So "make the chrome a bit shorter" is a change to a CONTRACT
 * between two processes, and the only honest way to look at it is with the
 * lights drawn in at the offsets each height implies. They are drawn here (the
 * lab has no window, so macOS draws nothing) at the exact geometry main asks
 * for — see {@link TrafficLights}.
 *
 * The trial is EXPRESSED AS OVERRIDES on the real component, never as a copy of
 * it ({@link TRIAL_CSS}). A forked band would drift from `chrome-bar.tsx` the
 * first time anyone touched it, and would then be answering a question about a
 * band that does not exist. The shipped frame carries no overrides at all, so
 * the A side is the app exactly as it ships.
 *
 * WHAT THE SWITCHES DO. Almost nothing about this band is reachable from a
 * static render. Its controls appear and disappear on app state (a ticket open,
 * a terminal focused), and its geometry moves on *window* state (fullscreen
 * hides the traffic lights, so the 78px spacer collapses and everything slides
 * left over 300ms). In the app you would have to open a ticket, start an agent,
 * and hit ⌃⌘F to see all of that; here it is five switches, and they drive the
 * REAL stores rather than props — `ChromeBar` takes none. So what you are
 * watching is the same state transition the app performs, at the same speed,
 * including the eased spacer collapse, on both heights at once.
 *
 * One deliberate cheat, and it is the interesting one: fullscreen is not store
 * state. `useFullScreen` seeds itself from the bridge and then listens for
 * pushes from main. So the stub below CAPTURES main's push callbacks and the
 * switch calls them — which is exactly the path the real main process uses, so
 * the transition is real even though the window never moves.
 *
 * THE PRICE OF TWO LIVE BANDS, so nothing here surprises you: each `ChromeBar`
 * registers its own ⌘K listener and each `SidebarProvider` its own ⌘B, so those
 * two chords fire twice on this page. Nothing else is doubled — every switch
 * below writes to a single global store that both bands read.
 */
import * as React from "react";

import { ChromeBar } from "@renderer/components/chrome-bar";
import { SidebarProvider } from "@renderer/components/ui/sidebar";
import { Switch } from "@renderer/components/ui/switch";
import { useUiStore } from "@renderer/stores/ui";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

import { project, ticketById } from "../fixtures";
import { appApi, seedApp } from "../seed";

export const title = "Chrome band";
export const note =
  "40px shipped against a 36px trial — does the shorter band still seat the lights";

export const seed = seedApp;

/**
 * Main's fullscreen push, captured from the subscriptions the bands set up on
 * mount. A SET rather than one slot: two bands subscribe, and a single-slot
 * capture silently lost the first one — the shipped band would have sat still
 * while only the trial collapsed its spacer, which is a rig that lies about the
 * one transition it exists to show.
 *
 * RELOAD THE PAGE AFTER EDITING THIS FILE if the fullscreen switch stops doing
 * anything. HMR gives the module a fresh Set while the mounted bands stay
 * subscribed to the old one, and `useFullScreen` only re-subscribes on mount.
 * Nothing else here is stateful across a hot swap.
 */
const fullScreenListeners = new Set<(fullScreen: boolean) => void>();

export const api = {
  ...appApi,
  window: {
    ...(appApi["window"] as object),
    onFullScreenChange: (callback: (fullScreen: boolean) => void): (() => void) => {
      fullScreenListeners.add(callback);
      return () => {
        fullScreenListeners.delete(callback);
      };
    },
  },
};

/* ─── THE GEOMETRY CONTRACT ───────────────────────────────────────────────── */

/**
 * The traffic lights, in macOS's own numbers rather than the app's ladder —
 * these are OS pixels, and the app does not get a vote on them.
 *
 * 12px is the diameter main's own arithmetic assumes (`(40 - 12) / 2 = 14`);
 * 20px is the Big Sur-era centre-to-centre pitch, which puts the group's right
 * edge at `10 + 12 + 2 × 20 = 62px`. Worth an eye against a real window:
 * `chrome-bar.tsx` estimates the group at "≈60px wide, ending ≈70px", eight
 * pixels more generous than these numbers imply. Either way the 78px spacer
 * clears it, and NONE of this moves with the band's height.
 */
const LIGHT_DIAMETER = 12;
const LIGHT_PITCH = 20;
const LIGHT_X = 10;

/** macOS's active-window fills. Literals because they are not this app's to theme. */
const LIGHT_FILLS = ["#ff5f57", "#febc2e", "#28c840"];

interface Band {
  id: "shipped" | "trial";
  /** The band's own height — `h-10` today, `h-9` in the trial. */
  height: number;
  /** The icon-button box: `size-7` (28px) today, `size-6` (24px) in the trial. */
  control: number;
  /** The glyph inside it — `size-4` under `icon`, `size-3.5` under `icon-sm`. */
  glyph: number;
  /**
   * The ⌘K pill's height. DERIVED, not specified: 40 − 26 leaves 7px of band
   * above and below the pill, so 36 − 14 = 22 keeps exactly that clearance.
   * Left at 26 the pill would be the tightest thing on a shorter band and you
   * would be judging the pill, not the band.
   */
  pill: number;
}

const SHIPPED: Band = { id: "shipped", height: 40, control: 28, glyph: 16, pill: 26 };
const TRIAL: Band = { id: "trial", height: 36, control: 24, glyph: 14, pill: 22 };

/** What `trafficLightPosition.y` has to be for the lights to centre in this band. */
function lightsY(band: Band): number {
  return (band.height - LIGHT_DIAMETER) / 2;
}

/**
 * Where the band's controls actually sit: the flex centre plus one pixel.
 *
 * The +1 is `chrome-bar.tsx`'s `translate-y-px` and the `top-[21px]` the ⌘K pill
 * and the focus breadcrumb are hard-coded to. It exists because the lights read
 * ~13px rather than 12, putting their optical centre half a pixel below the
 * band's — and because it is a correction to the LIGHTS, not to the band, it is
 * the same one pixel at either height.
 */
function controlCentre(band: Band): number {
  return band.height / 2 + 1;
}

/**
 * The 36px trial, as overrides on the real band.
 *
 * Unlayered author CSS, which is what makes this work at all: Tailwind's
 * utilities are layered, so these win over `h-10` / `size-7` / `top-[21px]`
 * without an `!important` and without caring about source order. Scoped to
 * `[data-band="trial"]`, so the shipped frame beside it is untouched.
 */
const TRIAL_CSS = `
[data-band="trial"] .app-region-drag {
  height: ${TRIAL.height}px;
}
[data-band="trial"] [data-slot="button"] {
  width: ${TRIAL.control}px;
  height: ${TRIAL.control}px;
}
[data-band="trial"] [data-slot="button"] svg {
  width: ${TRIAL.glyph}px;
  height: ${TRIAL.glyph}px;
}
[data-band="trial"] [aria-haspopup="dialog"] {
  height: ${TRIAL.pill}px;
  top: ${controlCentre(TRIAL)}px;
}
[data-band="trial"] [aria-live="polite"] {
  top: ${controlCentre(TRIAL)}px;
}
`;

/**
 * The lights macOS would draw, at the offsets `trafficLightPosition` would ask
 * for at this height.
 *
 * Positioned against the band's own top-left corner, which is the window's in
 * the real thing. Inline geometry rather than utilities on purpose: every number
 * here belongs to the OS, and spelling them as spacing tokens would imply the
 * app's ladder has a say in where they land.
 */
function TrafficLights({ band }: { band: Band }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute flex"
      style={{ left: LIGHT_X, top: lightsY(band), gap: LIGHT_PITCH - LIGHT_DIAMETER }}
    >
      {LIGHT_FILLS.map((fill) => (
        <span
          key={fill}
          className="rounded-full"
          style={{ width: LIGHT_DIAMETER, height: LIGHT_DIAMETER, background: fill }}
        />
      ))}
    </div>
  );
}

/**
 * The default window, from `main/index.ts` — the box the canvas gradient is
 * really sized against.
 */
const WINDOW_WIDTH = 1400;
const WINDOW_HEIGHT = 900;

/**
 * One band in a window-shaped frame.
 *
 * The frame paints `var(--canvas)` — the same declaration `html` carries in
 * `globals.css` — so the band's `--lift-1` gradient composites over its real
 * backdrop and the seam against the content card below is the app's own.
 *
 * The three longhands after it are what make that honest rather than merely
 * literal. `--canvas` is a radial gradient positioned at `68% 30%` OF ITS BOX,
 * so painting it into a 160px-tall frame drags the hotspot up under the band and
 * shows it sitting on the brightest part of a gradient it actually sits near the
 * dark top of. Re-sizing the gradient layer to the real window and pinning it to
 * the top-left shows the slice the band genuinely occupies. The grain layer
 * keeps its own 140px tile, which is why the size list has two entries.
 */
function BandFrame({
  band,
  label,
  fullScreen,
}: {
  band: Band;
  label: string;
  /** macOS takes the lights away in fullscreen, so the stand-in has to as well. */
  fullScreen: boolean;
}) {
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-ui font-medium text-foreground">{label}</span>
        <span className="font-mono text-label text-muted-foreground">
          band {band.height} · lights y:{lightsY(band)} · light centre{" "}
          {lightsY(band) + LIGHT_DIAMETER / 2} · controls {band.control} · ⌘K {band.pill} @{" "}
          {controlCentre(band)}
        </span>
      </figcaption>
      {/* The band is `shrink-0` inside a column and positions its ⌘K pill
          against its own width, so it needs a real window-width host to be
          judged in — not the intrinsic width it would take on its own. Press
          Full above for the widest read. The provider is required, not
          decorative: the band's sidebar toggle is a real `SidebarTrigger` and
          reads `useSidebar()`. */}
      <SidebarProvider
        data-band={band.id}
        className="min-h-0 flex-col overflow-hidden rounded-xl border border-border"
        style={{
          background: "var(--canvas)",
          backgroundSize: `140px 140px, ${WINDOW_WIDTH}px ${WINDOW_HEIGHT}px`,
          backgroundRepeat: "repeat, no-repeat",
          backgroundPosition: "0 0, 0 0",
        }}
      >
        {/* `relative` so the lights position against the band's corner, and
            `shrink-0` because this wrapper inherits the job the band's own
            `shrink-0` was doing before it gained a parent. */}
        <div className="relative shrink-0">
          <ChromeBar />
          {fullScreen ? null : <TrafficLights band={band} />}
        </div>
        <div className="flex h-24 items-center justify-center border-t border-border/60 bg-background">
          <p className="text-label text-muted-foreground">
            content area — the band owns the {band.height}px above this line
          </p>
        </div>
      </SidebarProvider>
    </figure>
  );
}

const GEOMETRY_ROWS: readonly (readonly [string, string, string])[] = [
  ["Band height", `${SHIPPED.height}px (h-10)`, `${TRIAL.height}px (h-9)`],
  [
    "trafficLightPosition",
    `{ x: ${LIGHT_X}, y: ${lightsY(SHIPPED)} }`,
    `{ x: ${LIGHT_X}, y: ${lightsY(TRIAL)} }`,
  ],
  [
    "Light centre",
    `${lightsY(SHIPPED) + LIGHT_DIAMETER / 2}px`,
    `${lightsY(TRIAL) + LIGHT_DIAMETER / 2}px`,
  ],
  ["Icon control", `${SHIPPED.control}px (size-7)`, `${TRIAL.control}px (size-6)`],
  ["Control glyph", `${SHIPPED.glyph}px`, `${TRIAL.glyph}px`],
  [
    "⌘K pill",
    `${SHIPPED.pill}px @ ${controlCentre(SHIPPED)}px`,
    `${TRIAL.pill}px @ ${controlCentre(TRIAL)}px`,
  ],
  ["Light spacer", "78px", "78px — unchanged"],
];

/** Every number the two bands differ by, side by side, so the diff is one glance. */
function GeometryTable() {
  return (
    <table className="w-full max-w-[560px] border-collapse text-ui">
      <thead>
        <tr className="border-b border-border">
          <th
            scope="col"
            className="py-1 pr-4 text-left text-label font-normal uppercase text-muted-foreground"
          >
            Geometry
          </th>
          <th
            scope="col"
            className="py-1 pr-4 text-left text-label font-normal uppercase text-muted-foreground"
          >
            Shipped
          </th>
          <th
            scope="col"
            className="py-1 text-left text-label font-normal uppercase text-muted-foreground"
          >
            Trial
          </th>
        </tr>
      </thead>
      <tbody>
        {GEOMETRY_ROWS.map(([fact, shipped, trial]) => (
          <tr key={fact} className="border-b border-border/40">
            <th scope="row" className="py-1 pr-4 text-left font-normal text-muted-foreground">
              {fact}
            </th>
            <td className="py-1 pr-4 font-mono text-label text-foreground">{shipped}</td>
            <td className="py-1 font-mono text-label text-foreground">{trial}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ─── THE STATE SWITCHES ──────────────────────────────────────────────────── */

const FOCUS_TARGET = {
  projectId: project.id,
  ticketId: "tkt-14",
  sessionId: "ses-14a",
};

/** The band's right-rail toggle only exists while a ticket is open. */
function setOpenTicket(open: boolean): void {
  useWorkspaceStore.setState({
    byProject: {
      [project.id]: {
        ...DEFAULT_WORKSPACE_UI,
        nav: "board",
        openTicketId: open ? ticketById("tkt-14").id : null,
      },
    },
  });
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <label className="flex items-start gap-3">
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5 shrink-0" />
      <span className="flex min-w-0 flex-col">
        <span className="text-ui text-foreground">{label}</span>
        <span className="text-label text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

export default function ChromeScratch() {
  const workspaceRailHidden = useUiStore((state) => state.workspaceRailHidden);
  const railCollapsed = useUiStore((state) => state.railCollapsed);
  const terminalFocused = useUiStore((state) => state.terminalFocusTarget !== null);
  const openTicketId = useWorkspaceStore(
    (state) => state.byProject[project.id]?.openTicketId ?? null,
  );
  // Not derived from a store: the window's own state has no renderer-side
  // record, so the switch owns it and pushes it the way main would.
  const [fullScreen, setFullScreen] = React.useState(false);

  return (
    <div className="flex flex-col gap-6">
      <style>{TRIAL_CSS}</style>

      <BandFrame band={SHIPPED} label="Shipped — 40px" fullScreen={fullScreen} />
      <BandFrame band={TRIAL} label="Trial — 36px" fullScreen={fullScreen} />

      <GeometryTable />

      <p className="max-w-[560px] text-ui text-muted-foreground">
        <span className="text-foreground">If 36px wins</span>, main/index.ts becomes{" "}
        <code className="font-mono text-label text-foreground">
          trafficLightPosition: {"{"} x: {LIGHT_X}, y: {lightsY(TRIAL)} {"}"}
        </code>{" "}
        — the same (band − {LIGHT_DIAMETER}) / 2 the current y:{lightsY(SHIPPED)} comes from. Only y
        moves: the group is three {LIGHT_DIAMETER}px dots at a {LIGHT_PITCH}px pitch from x:
        {LIGHT_X}, so it ends at {LIGHT_X + LIGHT_DIAMETER + 2 * LIGHT_PITCH}px whatever the
        band&apos;s height — the 78px spacer and the ⌘K pill&apos;s overlap margin are both
        untouched. The renderer half is chrome-bar.tsx&apos;s h-10, its size=&quot;icon&quot;
        buttons, and the two hard-coded top-[21px] anchors.
      </p>

      <div className="grid grid-cols-2 gap-x-8 gap-y-4">
        <Toggle
          label="Fullscreen"
          hint="Traffic lights hide, so the 78px spacer collapses (300ms)"
          checked={fullScreen}
          onChange={(next) => {
            setFullScreen(next);
            for (const listener of fullScreenListeners) listener(next);
          }}
        />
        <Toggle
          label="Ticket open"
          hint="Reveals the right-rail toggle at the band's right edge"
          checked={openTicketId !== null}
          onChange={setOpenTicket}
        />
        <Toggle
          label="Terminal focus"
          hint="Replaces all navigation with the breadcrumb + exit control"
          checked={terminalFocused}
          onChange={(next) =>
            useUiStore.getState().setTerminalFocusTarget(next ? FOCUS_TARGET : null)
          }
        />
        <Toggle
          label="Project switcher hidden"
          hint="Presses the leftmost toggle — the switcher rail's own visibility"
          checked={workspaceRailHidden}
          onChange={(next) => useUiStore.getState().setWorkspaceRailHidden(next)}
        />
        <Toggle
          label="Details rail collapsed"
          hint="Only visible while a ticket is open"
          checked={railCollapsed}
          onChange={(next) => useUiStore.getState().setRailCollapsed(next)}
        />
      </div>

      <p className="max-w-[560px] text-label text-muted-foreground">
        The band is a drag region in the app; here it is inert. The lights are the lab&apos;s
        stand-in — macOS draws the real ones, outside the renderer and outside ⌘+ zoom, which is why
        their offsets are a contract rather than a style. Fullscreen removes them entirely, so the
        seating question only applies to the windowed state on the left of both bands.
      </p>
    </div>
  );
}
