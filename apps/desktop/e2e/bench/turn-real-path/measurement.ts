/**
 * VC-456's runner: identical scripted turns at 1 / 5 / 15 / 20 in flight,
 * through the composition in `harness.ts`, summarized with VC-441's
 * `summarize` and written as `benchmark.json`, `benchmark.md` and
 * `run-manifest.json`.
 *
 * "In flight" means N Sessions each submitting one first turn at the same
 * moment, as one VC-441 wave did. Every arm gets a fresh disposable profile.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import {
  availableParallelism,
  cpus,
  freemem,
  homedir,
  loadavg,
  platform,
  release,
  totalmem,
} from "node:os";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { REAL_PATH_REQUEST_PLAN } from "@volli/agent-runtime/bench/turn-to-completion";

import { analyzeRealTurn, REAL_PATH_EXPECTED, summarizeTurns, type Distribution, type RealTurnSample } from "./analysis";
import { AUTHORITY_THINK_MS, createRealPathComposition, type ArtifactStoreKind } from "./harness";

export const FIXTURE_VERSION = "vc456-turn-real-path-v1";
const DEFAULT_CONCURRENCIES = [1, 5, 15, 20] as const;
const DEFAULT_REPETITIONS = 20;
const WARMUP_WAVES = 1;
const ARTIFACTS = ["benchmark.json", "benchmark.md", "run-manifest.json"] as const;

const round = (value: number): number => Number(value.toFixed(3));

export interface BenchmarkParameters {
  concurrencies: readonly number[];
  repetitions: number;
  /** Diagnostic arms run on the in-memory artifact store; `none` skips them. */
  control: "memory-artifacts" | "none";
}

export interface ArmReport {
  artifactStore: ArtifactStoreKind;
  concurrency: number;
  warmupWavesDiscarded: number;
  waves: number;
  summary: Record<string, unknown>;
  integrity: {
    networkAttempts: number;
    unscopedEnvelopes: number;
    runIdConflicts: number;
    providerRequests: Record<string, number>;
  };
  host: Record<string, unknown>;
}

function hostLoad(): number[] | null {
  return platform() === "win32" ? null : loadavg().map(round);
}

export async function runArm(input: {
  artifactStore: ArtifactStoreKind;
  concurrency: number;
  repetitions: number;
  /** Receives every analyzed sample, for tests that inspect them. */
  onSample?: (sample: RealTurnSample) => void;
}): Promise<ArmReport> {
  const { artifactStore, concurrency, repetitions } = input;
  const composition = await createRealPathComposition({ artifactStore });
  try {
    for (let wave = 0; wave < WARMUP_WAVES; wave += 1) {
      await composition.runWave({ concurrency, wave: -1 - wave });
    }
    const requestsBefore = { ...composition.requests() };
    const loopDelay = monitorEventLoopDelay({ resolution: 1 });
    loopDelay.enable();
    const loadBefore = hostLoad();
    const freeBefore = freemem();
    const cpuBefore = process.cpuUsage();
    const startedAt = performance.now();
    let peakRssBytes = process.memoryUsage.rss();
    const samples: RealTurnSample[] = [];
    for (let wave = 0; wave < repetitions; wave += 1) {
      const turns = await composition.runWave({ concurrency, wave });
      for (const [index, turn] of turns.entries()) {
        const sample = analyzeRealTurn(
          turn,
          `${artifactStore}-${concurrency}-${wave + 1}-${index + 1}`,
        );
        samples.push(sample);
        input.onSample?.(sample);
      }
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
    }
    const wallMs = performance.now() - startedAt;
    const cpu = process.cpuUsage(cpuBefore);
    loopDelay.disable();
    const requests = composition.requests();
    const providerRequests = Object.fromEntries(
      Object.entries(requests).map(([kind, count]) => [
        kind,
        count - requestsBefore[kind as keyof typeof requestsBefore],
      ]),
    );
    const toMs = (ns: number): number | null => (Number.isFinite(ns) ? round(ns / 1e6) : null);
    return {
      artifactStore,
      concurrency,
      warmupWavesDiscarded: WARMUP_WAVES,
      waves: repetitions,
      summary: summarizeTurns(samples),
      integrity: {
        networkAttempts: composition.networkAttempts(),
        unscopedEnvelopes: composition.unscopedEnvelopeCount(),
        runIdConflicts: composition.runIdConflictCount(),
        providerRequests,
      },
      host: {
        wallMs: round(wallMs),
        processCpuPercentOfOneCore: wallMs > 0 ? round(((cpu.user + cpu.system) / (wallMs * 1_000)) * 100) : null,
        eventLoopDelayMs: {
          p50: toMs(loopDelay.percentile(50)),
          p95: toMs(loopDelay.percentile(95)),
          max: toMs(loopDelay.max),
        },
        loadAverageBefore: loadBefore,
        loadAverageAfter: hostLoad(),
        freeMemoryBeforeBytes: freeBefore,
        freeMemoryAfterBytes: freemem(),
        peakRssBytes,
      },
    };
  } finally {
    await composition.close();
  }
}

