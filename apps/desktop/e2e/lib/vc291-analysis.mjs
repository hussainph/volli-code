/**
 * VC-291 — fold evidence into a verdict, FAIL-CLOSED.
 *
 * The first pass at this analyzer passed anything that did not actively prove
 * loss. A run whose pane painted nothing at all scored "0 markers at seed, 0
 * after" → "lost nothing" → PASS. A run that threw mid-action and recorded
 * `error` alongside a `fatal` in the file's metadata also passed, because
 * neither field was read. Both are reproduced as fixtures in the tests beside
 * this module.
 *
 * The rule here is the opposite: a run is UNKNOWN until the evidence proves it
 * PASSED, and anything unproven is a failure of the evidence, reported as such.
 * A run passes only when ALL of these hold.
 *
 *   1. The run recorded no `error`, and the file recorded no `fatal`.
 *   2. Its reference file exists, is uniquely its own (token-matched, not
 *      shared with another run), and matches the intended 63-line seed exactly.
 *   3. It has a seed checkpoint AND a final checkpoint.
 *   4. The seed checkpoint found EVERY required expected line — a blank or
 *      partial seed sweep means the pane was never proved to hold the seed, so
 *      nothing later can be concluded from it.
 *   5. The final checkpoint still finds every required expected line.
 *   6. It recorded at least the boundary checkpoints the ticket demands for
 *      that case, each carrying grid, scroll, pane identity and markers.
 *   7. The shell answered its REFLOW-CHECK probe at every checkpoint.
 *   8. The backend is the one the row claims to have exercised.
 *
 * A row (case) passes only when the expected number of runs all passed.
 */

import { REQUIRED_EXPECTED_KEYS, verifySeedReference } from "./vc291-seed.mjs";

/**
 * How many action-boundary checkpoints the ticket's matrix demands per case.
 *
 * These are not stylistic: the ticket asks for the grid and markers on EVERY
 * focus return, EVERY resize leg, EVERY split drag and EVERY hide/show return,
 * captured before a later resize or refit can recover a transient failure. A
 * run that only checkpoints its endpoints cannot answer the question the row
 * was designed to ask, so it is short evidence, not a pass.
 */
export const REQUIRED_BOUNDARIES = Object.freeze({
  control: 1, // the 10s idle observation
  resize: 7, // wide/narrow ×3, then restore
  focus: 10, // ten ⌥⌘⏎ round trips
  hsplit: 12, // 3 cycles × (25/50/75/50)
  vsplit: 12,
  hideshow: 20, // 10 × board↔terminal, then 10 × terminal↔terminal
});

const BACKEND_LABEL = (backend) =>
  backend?.webgpu ? "WebGPU" : backend?.webgl2 ? "WebGL2" : "unknown";

/** Checkpoints are events that carry a marker probe. */
const isCheckpoint = (event) => Boolean(event?.shots?.markers);
const isBoundary = (event) => event?.role === "boundary" && isCheckpoint(event);

const foundKeys = (event) => REQUIRED_EXPECTED_KEYS.filter((k) => event?.shots?.markers?.[k]);
const missingKeys = (event) => REQUIRED_EXPECTED_KEYS.filter((k) => !event?.shots?.markers?.[k]);

/**
 * Analyze one evidence directory.
 *
 * @param {object} input
 * @param {object} input.matrix         parsed matrix.json
 * @param {Map<string,{path:string,text:string|null}>} input.references
 *        keyed `${case}-r${run}`; a missing entry is a missing reference.
 * @param {object} input.expect
 *        `{ cases: string[], runsPerCase: number, backend: "webgpu"|"webgl2",
 *           minLiveTerminals?: number }`
 */
