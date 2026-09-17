#!/usr/bin/env node
/**
 * Generates docs/licensing/notice-inputs.md — the exact attribution text the
 * centralized notice files need, derived from the installed tree.
 *
 *     node apps/desktop/scripts/generate-license-notice-inputs.mjs          # write it
 *     node apps/desktop/scripts/generate-license-notice-inputs.mjs --check  # fail if stale
 *
 * WHY THIS EXISTS (VC-409). Shipping the notices is a different ticket. What
 * this ticket owes that one is INPUTS — and the inputs are the part that rots:
 * libvips bundles twenty-eight components under a dozen licenses, and both the
 * component list and their versions change with every `@img/sharp-libvips`
 * bump. A hand-typed list would be wrong by the next dependency update, and
 * wrong silently, because nothing reads a notice file.
 *
 * So the component data is copied out of the upstream package rather than
 * retyped: the license table from its README, the version list from its
 * versions.json, verbatim in both cases. `--check` runs in CI, so a libvips
 * bump that changes either one fails the build with this file named, instead
 * of leaving the notices quietly describing an older library.
 *
 * WHAT IT DELIBERATELY DOES NOT GENERATE: the full GPLv3 and LGPLv3 texts that
 * LGPLv3 section 4(b) requires be shipped. Those must be byte-verbatim
 * canonical copies from gnu.org, and a file this script assembled would be a
 * paraphrase with a license's name on it. The output names the two files and
 * where they must come from, and the review doc carries it as an open action.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(DESKTOP_ROOT, "../..");
const POLICY_PATH = resolve(HERE, "dependency-license-policy.json");
const OUT_PATH = resolve(REPO_ROOT, "docs/licensing/notice-inputs.md");

/** The LGPL package whose components the desktop app ships. */
const LIBVIPS_PACKAGE = "@img/sharp-libvips-darwin-arm64";

/**
 * Rows of the `| Library | Used under the terms of |` table in the libvips
 * package README — the upstream statement of what each bundled component is
 * licensed under. Parsed rather than retyped so it cannot drift from the
 * package actually installed.
 * @param {string} readme
 * @returns {Array<{ library: string, terms: string }>}
 */
export function parseComponentLicenseTable(readme) {
  const rows = [];
  for (const line of readme.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const cells = trimmed
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length !== 2) continue;
    // Skip the header and its `|---|---|` separator.
    if (/^-+$/.test(cells[0].replaceAll(":", ""))) continue;
    if (cells[0].toLowerCase() === "library") continue;
    rows.push({ library: cells[0], terms: cells[1] });
  }
  return rows;
}

/**
 * The components the table places under an LGPL. These are the ones that make
 * the whole dylib LGPL and that section 4(a) obliges us to name.
 * @param {Array<{ library: string, terms: string }>} rows
 */
export function lgplComponents(rows) {
  return rows.filter((row) => /\bLGPL/i.test(row.terms)).map((row) => row.library);
}

/** Markdown link syntax stripped back to its text, for a plain-text notice. */
export function flattenMarkdownLinks(text) {
  return text.replaceAll(/\[([^\]]*)\]\(([^)]*)\)/g, "$1 <$2>");
}

/**
 * The README's free prose about the LGPL, as whitespace-normalized paragraphs.
 *
 * Upstream uses it to say that the LGPLv3 terms are reached through the "any
 * later version" clause of LGPLv2/v2.1 — which a notice has to get right, and
 * which lives outside the table. Paragraphs are the unit rather than sentences:
 * the note is hard-wrapped across two lines, and a sentence splitter trips over
 * the version numbers in it ("LGPLv2.1.").
 * @param {string} readme
 * @returns {string[]}
 */
export function parseLicensingNotes(readme) {
  return readme
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim().replaceAll(/\s+/g, " "))
    .filter(
      (paragraph) =>
        paragraph.length > 0 &&
        !paragraph.startsWith("|") &&
        !paragraph.startsWith("#") &&
        /\bLGPL/.test(paragraph),
    );
}

/**
 * The whole document, as a pure function of the facts, so `--check` and the
 * writer cannot disagree about what "current" means.
 * @param {object} facts
 */
