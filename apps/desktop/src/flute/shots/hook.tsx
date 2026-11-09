/**
 * 01 · The hook. Frame 1 is a tight oblique on the real sidebar's Active band
 * — dozens of live chat Sessions, working rings travelling, waiting rings
 * standing — with the camera already moving fast down the list. It then pulls
 * back to reveal the whole AppShell window floating in the aurora world.
 *
 * Real: the whole `AppShell` (`ShellWindow`), its sidebar fed the fleet
 * fixture (kit/fleet.tsx) through the stores and bridge it reads.
 * Rig: scripts/film/shots/hook.mjs.
 */
import { Surface } from "@webprodigies/flute";

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
import { fleetApi, seedFleet } from "../kit/fleet";
import { ShellWindow } from "../kit/split-shell";
import { NOW } from "../../renderer/lab/fixtures";
import { Backdrop, useFilmTheme } from "../kit/world";

/** The window, in lab CSS px. The rig in scripts/film/shots/hook.mjs mirrors it. */
export const WINDOW = { width: 1600, height: 960 };

const API = fleetApi();

/** Lands once the pull-back has opened the aurora world, so it never sits on UI. */
const CUE: Cue = {
  at: 250,
  until: 2900,
  eyebrow: "Volli 0.2",
  lines: ["Dozens of agents.", "Nothing missed."],
  weights: [800, 320],
};

const CUES: Record<Format, Cue[]> = {
  landscape: [{ ...CUE, place: "lower-right" }],
  portrait: [{ ...CUE, place: "lower" }],
};

export function HookShot({ format }: { format: Format }) {
  const t = useFilm();
  useFilmTheme("aurora");
  // Rows read "just now", not a stale date: the fleet is stamped against NOW.
  useFilmWallClock(t, NOW);
  useFixtures({ api: API, seed: seedFleet });

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
        content={<ShellWindow width={WINDOW.width} height={WINDOW.height} />}
      />
      <Backdrop t={t} theme="aurora" focus={[0.3, 0.4]} />
      <FrameLayer format={format}>
        <Vignette strength={0.4} />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </>
  );
}
