/**
 * Stall signals for the desktop benchmark (VC-1093).
 *
 * The app already writes what a person feels as a stall into its profile's
 * structured log (`<userData>/logs/volli-YYYY-MM-DD.jsonl`):
 *
 * - `main-stall` lines (VC-1073, `packages/host-core/src/log/stall.ts`): an
 *   Electron main event-loop block at or over the threshold, with
 *   `attribution` (`door` with its `door`/`operation`, or `unattributed` with
 *   a `lastOperation` hint; VC-1090 adds more labels).
 * - `renderer-stall` lines (VC-1091, `apps/desktop/src/main/log/renderer-stall.ts`):
 *   a long animation frame or slow input in a window, labelled with the
 *   interaction it was in (`INTERACTION_LABELS` in `@volli/shared`).
 *
 * The benchmark reads those lines back out of each repetition's throwaway
 * profile instead of inventing its own probe, so a bench run and an owner's
 * machine report the same signal in the same vocabulary. This module is pure:
 * it parses lines, puts each main stall into the measured interaction whose
 * wall-clock window it landed in, and rolls repetitions up per arm.
 *
 * Renderer lines are timed by when main RECEIVED the batch (a window sends at
 * most every {@link RENDERER_STALL_FLUSH_MS}), not when the frame ran, so they
 * are rolled up by their own interaction label rather than by window.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

/** The production main-stall threshold (`MAIN_STALL_DEFAULTS.thresholdMs`). */
export const MAIN_STALL_DEFAULT_THRESHOLD_MS = 200;
/** The renderer's stall threshold (`STALL_THRESHOLD_MS` in `renderer-stalls.ts`). */
export const RENDERER_STALL_THRESHOLD_MS = 100;
/** The renderer's shortest gap between batches (`STALL_FLUSH_MS`). */
export const RENDERER_STALL_FLUSH_MS = 2_000;
/**
 * How long a repetition waits before closing the app, so the window's last
 * batch reaches main's log: one flush interval and a margin.
 */
export const RENDERER_STALL_FLUSH_WAIT_MS = RENDERER_STALL_FLUSH_MS + 500;
/**
 * How long after a window closes a main stall still belongs to it. The lag
 * probe notices a block on its next tick (`tickMs` 50), so a block that ran
 * at the very end of a window is logged just after it.
 */
export const MAIN_STALL_WINDOW_GRACE_MS = 100;
/** The bucket a main stall goes in when no measured window holds it. */
export const OUTSIDE_WINDOWS = "between-interactions";
/** How many operations / labels the roll-ups name. */
const TOP = 8;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value, fallback) {
  return typeof value === "string" && value !== "" ? value : fallback;
}

/**
 * One parsed log record as a main stall, or null for anything else. The
 * hourly `main stall load` roll-up shares the component and is not a stall.
 */
export function readMainStall(record) {
  if (!isRecord(record) || record.component !== "main-stall" || record.msg !== "main stall") {
    return null;
  }
  const durationMs = finite(record.durationMs);
  const at = Date.parse(record.ts);
  if (durationMs === null || !Number.isFinite(at)) return null;
  const attribution = text(record.attribution, "unknown");
  const unattributed = attribution === "unattributed";
  return {
    at,
    durationMs,
    attribution,
    // An unattributed line's `door`/`operation` are absent by design; it
    // names only a hint (`lastOperation`), which is never claimed as the cause.
    door: unattributed ? "unattributed" : text(record.door, attribution),
    operation: unattributed ? "unattributed" : text(record.operation, "unknown"),
    ...(unattributed && typeof record.lastOperation === "string"
      ? { lastOperation: record.lastOperation }
      : {}),
  };
}

/** One parsed log record as a renderer stall, or null for anything else. */
export function readRendererStall(record) {
  if (
    !isRecord(record) ||
    record.component !== "renderer-stall" ||
    record.msg !== "renderer stall"
  ) {
    return null;
  }
  const durationMs = finite(record.durationMs);
  if (durationMs === null) return null;
  return {
    kind: record.kind === "input" ? "input" : "frame",
    operation: text(record.operation, "unknown"),
    label: text(record.label, "idle"),
    durationMs,
    ...(finite(record.blockingMs) === null ? {} : { blockingMs: record.blockingMs }),
    ...(finite(record.inputDelayMs) === null ? {} : { inputDelayMs: record.inputDelayMs }),
  };
}

/** `renderer stalls dropped` lines: a window over its budget. */
function readDropped(record) {
  if (!isRecord(record) || record.component !== "renderer-stall") return 0;
  if (record.msg !== "renderer stalls dropped") return 0;
  return finite(record.dropped) ?? 0;
}

