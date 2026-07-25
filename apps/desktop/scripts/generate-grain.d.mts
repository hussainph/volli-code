/**
 * Types for `generate-grain.mjs`. The script itself stays plain JS: it is
 * Node-land tooling (it reaches for `node:zlib`), and nothing in the renderer
 * or main bundles imports it — only its committed PNG output and the test that
 * proves the two agree.
 */

/** Tile edge in pixels. */
export declare const GRAIN_TILE_PX: number;

/** Absolute path of the committed tile. */
export declare const GRAIN_TILE_PATH: string;

/** The grain tile as PNG bytes — pure and deterministic. */
export declare function generateGrainTilePng(): Buffer;
