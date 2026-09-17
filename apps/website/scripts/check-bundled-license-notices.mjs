#!/usr/bin/env node
/**
 * Fails the website build when bundled third-party code ships without the
 * copyright notice its license requires us to keep.
 *
 *     node apps/website/scripts/check-bundled-license-notices.mjs             # the gate
 *     node apps/website/scripts/check-bundled-license-notices.mjs --self-test # the parser's own tests
 *
 * WHY THIS EXISTS (VC-409). GSAP is not MIT. It ships under the GreenSock
 * Standard "no charge" license, and section III.3 of that license lists
 * "Remove or alter any proprietary notices or branding from GSAP Products"
 * among the things a licensee may not do. Every GSAP ES module we bundle opens
 * with a `/*!` banner carrying the copyright line and a link to the terms, so
 * keeping those banners in the deployed JavaScript is how that clause is
 * satisfied — there is nothing else in the payload that names GreenSock.
 *
 * The banners were being stripped. A production build of this site shipped
 * ~70 KB of GSAP with zero occurrences of `gsap.com/standard-license` in any
 * chunk; `astro.config.mjs` now pins `comments.legal` to restore them. That
 * option is one toolchain default away from flipping back, and the failure is
 * silent — the site looks identical either way — so the build asserts the
 * outcome rather than trusting the setting.
 *
 * The check is deliberately two-sided:
 *   - every chunk that contains GSAP RUNTIME CODE must carry a GSAP banner, so
 *     a new chunk split cannot strand code away from its notice; and
 *   - the set of banner subjects across dist/ must equal {@link REVIEWED_GSAP_BANNERS}
 *     exactly, so adding a GSAP plugin (or dropping one) fails here and gets a
 *     look rather than sliding in unreviewed.
 *
 * A check of this shape fails by going vacuous — passing because it found
 * nothing to inspect. Both halves guard against that: an empty reviewed set is
 * only legal when `gsap` is no longer a dependency at all, and a dist/ with no
 * GSAP code present fails instead of passing quietly.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBSITE_ROOT = resolve(HERE, "..");

/**
 * The GSAP banner subjects this site is reviewed to ship, as they appear on
 * the first line of each `/*!` block. `matrix` is not something the site
 * imports by name — it is a Flip internal that carries its own banner, and it
 * is listed because the assertion below is set EQUALITY, not containment.
 *
 * Versions are deliberately absent: they are read from the installed `gsap`
 * package at run time, so a version bump cannot leave a stale literal here
 * asserting a notice for a version we no longer ship.
 */
export const REVIEWED_GSAP_BANNERS = ["GSAP", "CSSPlugin", "Flip", "matrix"];

/**
 * String literals that only appear when a chunk contains GSAP's own runtime,
 * chosen to survive minification (they are property and global names GSAP
 * reads by string, not identifiers a minifier may rename).
 *
 * `transformOrigin` and a bare `gsap` are NOT markers on purpose: our own
 * components call `gsap.set(el, { transformOrigin })`, so a chunk of site code
 * contains both while containing no GSAP code to attribute.
 */
export const GSAP_CODE_MARKERS = ["_gsap", "GreenSockGlobals", "gsapVersions"];

/** The license URL every GSAP banner points at — the notice's operative half. */
const GSAP_LICENSE_URL = "gsap.com/standard-license";
/** The copyright holder every GSAP banner names. */
const GSAP_COPYRIGHT_HOLDER = "GreenSock";

/**
 * Every `/*!` legal comment in `source`, in order. Only this comment form is
 * collected: it is the one convention bundlers agree marks a comment as legal
 * text rather than developer prose, and it is the form GSAP uses.
 * @param {string} source
 * @returns {string[]}
 */
