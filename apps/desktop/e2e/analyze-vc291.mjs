/**
 * VC-291 — fold every evidence/<run>/matrix.json into the ticket's matrix:
 * per case/run, the grid before→after, scroll offset/max, which seed markers
 * OCR found at each checkpoint, and a PASS/FAIL verdict.
 *
 * A run PASSES when every seed marker (REFLOW-BEGIN, SHORT-01, SHORT-15,
 * LONG-15 + its -END tail, PWD, REFLOW-END) is still OCR-readable in the
 * post-action sweep AND the shell still answered the REFLOW-CHECK probe.
 *
 *   node apps/desktop/e2e/analyze-vc291.mjs evidence
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "evidence";
const dirs = (await fs.readdir(root, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const MARKER_KEYS = ["begin", "short01", "short15", "long15", "end15", "pwd", "end"];
const rows = [];
const notes = [];

for (const dir of dirs) {
  let matrix;
  try {
    matrix = JSON.parse(await fs.readFile(join(root, dir, "matrix.json"), "utf8"));
  } catch {
    notes.push(`${dir}: no matrix.json`);
    continue;
  }
  const backend = matrix.meta?.backend;
  const backendLabel = backend?.webgpu ? "WebGPU" : backend?.webgl2 ? "WebGL2" : "unknown";
  if (matrix.meta?.fatal) notes.push(`${dir}: FATAL ${String(matrix.meta.fatal).split("\n")[0]}`);
  const consoleErrors = (matrix.meta?.consoleErrors ?? []).map((e) => e.text);
  const deviceLoss = consoleErrors.filter((t) => /device|context lost|driver reset|restored/i.test(t));
  if (deviceLoss.length) notes.push(`${dir}: device-loss-ish console: ${deviceLoss.slice(0, 3).join(" | ")}`);

  for (const run of matrix.runs ?? []) {
    const events = run.events ?? [];
    const sweeps = events.filter((e) => e.shots && typeof e.shots === "object" && e.shots.markers);
    const first = sweeps[0];
    const last = sweeps[sweeps.length - 1];
    const grids = events.map((e) => e.grid).filter((g) => g && g !== "NO-RESPONSE");
    const noResponse = events.some((e) => e.grid === "NO-RESPONSE");
    const scrolls = events.filter((e) => e.scroll).map((e) => e.scroll);
    const missingAfter = last ? MARKER_KEYS.filter((k) => !last.shots.markers[k]) : MARKER_KEYS;
    const missingBefore = first ? MARKER_KEYS.filter((k) => !first.shots.markers[k]) : MARKER_KEYS;
    // Markers the seed had but the post-action sweep lost — the only thing
    // that can support a "line loss" classification.
    const lost = missingAfter.filter((k) => !missingBefore.includes(k));
    const gridChanged = new Set(grids).size > 1;
    rows.push({
      dir,
      case: run.case,
      run: run.run,
      surface: run.surface,
      backend: backendLabel,
      grids: [...new Set(grids)].join(" → ") || "n/a",
      gridChanged,
      scrollFirst: scrolls[0] ? `${scrolls[0].top}/${scrolls[0].max}` : "n/a",
      scrollLast: scrolls.at(-1) ? `${scrolls.at(-1).top}/${scrolls.at(-1).max}` : "n/a",
      seedMarkers: first ? MARKER_KEYS.filter((k) => first.shots.markers[k]).length : 0,
      finalMarkers: last ? MARKER_KEYS.filter((k) => last.shots.markers[k]).length : 0,
      lost,
      shellResponded: !noResponse,
      reference: run.referenceFile,
      verdict:
        lost.length === 0 && !noResponse && (last?.shots.markers ? true : false) ? "PASS" : "FAIL",
    });
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log(
  [
    pad("case", 10),
    pad("run", 4),
    pad("surface", 8),
    pad("backend", 8),
    pad("grid(s)", 22),
    pad("scroll first→last", 22),
    pad("markers", 9),
    pad("lost", 14),
    pad("shell", 6),
    "verdict",
  ].join(" "),
);
for (const r of rows) {
  console.log(
    [
      pad(r.case, 10),
      pad(r.run, 4),
      pad(r.surface, 8),
      pad(r.backend, 8),
      pad(r.grids, 22),
      pad(`${r.scrollFirst} → ${r.scrollLast}`, 22),
      pad(`${r.seedMarkers}→${r.finalMarkers}/7`, 9),
      pad(r.lost.join(",") || "-", 14),
      pad(r.shellResponded ? "ok" : "NO", 6),
      r.verdict,
    ].join(" "),
  );
}
const fails = rows.filter((r) => r.verdict === "FAIL");
console.log(`\n${rows.length} runs, ${rows.length - fails.length} PASS, ${fails.length} FAIL`);
if (notes.length) console.log("\nnotes:\n - " + notes.join("\n - "));
await fs.writeFile(join(root, "analysis.json"), JSON.stringify({ rows, notes }, null, 2));
console.log(`\nwritten: ${join(root, "analysis.json")}`);
