/**
 * VC-456's off-by-default real-path turn bench. Run with
 * `pnpm -C apps/desktop bench:turn-real-path`. It is outside the desktop app's
 * default test projects and CI.
 *
 * Without `VC456_OUTPUT` the file runs the analysis tests and a one-wave smoke
 * through the real composition. With it, the last test also runs the full
 * matrix and writes the report there:
 *
 *   VC456_OUTPUT=$PWD/performance-results/vc-456-turn-real-path \
 *     pnpm -C apps/desktop bench:turn-real-path
 *
 * `VC456_REPETITIONS` (default 20), `VC456_CONCURRENCIES` (default 1,5,15,20),
 * `VC456_CONTROL` (`memory-artifacts` or `none`), `VC456_DELTAS` (text deltas
 * per stand-in reply, default 8), `VC456_SUBSCRIBERS` (`all`, `none`, or
 * both, default both) and `VC456_CLIFF=0` (skip the overlay-cache sweep) tune
 * it.
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObservabilityEvent } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { analyzeRealTurn, crossCheckLedger, summarizeTurns } from "./analysis";
import {
  createRealPathComposition,
  PRIVATE_CONTENT_CANARY,
  type LedgerCommit,
  type LedgerFrame,
  type RawTurn,
  type RecordedEnvelope,
} from "./harness";
import {
  formatMarkdown,
  integrityFailures,
  runArm,
  runBenchmark,
  type ArmReport,
} from "./measurement";

const COMMAND = "command-1";

function envelope(event: ObservabilityEvent, order: number, recordedAt: number): RecordedEnvelope {
  return { event, order, recordedAt, sessionId: "session-1" };
}

const RUN = { runId: "run-1" };
/** One turn's six paired facts in causal order on both sides. */
function consistentTurn(): {
  envelopes: RecordedEnvelope[];
  commits: LedgerCommit[];
  frames: LedgerFrame[];
  ledger: RawTurn["ledger"];
} {
  const envelopes = [
    envelope({ kind: "turn-queue", queuedMs: 3 }, 0, 10),
    envelope(
      {
        kind: "provider-attempt",
        providerId: "p",
        modelId: "m",
        api: "anthropic-messages",
        stopReason: "toolUse",
        durationMs: 30,
        ...RUN,
      } as ObservabilityEvent,
      1,
      40,
    ),
    envelope({ kind: "authority", outcome: "allowed", waitDurationMs: 20, ...RUN }, 2, 80),
    envelope(
      { kind: "compaction", outcome: "compacted", reason: "overflow", durationMs: 9, ...RUN },
      3,
      120,
    ),
    envelope(
      {
        kind: "provider-attempt",
        providerId: "p",
        modelId: "m",
        api: "anthropic-messages",
        stopReason: "stop",
        durationMs: 30,
        ...RUN,
      } as ObservabilityEvent,
      4,
      160,
    ),
    envelope({ kind: "turn", outcome: "completed", durationMs: 160, ...RUN }, 5, 170),
  ];
  const kinds: Array<[string, number]> = [
    ["command.recorded", 5],
    ["turn.started", 11],
    ["usage.recorded", 41],
    ["interaction.opened", 62],
    ["command.recorded", 75],
    ["interaction.resolved", 79],
    ["usage.recorded", 100],
    ["context.compacted", 121],
    ["usage.recorded", 161],
    ["turn.completed", 171],
    ["command.receipt.recorded", 172],
  ];
  const ledger = kinds.map(([kind], index) => ({
    sequence: 10 + index,
    kind,
    commandId: index === 0 || index === kinds.length - 1 ? COMMAND : index === 4 ? "answer" : null,
  }));
  const frames = kinds.map(([kind, arrivedAt], index) => ({
    sequence: 10 + index,
    kind,
    commandId: ledger[index]!.commandId,
    arrivedAt,
  }));
  // Each fact commits half a millisecond before its frame arrives.
  const commits = frames.map(({ arrivedAt, ...frame }) => ({
    ...frame,
    committedAt: arrivedAt - 0.5,
  }));
  return { envelopes, commits, frames, ledger };
}

