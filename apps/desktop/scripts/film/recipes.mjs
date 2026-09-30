#!/usr/bin/env node
/**
 * Writes the release film's Flute recipes (VC-464) from scripts/film/shots.mjs
 * into src/flute/scenes/<key>-<format>.scene.json, then runs `flute sync` so
 * the portable adapter's catalog lists them.
 *
 *   node scripts/film/recipes.mjs [shot-key ...]
 *
 * The recipes are generated rather than hand-written because a camera that
 * keeps a moving world point framed through a changing rotation is a solved
 * equation per frame, not a handful of eased keyframes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { recipe } from "./lib.mjs";
import { FORMATS, SHOTS } from "./shots.mjs";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scenes = join(desktop, "src", "flute", "scenes");
const only = process.argv.slice(2);

for (const shot of SHOTS) {
  if (only.length > 0 && !only.includes(shot.key)) continue;
  for (const [format, size] of Object.entries(FORMATS)) {
    const id = `${shot.key}-${format}`;
    const doc = recipe({
      id,
      title: `${shot.title} · ${format === "wide" ? "16:9" : "9:16"}`,
      description: shot.description,
      width: size.width,
      height: size.height,
      durationMs: shot.durationMs,
      perspective: shot.perspective,
      rig: shot.rig(format),
      nodes: typeof shot.nodes === "function" ? shot.nodes(format) : shot.nodes,
      surfaceTracks: shot.surfaceTracks?.(format) ?? [],
      guard: shot.guard ?? [],
      stepMs: shot.stepMs,
    });
    writeFileSync(join(scenes, `${id}.scene.json`), JSON.stringify(doc, null, 2) + "\n");
    const binding = join(scenes, `${id}.tsx`);
    if (!existsSync(binding)) console.warn(`missing binding: ${binding}`);
    console.log("wrote", id);
  }
}

execFileSync("npx", ["flute", "sync"], { cwd: desktop, stdio: ["ignore", "ignore", "inherit"] });
console.log("flute sync: catalog updated");