export function extractLegalBanners(source) {
  return [...source.matchAll(/\/\*![\s\S]*?\*\//g)].map((match) => match[0]);
}

/**
 * The subject a banner announces — `GSAP 3.15.0` becomes
 * `{ subject: "GSAP", version: "3.15.0" }` — plus whether the banner still
 * carries the two things the license cares about. Returns `null` for a banner
 * whose first line is not a `<subject> <version>` headline, which is how a
 * non-GSAP legal comment (another library's) is passed over rather than
 * mis-read as a malformed GSAP one.
 * @param {string} banner
 * @returns {{ subject: string, version: string, hasLicenseUrl: boolean, hasCopyright: boolean } | null}
 */
export function describeBanner(banner) {
  const headline = banner
    .replace(/^\/\*!/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, "").trim())
    .find((line) => line.length > 0);
  if (headline === undefined) return null;
  const match = /^(\S+)\s+(\d+\.\d+\.\d+[^\s]*)$/.exec(headline);
  if (match === null) return null;
  return {
    subject: match[1],
    version: match[2],
    hasLicenseUrl: banner.includes(GSAP_LICENSE_URL),
    hasCopyright: banner.includes(GSAP_COPYRIGHT_HOLDER),
  };
}

/** Whether a chunk carries GSAP's own runtime rather than call sites into it. */
export function containsGsapRuntime(source) {
  return GSAP_CODE_MARKERS.some((marker) => source.includes(marker));
}

/**
 * The whole audit, as a pure function over already-read files so the self-test
 * can drive it without a build.
 *
 * @param {Array<{ path: string, source: string }>} files built JavaScript chunks
 * @param {{ gsapVersion: string | null, reviewedSubjects: readonly string[] }} context
 * @returns {string[]} one human-readable problem per finding; empty means clean
 */
export function auditBundledNotices(files, { gsapVersion, reviewedSubjects }) {
  const problems = [];

  if (gsapVersion === null) {
    // gsap is gone from the manifest. That is allowed — but only together with
    // an empty reviewed set, or this gate is asserting notices for code that is
    // no longer shipped and would pass on an empty dist/ forever.
    if (reviewedSubjects.length > 0) {
      problems.push(
        `gsap is no longer a dependency of @volli/website, but REVIEWED_GSAP_BANNERS still lists ` +
          `${reviewedSubjects.join(", ")}. Empty the list in the same change that drops the dependency.`,
      );
    }
    return problems;
  }

  const seen = new Map();
  for (const { path, source } of files) {
    // GSAP banners are identified by what they SAY, not by whether their
    // subject is one we expected. Selecting them by the reviewed list instead
    // would make the set-equality check below unable to see a subject that is
    // not on it — which is the half that catches a newly added plugin.
    const raw = extractLegalBanners(source).filter(
      (banner) => banner.includes(GSAP_COPYRIGHT_HOLDER) || banner.includes(GSAP_LICENSE_URL),
    );
    const gsapBanners = [];
    for (const banner of raw) {
      const described = describeBanner(banner);
      if (described === null) {
        problems.push(
          `${path} carries a GSAP legal comment with no readable "<subject> <version>" headline. ` +
            `A notice that cannot be read cannot be checked.`,
        );
        continue;
      }
      gsapBanners.push(described);
    }

    if (containsGsapRuntime(source) && gsapBanners.length === 0) {
      problems.push(
        `${path} bundles GSAP runtime code but carries no GSAP legal banner. The GreenSock ` +
          `Standard License (III.3) forbids removing its proprietary notices — check that ` +
          `astro.config.mjs still sets build.rollupOptions.output.comments.legal.`,
      );
    }

    for (const banner of gsapBanners) {
      seen.set(banner.subject, banner);
      if (banner.version !== gsapVersion) {
        problems.push(
          `${path} carries a "${banner.subject} ${banner.version}" banner, but the installed gsap ` +
            `is ${gsapVersion}. A notice naming a version we do not ship is a stale notice.`,
        );
      }
      if (!banner.hasLicenseUrl) {
        problems.push(`${path}: "${banner.subject}" banner no longer links ${GSAP_LICENSE_URL}.`);
      }
      if (!banner.hasCopyright) {
        problems.push(
          `${path}: "${banner.subject}" banner no longer names ${GSAP_COPYRIGHT_HOLDER}.`,
        );
      }
    }
  }

  for (const subject of reviewedSubjects) {
    if (!seen.has(subject)) {
      problems.push(
        `No "${subject}" legal banner survived into the built site. Either the build stripped it ` +
          `(see astro.config.mjs) or the site stopped bundling that module — if the latter, drop ` +
          `"${subject}" from REVIEWED_GSAP_BANNERS in the same change.`,
      );
    }
  }
  for (const subject of seen.keys()) {
    if (!reviewedSubjects.includes(subject)) {
      problems.push(
        `Unreviewed GSAP banner subject "${subject}" appeared in the built site. The site started ` +
          `bundling a GSAP module nobody has looked at — add it to REVIEWED_GSAP_BANNERS once its ` +
          `notice obligation has been checked.`,
      );
    }
  }

  return problems;
}

/** Every `.js` file under `dir`, recursively. */
function collectJavaScript(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectJavaScript(full));
    } else if (entry.endsWith(".js")) {
      found.push(full);
    }
  }
  return found;
}

