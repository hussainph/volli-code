/**
 * Rasterizes the grain tile (docs/plans/theming-engine.md § Grain) into
 * `src/renderer/src/assets/grain-128.png`.
 *
 *   node apps/desktop/scripts/generate-grain.mjs
 *
 * The tile is COMMITTED, and `src/renderer/src/theme/grain-asset.test.ts`
 * re-runs this generator and compares bytes — so the checked-in PNG can never
 * drift from the script that produced it, and neither can be a one-off.
 *
 * Three choices worth the words:
 *
 *  - **2-bit greyscale, 128×128.** The overlay paints at 1.5–3.5% opacity, so
 *    a source level only ever moves the composited 8-bit output by ~1–2 steps:
 *    four grey levels (0/85/170/255) are already finer than the destination
 *    can resolve, and anything deeper is bytes spent below the noise floor.
 *    128px is the smallest tile whose repeat is invisible for white noise.
 *    Raw scanlines are 33 bytes × 128 rows = 4224 B, which is what lands the
 *    file inside § Grain's 2–6 KB budget.
 *  - **Stored (uncompressed) deflate.** White noise is incompressible — level
 *    9 saves nothing on it — and a stored stream is byte-identical under any
 *    zlib version, which is what makes the byte-equality test above a
 *    reproducibility check rather than a Node-upgrade tripwire.
 *  - **A seeded PRNG.** `Math.random()` would regenerate a different tile
 *    every run and turn every regeneration into a spurious binary diff.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Tile edge in pixels. Mirrored by `GRAIN_TILE_PX` in `theme/grain.ts`. */
export const GRAIN_TILE_PX = 128;

/** Fixed so the tile is reproducible; the value itself is arbitrary. */
const GRAIN_SEED = 0x76_6f_6c_6c;

/** Bits per sample. 2 → four grey levels; see the header comment. */
const BIT_DEPTH = 2;

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Mulberry32 — small, fast, and identical on every platform and Node version. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_00_00_00_00;
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let c = index;
  for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

/** One PNG chunk: length, type, payload, CRC over type+payload. */
function chunk(type, payload) {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, Buffer.from(payload)]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([header, body, crc]);
}

/** The grain tile as PNG bytes. Pure and deterministic. */
export function generateGrainTilePng() {
  const random = mulberry32(GRAIN_SEED);
  const samplesPerByte = 8 / BIT_DEPTH;
  const bytesPerRow = GRAIN_TILE_PX / samplesPerByte;
  const maxLevel = (1 << BIT_DEPTH) - 1;

  // Filter byte 0 (None) per row: filtering only pays off on data with
  // structure, and there is none here by construction.
  const raw = Buffer.alloc((bytesPerRow + 1) * GRAIN_TILE_PX);
  for (let y = 0; y < GRAIN_TILE_PX; y += 1) {
    const rowStart = y * (bytesPerRow + 1) + 1;
    for (let x = 0; x < GRAIN_TILE_PX; x += 1) {
      const level = Math.min(maxLevel, Math.floor(random() * (maxLevel + 1)));
      const shift = (samplesPerByte - 1 - (x % samplesPerByte)) * BIT_DEPTH;
      raw[rowStart + Math.floor(x / samplesPerByte)] |= level << shift;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(GRAIN_TILE_PX, 0);
  ihdr.writeUInt32BE(GRAIN_TILE_PX, 4);
  ihdr.writeUInt8(BIT_DEPTH, 8);
  ihdr.writeUInt8(0, 9); // color type 0 = greyscale
  ihdr.writeUInt8(0, 10); // compression: deflate
  ihdr.writeUInt8(0, 11); // filter method 0
  ihdr.writeUInt8(0, 12); // non-interlaced

  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Where the committed tile lives, as an absolute path. */
export const GRAIN_TILE_PATH = fileURLToPath(
  new URL("../src/renderer/src/assets/grain-128.png", import.meta.url),
);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const png = generateGrainTilePng();
  writeFileSync(GRAIN_TILE_PATH, png);
  process.stdout.write(`wrote ${GRAIN_TILE_PATH} (${png.length} bytes)\n`);
}
