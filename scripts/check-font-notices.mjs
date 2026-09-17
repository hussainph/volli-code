/**
 * Release-compliance gate: no built site ships font software without its
 * license notice.
 *
 * Both static sites self-host Mona Sans, so `dist/_astro/` fills with .woff2
 * files on every build and every deploy redistributes them. OFL-1.1 permits
 * that redistribution only when "each copy contains the above copyright notice
 * and this license" (clause 2). Each site emits `/licenses.txt` from the
 * installed font package for exactly that reason; this script re-derives the
 * expectation from the app manifest and `node_modules`, then reads the finished
 * `dist/` and fails the build when the two disagree.
 *
 * It deliberately shares no code with the generator in
 * `apps/*\/src/lib/font-notices.ts`. A check that imports the thing it checks
 * agrees with itself; this one can only be satisfied by bytes that actually
 * reached `dist/`.
 *
 * What it enforces, per app:
 *   1. If `dist/` holds font binaries, `dist/licenses.txt` exists.
 *   2. Every Fontsource dependency in the app's package.json appears in that
 *      file by name and installed version, with its LICENSE text verbatim.
 *   3. Every font binary in `dist/` belongs to one of those packages — a new
 *      family added without a notice fails here rather than shipping.
 *
 * Usage — app paths resolve against the working directory, and checking every
 * site is the default:
 *
 *   node scripts/check-font-notices.mjs
 *   node scripts/check-font-notices.mjs apps/docs
 *
 * Each site's own `build` script runs it with `.` after `astro build`, so the
 * gate travels with the build rather than living only in CI — `pnpm deploy`
 * runs it too.
 */
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const DEFAULT_APPS = [join(repoRoot, "apps/website"), join(repoRoot, "apps/docs")];

/** Web font containers. A file with one of these extensions is font software. */
const FONT_EXTENSIONS = [".woff2", ".woff", ".ttf", ".otf", ".eot"];

/** The notice file each site publishes, relative to its `dist/`. */
const NOTICE_FILE = "licenses.txt";

/** Packages that vendor font binaries. Fontsource is the only family in use. */
function isFontPackage(name) {
  return name.startsWith("@fontsource/") || name.startsWith("@fontsource-variable/");
}

/**
 * The prefix Fontsource gives every binary it ships, e.g.
 * `@fontsource-variable/mona-sans` -> `mona-sans-latin-wght-normal.woff2`.
 * Astro only inserts a content hash before the extension, so the prefix
 * survives into `dist/`.
 */
function fontFilePrefix(packageName) {
  return packageName.slice(packageName.indexOf("/") + 1);
}

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, "utf8"));
}

/** Every file under `dir`, as paths relative to it. Missing dir -> null. */
async function listFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

async function checkApp(appPath, failures) {
  const appDir = resolve(process.cwd(), appPath);
  const label = relative(repoRoot, appDir) || appPath;
  const manifest = await readJson(join(appDir, "package.json"));

  const fontPackages = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })
    .filter((name) => isFontPackage(name))
    .toSorted();

  const distDir = join(appDir, "dist");
  const files = await listFiles(distDir);
  if (files === null) {
    failures.push(`${label}: no dist/ to check — build the site before checking it.`);
    return;
  }

  const fontFiles = files.filter((file) =>
    FONT_EXTENSIONS.some((extension) => file.toLowerCase().endsWith(extension)),
  );

  if (fontFiles.length === 0) {
    // Nothing is redistributed, so nothing is owed. Say so rather than passing
    // silently: a site that stopped emitting fonts is worth noticing.
    console.log(`  ${label}: no font binaries in dist/ — nothing to attribute.`);
    return;
  }

  let notice = null;
  try {
    notice = await fs.readFile(join(distDir, NOTICE_FILE), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (notice === null || notice.trim().length === 0) {
    failures.push(
      `${label}: dist/ ships ${fontFiles.length} font file(s) but no ${NOTICE_FILE}. ` +
        `Check src/pages/${NOTICE_FILE}.ts is present and building.`,
    );
    return;
  }

  // The app's own resolution, so a package hoisted differently per app is read
  // exactly as that app's build read it.
  const require = createRequire(join(appDir, "package.json"));

  const attributed = [];
  for (const packageName of fontPackages) {
    const { version } = await readJson(require.resolve(`${packageName}/package.json`));
    const licenseText = (
      await fs.readFile(require.resolve(`${packageName}/LICENSE`), "utf8")
    ).trim();

    if (!notice.includes(`${packageName} ${version}`)) {
      failures.push(`${label}: ${NOTICE_FILE} does not cite ${packageName} ${version}.`);
      continue;
    }

    if (!notice.includes(licenseText)) {
      failures.push(
        `${label}: ${NOTICE_FILE} does not carry the full LICENSE text of ${packageName}.`,
      );
      continue;
    }

    attributed.push(packageName);
  }

  // A font binary whose package is not attributed above: either a family was
  // added to the site without adding it to the notice list, or a font arrived
  // from somewhere this check does not know about. Both need a human.
  const prefixes = attributed.map((packageName) => fontFilePrefix(packageName));
  const orphans = fontFiles.filter((file) => {
    const base = file.slice(file.lastIndexOf("/") + 1);
    return !prefixes.some((prefix) => base.startsWith(prefix));
  });

  if (orphans.length > 0) {
    failures.push(
      `${label}: ${orphans.length} font file(s) in dist/ are not covered by ${NOTICE_FILE}: ` +
        `${orphans.slice(0, 5).join(", ")}. Add the family to REDISTRIBUTED_FONT_PACKAGES ` +
        `in src/lib/font-notices.ts.`,
    );
    return;
  }

  console.log(
    `  ${label}: ${fontFiles.length} font file(s), ${attributed.length} package(s) attributed in ${NOTICE_FILE} — ok`,
  );
}

async function main() {
  const apps = process.argv.slice(2);
  const targets = apps.length > 0 ? apps : DEFAULT_APPS;
  const failures = [];

  console.log("Checking font license notices in built output:");
  for (const app of targets) {
    await checkApp(app, failures);
  }

  if (failures.length > 0) {
    console.error(`\nFont notice check failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error("");
    process.exit(1);
  }
}

await main();
