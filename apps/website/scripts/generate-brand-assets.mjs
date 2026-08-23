/**
 * Brand raster derivatives for volli.app and docs.volli.app.
 *
 * The 1024px master (`apps/website/brand/volli-icon-master.png`) is the only
 * hand-held icon file. Everything a page actually links to is derived here,
 * because the master is 1.68 MB and every surface that referenced it directly
 * — the favicon, the 34px header logo on both website pages, and the Starlight
 * logo — was shipping all 1.68 MB to render something the size of a
 * fingernail. Astro does not rescue this: `public/` is copied verbatim, and the
 * Starlight logo came out of the build at full weight too.
 *
 * The master lives in `brand/` rather than `src/assets/` because it is input to
 * these generators, not to Astro's image pipeline — and because this clone's
 * `.git/info/exclude` carries an unanchored `assets/` rule that would silently
 * leave it untracked.
 *
 * Derivatives are deliberately few. A favicon and a 34px logo are the same
 * problem at different densities, so one 180px file answers both (180 is also
 * the apple-touch-icon size, so the same bytes cover a home-screen bookmark).
 *
 * Run after changing the master:
 *
 *   node apps/website/scripts/generate-brand-assets.mjs
 *
 * `--check` verifies the derivatives are current without writing, for CI or a
 * pre-release sweep.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const websiteRoot = join(here, "..");
const repoRoot = join(websiteRoot, "..", "..");

const MASTER = join(websiteRoot, "brand/volli-icon-master.png");

/**
 * Every derivative, and why it exists at that size.
 *
 * `size: null` means "copy the master": the OG generator composites the logo
 * at a large size and wants the real pixels.
 */
const DERIVATIVES = [
  {
    // Favicon + the 34px header logo on index.astro and download.astro.
    out: join(websiteRoot, "public/volli-icon-dark.png"),
    size: 180,
  },
  {
    // Starlight's `logo.src`. Rendered in the docs header at ~32px.
    out: join(repoRoot, "apps/docs/src/assets/volli-icon-dark.png"),
    size: 180,
  },
  {
    // Starlight's `favicon`, served from docs `public/`.
    out: join(repoRoot, "apps/docs/public/volli-icon-dark.png"),
    size: 180,
  },
];

/** Encode one derivative. Kept in one place so `--check` and the write path
 *  cannot drift into producing different bytes. */
async function render(size) {
  return sharp(MASTER)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, effort: 10, palette: true })
    .toBuffer();
}

const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function main() {
  const check = process.argv.includes("--check");
  const stale = [];

  for (const { out, size } of DERIVATIVES) {
    const next = await render(size);
    const label = relative(repoRoot, out);

    let current = null;
    try {
      current = await fs.readFile(out);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (current && digest(current) === digest(next)) {
      console.log(`  ok       ${label} (${size}px, ${(next.length / 1024).toFixed(1)} KB)`);
      continue;
    }

    if (check) {
      stale.push(label);
      console.log(`  STALE    ${label}`);
      continue;
    }

    await fs.mkdir(dirname(out), { recursive: true });
    await fs.writeFile(out, next);
    const before = current ? `${(current.length / 1024).toFixed(1)} KB -> ` : "";
    console.log(`  wrote    ${label} (${size}px, ${before}${(next.length / 1024).toFixed(1)} KB)`);
  }

  if (stale.length > 0) {
    console.error(
      `\n${stale.length} brand derivative(s) are stale. Run:\n  node apps/website/scripts/generate-brand-assets.mjs\n`,
    );
    process.exit(1);
  }
}

await main();