/** Refuses a run whose harness could not vouch for what it measured. */
export function integrityFailures(arm: ArmReport): string[] {
  const failures: string[] = [];
  const label = `${arm.artifactStore}@${arm.concurrency}`;
  const summary = arm.summary as { turnSampleCount: number; completeTurnCount: number };
  if (arm.integrity.networkAttempts !== 0) failures.push(`${label}: network was attempted`);
  if (arm.integrity.unscopedEnvelopes !== 0)
    failures.push(`${label}: an envelope escaped every Session scope`);
  if (arm.integrity.runIdConflicts !== 0) failures.push(`${label}: a runId crossed Sessions`);
  if (summary.completeTurnCount !== summary.turnSampleCount)
    failures.push(`${label}: ${summary.turnSampleCount - summary.completeTurnCount} incomplete turns`);
  const turns = summary.turnSampleCount;
  for (const [kind, count] of Object.entries(arm.integrity.providerRequests)) {
    if (count !== turns) failures.push(`${label}: ${count} ${kind} requests for ${turns} turns`);
  }
  return failures;
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function environment(): Record<string, unknown> {
  return {
    nodeVersion: process.version,
    platform: platform(),
    osRelease: release(),
    architecture: process.arch,
    cpuModel: cpus()[0]?.model ?? "unknown",
    logicalCores: cpus().length,
    availableParallelism: availableParallelism(),
    totalMemoryBytes: totalmem(),
    uvThreadpoolSize: process.env["UV_THREADPOOL_SIZE"] ?? "4 (default)",
    gitSha: git(["rev-parse", "HEAD"]),
    dirty: (git(["status", "--porcelain"]) ?? "unavailable") !== "",
    initialLoadAverage: hostLoad(),
  };
}

async function prepareOutputDirectory(outputPath: string): Promise<string> {
  const directory = resolve(outputPath);
  const root = git(["rev-parse", "--show-toplevel"]);
  if (directory === root || directory === resolve("/") || directory === homedir()) {
    throw new Error("Output must be a dedicated child directory, not a repository, home or filesystem root.");
  }
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory);
  const allowed = new Set<string>(ARTIFACTS);
  if (entries.some((entry) => !allowed.has(entry))) {
    throw new Error(`Refusing to write into ${directory}: it holds files this benchmark does not own.`);
  }
  if (entries.length > 0) {
    let manifest: { fixtureVersion?: string };
    try {
      manifest = JSON.parse(await readFile(join(directory, "run-manifest.json"), "utf8")) as {
        fixtureVersion?: string;
      };
    } catch {
      throw new Error(`Refusing to replace output without this benchmark's manifest: ${directory}`);
    }
    if (manifest.fixtureVersion !== FIXTURE_VERSION) {
      throw new Error(`Refusing to replace output from another fixture version in ${directory}.`);
    }
  }
  return directory;
}

function fmt(distribution: Distribution | null | undefined, digits = 1): string {
  if (distribution === null || distribution === undefined) return "n/a";
  return `${distribution.p50.toFixed(digits)} / ${distribution.p95.toFixed(digits)}`;
}

