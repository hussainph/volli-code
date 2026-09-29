/**
 * The release film's shot list (VC-464). Each shot lives in its own module in
 * ./shots/<key>.mjs and exports `shot`:
 *
 *   {
 *     key: "cursor",               // scene ids become `${key}-wide` / `${key}-tall`
 *     title, description,
 *     durationMs, perspective,
 *     nodes: [...] | (format) => [...],   // Flute node metadata, matching the Surfaces
 *     rig: (format) => (t) => ({ rotation, target, near, offset, focus, fStop, ... }),
 *     surfaceTracks?: (format) => [...],  // optional Flute surface tracks
 *   }
 *
 * The 9:16 recipe is its own composition — the rig receives the format and
 * frames it separately — never a crop of the 16:9 one.
 *
 * Coordinates: world units are the lab's CSS pixels, origin at the scene's
 * centre, +y down, +z toward the viewer. See lib.mjs for the camera algebra.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FORMATS = {
  wide: { width: 1920, height: 1080 },
  tall: { width: 1080, height: 1920 },
};

const directory = join(dirname(fileURLToPath(import.meta.url)), "shots");

export const SHOTS = await Promise.all(
  readdirSync(directory)
    .filter((file) => file.endsWith(".mjs"))
    .toSorted()
    .map(async (file) => (await import(pathToFileURL(join(directory, file)).href)).shot),
);