describe("VC-456 ledger cross-check", () => {
  it("pairs all six facts and finds nothing wrong in a consistent turn", () => {
    const check = crossCheckLedger({ commandId: COMMAND, ...consistentTurn() });
    expect(check.missing).toEqual([]);
    expect(check.paired).toHaveLength(6);
    expect(check.orderInversions).toBe(0);
    expect(check.causalityViolations).toEqual([]);
    expect(check.commitsMatchLedger).toBe(true);
    expect(check.streamMatchesLedger).toBe(true);
  });

  it("counts an envelope/ledger inversion even when every timestamp still increases", () => {
    const turn = consistentTurn();
    // The ledger records the compaction before the authority answer.
    const resolved = turn.ledger.findIndex((entry) => entry.kind === "interaction.resolved");
    const compacted = turn.ledger.findIndex((entry) => entry.kind === "context.compacted");
    turn.ledger[resolved]!.kind = "context.compacted";
    turn.ledger[compacted]!.kind = "interaction.resolved";
    turn.frames[resolved]!.kind = "context.compacted";
    turn.frames[compacted]!.kind = "interaction.resolved";
    turn.commits[resolved]!.kind = "context.compacted";
    turn.commits[compacted]!.kind = "interaction.resolved";
    expect(crossCheckLedger({ commandId: COMMAND, ...turn }).orderInversions).toBe(1);
  });

  it("names a turn-queue envelope recorded after its durable turn.started arrived", () => {
    const turn = consistentTurn();
    turn.envelopes[0] = { ...turn.envelopes[0]!, recordedAt: 12 };
    expect(crossCheckLedger({ commandId: COMMAND, ...turn }).causalityViolations).toEqual([
      "turn-start: envelope after its durable fact",
    ]);
  });

  it("names an authority wait that ended before the question reached the answerer", () => {
    const turn = consistentTurn();
    turn.envelopes[2] = { ...turn.envelopes[2]!, recordedAt: 61 };
    expect(crossCheckLedger({ commandId: COMMAND, ...turn }).causalityViolations).toEqual([
      "authority-answer: wait ended before the question arrived",
    ]);
  });

  it("reports a missing side as missing, never as agreement", () => {
    const turn = consistentTurn();
    turn.envelopes = turn.envelopes.filter(({ event }) => event.kind !== "compaction");
    const check = crossCheckLedger({ commandId: COMMAND, ...turn });
    expect(check.missing).toEqual(["compaction"]);
    expect(check.paired).not.toContain("compaction");
  });

  it("finds no turn for a command the ledger never recorded", () => {
    const check = crossCheckLedger({ commandId: "never-recorded", ...consistentTurn() });
    expect(check.paired).toEqual([]);
    expect(check.missing).toHaveLength(6);
  });

  it("flags a durable fact no engine call was seen committing", () => {
    const turn = consistentTurn();
    turn.commits.splice(4, 1);
    expect(crossCheckLedger({ commandId: COMMAND, ...turn }).commitsMatchLedger).toBe(false);
  });

  it("has no stream to compare when nobody subscribed", () => {
    const check = crossCheckLedger({ commandId: COMMAND, ...consistentTurn(), frames: [] });
    expect(check.streamMatchesLedger).toBeNull();
    expect(check.causalityViolations).toEqual([]);
  });

  it("flags a live stream that skipped a durable fact", () => {
    const turn = consistentTurn();
    turn.frames.splice(3, 1);
    expect(crossCheckLedger({ commandId: COMMAND, ...turn }).streamMatchesLedger).toBe(false);
  });

  it("flags a live stream that never delivered the turn's end, however well its prefix matches", () => {
    const turn = consistentTurn();
    turn.frames = turn.frames.filter(
      ({ kind }) => kind !== "turn.completed" && kind !== "command.receipt.recorded",
    );
    expect(crossCheckLedger({ commandId: COMMAND, ...turn }).streamMatchesLedger).toBe(false);
  });
});