export function analyzeEvidence({ dir, matrix, references, expect }) {
  const problems = [];
  const rows = [];
  const notes = [];

  const backend = matrix?.meta?.backend;
  const backendLabel = BACKEND_LABEL(backend);
  const wantBackend = expect?.backend;

  if (matrix?.meta?.fatal) {
    problems.push(
      `${dir}: run aborted with a fatal error — ${String(matrix.meta.fatal).split("\n")[0]}`,
    );
  }
  if (!backend || (!backend.webgpu && !backend.webgl2)) {
    problems.push(
      `${dir}: no terminal backend was confirmed (probe reported ${JSON.stringify(backend ?? null)})`,
    );
  } else if (wantBackend && !backend[wantBackend]) {
    problems.push(`${dir}: expected the ${wantBackend} backend, probe reported ${backendLabel}`);
  }

  // Every console level, not just errors: the WebGL2 context-eviction signal
  // arrives as a `warning`, which an error-only filter never sees.
  const consoleAll = matrix?.meta?.consoleAll ?? [];
  const byLevel = {};
  for (const line of consoleAll) byLevel[line.type] = (byLevel[line.type] ?? 0) + 1;
  const contextWarnings = consoleAll.filter((l) =>
    /too many active webgl|context will be lost|context lost|device.*lost|driver reset|restored/i.test(
      l.text ?? "",
    ),
  );
  if (contextWarnings.length > 0) {
    notes.push(
      `${dir}: ${contextWarnings.length} GPU context/device message(s), e.g. ${JSON.stringify(
        contextWarnings[0].text.slice(0, 120),
      )}`,
    );
  }

  const runs = matrix?.runs ?? [];
  const seenReferencePaths = new Map();

  for (const run of runs) {
    const key = `${run.case}-r${run.run}`;
    const failures = [];

    if (run.error) failures.push(`run recorded an error: ${String(run.error).slice(0, 120)}`);
    if (matrix?.meta?.fatal) failures.push("the file records a fatal error for this evidence set");

    // --- the reference file: present, this run's, and the intended sequence ---
    const reference = references?.get(key);
    let seedVerdict = null;
    if (!reference || reference.text === null || reference.text === undefined) {
      failures.push("no reference file was kept for this run");
    } else {
      if (run.referenceToken && reference.path && !reference.path.includes(run.referenceToken)) {
        failures.push(
          `reference file ${reference.path} does not carry this run's token ${run.referenceToken} (stale pointer)`,
        );
      }
      const previous = seenReferencePaths.get(reference.path);
      if (previous)
        failures.push(`reference file is shared with ${previous} — one of them is stale`);
      else seenReferencePaths.set(reference.path, key);

      seedVerdict = verifySeedReference(reference.text);
      if (!seedVerdict.ok) {
        failures.push(
          `seed reference is not the intended sequence: ${seedVerdict.problems.join("; ")}`,
        );
      }
    }

    // --- checkpoints ---
    const events = run.events ?? [];
    const checkpoints = events.filter(isCheckpoint);
    const seedCheckpoint = events.find((e) => e.role === "seed" && isCheckpoint(e)) ?? null;
    const finalCheckpoint = events.findLast((e) => e.role === "final" && isCheckpoint(e)) ?? null;
    const boundaries = events.filter(isBoundary);

    if (!seedCheckpoint)
      failures.push("no seed checkpoint (the pane was never proved to hold the seed)");
    if (!finalCheckpoint) failures.push("no final checkpoint after the action");

    const seedMissing = seedCheckpoint ? missingKeys(seedCheckpoint) : REQUIRED_EXPECTED_KEYS;
    const finalMissing = finalCheckpoint ? missingKeys(finalCheckpoint) : REQUIRED_EXPECTED_KEYS;

    if (seedCheckpoint && seedMissing.length > 0) {
      // This is the vacuity guard. A sweep that found nothing proves nothing,
      // and must never be read as "nothing was lost".
      failures.push(
        seedMissing.length === REQUIRED_EXPECTED_KEYS.length
          ? "seed checkpoint found NO expected lines — the pane rendered nothing, so this run measures nothing"
          : `seed checkpoint is incomplete, missing: ${seedMissing.join(",")}`,
      );
    }
    if (finalCheckpoint && finalMissing.length > 0) {
      failures.push(`final checkpoint is missing expected line(s): ${finalMissing.join(",")}`);
    }

    // --- boundary coverage the ticket demands ---
    const wantBoundaries = REQUIRED_BOUNDARIES[run.case];
    if (wantBoundaries === undefined) {
      failures.push(
        `unknown case ${JSON.stringify(run.case)} — no boundary requirement is defined for it`,
      );
    } else if (boundaries.length < wantBoundaries) {
      failures.push(
        `only ${boundaries.length} action-boundary checkpoint(s), the ticket requires ${wantBoundaries}`,
      );
    }
    for (const b of boundaries) {
      const gaps = [];
      if (!b.grid || b.grid === "NO-RESPONSE") gaps.push("grid");
      if (!b.scroll) gaps.push("scroll");
      if (!b.scroll?.paneId) gaps.push("paneId");
      if (b.anchoredAtBottom === undefined) gaps.push("anchoredAtBottom");
      if (gaps.length > 0) {
        failures.push(`boundary ${b.t} is missing ${gaps.join("/")}`);
        break; // one example is enough to condemn the run
      }
    }

    // --- the run must have measured the pane it seeded, throughout ---
    const wrongPane = checkpoints.filter(
      (e) => e.scroll?.paneId && run.seededPaneId && e.scroll.paneId !== run.seededPaneId,
    );
    if (wrongPane.length > 0) {
      failures.push(`${wrongPane.length} checkpoint(s) measured a pane other than the seeded one`);
    }
    if (!run.seededPaneId) failures.push("the seeded pane's identity was never recorded");

    // --- the shell stayed alive ---
    const noResponse = events.filter((e) => e.grid === "NO-RESPONSE");
    if (noResponse.length > 0) {
      failures.push(`the shell did not answer REFLOW-CHECK at ${noResponse.length} checkpoint(s)`);
    }

    // --- GPU-pressure rows must actually have been under pressure ---
    if (expect?.minLiveTerminals) {
      const pressure = events.find((e) => typeof e.liveTerminalHosts === "number");
      if (!pressure) failures.push("no live-terminal count was recorded for a GPU-pressure row");
      else if (pressure.liveTerminalHosts < expect.minLiveTerminals) {
        failures.push(
          `only ${pressure.liveTerminalHosts} live terminals, the row requires ${expect.minLiveTerminals}`,
        );
      }
      if (pressure && pressure.backOnSeededPane === false) {
        failures.push(
          "the harness did not return to the seeded pane after creating pressure panes",
        );
      }
    }

    const grids = events.map((e) => e.grid).filter((g) => g && g !== "NO-RESPONSE");
    const scrolls = events.filter((e) => e.scroll).map((e) => e.scroll);
    // Anchoring is a recorded, checked result — not an eyeballed note.
    const anchorSeries = events
      .filter((e) => e.anchoredAtBottom !== undefined)
      .map((e) => ({
        t: e.t,
        anchored: e.anchoredAtBottom,
        top: e.scroll?.top,
        max: e.scroll?.max,
      }));
    const unanchored = anchorSeries.filter((a) => !a.anchored);

    rows.push({
      dir,
      case: run.case,
      run: run.run,
      surface: run.surface,
      backend: backendLabel,
      grids: [...new Set(grids)].join(" → ") || "n/a",
      scrollFirst: scrolls[0] ? `${scrolls[0].top}/${scrolls[0].max}` : "n/a",
      scrollLast: scrolls.at(-1) ? `${scrolls.at(-1).top}/${scrolls.at(-1).max}` : "n/a",
      seedFound: seedCheckpoint ? foundKeys(seedCheckpoint).length : 0,
      finalFound: finalCheckpoint ? foundKeys(finalCheckpoint).length : 0,
      required: REQUIRED_EXPECTED_KEYS.length,
      boundaries: boundaries.length,
      requiredBoundaries: wantBoundaries ?? null,
      referencePath: reference?.path ?? null,
      referenceLines: seedVerdict?.lineCount ?? null,
      shellResponded: noResponse.length === 0,
      anchorSeries,
      firstUnanchored: unanchored[0]?.t ?? null,
      unanchoredCount: unanchored.length,
      failures,
      verdict: failures.length === 0 ? "PASS" : "FAIL",
    });
  }

  // --- suite-level coverage: the rows and runs that were supposed to exist ---
  const byCase = new Map();
  for (const row of rows) byCase.set(row.case, [...(byCase.get(row.case) ?? []), row]);
  for (const wanted of expect?.cases ?? []) {
    const got = byCase.get(wanted) ?? [];
    if (got.length === 0) {
      problems.push(`${dir}: case ${wanted} produced no runs at all`);
      continue;
    }
    if (expect?.runsPerCase && got.length !== expect.runsPerCase) {
      problems.push(
        `${dir}: case ${wanted} has ${got.length} run(s), expected ${expect.runsPerCase}`,
      );
    }
    const runNumbers = new Set(got.map((r) => r.run));
    for (let n = 1; n <= (expect?.runsPerCase ?? 0); n += 1) {
      if (!runNumbers.has(n)) problems.push(`${dir}: case ${wanted} is missing run ${n}`);
    }
  }
  for (const row of rows) {
    if (expect?.cases?.length && !expect.cases.includes(row.case)) {
      notes.push(`${dir}: ${row.case} r${row.run} was not an expected case for this evidence set`);
    }
  }

  const failedRows = rows.filter((r) => r.verdict === "FAIL");
  return {
    dir,
    backend: backendLabel,
    consoleByLevel: byLevel,
    contextWarnings: contextWarnings.length,
    contextWarningSample: contextWarnings.slice(0, 3).map((l) => l.text.slice(0, 200)),
    rows,
    notes,
    problems,
    ok: problems.length === 0 && failedRows.length === 0 && rows.length > 0,
  };
}

