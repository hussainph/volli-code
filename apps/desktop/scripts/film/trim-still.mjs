#!/usr/bin/env node
/**
 * Trim a website still to its subject (VC-472).
 *
 * The film composes each shot around room for a super, so a raw frame is
 * mostly empty: the window sits off to one side. The website sets its words
 * above the picture instead, so it wants the subject and nothing else — the
 * frame cropped to where the pixels are, with a margin for the soft shadow.
 *
 * Idempotent: a trimmed still trims to itself, because the margin is clamped
 * to the image. Frames with no transparency (a full-window shot) are left alone.
 *
 *   node scripts/film/trim-still.mjs <file.webp> [...]   # trims in place
 */
import { fileURLToPath } from "node:url";
import sharp from "sharp";

/** Alpha below this is shadow tail, not subject. */
const THRESHOLD = 48;
/** Margin kept around the subject, as a fraction of the frame's width. */
const MARGIN = 0.03;

/** @param {Buffer} input  @returns {Promise<Buffer>} a PNG buffer */
export async function trimToSubject(input) {
  const image = sharp(input).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * channels;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * channels + 3] >= THRESHOLD) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (bottom < 0) return sharp(input).png().toBuffer();
  const margin = Math.round(width * MARGIN);
  const box = {
    left: Math.max(0, left - margin),
    top: Math.max(0, top - margin),
    right: Math.min(width - 1, right + margin),
    bottom: Math.min(height - 1, bottom + margin),
  };
  return sharp(input)
    .extract({
      left: box.left,
      top: box.top,
      width: box.right - box.left + 1,
      height: box.bottom - box.top + 1,
    })
    .png()
    .toBuffer();
}

export const WEBP = { quality: 80, alphaQuality: 90, effort: 6 };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const file of process.argv.slice(2)) {
    const before = await sharp(file).metadata();
    const trimmed = await trimToSubject(await sharp(file).png().toBuffer());
    const buffer = await sharp(trimmed).webp(WEBP).toBuffer();
    await sharp(buffer).toFile(file);
    const after = await sharp(file).metadata();
    console.log(`${file}: ${before.width}×${before.height} → ${after.width}×${after.height}`);
  }
}
