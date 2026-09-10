/**
 * VC-291 — fold every evidence/<run>/matrix.json into the ticket's matrix and
 * return a verdict.
 *
 * The rules live in `lib/vc291-analysis.mjs` (unit-tested); this file only
 * loads evidence off disk, applies each set's DECLARED expectations from its
 * `run-config.json`, prints the table, and sets the exit code.
 *
 * Exit status is the point: 0 only when every run in every set passed. An
 * evidence set that is blank, short, aborted, on the wrong backend, or missing
 * its reference files exits non-zero, so no driver can print a success banner
 * over it.
 *
 *   node apps/desktop/e2e/analyze-vc291.mjs evidence
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { analyzeEvidence, renderTable, summarize } from "./lib/vc291-analysis.mjs";

const root = process.argv[2] ?? "evidence";

const readJson = async (path) => {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
};

const dirs = (await fs.readdir(root, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .toSorted();

const results = [];
const loadProblems = [];

for (const dir of dirs) {
  const matrix = await readJson(join(root, dir, "matrix.json"));
  if (!matrix) {
    // An a11y evidence directory has no matrix and is analysed by its own
    // harness; anything else without one is a hole in the evidence.
    if (await readJson(join(root, dir, "a11y.json"))) continue;
    loadProblems.push(`${dir}: no matrix.json`);
    continue;
  }
  const config = (await readJson(join(root, dir, "run-config.json"))) ?? {};

  // Each run's reference file, keyed the way the harness copied it in.
  const references = new Map();
  for (const run of matrix.runs ?? []) {
    const key = `${run.case}-r${run.run}`;
    const copied = join(root, dir, `reference-${key}.txt`);
    let text = null;
    try {
      text = await fs.readFile(copied, "utf8");
    } catch {
      text = null;
    }
    references.set(key, { path: run.referenceFile ?? copied, text });
  }

  results.push(
    analyzeEvidence({
      dir,
      matrix,
      references,
      expect: {
        cases: config.cases ?? [],
        runsPerCase: config.runsPerCase ?? 0,
        backend:
          config.expectBackend ??
          (config.forcedBackend?.startsWith("webgl2") ? "webgl2" : "webgpu"),
        minLiveTerminals: config.minLiveTerminals ?? 0,
      },
    }),
  );
}

const folded = summarize(results);
folded.problems.push(...loadProblems);

console.log(renderTable(folded.rows));
console.log(`\n${folded.total} runs, ${folded.passed} PASS, ${folded.failed} FAIL`);

for (const row of folded.rows.filter((r) => r.verdict === "FAIL")) {
  console.log(`\nFAIL ${row.dir} ${row.case} r${row.run}:`);
  for (const failure of row.failures) console.log(`  - ${failure}`);
}

const problems = [...folded.problems];
if (problems.length > 0) {
  console.log("\nevidence problems:");
  for (const p of problems) console.log(`  - ${p}`);
}
if (folded.notes.length > 0) {
  console.log("\nnotes:");
  for (const n of folded.notes) console.log(`  - ${n}`);
}

// Anchoring, reported as a checked result rather than left to a reader's eye.
const drifted = folded.rows.filter((r) => r.unanchoredCount > 0);
if (drifted.length > 0) {
  console.log("\nviewport anchoring — checkpoints where the pane was NOT at the bottom:");
  for (const r of drifted) {
    console.log(
      `  ${r.dir} ${r.case} r${r.run}: ${r.unanchoredCount} checkpoint(s), first at ${r.firstUnanchored}` +
        ` (${r.anchorSeries.find((a) => !a.anchored)?.top}/${r.anchorSeries.find((a) => !a.anchored)?.max})`,
    );
  }
}

const ok = folded.ok && problems.length === 0;
await fs.writeFile(
  join(root, "analysis.json"),
  JSON.stringify({ ok, ...folded, problems, byDir: results }, null, 2),
);
console.log(`\nwritten: ${join(root, "analysis.json")}`);
console.log(ok ? "\nANALYSIS: PASS" : "\nANALYSIS: FAIL");
process.exitCode = ok ? 0 : 1;