describe("VC-456 real-path smoke", () => {
  it.each(["all", "none"] as const)(
    "runs scripted turns through the real path with complete, ordered, content-free accounting (subscribers %s)",
    async (subscribers) => {
      const composition = await createRealPathComposition({ subscribers });
      let turns: RawTurn[];
      try {
        ({ turns } = await composition.runWave({ concurrency: 3, wave: 0 }));
        expect(composition.networkAttempts()).toBe(0);
        expect(composition.unscopedEnvelopeCount()).toBe(0);
        expect(composition.runIdConflictCount()).toBe(0);
        expect(composition.requests()).toEqual({
          "tool-round": 3,
          overflow: 3,
          summary: 3,
          final: 3,
        });
      } finally {
        await composition.close();
      }
      const samples = turns.map((turn, index) => analyzeRealTurn(turn, `smoke-${index}`));
      for (const sample of samples) {
        expect(sample.complete).toBe(true);
        expect(sample.gapIncludesMissingSpans).toBe(false);
        expect(sample.eventOrderValid).toBe(true);
        expect(sample.modelAttemptCount).toBe(3);
        expect(sample.toolRoundCount).toBe(1);
        expect(sample.toolsByName["read"]?.count).toBe(2);
        expect(sample.toolsByName["write"]?.count).toBe(1);
        expect(sample.toolsByName["bash"]?.count).toBe(1);
        expect(sample.authorityWaitCount).toBe(1);
        expect(sample.compactionCount).toBe(1);
        expect(sample.retryCount).toBe(1);
        // The Session runtime's own queue measurement, not a fixture timer.
        expect(sample.submissionToTurnStartMs).not.toBeNull();
        expect(sample.crossCheck.missing).toEqual([]);
        expect(sample.crossCheck.orderInversions).toBe(0);
        expect(sample.crossCheck.causalityViolations).toEqual([]);
        expect(sample.crossCheck.commitsMatchLedger).toBe(true);
        expect(sample.crossCheck.streamMatchesLedger).toBe(subscribers === "all" ? true : null);
        expect(sample.artifactWriteCount).toBeGreaterThan(0);
        expect(sample.ledgerTransactionCount).toBeGreaterThan(0);
      }
      // One ledger shape: the same script produced the same durable history.
      expect(new Set(samples.map(({ ledgerShape }) => ledgerShape)).size).toBe(1);

      // Privacy: the canary sat in the prompt, the replies and both tool files.
      const outputs = [
        JSON.stringify(turns.flatMap((turn) => turn.envelopes.map(({ event }) => event))),
        JSON.stringify(turns.map((turn) => [turn.frames, turn.ledger])),
        JSON.stringify(samples),
        JSON.stringify(summarizeTurns(samples)),
      ];
      for (const output of outputs) {
        expect(output).not.toContain(PRIVATE_CONTENT_CANARY);
        expect(output).not.toContain("vc456-call-");
      }
    },
  );

  it("marks a turn incomplete when its message or its answer did not land", async () => {
    const composition = await createRealPathComposition();
    let turn: RawTurn;
    try {
      [turn] = (await composition.runWave({ concurrency: 1, wave: 0 })).turns as [RawTurn];
    } finally {
      await composition.close();
    }
    expect(analyzeRealTurn(turn, "as-run").complete).toBe(true);
    expect(analyzeRealTurn({ ...turn, receiptStatus: "rejected" }, "rejected").complete).toBe(
      false,
    );
    expect(analyzeRealTurn({ ...turn, answers: [] }, "unanswered").complete).toBe(false);
    expect(
      analyzeRealTurn({ ...turn, answers: [turn.answers[0]!, turn.answers[0]!] }, "twice").complete,
    ).toBe(false);
    expect(
      analyzeRealTurn({ ...turn, commits: turn.commits.slice(0, -2) }, "commit lost").complete,
    ).toBe(false);
  });

  it("counts a network call, and gives the real fetch back when it closes", async () => {
    const realFetch = globalThis.fetch;
    const composition = await createRealPathComposition();
    try {
      await expect(globalThis.fetch("https://example.invalid/")).rejects.toThrow(/refused/);
      expect(composition.networkAttempts()).toBe(1);
    } finally {
      await composition.close();
    }
    expect(globalThis.fetch).toBe(realFetch);
  });

  it("publishes nothing from an arm whose harness or cross-check could not vouch for it", async () => {
    const arm = await runArm({ artifactStore: "memory", concurrency: 1, repetitions: 1 });
    expect(integrityFailures(arm)).toEqual([]);
    const tamper = (change: (copy: ArmReport) => void): string[] => {
      const copy = structuredClone(arm);
      change(copy);
      return integrityFailures(copy);
    };
    const label = "memory/all/8d@1";
    expect(tamper((copy) => (copy.integrity.networkAttempts = 1))).toEqual([
      `${label}: network was attempted`,
    ]);
    expect(tamper((copy) => (copy.integrity.unscopedEnvelopes = 1))).toEqual([
      `${label}: an envelope escaped every Session scope`,
    ]);
    expect(tamper((copy) => (copy.integrity.runIdConflicts = 1))).toEqual([
      `${label}: a runId crossed Sessions`,
    ]);
    expect(tamper((copy) => (copy.integrity.providerRequests["summary"] = 0))).toEqual([
      `${label}: 0 summary requests for 1 turns`,
    ]);
    expect(tamper((copy) => (copy.summary.completeTurnCount = 0))).toEqual([
      `${label}: 1 incomplete turns`,
    ]);
    expect(tamper((copy) => (copy.summary.vc119OrderViolations = 2))).toEqual([
      `${label}: 2 VC-119 order violations`,
    ]);
    expect(tamper((copy) => (copy.summary.crossCheck.orderInversions = 1))).toEqual([
      `${label}: 1 envelope/ledger inversions`,
    ]);
    expect(tamper((copy) => (copy.summary.crossCheck.causalityViolations = 1))).toEqual([
      `${label}: 1 causality violations`,
    ]);
    expect(tamper((copy) => (copy.summary.crossCheck.commitMismatches = 1))).toEqual([
      `${label}: 1 commit/read-back mismatches`,
    ]);
    expect(tamper((copy) => (copy.summary.crossCheck.streamMismatches = 1))).toEqual([
      `${label}: 1 stream/read-back mismatches`,
    ]);
    expect(
      tamper((copy) => copy.summary.ledgerShapes.push({ shape: "another", turns: 1 })),
    ).toEqual([`${label}: 2 different ledger shapes`]);
    const markdown = formatMarkdown({
      generatedAt: "now",
      environment: {
        nodeVersion: process.version,
        platform: "test",
        osRelease: "test",
        architecture: "test",
        cpuModel: "test",
        logicalCores: 1,
        availableParallelism: 1,
        totalMemoryBytes: 1,
        uvThreadpoolSize: "4",
        gitSha: "test",
        dirty: false,
        initialLoadAverage: null,
        fileSyncProbes: [],
      },
      parameters: {
        concurrencies: [1],
        repetitions: 1,
        control: "none",
        deltasPerReply: 8,
        subscribers: ["all"],
        cliff: false,
      },
      arms: [arm],
    });
    expect(markdown).not.toContain(PRIVATE_CONTENT_CANARY);
  });
});