type Summary = Record<string, Distribution | null> & {
  turnSampleCount: number;
  completeTurnCount: number;
  toolsByName: Record<string, Distribution | null>;
  timerLatenessMs: Record<string, Distribution | null>;
  crossCheck: {
    turnsWithAllFactsPaired: number;
    orderInversions: number;
    causalityViolations: number;
    streamMismatches: number;
  };
  vc119OrderViolations: number;
  ledgerShapes: Array<{ shape: string; turns: number }>;
};

function timingRow(arm: ArmReport): string {
  const s = arm.summary as Summary;
  const host = arm.host as {
    eventLoopDelayMs: { p95: number | null; max: number | null };
    processCpuPercentOfOneCore: number | null;
    loadAverageAfter: number[] | null;
  };
  return `| ${arm.concurrency} | ${s.turnSampleCount} | ${fmt(s["submitToAcceptedMs"])} | ${fmt(s["queuedMs"])} | ${fmt(s["turnStartDurableLagMs"])} | ${fmt(s["runtimeTurnMs"])} | ${fmt(s["firstMessageToCompletionMs"])} | ${fmt(s["submitToResolvedMs"])} | ${host.eventLoopDelayMs.p95 ?? "n/a"} / ${host.eventLoopDelayMs.max ?? "n/a"} | ${host.processCpuPercentOfOneCore ?? "n/a"} | ${host.loadAverageAfter?.[0] ?? "n/a"} |`;
}

function attributionRow(arm: ArmReport): string {
  const s = arm.summary as Summary;
  return `| ${arm.concurrency} | ${fmt(s["providerPerTurnMs"])} | ${fmt(s.toolsByName["read"])} | ${fmt(s.toolsByName["bash"])} | ${fmt(s["authorityWaitMs"])} | ${fmt(s["questionDeliveryMs"])} | ${fmt(s["answerCommandMs"])} | ${fmt(s["compactionDurationMs"])} | ${fmt(s["unaccountedGapMs"])} | ${fmt(s["artifactWriteMs"])} | ${fmt(s["artifactWriteTotalPerTurnMs"])} | ${fmt(s["ledgerServicePerTurnMs"], 2)} | ${fmt(s["ledgerTransactionWaitMs"], 2)} |`;
}

function checkRow(arm: ArmReport): string {
  const s = arm.summary as Summary;
  return `| ${arm.artifactStore} | ${arm.concurrency} | ${s.completeTurnCount} / ${s.turnSampleCount} | ${s.vc119OrderViolations} | ${s.crossCheck.turnsWithAllFactsPaired} | ${s.crossCheck.orderInversions} | ${s.crossCheck.causalityViolations} | ${s.crossCheck.streamMismatches} | ${s.ledgerShapes.length} | ${arm.integrity.networkAttempts} |`;
}

