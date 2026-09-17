// The license notices that must travel with the web fonts a site serves.
//
// WHY THIS EXISTS. volli.app and docs.volli.app both self-host Mona Sans: each
// build copies the font binaries out of `@fontsource-variable/mona-sans` and
// emits them into `dist/_astro/`, so every deploy REDISTRIBUTES font software.
// Mona Sans is OFL-1.1, and clause 2 of that license lets a copy be bundled
// with any software only "provided that each copy contains the above copyright
// notice and this license". Shipping the .woff2 files with no notice beside
// them does not meet that condition.
//
// WHY IT IS A PACKAGE. Two sites owe the same notice and a third public surface
// would owe it too, so the rendering lives once, here, rather than in a copy per
// app. `apps/*/src/pages/licenses.txt.ts` is the thin per-site half: it names
// the fonts that site redistributes and supplies their manifest and LICENSE
// text, and this module turns that into the published document.
//
// WHY IT IS PURE. Nothing here touches `node:fs`, `createRequire`, Electron or
// the DOM — the same rule `packages/shared` carries in CLAUDE.md. Each site
// reads its own font package through its own bundler (`?raw` / JSON imports),
// which means resolution happens in the app that actually declares the
// dependency, and this module stays safe to import from any surface a future
// client/server split puts it in front of.
//
// The loop is closed from the other end by `check-dist.mjs` in this package,
// which re-reads the finished `dist/` and fails the build when font binaries
// shipped without a notice covering them. It deliberately shares no code with
// this module, so the two cannot agree with each other about a gap.

/** A font package whose binaries a site serves from its own origin. */
export interface FontPackage {
  /** Family name as a reader would recognise it, e.g. `Mona Sans`. */
  family: string;
  /** npm package that vendors the font files, e.g. `@fontsource-variable/mona-sans`. */
  packageName: string;
}

/**
 * A font package as the site's bundler handed it over: the parsed manifest and
 * the LICENSE file's bytes.
 *
 * `manifest` is `unknown` on purpose. It is third-party JSON that arrives
 * through an import the type system does not vouch for, so it is narrowed here
 * rather than trusted at the call site.
 */
export interface FontPackageSource extends FontPackage {
  /** The package's `package.json`, parsed. */
  manifest: unknown;
  /** The package's LICENSE file verbatim. */
  licenseText: string;
}

/** One rendered attribution: what the package is, and the notice it carries. */
export interface FontNotice extends FontPackage {
  /** Installed version of the font package, as the notice should cite it. */
  version: string;
  /** SPDX identifier the package declares, e.g. `OFL-1.1`. */
  license: string;
  /** Upstream page for the font, or null when the package names none. */
  homepage: string | null;
  /** The package's LICENSE file, trimmed: copyright line plus license text. */
  text: string;
}

function readString(manifest: Record<string, unknown>, field: string): string | null {
  const value = manifest[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Builds one notice from a font package the site is about to redistribute.
 *
 * Every missing piece throws, naming the field. A build that cannot state the
 * version or the license of a font it is about to publish should stop, not
 * publish the font with a gap where the attribution belongs — the gap is the
 * exact license breach this whole module exists to prevent, and it is invisible
 * in the built output unless something refuses to produce it.
 */
export function buildFontNotice(source: FontPackageSource): FontNotice {
  const { family, packageName, manifest, licenseText } = source;

  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error(`${packageName} has no readable package.json to attribute.`);
  }

  const fields = manifest as Record<string, unknown>;
  const version = readString(fields, "version");
  if (version === null) {
    throw new Error(`${packageName} declares no version to attribute.`);
  }

  const license = readString(fields, "license");
  if (license === null) {
    throw new Error(`${packageName} declares no license to attribute.`);
  }

  const text = licenseText.trim();
  if (text.length === 0) {
    throw new Error(`${packageName} ships an empty LICENSE file.`);
  }

  return { family, packageName, version, license, homepage: readString(fields, "homepage"), text };
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
 * Plain text on purpose: it is the artifact a license audit or a mirror of the
 * site will read, it needs no stylesheet to stay legible, and it can be diffed.
 *
 * Throws on an empty notice list. A site with no fonts never calls this; a site
 * that calls it and has nothing to say has lost its font list somewhere between
 * the import and here, and would otherwise publish a page that claims to carry
 * notices and carries none.
 */
export function renderFontNoticeDocument(
  notices: readonly FontNotice[],
  options: FontNoticeDocumentOptions,
): string {
  if (notices.length === 0) {
    throw new Error(`No font notices to publish for ${options.siteName}.`);
  }

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
    "Generated from the installed font packages at build time, never edited by",
    "hand, so it cannot drift from what the build actually ships.",
  ];

  for (const notice of notices) {
    lines.push(
      "",
      RULE,
      `${notice.family} (${notice.packageName} ${notice.version})`,
      `SPDX-License-Identifier: ${notice.license}`,
      ...(notice.homepage === null ? [] : [`Upstream: ${notice.homepage}`]),
      RULE,
      "",
      notice.text,
    );
  }

  return `${lines.join("\n")}\n`;
}
