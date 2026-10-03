/**
 * Micro-beat · dozens of sessions, still fast. The real sidebar, fed the fleet
 * fixture (kit/fleet.tsx), scrolls hard through its dozens of Sessions — the
 * scrollport's `scrollTop` is driven from scene time — while the camera rides
 * alongside on an oblique, the aurora world open to the right.
 *
 * Real: the whole `AppShell` (`ShellWindow`). Rig: scripts/film/shots/sessions.mjs.
 */
import { Surface } from "@webprodigies/flute";

import { ease, progress } from "../kit/clock";
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
import { fleetApi, seedFleet, SidebarScroll } from "../kit/fleet";
import { ShellWindow } from "../kit/split-shell";
import { NOW } from "../../renderer/lab/fixtures";
import { Backdrop, useFilmTheme } from "../kit/world";

/** The window, in lab CSS px. The rig in scripts/film/shots/sessions.mjs mirrors it. */
export const WINDOW = { width: 1600, height: 960 };

/** How far the list travels (clamped to its real overflow). */
const TRAVEL = 1200;

const API = fleetApi();

const CUE: Cue = {
  at: 100,
  until: 1300,
  lines: ["Dozens of sessions.", "Still fast."],
  weights: [800, 320],
};

const CUES: Record<Format, Cue[]> = {
  landscape: [{ ...CUE, place: "lower-right" }],
  portrait: [{ ...CUE, place: "lower" }],
};

export function SessionsShot({ format }: { format: Format }) {
  const t = useFilm();
  useFilmTheme("aurora");
  useFilmWallClock(t, NOW);
  useFixtures({ api: API, seed: seedFleet });
  const top = TRAVEL * progress(t, 0, 1250, ease.inOutCubic);

  return (
    <>
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
            <SidebarScroll top={top} />
          </ShellWindow>
        }
      />
      <Backdrop t={t} theme="aurora" focus={[0.25, 0.5]} />
      <FrameLayer format={format}>
        <Vignette strength={0.4} />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </>
  );
}