/** Fold many evidence directories into one report. */
export function summarize(results) {
  const rows = results.flatMap((r) => r.rows);
  const problems = results.flatMap((r) => r.problems);
  const notes = results.flatMap((r) => r.notes);
  const empty = results.filter((r) => r.rows.length === 0).map((r) => `${r.dir}: no runs`);
  const failed = rows.filter((r) => r.verdict === "FAIL");
  return {
    rows,
    notes,
    problems: [...problems, ...empty],
    passed: rows.length - failed.length,
    failed: failed.length,
    total: rows.length,
    ok: rows.length > 0 && failed.length === 0 && problems.length === 0 && empty.length === 0,
  };
}

const pad = (s, n) => String(s).padEnd(n);

/** Render the ticket's matrix table. */
export function renderTable(rows) {
  const header = [
    pad("case", 10),
    pad("run", 4),
    pad("surface", 8),
    pad("backend", 8),
    pad("grid(s)", 24),
    pad("scroll first→last", 22),
    pad("lines", 12),
    pad("bounds", 7),
    pad("ref", 5),
    pad("shell", 6),
    "verdict",
  ].join(" ");
  const body = rows.map((r) =>
    [
      pad(r.case, 10),
      pad(r.run, 4),
      pad(r.surface ?? "-", 8),
      pad(r.backend, 8),
      pad(r.grids, 24),
      pad(`${r.scrollFirst} → ${r.scrollLast}`, 22),
      pad(`${r.seedFound}→${r.finalFound}/${r.required}`, 12),
      pad(`${r.boundaries}/${r.requiredBoundaries ?? "?"}`, 7),
      pad(r.referenceLines ?? "-", 5),
      pad(r.shellResponded ? "ok" : "NO", 6),
      r.verdict,
    ].join(" "),
  );
  return [header, ...body].join("\n");
}
