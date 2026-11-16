import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { summarize } from "./run.mjs";
import {
  armSignals,
  mainStallsByWindow,
  OUTSIDE_WINDOWS,
  parseStallLines,
  readProfileStalls,
  repetitionSignals,
  signalsMarkdown,
} from "./stall-signals.mjs";

const T0 = Date.parse("2026-11-02T10:00:00.000Z");
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

/** Lines in the shapes `stall.ts` and `renderer-stall.ts` write. */
function mainLine(offsetMs, durationMs, extra = {}) {
  return JSON.stringify({
    ts: iso(offsetMs),
    level: "warn",
    msg: "main stall",
    component: "main-stall",
    durationMs,
    thresholdMs: 200,
    ...extra,
  });
}

function rendererLine(label, durationMs, extra = {}) {
  return JSON.stringify({
    ts: iso(0),
    level: "warn",
    msg: "renderer stall",
    component: "renderer-stall",
    window: 1,
    door: "renderer",
    kind: "frame",
    operation: "long-animation-frame",
    label,
    durationMs,
    ...extra,
  });
}

const LOG = [
  mainLine(100, 400, { attribution: "door", door: "ipc", operation: "volli:session-list" }),
  mainLine(1_050, 250, { attribution: "unattributed", lastOperation: "volli:data-bootstrap" }),
  mainLine(5_000, 300, { attribution: "door", door: "ipc", operation: "volli:session-list" }),
  // The hourly roll-up shares the component; it is not a stall.
  JSON.stringify({
    ts: iso(6_000),
    level: "info",
    msg: "main stall load",
    component: "main-stall",
    stalls: 3,
  }),
  rendererLine("workspace-switch", 180),
  rendererLine("draft-typing", 120, {
    kind: "input",
    operation: "keydown",
    inputDelayMs: 90,
    processingMs: 20,
    presentationMs: 10,
  }),
  JSON.stringify({
    ts: iso(0),
    level: "warn",
    msg: "renderer stalls dropped",
    component: "renderer-stall",
    window: 1,
    dropped: 4,
  }),
  JSON.stringify({ ts: iso(0), level: "info", msg: "unrelated", component: "desktop" }),
  '{"torn',
].join("\n");