/** Every main and renderer stall in a set of JSONL texts. A torn last line is skipped. */
export function parseStallLines(texts) {
  const main = [];
  const renderer = [];
  let rendererDropped = 0;
  let unreadableLines = 0;
  for (const body of texts) {
    for (const line of body.split("\n")) {
      if (line.trim() === "") continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        unreadableLines += 1;
        continue;
      }
      const mainStall = readMainStall(record);
      if (mainStall !== null) {
        main.push(mainStall);
        continue;
      }
      const rendererStall = readRendererStall(record);
      if (rendererStall !== null) {
        renderer.push(rendererStall);
        continue;
      }
      rendererDropped += readDropped(record);
    }
  }
  main.sort((a, b) => a.at - b.at);
  return { main, renderer, rendererDropped, unreadableLines };
}

/** Reads every log file a repetition's profile wrote. A profile with no logs has no stalls. */
export async function readProfileStalls(profileDirectory) {
  const directory = join(profileDirectory, "logs");
  const names = await fs.readdir(directory).catch(() => []);
  const files = names.filter((name) => name.endsWith(".jsonl")).toSorted();
  const texts = await Promise.all(files.map((name) => fs.readFile(join(directory, name), "utf8")));
  return { ...parseStallLines(texts), logFiles: files.length };
}

/**
 * Which measured window each main stall belongs to. `windows` are
 * `{ id, startMs, endMs }` in wall-clock milliseconds, in the order they ran;
 * they never overlap. A stall is the window's when its line's time falls
 * inside the window or its grace, else {@link OUTSIDE_WINDOWS} (harness
 * setup between measurements, which is still the app stalling).
 */
export function mainStallsByWindow(stalls, windows, graceMs = MAIN_STALL_WINDOW_GRACE_MS) {
  const byWindow = Object.fromEntries(windows.map((window) => [window.id, []]));
  byWindow[OUTSIDE_WINDOWS] = [];
  for (const stall of stalls) {
    const window = windows.find(
      (candidate) => stall.at >= candidate.startMs && stall.at <= candidate.endMs + graceMs,
    );
    byWindow[window?.id ?? OUTSIDE_WINDOWS].push(stall);
  }
  return byWindow;
}

/** Count, total and longest of a list of stalls. */
export function stallTotals(stalls) {
  return {
    count: stalls.length,
    totalMs: stalls.reduce((sum, stall) => sum + stall.durationMs, 0),
    maxMs: stalls.reduce((max, stall) => Math.max(max, stall.durationMs), 0),
  };
}

/** The per-sample fields a measured interaction carries for its window's main stalls. */
export function mainStallSampleFields(stalls) {
  const totals = stallTotals(stalls);
  return {
    mainStallCount: totals.count,
    mainStallMs: totals.totalMs,
    mainStallMaxMs: totals.maxMs,
  };
}

/** Stalls grouped by `keyOf`, each group's totals, heaviest total first. */
function grouped(stalls, keyOf, seedOf) {
  const groups = new Map();
  for (const stall of stalls) {
    const key = keyOf(stall);
    const group = groups.get(key) ?? { ...seedOf(stall), count: 0, totalMs: 0, maxMs: 0 };
    group.count += 1;
    group.totalMs += stall.durationMs;
    group.maxMs = Math.max(group.maxMs, stall.durationMs);
    groups.set(key, group);
  }
  return [...groups.values()].toSorted((a, b) => b.totalMs - a.totalMs || b.count - a.count);
}

/**
 * One repetition's signals: what its profile logged, with every main stall
 * put in a window. Kept compact on purpose — the raw report holds one of
 * these per repetition.
 */
export function repetitionSignals(parsed, windows) {
  const byWindow = mainStallsByWindow(parsed.main, windows);
  return {
    logFiles: parsed.logFiles ?? null,
    unreadableLines: parsed.unreadableLines,
    main: parsed.main,
    mainByWindow: Object.fromEntries(
      Object.entries(byWindow).map(([id, stalls]) => [id, stallTotals(stalls)]),
    ),
    renderer: parsed.renderer,
    rendererDropped: parsed.rendererDropped,
  };
}

/**
 * An arm's signals over its repetitions (warm-up excluded): totals, a
 * per-repetition distribution, the operations and labels that stalled most,
 * and main stalls per measured interaction. `summarize` is the runner's
 * nearest-rank summary, passed in so both use one definition.
 */
