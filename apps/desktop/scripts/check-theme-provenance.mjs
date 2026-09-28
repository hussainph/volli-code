/**
 * Fails when the vendored Ghostty theme catalog and its license notice stop
 * describing the same material.
 *
 *     node apps/desktop/scripts/check-theme-provenance.mjs             # the gate
 *     node apps/desktop/scripts/check-theme-provenance.mjs --self-test # the matchers' own tests
 *
 * WHY THIS EXISTS. `packages/shared/src/ghostty-theme-sources.generated.ts` is
 * 463 third-party theme files copied verbatim out of an installed Ghostty.app
 * and redistributed with the app. `packages/shared/THIRD-PARTY-THEMES.md` is
 * the only place the chain behind them is written down — Ghostty release ->
 * `build.zig.zon` -> an iTerm2-Color-Schemes release -> MIT — and every link in
 * it was established by hand against sources that had to be fetched. None of
 * that is re-derivable by a machine, so without a check nothing notices when
 * the two drift apart.
 *
 * The drift that matters is not cosmetic. Regenerating against a newer Ghostty
 * silently swaps the material while the notice goes on naming `1.3.0` and
 * `release-20260216-151611-fc73ce3` — provenance that is confidently wrong,
 * pointing at a real tarball that no longer holds what we ship. That is worse
 * than no provenance at all, and it is the cheapest mistake in this repo to
 * make: one `node generate-ghostty-themes.mjs` after a brew upgrade.
 *
 * WHY A CHECK AND NOT A UNIT TEST. Two reasons. The subject lives in
 * `@volli/shared`, which is pure domain code with no Node types by design
 * (CLAUDE.md) — a test there cannot read a file. And this reads only checked-in
 * bytes, so unlike `generate-ghostty-themes.mjs --check` (which needs a real
 * Ghostty.app and therefore cannot run in Linux CI) it runs everywhere, beside
 * `check:theme-css` and `check:design-tokens`.
 *
 * WHAT IT DOES NOT ASSERT is the per-theme licenses. That question is open
 * upstream, is recorded in the notice as a blocker, and a check that asserted
 * an answer would be inventing one.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "../../..");

const CATALOG = resolvePath(REPO_ROOT, "packages/shared/src/ghostty-theme-sources.generated.ts");
const NOTICE = resolvePath(REPO_ROOT, "packages/shared/THIRD-PARTY-THEMES.md");

/**
 * Every theme name in the generated catalog.
 *
 * Both key spellings, because the repo formatter runs over the generated file
 * and unquotes any key that is a valid identifier — `"Aardvark Blue":` stays
 * quoted, `Abernathy:` does not. A quoted-only matcher reads 279 of the 463 and
 * would have let a third of the catalog through unchecked.
 */
export function catalogThemes(source) {
  const entries = source.matchAll(/^ {2}(?:"((?:[^"\\\n]|\\.)*)"|([A-Za-z_$][\w$]*)):/gm);
  return [...entries].map(([, quoted, bare]) => (bare === undefined ? unescape(quoted) : bare));
}

function unescape(literal) {
  return JSON.parse(`"${literal}"`);
}

/** The generated file's header — everything above the first line of data. */
export function catalogHeader(source) {
  const end = source.indexOf("export const");
  return end === -1 ? "" : source.slice(0, end);
}

/** The one Ghostty release the notice pins the whole chain to, or null. */
export function pinnedRelease(notice) {
  const row = /Ghostty\.app \*\*([\d.]+)\*\* \(`CFBundleVersion` (\d+)\), (\d+) theme files/.exec(
    notice,
  );
  return row === null ? null : { version: row[1], build: row[2], themes: Number(row[3]) };
}

/**
 * Theme names the notice registers as known license conflicts.
 *
 * Scoped to the one paragraph that lists them rather than swept from the whole
 * file: elsewhere the notice discusses the `Monokai Pro*` family as a pattern,
 * and a sweep reads that prose as another theme. Narrowing it also gives the
 * register one home — a name mentioned anywhere else does not quietly count as
 * declared.
 */