describe("stall lines", () => {
  it("reads main and renderer stalls and nothing else", () => {
    const parsed = parseStallLines([LOG]);
    expect(parsed.main).toHaveLength(3);
    expect(parsed.main[0]).toMatchObject({
      durationMs: 400,
      attribution: "door",
      door: "ipc",
      operation: "volli:session-list",
    });
    // An unattributed stall never claims its hint as its cause.
    expect(parsed.main[1]).toMatchObject({
      door: "unattributed",
      operation: "unattributed",
      lastOperation: "volli:data-bootstrap",
    });
    expect(parsed.renderer.map((stall) => [stall.label, stall.kind])).toEqual([
      ["workspace-switch", "frame"],
      ["draft-typing", "input"],
    ]);
    expect(parsed.rendererDropped).toBe(4);
    expect(parsed.unreadableLines).toBe(1);
  });

  it("files VC-1090's attributions under their own door and operation", () => {
    const parsed = parseStallLines([
      [
        mainLine(0, 300, {
          attribution: "span",
          door: "runtime",
          operation: "pi.turn",
          sessionId: "s",
        }),
        mainLine(1, 250, {
          attribution: "aggregate",
          door: "broadcast",
          operation: "session-activity",
          spanCount: 40,
        }),
        mainLine(2, 220, { attribution: "gc", door: "gc", operation: "major" }),
        mainLine(3, 210, { attribution: "off-cpu", door: "off-cpu", operation: "wait" }),
      ].join("\n"),
    ]);
    expect(parsed.main.map((stall) => [stall.attribution, stall.door, stall.operation])).toEqual([
      ["span", "runtime", "pi.turn"],
      ["aggregate", "broadcast", "session-activity"],
      ["gc", "gc", "major"],
      ["off-cpu", "off-cpu", "wait"],
    ]);
    const signals = armSignals([repetitionSignals(parsed, [])], {
      summarize,
      mainStallThresholdMs: 200,
    });
    expect(signals.main.unattributedShare).toBe(0);
  });

  it("keeps an off-CPU wait's hint and what its window cost, when the line has them", () => {
    const parsed = parseStallLines([
      [
        mainLine(0, 600, {
          attribution: "off-cpu",
          door: "off-cpu",
          operation: "wait",
          lastOperation: "volli:app-state-set",
          cpuMs: 12,
          majorFaults: 340,
          involuntarySwitches: 9,
        }),
        mainLine(1, 300, { attribution: "door", door: "ipc", operation: "x", cpuMs: "?" }),
      ].join("\n"),
    ]);
    expect(parsed.main[0]).toMatchObject({
      lastOperation: "volli:app-state-set",
      cpuMs: 12,
      majorFaults: 340,
      involuntarySwitches: 9,
    });
    expect(parsed.main[1]).not.toHaveProperty("cpuMs");
    expect(parsed.main[1]).not.toHaveProperty("lastOperation");
  });

  it("puts each main stall in the window it landed in, with the probe's grace", () => {
    const { main } = parseStallLines([LOG]);
    const byWindow = mainStallsByWindow(main, [
      { id: "cold_launch", startMs: T0, endMs: T0 + 1_000 },
      { id: "workspace_switch", startMs: T0 + 4_000, endMs: T0 + 6_000 },
    ]);
    // 1,050 ms is 50 ms past cold launch's end: the lag probe's late tick.
    expect(byWindow.cold_launch.map((stall) => stall.durationMs)).toEqual([400, 250]);
    expect(byWindow.workspace_switch.map((stall) => stall.durationMs)).toEqual([300]);
    expect(byWindow[OUTSIDE_WINDOWS]).toEqual([]);
    const late = mainStallsByWindow(main, [{ id: "cold_launch", startMs: T0, endMs: T0 + 500 }]);
    expect(late[OUTSIDE_WINDOWS].map((stall) => stall.durationMs)).toEqual([250, 300]);
  });

  it("reads a profile's rotated log files, and none as no stalls", async () => {
    const profile = await mkdtemp(join(os.tmpdir(), "vc1093-signals-"));
    try {
      expect((await readProfileStalls(profile)).main).toEqual([]);
      await mkdir(join(profile, "logs"));
      await writeFile(join(profile, "logs", "volli-2026-11-02.jsonl"), LOG);
      await writeFile(
        join(profile, "logs", "volli-2026-11-03.jsonl"),
        mainLine(9_000, 220, { attribution: "door", door: "socket", operation: "ticket.comment" }),
      );
      await writeFile(join(profile, "logs", "notes.txt"), mainLine(9_000, 999));
      const parsed = await readProfileStalls(profile);
      expect(parsed.logFiles).toBe(2);
      expect(parsed.main.map((stall) => stall.durationMs)).toEqual([400, 250, 300, 220]);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });
});

describe("arm signals", () => {
  const windows = [
    { id: "cold_launch", startMs: T0, endMs: T0 + 1_000 },
    { id: "workspace_switch", startMs: T0 + 4_000, endMs: T0 + 6_000 },
  ];

  it("rolls repetitions up without raw lines, by operation, label and interaction", () => {
    const first = repetitionSignals(parseStallLines([LOG]), windows);
    const second = repetitionSignals(parseStallLines([""]), windows);
    const signals = armSignals([first, second], { summarize, mainStallThresholdMs: 200 });
    expect(signals.main).toMatchObject({
      count: 3,
      totalMs: 950,
      maxMs: 400,
      unattributedCount: 1,
      unattributedShare: 0.333,
      countPerRepetition: { n: 2, p50: 0, p95: 3 },
    });
    expect(signals.main.topOperations[0]).toEqual({
      door: "ipc",
      operation: "volli:session-list",
      count: 2,
      totalMs: 700,
      maxMs: 400,
    });
    expect(signals.main.unattributedHints).toEqual([
      { lastOperation: "volli:data-bootstrap", count: 1, totalMs: 250, maxMs: 250 },
    ]);
    expect(signals.main.byInteraction).toMatchObject({
      cold_launch: { count: 2, totalMs: 650, maxMs: 400 },
      workspace_switch: { count: 1, totalMs: 300 },
      [OUTSIDE_WINDOWS]: { count: 0 },
    });
    expect(signals.renderer).toMatchObject({ count: 2, frames: 1, inputs: 1, dropped: 4 });
    expect(signals.renderer.byLabel.map((entry) => entry.label)).toEqual([
      "workspace-switch",
      "draft-typing",
    ]);
    // The summary is committable: no raw line arrays ride in it.
    expect(JSON.stringify(signals)).not.toMatch(/samples|"at":/);
  });

  it("reports a run with no stalls as zeros and an unknown share, never as missing", () => {
    const quiet = repetitionSignals(parseStallLines([""]), windows);
    const signals = armSignals([quiet], { summarize, mainStallThresholdMs: 200 });
    expect(signals.main).toMatchObject({ count: 0, totalMs: 0, unattributedShare: null });
    const markdown = signalsMarkdown([{ name: "idle", signals }], (id) => id).join("\n");
    expect(markdown).toContain("## Stall signals");
    expect(markdown).toContain("| idle | 0 | 0 ms | 0 ms | 0 / 0 | — | 0 |");
  });

  it("renders every arm's stalls, interactions and labels", () => {
    const signals = armSignals([repetitionSignals(parseStallLines([LOG]), windows)], {
      summarize,
      mainStallThresholdMs: 200,
    });
    const markdown = signalsMarkdown([{ name: "idle", signals }, { name: "stream-only" }], (id) =>
      id === "workspace_switch" ? "Workspace switch" : id,
    ).join("\n");
    expect(markdown).toContain("| idle | Workspace switch | 1 | 300 ms | 300 ms |");
    expect(markdown).toContain("| idle | `ipc` | `volli:session-list` | 2 | 700 ms | 400 ms |");
    expect(markdown).toContain("| idle | `draft-typing` | input | 1 | 120 ms | 120 ms |");
    expect(markdown).toContain("| idle | `volli:data-bootstrap` | 1 | 250 ms | 250 ms |");
    expect(markdown).not.toContain("stream-only");
  });
});
