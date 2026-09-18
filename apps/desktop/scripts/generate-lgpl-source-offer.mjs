#!/usr/bin/env node
/**
 * Generates apps/desktop/licensing/LGPL-LIBVIPS.md — the LGPL notice and the
 * Corresponding Source directions that SHIP INSIDE the packaged app.
 *
 *     node apps/desktop/scripts/generate-lgpl-source-offer.mjs          # write it
 *     node apps/desktop/scripts/generate-lgpl-source-offer.mjs --check  # fail if stale
 *     node apps/desktop/scripts/generate-lgpl-source-offer.mjs --verify-sources
 *
 * WHY THIS EXISTS (VC-409). Volli Code ships a prebuilt libvips under the
 * LGPLv3. Section 4(d) requires that a user be able to run a modified version
 * of the library; taken through 4(d)(0), that means conveying the Minimal
 * Corresponding Source. GPLv3 section 6(d) — which 4(d)(0) reaches — allows
 * the source to sit on a third party's server, PROVIDED the object code is
 * accompanied by "clear directions" to it. This file is those directions.
 *
 * It is generated, not written, because every URL in it is a function of a
 * version number that changes with each `@img/sharp-libvips` bump. Directions
 * that point at a version we no longer ship are not directions to the
 * Corresponding Source of anything, and they would rot silently: nobody reads
 * a compliance file until the day it matters.
 *
 * WHAT IT IS NOT. Not a mirror. Section 6(d) obliges us to "ensure that it is
 * available for as long as needed", which is an ongoing duty, not a build
 * step: `--verify-sources` fetches every URL and reports the ones that have
 * gone. Run it when the dependency is bumped and when a release goes out. If
 * upstream ever disappears, that duty becomes a mirroring job, and this script
 * names exactly which tarballs would have to be mirrored.
 *
 * It also does not generate the GPL and LGPL license texts themselves — see
 * `licenseTexts` in dependency-license-policy.json for why, and for the gate
 * that keeps that gap honest.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { lgplComponents, parseComponentLicenseTable } from "./generate-license-notice-inputs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(HERE, "..");
const POLICY_PATH = resolve(HERE, "dependency-license-policy.json");
const OUT_PATH = resolve(DESKTOP_ROOT, "licensing/LGPL-LIBVIPS.md");

/** The LGPL package whose components the desktop app ships. */
const LIBVIPS_PACKAGE = "@img/sharp-libvips-darwin-arm64";
/** The policy entry those components are reviewed under. */
const POLICY_KEY = "@img/sharp-libvips-*";

// ---------------------------------------------------------------------------
// Pure matchers
// ---------------------------------------------------------------------------

/**
 * `2.89.4` -> `2.89`. GNOME's download server files a release under its
 * major.minor directory; upstream's build script calls this `without_patch`.
 * @param {string} version
 */
export function withoutPatch(version) {
  return version.replace(/\.[^.]*$/, "");
}

/**
 * `8.18.6-rc1` -> `8.18.6`. Upstream's `without_prerelease`: libvips tarballs
 * are named for the release even when the tag carries a prerelease suffix.
 * @param {string} version
 */
export function withoutPrerelease(version) {
  return version.replace(/-[\dA-Za-z]+$/, "");
}

/**
 * Fills a URL template from the policy with a concrete version.
 *
 * Throws on an unrecognised placeholder rather than emitting it literally: a
 * URL with `{minor}` still in it is a broken direction to source code, and
 * shipping one would be worse than shipping none, because it reads as though
 * someone checked.
 * @param {string} template
 * @param {{ version: string, packageVersion?: string }} values
 */
export function expandSourceUrl(template, values) {
  return template.replaceAll(/\{(\w+)\}/g, (_match, name) => {
    switch (name) {
      case "version":
        return values.version;
      case "minor":
        return withoutPatch(values.version);
      case "release":
        return withoutPrerelease(values.version);
      case "packageVersion":
        if (values.packageVersion === undefined) {
          throw new Error(`{packageVersion} is not available in this template: ${template}`);
        }
        return values.packageVersion;
      default:
        throw new Error(`Unknown placeholder {${name}} in template: ${template}`);
    }
  });
}

/**
 * Where the reviewed source directions and the installed library disagree.
 *
 * Three ways they can, and each one silently produces a wrong legal document:
 *   - upstream adds an LGPL component and nothing points at its source;
 *   - the record points at a component upstream no longer bundles;
 *   - a component is named but its version is not in versions.json, so the
 *     URL could not be filled in.
 * @param {{ lgplLibraries: string[], versions: Record<string, string>, components: Record<string, { library: string }> }} facts
 * @returns {string[]}
 */