describe("VC-456 runner guards", () => {
  it("refuses too few repetitions and out-of-range concurrency before running", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vc456-guard-"));
    try {
      await expect(
        runBenchmark({ output: directory, parameters: { repetitions: 5 } }),
      ).rejects.toThrow(/repetitions/);
      await expect(
        runBenchmark({ output: directory, parameters: { concurrencies: [0, 21] } }),
      ).rejects.toThrow(/concurrencies/);
      // Refused before the output directory was touched.
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses an output directory holding files it does not own", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vc456-output-"));
    try {
      await writeFile(join(directory, "notes.txt"), "someone else's");
      await expect(
        runBenchmark({ output: directory, parameters: { concurrencies: [1] } }),
      ).rejects.toThrow(/does not own/);
      expect(await readdir(directory)).toEqual(["notes.txt"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const output = process.env["VC456_OUTPUT"];
describe.runIf(output !== undefined)("VC-456 full matrix", () => {
  it("writes the report", async () => {
    const concurrencies = process.env["VC456_CONCURRENCIES"]?.split(",").map(Number);
    const repetitions = process.env["VC456_REPETITIONS"];
    const control = process.env["VC456_CONTROL"];
    const deltas = process.env["VC456_DELTAS"];
    const subscribers = process.env["VC456_SUBSCRIBERS"]?.split(",");
    const cliff = process.env["VC456_CLIFF"];
    const { failures } = await runBenchmark({
      output: output!,
      parameters: {
        ...(concurrencies === undefined ? {} : { concurrencies }),
        ...(repetitions === undefined ? {} : { repetitions: Number(repetitions) }),
        ...(control === "none" || control === "memory-artifacts" ? { control } : {}),
        ...(deltas === undefined ? {} : { deltasPerReply: Number(deltas) }),
        ...(subscribers === undefined ? {} : { subscribers: subscribers as Array<"all" | "none"> }),
        ...(cliff === undefined ? {} : { cliff: cliff !== "0" }),
      },
    });
    expect(failures).toEqual([]);
  });
});