/** The installed `gsap` version, or `null` when it is not a dependency. */
function installedGsapVersion() {
  const manifest = JSON.parse(readFileSync(resolve(WEBSITE_ROOT, "package.json"), "utf8"));
  if (manifest.dependencies?.gsap === undefined && manifest.devDependencies?.gsap === undefined) {
    return null;
  }
  const installed = JSON.parse(
    readFileSync(resolve(WEBSITE_ROOT, "node_modules/gsap/package.json"), "utf8"),
  );
  return installed.version;
}

function gate() {
  const distDir = resolve(WEBSITE_ROOT, "dist");
  const gsapVersion = installedGsapVersion();

  let files;
  try {
    files = collectJavaScript(distDir).map((path) => ({
      path: relative(WEBSITE_ROOT, path),
      source: readFileSync(path, "utf8"),
    }));
  } catch (error) {
    console.error(
      `check-bundled-license-notices: could not read ${distDir} — run the site build first.\n${error}`,
    );
    process.exit(1);
  }

  const problems = auditBundledNotices(files, {
    gsapVersion,
    reviewedSubjects: REVIEWED_GSAP_BANNERS,
  });

  if (problems.length > 0) {
    console.error("Bundled third-party license notices are not intact:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "\nSee docs/licensing/dependency-license-review.md for what each notice discharges.",
    );
    process.exit(1);
  }

  console.log(
    `check-bundled-license-notices: ${REVIEWED_GSAP_BANNERS.length} GSAP legal banners intact ` +
      `across ${files.length} built chunks (gsap ${gsapVersion}).`,
  );
}