export function renderNoticeInputs(facts) {
  const { libvips, policy } = facts;
  const lgplNames = lgplComponents(libvips.componentLicenses);

  const lines = [];
  const push = (...text) => lines.push(...text);

  push(
    "<!-- GENERATED FILE — do not edit by hand.",
    "     Regenerate: node apps/desktop/scripts/generate-license-notice-inputs.mjs",
    "     Verified in CI: pnpm -C apps/desktop run check:notice-inputs -->",
    "",
    "# Notice inputs",
    "",
    "Attribution text for the centralized notice files, derived from the installed dependency",
    "tree. This file is an INPUT handoff, not a notice: nothing here ships as-is, and the",
    "tickets that own `apps/desktop/THIRD-PARTY-NOTICES` and the website's static notices decide",
    "the final wording and placement.",
    "",
    "Why it is generated: the component lists below change with every `@img/sharp-libvips` bump,",
    "and a notice that silently describes an older library is the failure mode this replaces.",
    "",
    "The reasoning, and the questions still open, are in `dependency-license-review.md`.",
    "",
  );

  // --- LGPL ---------------------------------------------------------------
  push(
    "## 1. LGPL — libvips, shipped inside the desktop app",
    "",
    `Package: \`${LIBVIPS_PACKAGE}@${libvips.version}\`  `,
    `SPDX: \`${libvips.license}\`  `,
    `Upstream: ${libvips.repository}  `,
    `Payload: \`${libvips.binary}\`, loaded at run time by \`@img/sharp-darwin-arm64\`'s native addon.`,
    "",
    "### 1a. Notice text (LGPLv3 sections 4(a) and 4(c))",
    "",
    "Section 4(a) wants prominent notice that the library is used and is covered by the LGPL;",
    "4(c) wants libvips named among any copyright notices the app shows while running.",
    "",
    "```text",
    "This application uses libvips, bundled as a prebuilt shared library together with its",
    "dependencies. libvips and several of the components it links are used under the terms of",
    "the GNU Lesser General Public License version 3 or later.",
    "",
    "Components used under an LGPL license:",
    ...lgplNames.map((name) => `  - ${name}`),
    "",
    "Copies of the GNU General Public License v3 and the GNU Lesser General Public License v3",
    "accompany this application. libvips itself is available from https://github.com/libvips/libvips",
    "and the prebuilt package from https://github.com/lovell/sharp-libvips.",
    "",
    "The library is dynamically linked and ships as a separate, unmodified file inside the",
    "application bundle, so it can be replaced with a compatible build.",
    "```",
    "",
    "### 1b. License texts that must accompany the app (LGPLv3 section 4(b))",
    "",
    "Section 4(b) requires a copy of BOTH documents. They are not in this repository and are not",
    "generated here on purpose — they must be byte-verbatim canonical copies, and a reflowed or",
    "paraphrased GPL is not a copy of it.",
    "",
    "| File to ship | Canonical source |",
    "| --- | --- |",
    "| `GPL-3.0.txt` | <https://www.gnu.org/licenses/gpl-3.0.txt> |",
    "| `LGPL-3.0.txt` | <https://www.gnu.org/licenses/lgpl-3.0.txt> |",
    "",
    `The \`${LIBVIPS_PACKAGE}\` package itself ships neither: its files are \`package.json\`,`,
    "`README.md`, `versions.json`, one header and the dylib. The README's component table is",
    "reproduced below because it is the only license statement the package carries.",
    "",
    "### 1c. Component licenses — verbatim from the package README",
    "",
    "| Library | Used under the terms of |",
    "| --- | --- |",
    ...libvips.componentLicenses.map(
      (row) => `| ${row.library} | ${flattenMarkdownLinks(row.terms)} |`,
    ),
    "",
    ...(libvips.licensingNotes.length > 0
      ? ["Also stated by the README:", "", ...libvips.licensingNotes.map((note) => `> ${note}`), ""]
      : []),
    "### 1d. Component versions — verbatim from the package versions.json",
    "",
    "| Component | Version |",
    "| --- | --- |",
    ...libvips.componentVersions.map(([name, version]) => `| ${name} | ${version} |`),
    "",
    "The two tables are reproduced side by side rather than joined: upstream keys them",
    "differently (`exif` against `libexif`, `vips` against `libvips`), and pairing them here",
    "would mean inventing a mapping upstream does not publish.",
    "",
  );

  // --- GSAP ---------------------------------------------------------------
  const gsap = policy.reviewed.gsap;
  push(
    "## 2. GSAP — bundled into the marketing website",
    "",
    `Package: \`gsap@${facts.gsapVersion}\`  `,
    `License: ${gsap.license}  `,
    "Terms read at <https://gsap.com/standard-license> (effective 2025-04-30).",
    "",
    "The operative notice already ships: GSAP's own `/*!` banners survive into the deployed",
    "bundles, which is what section III.3 protects. `apps/website/scripts/check-bundled-license-notices.mjs`",
    "holds them there. A static website notice, if one is added, needs only:",
    "",
    "```text",
    `GSAP ${facts.gsapVersion} — Copyright 2008-2026, GreenSock. All rights reserved.`,
    "Used under the GreenSock Standard License: https://gsap.com/standard-license",
    "```",
    "",
  );

  // --- Elected licenses ---------------------------------------------------
  const elected = Object.entries(policy.reviewed).filter(([, entry]) => entry.electedLicense);
  push(
    "## 3. Dual-licensed dependencies — the half Volli elected",
    "",
    "A notice reading only `MPL-2.0 OR Apache-2.0` leaves the reader to guess which set of terms",
    "applies. These entries state the election.",
    "",
    "| Package | Published as | Volli elects |",
    "| --- | --- | --- |",
    ...elected.map(
      ([name, entry]) => `| \`${name}\` | ${entry.license} | ${entry.electedLicense} |`,
    ),
    "",
  );

  // --- License read from elsewhere ----------------------------------------
  const offManifest = Object.entries(policy.reviewed).filter(([, entry]) => entry.licenseSource);
  push(
    "## 4. Dependencies whose license is not in their manifest",
    "",
    "Automated scanners report these as unlicensed. They are not — the license is simply somewhere",
    "a scanner does not look, so a notice generator must be told where to read it from.",
    "",
    "| Package | License | Read from |",
    "| --- | --- | --- |",
    ...offManifest.map(
      ([name, entry]) =>
        `| \`${name}\` | ${entry.license} | ${
          entry.licenseSource === "license-file"
            ? "the package's own `license` file"
            : "its parent package's manifest"
        } |`,
    ),
    "",
  );

  return `${lines.join("\n").replaceAll(/\n{3,}/g, "\n\n")}\n`;
}