export function registeredConflicts(notice) {
  const paragraph = /The catalog Volli vendors contains[\s\S]*?\n\n/.exec(notice)?.[0] ?? "";
  return [...new Set([...paragraph.matchAll(/`([^`\n]+)`/g)].map(([, name]) => name))];
}

/**
 * The reproduced MIT license, and only it.
 *
 * The notice also *quotes* the collection-scope caveat as a blockquote while
 * making its argument, so a whole-file search for any line of the license
 * succeeds just as happily when the license itself has been trimmed and only
 * the quotation survives. MIT asks for the text to travel with the copy, so the
 * text is what gets checked.
 */
export function reproducedLicense(notice) {
  const fences = [...notice.matchAll(/```text\n([\s\S]*?)```/g)].map(([, body]) => body);
  return fences.find((fence) => fence.includes("MIT License")) ?? "";
}

/** Every way the catalog and the notice can disagree, as reader-facing lines. */
export function disagreements(catalog, notice) {
  const problems = [];
  const pinned = pinnedRelease(notice);

  if (pinned === null) {
    // Everything below reads through this row. Bailing out loudly beats
    // reporting eight derived failures, or — worse — passing them vacuously.
    return [
      "THIRD-PARTY-THEMES.md no longer pins a Ghostty release in its provenance table.",
      "  Expected a row like: | Which is | Ghostty.app **1.3.0** (`CFBundleVersion` 15112), 463 theme files |",
    ];
  }

  const header = catalogHeader(catalog);
  const themes = catalogThemes(catalog);
  const stamp = `Ghostty version: ${pinned.version} (CFBundleVersion ${pinned.build})`;

  if (!header.includes(stamp)) {
    problems.push(
      `The catalog was not generated from the Ghostty release the notice documents.`,
      `  notice pins:      ${stamp}`,
      `  catalog header:   ${/Ghostty version: .*/.exec(header)?.[0] ?? "(no version stamp)"}`,
      `  Re-walk build.zig.zon to the new iTerm2-Color-Schemes release and update the notice.`,
    );
  }

  if (themes.length !== pinned.themes) {
    problems.push(
      `The catalog holds ${themes.length} themes; the notice describes ${pinned.themes}.`,
    );
  }

  if (!header.includes(`(${themes.length} files`)) {
    problems.push(
      `The catalog header's theme count disagrees with the entries below it (${themes.length}).`,
    );
  }

  for (const marker of ["THIRD-PARTY MATERIAL", "packages/shared/THIRD-PARTY-THEMES.md"]) {
    if (!header.includes(marker)) {
      problems.push(`The catalog header no longer carries "${marker}" — regenerate it.`);
    }
  }

  const conflicts = registeredConflicts(notice);
  if (conflicts.length === 0) {
    problems.push("The notice's known-conflict paragraph no longer parses; nothing is registered.");
  }
  for (const name of conflicts) {
    if (!themes.includes(name)) {
      problems.push(
        `The notice names "${name}" as a known conflict, but the catalog has no such theme.`,
      );
    }
  }
  for (const name of themes.filter((theme) => theme.startsWith("Monokai Pro"))) {
    if (!conflicts.includes(name)) {
      problems.push(
        `The catalog ships "${name}", which the notice does not register as a known conflict.`,
      );
    }
  }

  const license = reproducedLicense(notice);
  const required = [
    "Copyright (c) 2011 to Present Mark Badolato",
    "Permission is hereby granted, free of charge",
    'THE SOFTWARE IS PROVIDED "AS IS"',
    // Without this pair the MIT text reads as though it licensed all 463
    // themes, which is the exact misreading the open question turns on.
    "This license covers the iTerm-Color-Schemes repository collection of themes.",
    "The copyright/license for each individual theme belongs to the author of that theme.",
  ];
  for (const clause of required) {
    if (!license.includes(clause)) {
      problems.push(`The reproduced MIT license is missing: ${JSON.stringify(clause)}`);
    }
  }

  return problems;
}

function main() {
  const problems = disagreements(readFileSync(CATALOG, "utf8"), readFileSync(NOTICE, "utf8"));
  if (problems.length > 0) {
    console.error("Ghostty theme provenance is stale:\n");
    for (const line of problems) console.error(`  ${line}`);
    console.error("\nSee packages/shared/THIRD-PARTY-THEMES.md.");
    process.exit(1);
  }
  console.log("Ghostty theme provenance: catalog and notice agree.");
}

function selfTest() {
  const catalog = readFileSync(CATALOG, "utf8");
  const notice = readFileSync(NOTICE, "utf8");

  const cases = [
    ["the checked-in pair agrees", catalog, notice, false],
    [
      "notice pinned to a different Ghostty release",
      catalog,
      notice.replace("Ghostty.app **1.3.0**", "Ghostty.app **1.4.0**"),
      true,
    ],
    [
      "catalog regenerated against a newer Ghostty",
      catalog.replace("Ghostty version: 1.3.0", "Ghostty version: 1.4.0"),
      notice,
      true,
    ],
    [
      "theme count drifts in the notice",
      catalog,
      notice.replace("), 463 theme files", "), 460 theme files"),
      true,
    ],
    [
      "a registered conflict dropped from the notice",
      catalog,
      notice.replace("`Monokai Pro Octagon`, ", ""),
      true,
    ],
    [
      "the catalog's pointer back to the notice removed",
      catalog.replace("packages/shared/THIRD-PARTY-THEMES.md", "(removed)"),
      notice,
      true,
    ],
    [
      // The failure a whole-file search would miss: the caveat survives as the
      // blockquote above while the reproduced license loses it.
      "the collection-scope caveat trimmed from the reproduced license",
      catalog,
      notice.replace(
        /^The copyright\/license for each individual theme belongs to the author of that theme\.$/m,
        "",
      ),
      true,
    ],
    [
      "the MIT warranty clause gutted",
      catalog,
      notice.replace(/^THE SOFTWARE IS PROVIDED "AS IS".*$/m, ""),
      true,
    ],
    [
      "the provenance table reworded past recognition",
      catalog,
      notice.replace(
        "Ghostty.app **1.3.0** (`CFBundleVersion` 15112), 463 theme files",
        "see above",
      ),
      true,
    ],
  ];

  let failures = 0;
  for (const [name, catalogText, noticeText, shouldFail] of cases) {
    const problems = disagreements(catalogText, noticeText);
    if (problems.length > 0 !== shouldFail) {
      failures += 1;
      console.error(
        `FAIL ${name}\n  expected ${shouldFail ? "a failure" : "no failure"}, got [${problems.join(" | ")}]`,
      );
    }
  }

  // The matchers' own floor: a parse that silently returns nothing would make
  // every case above pass for the wrong reason.
  const themes = catalogThemes(catalog);
  if (themes.length !== 463) {
    failures += 1;
    console.error(`FAIL catalog parse\n  expected 463 themes, got ${themes.length}`);
  }
  if (!themes.includes("Abernathy")) {
    failures += 1;
    console.error("FAIL catalog parse\n  unquoted keys are not being read");
  }
  if (registeredConflicts(notice).length !== 8) {
    failures += 1;
    console.error(
      `FAIL conflict register\n  expected 8 names, got ${registeredConflicts(notice).length}`,
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} self-test case(s) failed.`);
    process.exit(1);
  }
  console.log(`Theme-provenance matchers: ${cases.length} cases pass.`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
