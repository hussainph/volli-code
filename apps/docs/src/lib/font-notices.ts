// The license notices that must travel with the web fonts this site serves.
//
// docs.volli.app self-hosts Mona Sans: Starlight's `customCss` pulls in
// `@fontsource-variable/mona-sans/wght.css`, and the build emits its font
// binaries into `dist/_astro/`, so every deploy REDISTRIBUTES font software.
// Mona Sans is OFL-1.1, and clause 2 of that license lets a copy be bundled
// with any software only "provided that each copy contains the above copyright
// notice and this license". Shipping the .woff2 files with no notice beside
// them does not meet that condition.
//
// So the notice is derived from the font package itself — its LICENSE file, its
// version, its homepage — at build time, by `src/pages/licenses.txt.ts`. Nothing
// here is transcribed by hand: bumping the dependency, or adding a second font,
// rewrites the published notice on the next build instead of leaving a stale
// copy behind. `scripts/check-font-notices.mjs` at the repo root then re-reads
// the finished `dist/` and fails the build if fonts shipped without them.
//
// `apps/website/src/lib/font-notices.ts` is the same module for volli.app,
// which self-hosts the same family. The two sites are separate Astro projects
// with no shared build, so this is duplicated deliberately rather than pulled
// through a workspace package that neither site would otherwise need. This app
// has no test runner of its own, so the website's copy carries the unit tests
// (`font-notices.test.ts`) — including a guard that reads THIS file and fails
// when the two copies' code stops matching. Edit one, edit the other.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** A font package whose binaries this site serves from its own origin. */
export interface FontPackage {
  /** Family name as a reader would recognise it, e.g. `Mona Sans`. */
  family: string;
  /** npm package that vendors the font files, e.g. `@fontsource-variable/mona-sans`. */
  packageName: string;
}

/** One rendered attribution: what the package is, and the notice it carries. */
export interface FontNotice extends FontPackage {
  /** Installed version of the font package, as the notice should cite it. */
  version: string;
  /** SPDX identifier the package declares, e.g. `OFL-1.1`. */
  license: string;
  /** Upstream page for the font, or null when the package names none. */
  homepage: string | null;
  /** The package's LICENSE file verbatim: copyright line plus license text. */
  text: string;
}

/**
 * Every font package this site redistributes.
 *
 * `astro.config.mjs` lists `@fontsource-variable/mona-sans/wght.css` in
 * Starlight's `customCss`, which is what pulls the binaries into the build. A
 * font added there has to be added here too — the dist check fails the build
 * when a font family reaches `dist/` without a notice.
 */
export const REDISTRIBUTED_FONT_PACKAGES: readonly FontPackage[] = [
  { family: "Mona Sans", packageName: "@fontsource-variable/mona-sans" },
];

/**
 * Reads files out of an installed package by subpath, e.g.
 * `@fontsource-variable/mona-sans/LICENSE`. Injectable so the unit tests can
 * exercise a malformed package without installing one.
 */
export interface PackageFileReader {
  (specifier: string): string;
}

const readPackageFile: PackageFileReader = (specifier) => {
  // Both subpaths are published in Fontsource's `exports` map, so this is a
  // supported read rather than a reach into the package's innards.
  const require = createRequire(import.meta.url);
  return readFileSync(require.resolve(specifier), "utf8");
};

interface FontPackageManifest {
  version?: unknown;
  license?: unknown;
  homepage?: unknown;
}

/**
 * Builds one notice from an installed font package.
 *
 * Every missing piece throws. A build that cannot state the license of a font
 * it is about to publish should stop, not publish the font with a gap where the
 * attribution belongs.
 */
export function readFontNotice(
  font: FontPackage,
  readFile: PackageFileReader = readPackageFile,
): FontNotice {
  const manifest = JSON.parse(readFile(`${font.packageName}/package.json`)) as FontPackageManifest;

  if (typeof manifest.version !== "string" || typeof manifest.license !== "string") {
    throw new Error(`${font.packageName} declares no version and license to attribute.`);
  }

  const text = readFile(`${font.packageName}/LICENSE`).trim();
  if (text.length === 0) {
    throw new Error(`${font.packageName} ships an empty LICENSE file.`);
  }

  return {
    ...font,
    version: manifest.version,
    license: manifest.license,
    homepage: typeof manifest.homepage === "string" ? manifest.homepage : null,
    text,
  };
}

/** Reads the notice for every redistributed font package. */
export function collectFontNotices(
  fonts: readonly FontPackage[] = REDISTRIBUTED_FONT_PACKAGES,
  readFile: PackageFileReader = readPackageFile,
): FontNotice[] {
  return fonts.map((font) => readFontNotice(font, readFile));
}

/** Where the notice is published, and what it should call the site. */
export interface FontNoticeDocumentOptions {
  /** Site name for the heading, e.g. `volli.app`. */
  siteName: string;
  /** The project's own license, linked so the two are not confused. */
  projectLicenseUrl: string;
}

const RULE = "=".repeat(78);

/**
 * Renders the published `/licenses.txt`.
 *
 * Plain text on purpose: it is the artifact a license audit or a mirror of this
 * site will read, it needs no stylesheet to stay legible, and it can be diffed.
 */
export function renderFontNoticeDocument(
  notices: readonly FontNotice[],
  options: FontNoticeDocumentOptions,
): string {
  const lines = [
    `Third-party font notices for ${options.siteName}`,
    "",
    "This site serves the fonts below from its own origin, so each deploy",
    "redistributes their font software. The copyright notice and full license",
    "text for every one of them follow, as their licenses require.",
    "",
    "Nothing here covers the rest of the site: Volli Code itself is licensed",
    `under Apache-2.0 (${options.projectLicenseUrl}).`,
    "",
    "Generated from the installed font packages at build time — never edited by",
    "hand, so it cannot drift from what the build actually ships.",
  ];

  for (const notice of notices) {
    lines.push(
      "",
      RULE,
      `${notice.family} — ${notice.packageName} ${notice.version}`,
      `SPDX-License-Identifier: ${notice.license}`,
      ...(notice.homepage === null ? [] : [`Upstream: ${notice.homepage}`]),
      RULE,
      "",
      notice.text,
    );
  }

  return `${lines.join("\n")}\n`;
}
