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
 * `VC456_REPETITIONS` (default 20), `VC456_CONCURRENCIES` (default 1,5,15,20)
 * and `VC456_CONTROL` (`memory-artifacts` or `none`) tune the matrix.
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
  type LedgerFrame,
  type RawTurn,
  type RecordedEnvelope,
} from "./harness";
import { formatMarkdown, integrityFailures, runArm, runBenchmark } from "./measurement";

const COMMAND = "command-1";

function envelope(event: ObservabilityEvent, order: number, recordedAt: number): RecordedEnvelope {
  return { event, order, recordedAt, sessionId: "session-1" };
}

const RUN = { runId: "run-1" };
/** One turn's six paired facts in causal order on both sides. */
function consistentTurn(): {
  envelopes: RecordedEnvelope[];
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
  return { envelopes, frames, ledger };
}

describe("VC-456 ledger cross-check", () => {
  it("pairs all six facts and finds nothing wrong in a consistent turn", () => {
    const check = crossCheckLedger({ commandId: COMMAND, ...consistentTurn() });
    expect(check.missing).toEqual([]);
    expect(check.paired).toHaveLength(6);
    expect(check.orderInversions).toBe(0);
    expect(check.causalityViolations).toEqual([]);
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

  it("flags a live stream that skipped a durable fact", () => {
    const turn = consistentTurn();
    turn.frames.splice(3, 1);
    expect(crossCheckLedger({ commandId: COMMAND, ...turn }).streamMatchesLedger).toBe(false);
  });
});

describe("VC-456 real-path smoke", () => {
  it("runs scripted turns through the real path with complete, ordered, content-free accounting", async () => {
    const composition = await createRealPathComposition();
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
      expect(sample.toolsByName["bash"]?.count).toBe(1);
      expect(sample.authorityWaitCount).toBe(1);
      expect(sample.compactionCount).toBe(1);
      expect(sample.retryCount).toBe(1);
      // The Session runtime's own queue measurement, not a fixture timer.
      expect(sample.submissionToTurnStartMs).not.toBeNull();
      expect(sample.crossCheck.missing).toEqual([]);
      expect(sample.crossCheck.orderInversions).toBe(0);
      expect(sample.crossCheck.causalityViolations).toEqual([]);
      expect(sample.crossCheck.streamMatchesLedger).toBe(true);
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
  });

  it("publishes nothing from an arm whose harness could not vouch for it", async () => {
    const arm = await runArm({ artifactStore: "memory", concurrency: 1, repetitions: 1 });
    expect(integrityFailures(arm)).toEqual([]);
    const tampered = { ...arm, integrity: { ...arm.integrity, networkAttempts: 1 } };
    expect(integrityFailures(tampered)).toEqual(["memory@1: network was attempted"]);
    const markdown = formatMarkdown({
      generatedAt: "now",
      environment: {},
      parameters: { concurrencies: [1], repetitions: 1, control: "none" },
      arms: [arm],
    });
    expect(markdown).not.toContain(PRIVATE_CONTENT_CANARY);
  });
});

describe("VC-456 runner guards", () => {
  it("refuses too few repetitions and out-of-range concurrency before running", async () => {
    await expect(
      runBenchmark({ output: join(tmpdir(), "vc456-never"), parameters: { repetitions: 5 } }),
    ).rejects.toThrow(/repetitions/);
    await expect(
      runBenchmark({
        output: join(tmpdir(), "vc456-never"),
        parameters: { concurrencies: [0, 21] },
      }),
    ).rejects.toThrow(/concurrencies/);
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
    const { failures } = await runBenchmark({
      output: output!,
      parameters: {
        ...(concurrencies === undefined ? {} : { concurrencies }),
        ...(repetitions === undefined ? {} : { repetitions: Number(repetitions) }),
        ...(control === "none" || control === "memory-artifacts" ? { control } : {}),
      },
    });
    expect(failures).toEqual([]);
  });
});
