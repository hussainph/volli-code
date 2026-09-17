/**
 * Release-compliance gate: no built site ships font software without its
 * license notice.
 *
 * Both static sites self-host Mona Sans, so `dist/_astro/` fills with .woff2
 * files on every build and every deploy redistributes them. OFL-1.1 permits
 * that redistribution only when "each copy contains the above copyright notice
 * and this license" (clause 2). Each site emits `/licenses.txt` from the
 * installed font package for exactly that reason; this module re-derives the
 * expectation from the app manifest and `node_modules`, then reads the finished
 * `dist/` and fails when the two disagree.
 *
 * It deliberately shares no code with the generator in `src/index.ts`. A check
 * that imports the thing it checks agrees with itself; this one can only be
 * satisfied by bytes that actually reached `dist/`.
 *
 * What it enforces, per app:
 *   1. If `dist/` holds font binaries, `dist/licenses.txt` exists and is not
 *      empty.
 *   2. Every font dependency in the app's package.json appears in that file by
 *      name and installed version, with its LICENSE text verbatim.
 *   3. Every font binary in `dist/` is a file one of those packages actually
 *      ships. A family added without a notice fails here rather than shipping.
 *
 * Ownership in (3) is decided by FILENAME IDENTITY, not by a name prefix: the
 * check lists the font files inside each attributed package and matches dist
 * basenames against that set, allowing for the one content-hash segment Astro
 * inserts before the extension. A prefix test would let a second, differently
 * licensed family through whenever its files happened to start with an
 * attributed package's name (`mona-sans-expanded-…` under `mona-sans`), which
 * is precisely the case this gate exists to catch.
 *
 * `bin/check-font-notices.mjs` is the CLI over this module; `check-dist.test.mjs`
 * is its test.
 */
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Web font containers. A file with one of these extensions is font software. */
const FONT_EXTENSIONS = [".woff2", ".woff", ".ttf", ".otf", ".eot"];

/** The notice file each site publishes, relative to its `dist/`. */
export const NOTICE_FILE = "licenses.txt";

/** Packages that vendor font binaries. Fontsource is the only family in use. */
function isFontPackage(name) {
  return name.startsWith("@fontsource/") || name.startsWith("@fontsource-variable/");
}

function isFontFile(name) {
  const lower = name.toLowerCase();
  return FONT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function basename(path) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf(sep));
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * The names a dist file could have had in its source package.
 *
 * Astro emits `mona-sans-latin-wght-normal.woff2` as
 * `mona-sans-latin-wght-normal.Pz49MTQZ.woff2` — one hash segment inserted
 * before the extension. Both the hashed and unhashed spellings are offered so
 * this works whether or not the bundler hashed the asset.
 */
export function sourceFileNames(distBasename) {
  const parts = distBasename.split(".");
  if (parts.length <= 2) return [distBasename];
  return [distBasename, `${parts.slice(0, -2).join(".")}.${parts.at(-1)}`];
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

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, "utf8"));
}

/**
 * Resolves a subpath inside a package installed for `appDir`, e.g.
 * `@fontsource-variable/mona-sans/LICENSE`, using that app's own resolution —
 * so a package hoisted differently per app is read exactly as that app's build
 * read it. Throws when the package is not installed.
 *
 * Injectable, because under a test runner `createRequire` resolves from the
 * runner's project root rather than the path it is handed, which would make
 * "this package is missing" untestable.
 */
export function packageFileResolver(appDir) {
  const require = createRequire(join(appDir, "package.json"));
  return (specifier) => require.resolve(specifier);
}

/**
 * Checks one built app. Returns its failures and a one-line note for the log;
 * it never exits, so the CLI owns the process and the test can call it plainly.
 */