function selfTest() {
  const failures = [];
  /** @param {string} what @param {boolean} ok */
  const expect = (what, ok) => {
    if (!ok) failures.push(what);
  };

  const realBanner = `/*!
 * Flip 3.15.0
 * https://gsap.com
 *
 * @license Copyright 2008-2026, GreenSock. All rights reserved.
 * Subject to the terms at https://gsap.com/standard-license
 * @author: Jack Doyle, jack@greensock.com
*/`;

  expect("extracts one banner", extractLegalBanners(`${realBanner}\nvar a=1;`).length === 1);
  expect("extracts none from bare code", extractLegalBanners("var a=1; /* plain */").length === 0);
  expect(
    "extracts two banners",
    extractLegalBanners(`${realBanner}\nvar a=1;\n${realBanner}`).length === 2,
  );

  const described = describeBanner(realBanner);
  expect("reads subject", described?.subject === "Flip");
  expect("reads version", described?.version === "3.15.0");
  expect("sees the license url", described?.hasLicenseUrl === true);
  expect("sees the copyright", described?.hasCopyright === true);
  // The minified form loses the leading space before `*`; it must still parse.
  expect(
    "reads a minified banner",
    describeBanner(realBanner.replaceAll("\n * ", "\n* "))?.subject === "Flip",
  );
  expect("ignores a non-headline banner", describeBanner("/*! not a headline */") === null);
  expect("ignores an empty banner", describeBanner("/*!*/") === null);

  expect("marker detected", containsGsapRuntime("el._gsap.x=1"));
  expect(
    "call sites are not runtime",
    !containsGsapRuntime('gsap.set(el,{transformOrigin:"0 0"})'),
  );

  const clean = auditBundledNotices(
    [{ path: "dist/gsap.js", source: `${realBanner}\nel._gsap;` }],
    { gsapVersion: "3.15.0", reviewedSubjects: ["Flip"] },
  );
  expect("clean bundle passes", clean.length === 0);

  const stripped = auditBundledNotices([{ path: "dist/gsap.js", source: "el._gsap;" }], {
    gsapVersion: "3.15.0",
    reviewedSubjects: ["Flip"],
  });
  expect("stripped banner is caught", stripped.length === 2);
  expect(
    "stripped banner names the chunk",
    stripped.some((p) => p.includes("carries no GSAP legal banner")),
  );

  const stale = auditBundledNotices(
    [{ path: "dist/gsap.js", source: `${realBanner}\nel._gsap;` }],
    { gsapVersion: "3.16.0", reviewedSubjects: ["Flip"] },
  );
  expect(
    "version drift is caught",
    stale.some((p) => p.includes("stale notice")),
  );

  const noUrl = auditBundledNotices(
    [
      {
        path: "dist/gsap.js",
        source: `/*!\n * Flip 3.15.0\n * Copyright 2008-2026, GreenSock.\n*/\nel._gsap;`,
      },
    ],
    { gsapVersion: "3.15.0", reviewedSubjects: ["Flip"] },
  );
  expect(
    "a banner that lost the license link is caught",
    noUrl.some((p) => p.includes("no longer links")),
  );

  const noHolder = auditBundledNotices(
    [
      {
        path: "dist/gsap.js",
        source: `/*!\n * Flip 3.15.0\n * https://gsap.com/standard-license\n*/\nel._gsap;`,
      },
    ],
    { gsapVersion: "3.15.0", reviewedSubjects: ["Flip"] },
  );
  expect(
    "a banner that lost the copyright holder is caught",
    noHolder.some((p) => p.includes("no longer names")),
  );

  const missingSubject = auditBundledNotices(
    [{ path: "dist/gsap.js", source: `${realBanner}\nel._gsap;` }],
    { gsapVersion: "3.15.0", reviewedSubjects: ["Flip", "ScrollTrigger"] },
  );
  expect(
    "a reviewed subject that never ships is caught",
    missingSubject.some((p) => p.includes('No "ScrollTrigger" legal banner')),
  );

  // The half that was unreachable until the banner filter stopped keying off
  // the reviewed list: a plugin added to the site arrives with its own banner.
  const addedPlugin = auditBundledNotices(
    [
      {
        path: "dist/gsap.js",
        source: `${realBanner}\n${realBanner.replace("Flip 3.15.0", "ScrollTrigger 3.15.0")}\nel._gsap;`,
      },
    ],
    { gsapVersion: "3.15.0", reviewedSubjects: ["Flip"] },
  );
  expect(
    "a newly bundled GSAP plugin is caught",
    addedPlugin.some((p) => p.includes('Unreviewed GSAP banner subject "ScrollTrigger"')),
  );

  const unreadable = auditBundledNotices(
    [
      {
        path: "dist/gsap.js",
        source: `/*! GreenSock, all rights reserved */\n${realBanner}\nel._gsap;`,
      },
    ],
    { gsapVersion: "3.15.0", reviewedSubjects: ["Flip"] },
  );
  expect(
    "an unreadable GSAP banner is caught",
    unreadable.some((p) => p.includes("no readable")),
  );

  // A non-GSAP legal comment is left alone rather than mis-read as a GSAP one.
  const otherLibrary = auditBundledNotices(
    [
      {
        path: "dist/gsap.js",
        source: `/*!\n * other-lib 1.2.3\n * MIT\n*/\n${realBanner}\nel._gsap;`,
      },
    ],
    { gsapVersion: "3.15.0", reviewedSubjects: ["Flip"] },
  );
  expect("another library's banner is ignored", otherLibrary.length === 0);

  const droppedDependency = auditBundledNotices([], {
    gsapVersion: null,
    reviewedSubjects: ["Flip"],
  });
  expect(
    "dropping gsap without emptying the list is caught",
    droppedDependency.length === 1 && droppedDependency[0].includes("no longer a dependency"),
  );
  expect(
    "dropping gsap and the list together is clean",
    auditBundledNotices([], { gsapVersion: null, reviewedSubjects: [] }).length === 0,
  );

  if (failures.length > 0) {
    console.error("check-bundled-license-notices self-test failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("check-bundled-license-notices self-test passed");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else {
    gate();
  }
}