export function armSignals(repetitions, { summarize, mainStallThresholdMs }) {
  const main = repetitions.flatMap((repetition) => repetition.main);
  const renderer = repetitions.flatMap((repetition) => repetition.renderer);
  const mainTotals = stallTotals(main);
  const unattributed = main.filter((stall) => stall.attribution === "unattributed").length;
  const windowIds = [
    ...new Set(repetitions.flatMap((repetition) => Object.keys(repetition.mainByWindow))),
  ];
  return {
    repetitions: repetitions.length,
    mainStallThresholdMs,
    rendererStallThresholdMs: RENDERER_STALL_THRESHOLD_MS,
    main: {
      ...mainTotals,
      countPerRepetition: summarize(repetitions.map((repetition) => repetition.main.length)),
      msPerRepetition: summarize(
        repetitions.map((repetition) => stallTotals(repetition.main).totalMs),
      ),
      durationMs: summarize(main.map((stall) => stall.durationMs)),
      unattributedCount: unattributed,
      unattributedShare:
        main.length === 0 ? null : Math.round((unattributed / main.length) * 1_000) / 1_000,
      topOperations: grouped(
        main,
        (stall) => `${stall.door}\u0000${stall.operation}`,
        (stall) => ({ door: stall.door, operation: stall.operation }),
      ).slice(0, TOP),
      byInteraction: Object.fromEntries(
        windowIds.map((id) => {
          const totals = repetitions.map(
            (repetition) => repetition.mainByWindow[id] ?? { count: 0, totalMs: 0, maxMs: 0 },
          );
          return [
            id,
            {
              count: totals.reduce((sum, total) => sum + total.count, 0),
              totalMs: totals.reduce((sum, total) => sum + total.totalMs, 0),
              maxMs: totals.reduce((max, total) => Math.max(max, total.maxMs), 0),
            },
          ];
        }),
      ),
    },
    renderer: {
      ...stallTotals(renderer),
      frames: renderer.filter((stall) => stall.kind === "frame").length,
      inputs: renderer.filter((stall) => stall.kind === "input").length,
      dropped: repetitions.reduce((sum, repetition) => sum + repetition.rendererDropped, 0),
      countPerRepetition: summarize(repetitions.map((repetition) => repetition.renderer.length)),
      durationMs: summarize(renderer.map((stall) => stall.durationMs)),
      byLabel: grouped(
        renderer,
        (stall) => `${stall.label}\u0000${stall.kind}`,
        (stall) => ({ label: stall.label, kind: stall.kind }),
      ).slice(0, TOP),
      byOperation: grouped(
        renderer,
        (stall) => `${stall.kind}\u0000${stall.operation}`,
        (stall) => ({ kind: stall.kind, operation: stall.operation }),
      ).slice(0, TOP),
    },
  };
}

/** The Markdown section for every arm's signals. */
export function signalsMarkdown(arms, labelOf) {
  const withSignals = arms.filter((arm) => arm.signals !== undefined);
  if (withSignals.length === 0) return [];
  const lines = [
    "",
    "## Stall signals",
    "",
    `Read back from each repetition's own profile log: \`main-stall\` lines (Electron main event-loop blocks ≥ ${withSignals[0].signals.mainStallThresholdMs} ms) and \`renderer-stall\` lines (long frames / slow inputs ≥ ${withSignals[0].signals.rendererStallThresholdMs} ms, labelled by interaction). Warm-up iterations are excluded.`,
    "",
    "| Load | main stalls | main ms | main max | per rep p50 / p95 | unattributed | renderer stalls | renderer ms | renderer max | dropped |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const arm of withSignals) {
    const { main, renderer } = arm.signals;
    lines.push(
      `| ${arm.name} | ${main.count} | ${main.totalMs} ms | ${main.maxMs} ms | ${main.countPerRepetition?.p50 ?? "—"} / ${main.countPerRepetition?.p95 ?? "—"} | ${main.unattributedShare === null ? "—" : `${Math.round(main.unattributedShare * 100)}%`} | ${renderer.count} | ${renderer.totalMs} ms | ${renderer.maxMs} ms | ${renderer.dropped} |`,
    );
  }
  lines.push(
    "",
    "### Main stalls by interaction",
    "",
    "| Load | Interaction | stalls | total | max |",
    "|---|---|---:|---:|---:|",
  );
  for (const arm of withSignals) {
    for (const [id, totals] of Object.entries(arm.signals.main.byInteraction)) {
      if (totals.count === 0) continue;
      lines.push(
        `| ${arm.name} | ${labelOf(id)} | ${totals.count} | ${totals.totalMs} ms | ${totals.maxMs} ms |`,
      );
    }
  }
  lines.push(
    "",
    "### Top main operations",
    "",
    "| Load | door | operation | stalls | total | max |",
    "|---|---|---|---:|---:|---:|",
  );
  for (const arm of withSignals) {
    for (const operation of arm.signals.main.topOperations) {
      lines.push(
        `| ${arm.name} | \`${operation.door}\` | \`${operation.operation}\` | ${operation.count} | ${operation.totalMs} ms | ${operation.maxMs} ms |`,
      );
    }
  }
  lines.push(
    "",
    "### Renderer stalls by label",
    "",
    "| Load | label | kind | stalls | total | max |",
    "|---|---|---|---:|---:|---:|",
  );
  for (const arm of withSignals) {
    for (const label of arm.signals.renderer.byLabel) {
      lines.push(
        `| ${arm.name} | \`${label.label}\` | ${label.kind} | ${label.count} | ${label.totalMs} ms | ${label.maxMs} ms |`,
      );
    }
  }
  return lines;
}