export function correspondingSourceGaps(facts) {
  const gaps = [];
  const recordedLibraries = new Map(
    Object.entries(facts.components).map(([key, component]) => [component.library, key]),
  );

  for (const library of facts.lgplLibraries) {
    if (!recordedLibraries.has(library)) {
      gaps.push(
        `${library} is LGPL per the package README, but dependency-license-policy.json records ` +
          `no Corresponding Source for it. LGPLv3 4(d)(0) obliges us to convey source for every ` +
          `LGPL component we ship — read upstream's build script for where this one comes from.`,
      );
    }
  }
  for (const [library, key] of recordedLibraries) {
    if (!facts.lgplLibraries.includes(library)) {
      gaps.push(
        `dependency-license-policy.json records Corresponding Source for ${library}, which the ` +
          `installed package no longer lists as LGPL. Drop the entry, or correct it.`,
      );
    }
    if (facts.versions[key] === undefined) {
      gaps.push(
        `${library} is keyed "${key}" in the record, but versions.json has no such key, so no ` +
          `version could be filled into its source URL. Upstream renamed it, or the key is wrong.`,
      );
    }
  }
  return gaps.toSorted();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Builds the rows of the source table: one per LGPL component, plus the build
 * recipe, each with the exact URL its source is fetched from.
 * @param {{ packageVersion: string, versions: Record<string, string>, correspondingSource: any }} facts
 */
export function sourceRows(facts) {
  const { components, buildRecipe } = facts.correspondingSource;
  const rows = Object.entries(components)
    .map(([key, component]) => ({
      library: component.library,
      version: facts.versions[key],
      url: expandSourceUrl(component.url, { version: facts.versions[key] }),
      patches: component.patches ?? [],
    }))
    .toSorted((a, b) => a.library.localeCompare(b.library));

  return {
    rows,
    recipe: {
      name: buildRecipe.name,
      version: facts.packageVersion,
      url: expandSourceUrl(buildRecipe.url, {
        version: facts.packageVersion,
        packageVersion: facts.packageVersion,
      }),
      note: buildRecipe.note,
    },
  };
}

/**
 * The shipped document.
 * @param {any} facts
 */
export function renderSourceOffer(facts) {
  const { rows, recipe } = sourceRows(facts);
  const lines = [];

  lines.push(
    "<!-- GENERATED FILE — do not edit by hand.",
    "     Regenerate: node apps/desktop/scripts/generate-lgpl-source-offer.mjs",
    "     Verified in CI: pnpm -C apps/desktop run check:lgpl-source",
    "",
    "     This file SHIPS INSIDE the application bundle (Contents/Resources/licensing).",
    "     It is not an internal note: it is the notice and the source directions that",
    "     LGPLv3 section 4 requires accompany the binary. -->",
    "",
    "# libvips and the GNU Lesser General Public License",
    "",
    `Volli Code ${facts.appVersion} includes **libvips**, bundled together with its own`,
    "dependencies as a single prebuilt shared library:",
    "",
    `    ${facts.binary}`,
    "",
    `It is supplied by the npm package \`${LIBVIPS_PACKAGE}@${facts.packageVersion}\`,`,
    `published under **${facts.license}**, and built from`,
    `<${facts.repository}>.`,
    "",
    "## The components covered by the LGPL",
    "",
    "libvips itself and the following bundled components are used under the terms of the GNU",
    "Lesser General Public License, version 3 or later. Upstream reaches LGPLv3 for some of",
    "them through the \u201cany later version\u201d clause of the LGPLv2 or LGPLv2.1.",
    "",
  );

  for (const library of facts.lgplLibraries) lines.push(`  - ${library}`);

  lines.push(
    "",
    "The other components in the same library are under permissive licenses; they are listed,",
    "with their terms, in the application\u2019s third-party notices.",
    "",
    ...(facts.licenseTextsShipped
      ? [
          "## The license itself",
          "",
          "Verbatim copies of both documents the LGPL requires accompany this application, in this",
          "same folder:",
          "",
          ...facts.licenseTextFiles.map((file) => `  - ${file}`),
          "",
        ]
      : []),
    "## Getting the source code",
    "",
    "The LGPL gives you the right to the source of the LGPL-covered parts, so that you can study,",
    "modify and rebuild them. Every component below is fetched from the address shown, by the",
    "build script listed at the end, at exactly the version shown.",
    "",
    "| Component | Version | Source |",
    "| --- | --- | --- |",
  );

  for (const row of rows) lines.push(`| ${row.library} | ${row.version} | <${row.url}> |`);

  lines.push(
    "",
    "The library is **not** compiled from those tarballs unmodified, so the tarballs alone are not",
    `the whole of the source. It is built by the ${recipe.name}, version ${recipe.version}:`,
    "",
    `  <${recipe.url}>`,
    "",
    "You need that as well: it carries the configure flags, the source edits applied during the",
    "build, and the exact way the components are linked together into one library.",
  );

  const patched = rows.filter((row) => row.patches.length > 0);
  if (patched.length > 0) {
    lines.push(
      "",
      "These components are patched before they are compiled. The patches are part of the source",
      "you are entitled to, and are applied by the build script above:",
      "",
    );
    for (const row of patched) {
      for (const patch of row.patches) lines.push(`  - ${row.library}: <${patch}>`);
    }
  }

  lines.push(
    "",
    "### If any of those addresses has gone",
    "",
    "They are third-party servers, and the obligation to keep the source reachable is ours, not",
    "theirs. If a link above is dead, ask us and we will supply the Corresponding Source for the",
    "version you have, on a medium customarily used for software interchange:",
    "",
    `  <${facts.sourceContact}>`,
    "",
    "This offer is valid for anyone who has a copy of this software, for as long as we distribute",
    "this version of it, and for at least three years after we stop.",
    "",
    "## Running your own build of libvips",
    "",
    "Section 4(d) of the LGPL is not only about source: you are entitled to run a **modified**",
    "libvips inside this application. The library ships as a separate, unmodified, replaceable",
    "file for that reason \u2014 it is not sealed inside the application archive.",
    "",
    "macOS puts one obstacle in the way, and we have documented how to get past it rather than",
    "removing the protection that causes it. See **RELINK-LIBVIPS.md**, beside this file, and the",
    "script it describes.",
    "",
  );

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Facts, and the entry points
// ---------------------------------------------------------------------------

function findLibvipsRoot() {
  const root = resolve(DESKTOP_ROOT, "node_modules", LIBVIPS_PACKAGE);
  return existsSync(resolve(root, "package.json")) ? root : null;
}

/** @param {string} libvipsRoot */
function gatherFacts(libvipsRoot) {
  const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
  const entry = policy.reviewed[POLICY_KEY];
  const manifest = JSON.parse(readFileSync(resolve(libvipsRoot, "package.json"), "utf8"));
  const readme = readFileSync(resolve(libvipsRoot, "README.md"), "utf8");
  const versions = JSON.parse(readFileSync(resolve(libvipsRoot, "versions.json"), "utf8"));
  const appManifest = JSON.parse(readFileSync(resolve(DESKTOP_ROOT, "package.json"), "utf8"));

  return {
    appVersion: appManifest.version,
    packageVersion: manifest.version,
    license: manifest.license,
    repository: manifest.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, "") ?? "",
    binary: manifest.exports?.["./binary"]?.replace(/^\.\//, "") ?? "(none declared)",
    // Read from the same record `check:licenses` holds to the filesystem and to
    // the files' hashes, so this document cannot tell a user the license texts
    // are beside it while the gate knows they are not.
    licenseTextsShipped: entry.shippedCompliance.licenseTexts.state === "shipped",
    licenseTextFiles: entry.shippedCompliance.licenseTexts.expected.map((text) =>
      text.file.replace(/^licensing\//, ""),
    ),
    lgplLibraries: lgplComponents(parseComponentLicenseTable(readme)),
    versions,
    correspondingSource: entry.correspondingSource,
    sourceContact: entry.correspondingSource.contact,
  };
}

async function verifySources() {
  const libvipsRoot = findLibvipsRoot();
  if (libvipsRoot === null) {
    console.error(`${LIBVIPS_PACKAGE} is not installed here; nothing to verify.`);
    process.exit(1);
  }
  const facts = gatherFacts(libvipsRoot);
  const { rows, recipe } = sourceRows(facts);
  const targets = [{ what: recipe.name, url: recipe.url }];
  for (const row of rows) {
    targets.push({ what: row.library, url: row.url });
    // Patches count: without them the tarballs are not the Corresponding
    // Source of the library we actually ship.
    for (const patch of row.patches) targets.push({ what: `${row.library} patch`, url: patch });
  }

  const gone = [];
  for (const target of targets) {
    let status;
    try {
      // GET, not HEAD: several of these hosts answer HEAD with 403 or 405
      // while serving the file perfectly well, and a check that reports a
      // reachable tarball as missing gets switched off within a week.
      const response = await fetch(target.url, { redirect: "follow" });
      status = response.status;
      await response.body?.cancel();
    } catch (error) {
      status = `network error: ${error instanceof Error ? error.message : String(error)}`;
    }
    const ok = status === 200;
    console.log(`  ${ok ? "ok  " : "GONE"}  ${String(status).padEnd(14)} ${target.what}`);
    if (!ok) gone.push(`${target.what}: ${target.url} (${status})`);
  }

  if (gone.length > 0) {
    console.error(
      `\n${gone.length} of ${targets.length} Corresponding Source addresses are unreachable:\n`,
    );
    for (const entry of gone) console.error(`  - ${entry}`);
    console.error(
      "\nGPLv3 section 6(d) leaves the duty to keep source available with us, not with the host. " +
        "Mirror the missing tarballs somewhere we control and repoint the record at the mirror.",
    );
    process.exit(1);
  }
  console.log(`\nAll ${targets.length} Corresponding Source addresses are reachable.`);
}

function main() {
  if (process.argv.includes("--verify-sources")) return verifySources();

  const checking = process.argv.includes("--check");
  const libvipsRoot = findLibvipsRoot();
  if (libvipsRoot === null) {
    // Same reasoning as notice-inputs: pnpm skips optional packages whose
    // os/cpu do not match, so Linux CI has no darwin binary to read.
    const message =
      `${LIBVIPS_PACKAGE} is not installed on this platform (${process.platform}-${process.arch}), ` +
      "so the LGPL source offer cannot be derived here. It is generated and verified on macOS " +
      "arm64, the only target the desktop app is built for.";
    if (checking) {
      console.log(`check-lgpl-source: skipped — ${message}`);
      return;
    }
    console.error(`Cannot generate: ${message}`);
    process.exit(1);
  }

  const facts = gatherFacts(libvipsRoot);

  const gaps = correspondingSourceGaps({
    lgplLibraries: facts.lgplLibraries,
    versions: facts.versions,
    components: facts.correspondingSource.components,
  });
  if (gaps.length > 0) {
    console.error("\nThe recorded Corresponding Source no longer matches the installed library:\n");
    for (const gap of gaps) console.error(`  - ${gap}`);
    console.error(
      "\nThe record is the correspondingSource block of apps/desktop/scripts/" +
        "dependency-license-policy.json. Its templates are read out of upstream's own build " +
        "script — see the provenance note there before changing one.\n",
    );
    process.exit(1);
  }

  const rendered = renderSourceOffer(facts);

  if (checking) {
    const existing = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, "utf8") : null;
    if (existing !== rendered) {
      console.error(
        `apps/desktop/licensing/LGPL-LIBVIPS.md is ${existing === null ? "missing" : "stale"}.\n` +
          "It ships inside the application as the LGPL notice and source directions, so a stale " +
          "copy is a false statement to a user, not an untidy file. Regenerate it:\n\n" +
          "  pnpm -C apps/desktop run licenses:lgpl-source\n",
      );
      process.exit(1);
    }
    console.log("check-lgpl-source: apps/desktop/licensing/LGPL-LIBVIPS.md is current.");
    return;
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, rendered);
  console.log(`Wrote ${OUT_PATH}`);
}

function selfTest() {
  const failures = [];
  /** @param {string} what @param {boolean} ok */
  const expect = (what, ok) => {
    if (!ok) failures.push(what);
  };

  // --- version transforms, matching upstream's own helpers ---
  expect("drops the patch component", withoutPatch("2.89.4") === "2.89");
  expect("drops the patch component of a two-part version", withoutPatch("0.5") === "0");
  expect("leaves a release version alone", withoutPrerelease("8.18.6") === "8.18.6");
  expect("drops a prerelease suffix", withoutPrerelease("8.18.6-rc1") === "8.18.6");

  // --- URL expansion ---
  expect(
    "fills {version}",
    expandSourceUrl("https://x/v{version}/f-{version}.tar.xz", { version: "1.0.16" }) ===
      "https://x/v1.0.16/f-1.0.16.tar.xz",
  );
  expect(
    "fills {minor} with the GNOME directory",
    expandSourceUrl("https://d/sources/glib/{minor}/glib-{version}.tar.xz", {
      version: "2.89.4",
    }) === "https://d/sources/glib/2.89/glib-2.89.4.tar.xz",
  );
  expect(
    "fills {release}",
    expandSourceUrl("https://x/v{version}/vips-{release}.tar.xz", { version: "8.18.6-rc1" }) ===
      "https://x/v8.18.6-rc1/vips-8.18.6.tar.xz",
  );
  expect(
    "fills {packageVersion} when it is supplied",
    expandSourceUrl("https://x/v{packageVersion}.tar.gz", {
      version: "8.18.6",
      packageVersion: "1.3.3",
    }) === "https://x/v1.3.3.tar.gz",
  );
  // A template that silently kept its braces would ship a dead link in a legal
  // notice, which is the one failure mode this whole file exists to prevent.
  expect(
    "refuses an unknown placeholder",
    (() => {
      try {
        expandSourceUrl("https://x/{nope}", { version: "1" });
        return false;
      } catch {
        return true;
      }
    })(),
  );
  expect(
    "refuses {packageVersion} where it is not available",
    (() => {
      try {
        expandSourceUrl("https://x/{packageVersion}", { version: "1" });
        return false;
      } catch {
        return true;
      }
    })(),
  );

  // --- coverage against the installed library ---
  const covered = {
    lgplLibraries: ["glib", "libvips"],
    versions: { glib: "2.89.4", vips: "8.18.6" },
    components: { glib: { library: "glib" }, vips: { library: "libvips" } },
  };
  expect(
    "passes a record that covers every LGPL component",
    correspondingSourceGaps(covered).length === 0,
  );
  expect(
    "catches an LGPL component with no recorded source",
    correspondingSourceGaps({ ...covered, lgplLibraries: ["glib", "libvips", "pango"] }).some(
      (gap) => gap.includes("pango") && gap.includes("no Corresponding Source"),
    ),
  );
  expect(
    "catches a recorded component upstream dropped",
    correspondingSourceGaps({ ...covered, lgplLibraries: ["glib"] }).some((gap) =>
      gap.includes("libvips"),
    ),
  );
  expect(
    "catches a key that versions.json does not have",
    correspondingSourceGaps({ ...covered, versions: { glib: "2.89.4" } }).some((gap) =>
      gap.includes('keyed "vips"'),
    ),
  );

  // --- the rendered document ---
  const offerFixture = {
    appVersion: "0.1.2",
    packageVersion: "1.3.3",
    license: "LGPL-3.0-or-later",
    repository: "https://github.com/lovell/sharp-libvips",
    binary: "lib/libvips-cpp.8.18.6.dylib",
    lgplLibraries: ["glib", "libvips"],
    versions: { glib: "2.89.4", vips: "8.18.6" },
    sourceContact: "source@volli.app",
    licenseTextsShipped: true,
    licenseTextFiles: ["GPL-3.0.txt", "LGPL-3.0.txt"],
    correspondingSource: {
      buildRecipe: {
        name: "sharp-libvips build scripts",
        url: "https://github.com/lovell/sharp-libvips/archive/refs/tags/v{packageVersion}.tar.gz",
        note: "The recipe.",
      },
      components: {
        glib: {
          library: "glib",
          url: "https://download.gnome.org/sources/glib/{minor}/glib-{version}.tar.xz",
          patches: ["https://example.invalid/glib.patch"],
        },
        vips: {
          library: "libvips",
          url: "https://github.com/libvips/libvips/releases/download/v{version}/vips-{release}.tar.xz",
        },
      },
    },
  };
  const rendered = renderSourceOffer(offerFixture);
  expect("states the license", rendered.includes("LGPL-3.0-or-later"));
  expect("names the shipped binary", rendered.includes("lib/libvips-cpp.8.18.6.dylib"));
  expect(
    "names every LGPL component",
    rendered.includes("- glib") && rendered.includes("- libvips"),
  );
  expect(
    "gives a filled-in source URL",
    rendered.includes("https://download.gnome.org/sources/glib/2.89/glib-2.89.4.tar.xz"),
  );
  expect(
    "gives the build recipe at the package version",
    rendered.includes("https://github.com/lovell/sharp-libvips/archive/refs/tags/v1.3.3.tar.gz"),
  );
  expect("lists the patches", rendered.includes("https://example.invalid/glib.patch"));
  expect("carries the written offer contact", rendered.includes("source@volli.app"));
  expect("points at the relink instructions", rendered.includes("RELINK-LIBVIPS.md"));
  expect("names the license texts beside it", rendered.includes("GPL-3.0.txt"));
  // A user reads this file to find out what their rights are and where the
  // documents are. It must not point at texts that are not there.
  expect(
    "and says nothing about them when they do not ship",
    !renderSourceOffer({ ...offerFixture, licenseTextsShipped: false }).includes("GPL-3.0.txt"),
  );
  expect("leaves no unfilled placeholder", !/\{\w+\}/.test(rendered));

  if (failures.length > 0) {
    console.error("generate-lgpl-source-offer --self-test failures:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("generate-lgpl-source-offer --self-test: all assertions pass.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else {
    await main();
  }
}
