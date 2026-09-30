/**
 * volli.app's hero (VC-472) — web-only, never in the release film. The hook's
 * real AppShell and fleet (./hook.tsx), with no supers: the page sets its own
 * words. Rig: scripts/film/shots/hero.mjs.
 *
 * The site loops the drift after the intro, so everything that moves must come
 * back to where it was: the backdrop's clock swings back and forth over the
 * loop instead of running on, with the same pace as the intro at the join.
 */
import { Surface } from "@webprodigies/flute";

import { useFilm, useFilmWallClock, useFixtures, type Format } from "../kit/film";
import { fleetApi, seedFleet } from "../kit/fleet";
import { ShellWindow } from "../kit/split-shell";
import { NOW } from "../../renderer/lab/fixtures";
import { Backdrop, useFilmTheme } from "../kit/world";
import { WINDOW } from "./hook";

const INTRO_MS = 2600;
const LOOP_MS = 6000;
const API = fleetApi();

/** Scene time → backdrop time: real time in the intro, a seamless swing after. */
function backdropClock(t: number): number {
  if (t <= INTRO_MS) return t;
  const u = ((t - INTRO_MS) % LOOP_MS) / LOOP_MS;
  return INTRO_MS + (LOOP_MS / (2 * Math.PI)) * Math.sin(2 * Math.PI * u);
}

export function HeroShot(_: { format: Format }) {
  const t = useFilm();
  useFilmTheme("aurora");
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
      <Backdrop t={backdropClock(t)} theme="aurora" focus={[0.5, 0.45]} />
    </>
  );
}