export async function checkApp(
  appPath,
  { cwd = process.cwd(), resolverFor = packageFileResolver } = {},
) {
  const appDir = resolve(cwd, appPath);
  const failures = [];
  // Named by its workspace package, not by the path it was invoked with: each
  // site's build runs this as `check-font-notices .`, and a report that says
  // "." tells a CI log nothing about which site is out of compliance.
  let label = appPath;
  const fail = (message) => {
    failures.push(`${label}: ${message}`);
    return { label, failures, note: null };
  };

  let manifest;
  try {
    manifest = await readJson(join(appDir, "package.json"));
  } catch {
    return fail(`no readable package.json at ${appDir}.`);
  }
  if (typeof manifest.name === "string" && manifest.name.length > 0) label = manifest.name;

  const fontPackages = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => isFontPackage(name))
    .toSorted();

  const distDir = join(appDir, "dist");
  const files = await listFiles(distDir);
  if (files === null) {
    return fail("no dist/ to check — build the site before checking it.");
  }

  const fontFiles = files.filter((file) => isFontFile(file));
  if (fontFiles.length === 0) {
    // Nothing is redistributed, so nothing is owed. Say so rather than passing
    // silently: a site that stopped emitting fonts is worth noticing.
    return { label, failures, note: `${label}: no font binaries in dist/ — nothing to attribute.` };
  }

  let notice = null;
  try {
    notice = await fs.readFile(join(distDir, NOTICE_FILE), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (notice === null || notice.trim().length === 0) {
    return fail(
      `dist/ ships ${fontFiles.length} font file(s) but no ${NOTICE_FILE}. ` +
        `Check src/pages/${NOTICE_FILE}.ts is present and building.`,
    );
  }

  const resolveFile = resolverFor(appDir);

  // Font files belonging to a package the site DECLARES, whether or not its
  // notice turned out to be correct. Ownership and notice correctness are
  // separate questions: a stale version is one fault, and reporting its font
  // files as unknown strays on top of it would bury the cause under a symptom.
  const declaredFileNames = new Set();
  let ownershipKnown = true;

  for (const packageName of fontPackages) {
    let version;
    let licenseText;
    try {
      const manifestPath = resolveFile(`${packageName}/package.json`);
      ({ version } = await readJson(manifestPath));
      licenseText = (await fs.readFile(resolveFile(`${packageName}/LICENSE`), "utf8")).trim();

      for (const file of (await listFiles(dirname(manifestPath))) ?? []) {
        if (isFontFile(file)) declaredFileNames.add(basename(file));
      }
    } catch {
      // Nothing can be said about which files this package owns, so the orphan
      // verdict below would be guesswork.
      ownershipKnown = false;
      failures.push(
        `${label}: cannot read ${packageName}'s package.json and LICENSE to verify it.`,
      );
      continue;
    }

    if (!notice.includes(`${packageName} ${version}`)) {
      failures.push(`${label}: ${NOTICE_FILE} does not cite ${packageName} ${version}.`);
      continue;
    }

    if (!notice.includes(licenseText)) {
      failures.push(
        `${label}: ${NOTICE_FILE} does not carry the full LICENSE text of ${packageName}.`,
      );
    }
  }

  // A font binary that no declared package ships: either a family was added to
  // the site without declaring it, or a font arrived from somewhere this check
  // does not know about. Both need a human.
  const orphans = ownershipKnown
    ? fontFiles.filter(
        (file) => !sourceFileNames(basename(file)).some((name) => declaredFileNames.has(name)),
      )
    : [];

  if (orphans.length > 0) {
    failures.push(
      `${label}: ${orphans.length} font file(s) in dist/ are not covered by ${NOTICE_FILE}: ` +
        `${orphans.slice(0, 5).join(", ")}. Add the family to src/pages/${NOTICE_FILE}.ts ` +
        `and declare it in package.json.`,
    );
  }

  if (failures.length > 0) return { label, failures, note: null };

  return {
    label,
    failures,
    note: `${label}: ${fontFiles.length} font file(s), ${fontPackages.length} package(s) attributed in ${NOTICE_FILE} — ok`,
  };
}

/** Checks several built apps, collecting every failure rather than stopping at the first. */
export async function checkApps(appPaths, options = {}) {
  const failures = [];
  const notes = [];

  for (const appPath of appPaths) {
    const result = await checkApp(appPath, options);
    failures.push(...result.failures);
    if (result.note !== null) notes.push(result.note);
  }

  return { failures, notes };
}