export function formatMarkdown(report: {
  generatedAt: string;
  environment: Record<string, unknown>;
  parameters: BenchmarkParameters;
  arms: ArmReport[];
}): string {
  const { concurrencies, repetitions, control } = report.parameters;
  const file = report.arms.filter((arm) => arm.artifactStore === "file");
  const memory = report.arms.filter((arm) => arm.artifactStore === "memory");
  const env = report.environment;
  const timingHeader =
    "| In flight | Turns | Submit → accepted | Submit → turn start (`queuedMs`) | `turn-queue` → durable `turn.started` | Runtime turn (VC-119) | First message → completion | Submit → `command()` resolved | Loop delay p95 / max (ms) | Runner CPU (% one core) | Load 1m after |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const attributionHeader =
    "| In flight | Provider per turn | `read` ×2 per turn | `bash` | Authority wait | Wait start → question seen | `interaction.resolve` round trip | Compaction | Unaccounted gap (runtime turn) | Artifact write, per call | Artifact writes, per turn | Ledger txn CPU per turn | Ledger txn queue wait |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const shape = (file[0]?.summary as Summary | undefined)?.ledgerShapes[0]?.shape ?? "n/a";
  const sections = [
    `# Agent turn critical path on the real Session path (VC-456)\n`,
    `Fixture \`${FIXTURE_VERSION}\` · generated ${report.generatedAt} · ${repetitions} measured waves per arm after ${WARMUP_WAVES} discarded warm-up wave · in flight ${concurrencies.join(" / ")}.\n`,
    `Reproduction: \`VC456_OUTPUT=$PWD/performance-results/vc-456-turn-real-path pnpm -C apps/desktop bench:turn-real-path\`.\n`,
    `All values are p50 / p95 in ms, nearest-rank, over individual turns. Turns in one wave share a host interval and are not independent.\n`,
    `## Production path (file transcript artifacts)\n`,
    timingHeader,
    ...file.map(timingRow),
    ``,
    attributionHeader,
    ...file.map(attributionRow),
    ``,
  ];
  if (memory.length > 0) {
    sections.push(
      `## Diagnostic control: in-memory transcript artifacts\n`,
      `Everything else identical: SQLite ledger, Pi sidecars, tools, gate, subscriber. Not a product configuration; it isolates what durable artifact publication costs.\n`,
      timingHeader,
      ...memory.map(timingRow),
      ``,
      attributionHeader,
      ...memory.map(attributionRow),
      ``,
    );
  }
  sections.push(
    `## Accounting and cross-checks\n`,
    `| Artifact store | In flight | Complete turns | VC-119 order violations | Turns with all 6 facts paired | Envelope/ledger order inversions | Causality violations | Live stream ≠ SQLite read-back | Distinct ledger shapes | Network attempts |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
    ...report.arms.map(checkRow),
    ``,
    `Ledger shape of a turn, \`command.recorded\` → \`turn.completed\`: \`${shape}\`.\n`,
    `## Method\n`,
    `- Composition: \`SessionRuntime\` + the desktop Pi adapter over \`createPiAgentRuntime\` + the desktop \`SqliteSessionLedger\` on a migrated \`volli.db\` opened by \`openVolliDb\`, the file transcript-artifact store, and one VC-119 sink shared by the Session runtime and the Pi runtime, as \`createDesktopSessionRuntime\` composes them. Differences: an Electron-free location resolver answering a fixed directory, and a fixed \`resolveRuntimeContext\`.\n`,
    `- Script per turn: a tool round (\`read\` inside the workspace, \`read\` outside it, \`bash printf\`), a provider overflow error, Pi's local overflow compaction, and a final reply. Provider stand-in timings per request: ${Object.values(REAL_PATH_REQUEST_PLAN).map((plan) => `${plan.kind} ${plan.serviceMs} ms (first event ${plan.ttftMs} ms)`).join(", ")}. Expected per turn: ${REAL_PATH_EXPECTED.modelAttempts} provider attempts, ${Object.values(REAL_PATH_EXPECTED.toolsByName).reduce((sum, count) => sum + count, 0)} tools, ${REAL_PATH_EXPECTED.authorityWaits} authority wait, ${REAL_PATH_EXPECTED.compactions} compaction, ${REAL_PATH_EXPECTED.retries} retry, ${REAL_PATH_EXPECTED.turnQueues} \`turn-queue\`.\n`,
    `- Authority: \`enforcement: "enforce"\` with a one-refusal fallback (the shipped default is \`observe\`, which installs no gate). The outside read is refused by \`path.outside-workspace\` and escalated; a live subscriber answers \`once\` via \`interaction.resolve\` after ${AUTHORITY_THINK_MS} ms.\n`,
    `- Clocks: \`queuedMs\` and every VC-119 duration come from the product's own \`Date.now\` clocks, so they have 1 ms resolution. Submit, frame arrival and envelope record times are the harness's \`performance.now()\`.\n`,
    `- Accepted is this command's durable \`command.recorded\` reaching a live subscriber. \`turn-queue\` → durable \`turn.started\` is one fact's ledger write and publish. Artifact and ledger timings wrap the real store and ledger and are filed per Session through \`AsyncLocalStorage\`, which also joins VC-119 envelopes to turns.\n`,
    `- Cross-check facts (VC-119 envelope ↔ ledger event): turn start (\`turn-queue\` ↔ \`turn.started\`), first attempt (first \`provider-attempt\` ↔ first \`usage.recorded\`), authority answer (wait-bearing \`authority\` ↔ \`interaction.resolved\`), compaction (\`compaction\` ↔ \`context.compacted\`), final attempt (last of each), turn end (\`turn\` ↔ \`turn.completed\`).\n`,
    `- ${control === "none" ? "No diagnostic control arm ran." : "The control arms swap only the transcript-artifact store for the in-memory one."}\n`,
    `Environment: Node ${String(env["nodeVersion"])} · ${String(env["platform"])} ${String(env["osRelease"])} · ${String(env["cpuModel"])} · ${String(env["logicalCores"])} logical cores · ${String(env["totalMemoryBytes"])} bytes RAM · UV_THREADPOOL_SIZE ${String(env["uvThreadpoolSize"])} · initial load ${JSON.stringify(env["initialLoadAverage"])} · commit ${String(env["gitSha"])} (dirty=${String(env["dirty"])}).\n`,
  );
  return sections.join("\n");
}