/**
 * Where the libvips package lives, or `null` when this platform did not
 * install it.
 *
 * Deliberately the darwin-arm64 package by name and not "whichever
 * `@img/sharp-libvips-*` sibling is present": that is the one the packaged app
 * ships (electron-builder targets mac arm64 only), and every sibling would
 * render a slightly different document — which would make `--check` fail on
 * Linux for a file that is perfectly correct.
 */
function findLibvipsRoot() {
  const root = resolve(DESKTOP_ROOT, "node_modules", LIBVIPS_PACKAGE);
  return existsSync(resolve(root, "package.json")) ? root : null;
}

/** Everything the document is derived from, read off disk. */
function gatherFacts(libvipsRoot) {
  const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(libvipsRoot, "package.json"), "utf8"));
  const readme = readFileSync(resolve(libvipsRoot, "README.md"), "utf8");
  const versions = JSON.parse(readFileSync(resolve(libvipsRoot, "versions.json"), "utf8"));

  const licensingNotes = parseLicensingNotes(readme);

  return {
    policy,
    gsapVersion: JSON.parse(
      readFileSync(resolve(REPO_ROOT, "apps/website/node_modules/gsap/package.json"), "utf8"),
    ).version,
    libvips: {
      version: manifest.version,
      license: manifest.license,
      repository: manifest.repository?.url?.replace(/^git\+/, "") ?? "(none declared)",
      binary: manifest.exports?.["./binary"] ?? "(none declared)",
      componentLicenses: parseComponentLicenseTable(readme),
      componentVersions: Object.entries(versions).toSorted(([a], [b]) => a.localeCompare(b)),
      licensingNotes,
    },
  };
}

function main() {
  const checking = process.argv.includes("--check");

  const libvipsRoot = findLibvipsRoot();
  if (libvipsRoot === null) {
    // pnpm skips optional packages whose os/cpu do not match, so Linux CI has
    // no darwin binaries to read. Say so rather than regenerating from another
    // platform's sibling, which would rewrite the file into a different-but-
    // also-correct shape and leave the two platforms fighting over it.
    const message =
      `${LIBVIPS_PACKAGE} is not installed on this platform (${process.platform}-${process.arch}), ` +
      "so notice-inputs.md cannot be derived here. It is generated and verified on macOS arm64, " +
      "which is the only target the desktop app is built for.";
    if (checking) {
      console.log(`check-notice-inputs: skipped — ${message}`);
      return;
    }
    console.error(`Cannot generate: ${message}`);
    process.exit(1);
  }

  const rendered = renderNoticeInputs(gatherFacts(libvipsRoot));

  if (checking) {
    const existing = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, "utf8") : null;
    if (existing !== rendered) {
      console.error(
        `docs/licensing/notice-inputs.md is ${existing === null ? "missing" : "stale"}.\n` +
          "The dependency tree changed under it — regenerate and re-read the result:\n\n" +
          "  pnpm -C apps/desktop run licenses:notice-inputs\n",
      );
      process.exit(1);
    }
    console.log("check-notice-inputs: docs/licensing/notice-inputs.md is current.");
    return;
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, rendered);
  console.log(`Wrote ${OUT_PATH}`);
}