export async function runBenchmark(input: {
  output: string;
  parameters?: Partial<BenchmarkParameters>;
}): Promise<{ report: Record<string, unknown>; failures: string[] }> {
  const parameters: BenchmarkParameters = {
    concurrencies: input.parameters?.concurrencies ?? DEFAULT_CONCURRENCIES,
    repetitions: input.parameters?.repetitions ?? DEFAULT_REPETITIONS,
    control: input.parameters?.control ?? "memory-artifacts",
  };
  if (!Number.isInteger(parameters.repetitions) || parameters.repetitions < 20) {
    throw new Error("repetitions must be an integer >= 20 so p95 is not just a maximum.");
  }
  const { concurrencies } = parameters;
  if (
    concurrencies.length === 0 ||
    new Set(concurrencies).size !== concurrencies.length ||
    !concurrencies.every((value) => Number.isInteger(value) && value >= 1 && value <= 20)
  ) {
    throw new Error("concurrencies accepts unique integers from 1 through 20.");
  }
  const directory = await prepareOutputDirectory(input.output);
  const env = environment();
  const arms: ArmReport[] = [];
  const stores: ArtifactStoreKind[] = parameters.control === "none" ? ["file"] : ["file", "memory"];
  for (const artifactStore of stores) {
    for (const concurrency of concurrencies) {
      arms.push(await runArm({ artifactStore, concurrency, repetitions: parameters.repetitions }));
    }
  }
  const failures = arms.flatMap(integrityFailures);
  const generatedAt = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    fixtureVersion: FIXTURE_VERSION,
    generatedAt,
    environment: env,
    parameters: {
      ...parameters,
      warmupWaves: WARMUP_WAVES,
      authorityThinkMs: AUTHORITY_THINK_MS,
      expected: REAL_PATH_EXPECTED,
      requestPlan: REAL_PATH_REQUEST_PLAN,
    },
    integrityFailures: failures,
    arms,
  };
  // A run the harness cannot vouch for is not published.
  if (failures.length > 0) return { report, failures };
  const markdown = formatMarkdown({ generatedAt, environment: env, parameters, arms });
  const stamp = `${process.pid}-${Date.now()}`;
  const staged = [
    [`.benchmark-${stamp}.json`, "benchmark.json", `${JSON.stringify(report, null, 2)}\n`],
    [`.benchmark-${stamp}.md`, "benchmark.md", markdown],
    [
      `.manifest-${stamp}.json`,
      "run-manifest.json",
      `${JSON.stringify({ fixtureVersion: FIXTURE_VERSION, artifacts: ARTIFACTS }, null, 2)}\n`,
    ],
  ] as const;
  for (const [temporary, , contents] of staged) await writeFile(join(directory, temporary), contents);
  for (const [temporary, final] of staged) await rename(join(directory, temporary), join(directory, final));
  return { report, failures };
}