function selfTest() {
  const failures = [];
  const expect = (what, ok) => {
    if (!ok) failures.push(what);
  };

  const readme = [
    "| Library       | Used under the terms of |",
    "|---------------|-------------------------|",
    "| aom           | BSD 2-Clause + [AOM Patent License 1.0](https://aomedia.org/license/patent-license/) |",
    "| glib          | LGPLv3 |",
    "| libvips       | LGPLv3 |",
    "| cgif          | MIT License |",
    "",
    'Use of libraries under the terms of the LGPLv3 is via the "any later version" clause.',
  ].join("\n");

  const rows = parseComponentLicenseTable(readme);
  expect("parses every row", rows.length === 4);
  expect("drops the header", !rows.some((row) => row.library.toLowerCase() === "library"));
  expect("drops the separator", !rows.some((row) => /^-+$/.test(row.library)));
  expect("keeps the terms", rows[3].terms === "MIT License");
  expect("finds the LGPL components", lgplComponents(rows).join() === "glib,libvips");
  expect("ignores prose lines", parseComponentLicenseTable("not a table").length === 0);
  expect("ignores a three-column table", parseComponentLicenseTable("| a | b | c |").length === 0);

  const notes = parseLicensingNotes(readme);
  expect("finds the any-later-version note", notes.length === 1);
  expect(
    "unwraps the hard-wrapped note",
    notes[0] ===
      'Use of libraries under the terms of the LGPLv3 is via the "any later version" clause.',
  );
  expect("ignores table rows", parseLicensingNotes("| glib | LGPLv3 |").length === 0);
  expect("ignores headings", parseLicensingNotes("## LGPL stuff").length === 0);
  expect("ignores unrelated prose", parseLicensingNotes("Please report any errors.").length === 0);

  expect(
    "flattens a markdown link",
    flattenMarkdownLinks("[AOM](https://x/y)") === "AOM <https://x/y>",
  );
  expect("leaves plain text alone", flattenMarkdownLinks("MIT License") === "MIT License");

  const rendered = renderNoticeInputs({
    gsapVersion: "3.15.0",
    policy: {
      reviewed: {
        gsap: { license: "Standard 'no charge' license" },
        dompurify: { license: "(MPL-2.0 OR Apache-2.0)", electedLicense: "Apache-2.0" },
        khroma: { license: "MIT", licenseSource: "license-file" },
        "@yuku-parser/binding-darwin-arm64": { license: "MIT", licenseSource: "parent-package" },
      },
    },
    libvips: {
      version: "1.3.3",
      license: "LGPL-3.0-or-later",
      repository: "https://github.com/lovell/sharp-libvips.git",
      binary: "./lib/libvips-cpp.8.18.6.dylib",
      componentLicenses: rows,
      componentVersions: [["vips", "8.18.6"]],
      licensingNotes: [
        'Use of libraries under the terms of the LGPLv3 is via the "any later version" clause.',
      ],
    },
  });
  expect("names the LGPL components in the notice", rendered.includes("  - libvips"));
  expect(
    "keeps the GPL text requirement visible",
    rendered.includes("gnu.org/licenses/gpl-3.0.txt"),
  );
  expect(
    "records the elected license",
    rendered.includes("| `dompurify` | (MPL-2.0 OR Apache-2.0) | Apache-2.0 |"),
  );
  expect("explains a license-file read", rendered.includes("the package's own `license` file"));
  expect("explains a parent-package read", rendered.includes("its parent package's manifest"));
  expect("carries the component versions", rendered.includes("| vips | 8.18.6 |"));
  expect(
    "quotes the any-later-version note",
    rendered.includes("> Use of libraries under the terms of"),
  );
  expect(
    "states the gsap version",
    rendered.includes("GSAP 3.15.0 — Copyright 2008-2026, GreenSock."),
  );
  expect(
    "is deterministic",
    rendered ===
      renderNoticeInputs({
        gsapVersion: "3.15.0",
        policy: {
          reviewed: {
            gsap: { license: "Standard 'no charge' license" },
            dompurify: { license: "(MPL-2.0 OR Apache-2.0)", electedLicense: "Apache-2.0" },
            khroma: { license: "MIT", licenseSource: "license-file" },
            "@yuku-parser/binding-darwin-arm64": {
              license: "MIT",
              licenseSource: "parent-package",
            },
          },
        },
        libvips: {
          version: "1.3.3",
          license: "LGPL-3.0-or-later",
          repository: "https://github.com/lovell/sharp-libvips.git",
          binary: "./lib/libvips-cpp.8.18.6.dylib",
          componentLicenses: rows,
          componentVersions: [["vips", "8.18.6"]],
          licensingNotes: [
            'Use of libraries under the terms of the LGPLv3 is via the "any later version" clause.',
          ],
        },
      }),
  );

  if (failures.length > 0) {
    console.error("generate-license-notice-inputs self-test failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("generate-license-notice-inputs self-test passed");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else {
    main();
  }
}
