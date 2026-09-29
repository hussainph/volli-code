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
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import {
  availableParallelism,
  cpus,
  freemem,
  homedir,
  loadavg,
  platform,
  release,
  tmpdir,
  totalmem,
} from "node:os";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { REAL_PATH_REQUEST_PLAN, summarize } from "@volli/agent-runtime/bench/turn-to-completion";

import {
  analyzeRealTurn,
  REAL_PATH_EXPECTED,
  summarizeTurns,
  type Distribution,
  type RealTurnSample,
} from "./analysis";
import {
  AUTHORITY_THINK_MS,
  createRealPathComposition,
  type ArtifactStoreKind,
  type WatchMode,
} from "./harness";

export const FIXTURE_VERSION = "vc456-turn-real-path-v1";
const DEFAULT_CONCURRENCIES = [1, 5, 15, 20] as const;
const DEFAULT_REPETITIONS = 20;
const WARMUP_WAVES = 1;
const DEFAULT_DELTAS_PER_REPLY = 8;
const ARTIFACTS = ["benchmark.json", "benchmark.md", "run-manifest.json"] as const;

const round = (value: number): number => Number(value.toFixed(3));

export interface BenchmarkParameters {
  concurrencies: readonly number[];
  repetitions: number;
  /**
   * `memory-artifacts` adds diagnostic arms on the in-memory artifact store;
   * `none` runs the production store only.
   */
  control: "memory-artifacts" | "none";
  /** Which subscriber postures to run: every Session watched, none, or both. */
  watch: readonly WatchMode[];
  /** Text deltas per stand-in reply. */
  deltasPerReply: number;
  /**
   * Adds the overlay-cache sweep: in-memory artifacts, both watch postures,
   * {@link CLIFF_DELTAS} deltas per reply, at {@link CLIFF_CONCURRENCIES} in
   * flight — either side of the Session runtime's eight-entry overlay cache.
   */
  cliff: boolean;
}

/** One side of the eight-entry overlay cache, the other, and the matrix's top. */
export const CLIFF_CONCURRENCIES = [8, 9, 20] as const;
/** VC-441's single-chunk-like reply against one that streams like a provider. */
export const CLIFF_DELTAS = [8, 256] as const;

export interface ArmReport {
  section: "matrix" | "cliff";
  artifactStore: ArtifactStoreKind;
  watch: WatchMode;
  deltasPerReply: number;
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
  section?: ArmReport["section"];
  artifactStore: ArtifactStoreKind;
  watch?: WatchMode;
  concurrency: number;
  repetitions: number;
  deltasPerReply?: number;
  /** Receives every analyzed sample, for tests that inspect them. */
  onSample?: (sample: RealTurnSample) => void;
}): Promise<ArmReport> {
  const { artifactStore, concurrency, repetitions } = input;
  const watch = input.watch ?? "all";
  const composition = await createRealPathComposition({
    artifactStore,
    watch,
    ...(input.deltasPerReply === undefined ? {} : { deltasPerReply: input.deltasPerReply }),
  });
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
    let measuredWallMs = 0;
    let measuredCpuMs = 0;
    for (let wave = 0; wave < repetitions; wave += 1) {
      const result = await composition.runWave({ concurrency, wave });
      measuredWallMs += result.measuredWallMs;
      measuredCpuMs += result.measuredCpuMs;
      for (const [index, turn] of result.turns.entries()) {
        const sample = analyzeRealTurn(
          turn,
          `${artifactStore}-${watch}-${concurrency}-${wave + 1}-${index + 1}`,
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
      section: input.section ?? "matrix",
      artifactStore,
      watch,
      deltasPerReply: input.deltasPerReply ?? DEFAULT_DELTAS_PER_REPLY,
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
        // The measured phases alone, without setup and teardown: what the
        // turns cost the one event loop, and how busy they kept it.
        measuredCpuMsPerTurn: samples.length > 0 ? round(measuredCpuMs / samples.length) : null,
        measuredCpuPercentOfOneCore:
          measuredWallMs > 0 ? round((measuredCpuMs / measuredWallMs) * 100) : null,
        processCpuPercentOfOneCore:
          wallMs > 0 ? round(((cpu.user + cpu.system) / (wallMs * 1_000)) * 100) : null,
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
  const label = `${arm.artifactStore}/${arm.watch}/${arm.deltasPerReply}d@${arm.concurrency}`;
  const summary = arm.summary as { turnSampleCount: number; completeTurnCount: number };
  if (arm.integrity.networkAttempts !== 0) failures.push(`${label}: network was attempted`);
  if (arm.integrity.unscopedEnvelopes !== 0)
    failures.push(`${label}: an envelope escaped every Session scope`);
  if (arm.integrity.runIdConflicts !== 0) failures.push(`${label}: a runId crossed Sessions`);
  if (summary.completeTurnCount !== summary.turnSampleCount)
    failures.push(
      `${label}: ${summary.turnSampleCount - summary.completeTurnCount} incomplete turns`,
    );
  const turns = summary.turnSampleCount;
  for (const [kind, count] of Object.entries(arm.integrity.providerRequests)) {
    if (count !== turns) failures.push(`${label}: ${count} ${kind} requests for ${turns} turns`);
  }
  return failures;
}

/**
 * How long one `FileHandle.sync()` takes on the volume the disposable profile
 * lives on, alone and with others in flight. The transcript-artifact store
 * syncs a file and its directory for every artifact it publishes, so this is
 * the unit its cost is made of. On macOS libuv implements `sync()` with
 * `F_FULLFSYNC`, which flushes the drive's cache.
 */
export async function probeFileSync(): Promise<Record<string, unknown>> {
  const directory = await mkdtemp(join(tmpdir(), "volli-vc456-fsync-"));
  let sequence = 0;
  const once = async (): Promise<number> => {
    sequence += 1;
    const handle = await open(join(directory, `probe-${sequence}`), "wx");
    try {
      await handle.writeFile("x".repeat(600));
      const startedAt = performance.now();
      await handle.sync();
      return performance.now() - startedAt;
    } finally {
      await handle.close();
    }
  };
  try {
    const sequential: number[] = [];
    for (let index = 0; index < 40; index += 1) sequential.push(await once());
    const startedAt = performance.now();
    const concurrent = await Promise.all(Array.from({ length: 40 }, () => once()));
    const concurrentWallMs = performance.now() - startedAt;
    return {
      sequentialMs: summarize(sequential),
      concurrent40Ms: summarize(concurrent),
      concurrent40WallMs: round(concurrentWallMs),
      concurrent40SyncsPerSecond: round((40 / concurrentWallMs) * 1_000),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
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
    throw new Error(
      "Output must be a dedicated child directory, not a repository, home or filesystem root.",
    );
  }
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory);
  const allowed = new Set<string>(ARTIFACTS);
  if (entries.some((entry) => !allowed.has(entry))) {
    throw new Error(
      `Refusing to write into ${directory}: it holds files this benchmark does not own.`,
    );
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
    commitMismatches: number;
    streamMismatches: number;
  };
  vc119OrderViolations: number;
  ledgerShapes: Array<{ shape: string; turns: number }>;
};

function timingRow(arm: ArmReport): string {
  const s = arm.summary as Summary;
  const host = arm.host as {
    eventLoopDelayMs: { p95: number | null; max: number | null };
    measuredCpuMsPerTurn: number | null;
    measuredCpuPercentOfOneCore: number | null;
    loadAverageAfter: number[] | null;
  };
  return `| ${arm.concurrency} | ${s.turnSampleCount} | ${fmt(s["submitToAcceptedMs"])} | ${fmt(s["queuedMs"])} | ${fmt(s["turnStartDurableLagMs"])} | ${fmt(s["runtimeTurnMs"])} | ${fmt(s["firstMessageToCompletionMs"])} | ${fmt(s["submitToResolvedMs"])} | ${fmt(s["subscriberLagMs"])} | ${host.eventLoopDelayMs.p95 ?? "n/a"} / ${host.eventLoopDelayMs.max ?? "n/a"} | ${host.measuredCpuMsPerTurn ?? "n/a"} | ${host.measuredCpuPercentOfOneCore ?? "n/a"} | ${host.loadAverageAfter?.[0] ?? "n/a"} |`;
}

function attributionRow(arm: ArmReport): string {
  const s = arm.summary as Summary;
  return `| ${arm.concurrency} | ${fmt(s["providerPerTurnMs"])} | ${fmt(s.toolsByName["read"])} | ${fmt(s.toolsByName["bash"])} | ${fmt(s["authorityWaitMs"])} | ${fmt(s["questionDeliveryMs"])} | ${fmt(s["answerCommandMs"])} | ${fmt(s["compactionDurationMs"])} | ${fmt(s["unaccountedGapMs"])} | ${fmt(s["artifactWriteMs"])} | ${fmt(s["artifactWriteTotalPerTurnMs"])} | ${fmt(s["ledgerReadsPerTurn"], 0)} | ${fmt(s["ledgerTransactionsPerTurn"], 0)} | ${fmt(s["ledgerServicePerTurnMs"], 2)} | ${fmt(s["ledgerTransactionWaitMs"], 2)} |`;
}

function checkRow(arm: ArmReport): string {
  const s = arm.summary as Summary;
  return `| ${arm.section} | ${arm.artifactStore} | ${arm.watch} | ${arm.deltasPerReply} | ${arm.concurrency} | ${s.completeTurnCount} / ${s.turnSampleCount} | ${s.vc119OrderViolations} | ${s.crossCheck.turnsWithAllFactsPaired} | ${s.crossCheck.orderInversions} | ${s.crossCheck.causalityViolations} | ${s.crossCheck.commitMismatches} | ${s.crossCheck.streamMismatches} | ${s.ledgerShapes.length} | ${arm.integrity.networkAttempts} |`;
}

function cliffRow(arm: ArmReport): string {
  const s = arm.summary as Summary;
  const host = arm.host as {
    measuredCpuMsPerTurn: number | null;
    measuredCpuPercentOfOneCore: number | null;
  };
  return `| ${arm.watch} | ${arm.deltasPerReply} | ${arm.concurrency} | ${fmt(s["ledgerReadsPerTurn"], 0)} | ${fmt(s["ledgerTransactionsPerTurn"], 0)} | ${fmt(s["ledgerServicePerTurnMs"], 1)} | ${host.measuredCpuMsPerTurn ?? "n/a"} | ${host.measuredCpuPercentOfOneCore ?? "n/a"} | ${fmt(s["runtimeTurnMs"])} | ${fmt(s["firstMessageToCompletionMs"])} |`;
}

function fileSyncLine(probe: unknown): string {
  if (typeof probe !== "object" || probe === null) return "not measured";
  const value = probe as {
    sequentialMs: Distribution | null;
    concurrent40Ms: Distribution | null;
    concurrent40WallMs: number;
    concurrent40SyncsPerSecond: number;
  };
  return `one at a time p50 / p95 ${fmt(value.sequentialMs, 2)} ms; 40 at once p50 / p95 ${fmt(value.concurrent40Ms, 1)} ms each, ${value.concurrent40WallMs} ms wall, ${value.concurrent40SyncsPerSecond} syncs/s`;
}

function sectionTitle(store: ArtifactStoreKind, watch: WatchMode): string {
  return `## ${store === "file" ? "Production path" : "Diagnostic control"}: ${store === "file" ? "file" : "in-memory"} transcript artifacts, ${watch === "all" ? "every Session watched" : "no Session watched"}\n`;
}

export function formatMarkdown(report: {
  generatedAt: string;
  environment: Record<string, unknown>;
  parameters: BenchmarkParameters;
  arms: ArmReport[];
}): string {
  const { concurrencies, repetitions, control } = report.parameters;
  const env = report.environment;
  const timingHeader =
    "| In flight | Turns | Submit → accepted | Submit → turn start (`queuedMs`) | `turn-queue` → `turn.started` committed | Runtime turn (VC-119) | First message → completion | Submit → `command()` resolved | Commit → subscriber (`turn.completed`) | Loop delay p95 / max (ms) | CPU per turn (ms) | Loop busy (% one core) | Load 1m after |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const attributionHeader =
    "| In flight | Provider per turn | `read` ×2 per turn | `bash` | Authority wait | Wait start → question seen | `interaction.resolve` round trip | Compaction | Unaccounted gap (runtime turn) | Artifact write, per call | Artifact writes, per turn | Ledger reads per turn | Ledger txns per turn | Ledger txn CPU per turn | Ledger txn queue wait |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const shape = (report.arms[0]?.summary as Summary | undefined)?.ledgerShapes[0]?.shape ?? "n/a";
  const sections = [
    `# Agent turn critical path on the real Session path (VC-456)\n`,
    `Fixture \`${FIXTURE_VERSION}\` · generated ${report.generatedAt} · ${repetitions} measured waves per arm after ${WARMUP_WAVES} discarded warm-up wave · in flight ${concurrencies.join(" / ")}.\n`,
    `Reproduction: \`VC456_OUTPUT=$PWD/performance-results/vc-456-turn-real-path pnpm -C apps/desktop bench:turn-real-path\`.\n`,
    `All values are p50 / p95 in ms, nearest-rank, over individual turns. Turns in one wave share a host interval and are not independent. "Watched" means a live subscriber per Session, as a chat open in a tab; "no Session watched" is Sessions working in the background.\n`,
  ];
  const groups = new Map<string, ArmReport[]>();
  for (const arm of report.arms.filter(({ section }) => section === "matrix")) {
    const key = `${arm.artifactStore}|${arm.watch}`;
    groups.set(key, [...(groups.get(key) ?? []), arm]);
  }
  for (const arms of groups.values()) {
    const first = arms[0]!;
    sections.push(sectionTitle(first.artifactStore, first.watch));
    if (first.artifactStore === "memory") {
      sections.push(
        `Everything else identical: SQLite ledger, Pi sidecars, tools, gate, subscribers. Not a product configuration; it isolates what durable artifact publication costs.\n`,
      );
    }
    sections.push(
      timingHeader,
      ...arms.map(timingRow),
      ``,
      attributionHeader,
      ...arms.map(attributionRow),
      ``,
    );
  }
  const cliff = report.arms.filter(({ section }) => section === "cliff");
  if (cliff.length > 0) {
    sections.push(
      `## Overlay cache sweep: either side of eight Sessions streaming\n`,
      `In-memory artifacts (so bottleneck 1 is out of the way), ${repetitions} waves per row. The Session runtime keeps a live overlay for at most eight Sessions (\`OVERLAY_CACHE_LIMIT\`), and a fold for at most eight unwatched ones (\`PROJECTION_CACHE_LIMIT\`).\n`,
      `| Watched | Deltas per reply | In flight | Ledger reads per turn | Ledger txns per turn | Ledger txn CPU per turn | CPU per turn (ms) | Loop busy (% one core) | Runtime turn | First message → completion |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
      ...cliff.map(cliffRow),
      ``,
    );
  }
  sections.push(
    `## Accounting and cross-checks\n`,
    `| Section | Artifact store | Watched | Deltas | In flight | Complete turns | VC-119 order violations | Turns with all 6 facts paired | Envelope/ledger order inversions | Causality violations | Commits ≠ SQLite read-back | Live stream ≠ SQLite read-back | Distinct ledger shapes | Network attempts |\n| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
    ...report.arms.map(checkRow),
    ``,
    `Ledger shape of a turn, \`command.recorded\` → \`turn.completed\`: \`${shape}\`.\n`,
    `## Method\n`,
    `- Composition: \`SessionRuntime\` + the desktop Pi adapter over \`createPiAgentRuntime\` + the desktop \`SqliteSessionLedger\` on a migrated \`volli.db\` opened by \`openVolliDb\`, the file transcript-artifact store, and one VC-119 sink shared by the Session runtime and the Pi runtime, as \`createDesktopSessionRuntime\` composes them. Differences: an Electron-free location resolver answering a fixed directory, and a fixed \`resolveRuntimeContext\`.\n`,
    `- Script per turn (${report.parameters.deltasPerReply} text deltas per reply): a tool round (\`read\` inside the workspace, \`read\` outside it, \`bash printf\`), a provider overflow error, Pi's local overflow compaction, and a final reply. Provider stand-in timings per request: ${Object.values(
      REAL_PATH_REQUEST_PLAN,
    )
      .map((plan) => `${plan.kind} ${plan.serviceMs} ms (first event ${plan.ttftMs} ms)`)
      .join(
        ", ",
      )}. Expected per turn: ${REAL_PATH_EXPECTED.modelAttempts} provider attempts, ${Object.values(REAL_PATH_EXPECTED.toolsByName).reduce((sum, count) => sum + count, 0)} tools, ${REAL_PATH_EXPECTED.authorityWaits} authority wait, ${REAL_PATH_EXPECTED.compactions} compaction, ${REAL_PATH_EXPECTED.retries} retry, ${REAL_PATH_EXPECTED.turnQueues} \`turn-queue\`.\n`,
    `- Authority: \`enforcement: "enforce"\` with a one-refusal fallback (the shipped default is \`observe\`, which installs no gate). The outside read is refused by \`path.outside-workspace\` and escalated; a live subscriber answers \`once\` via \`interaction.resolve\` after ${AUTHORITY_THINK_MS} ms.\n`,
    `- Clocks: \`queuedMs\` and every VC-119 duration come from the product's own \`Date.now\` clocks, so they have 1 ms resolution. Submit, frame arrival and envelope record times are the harness's \`performance.now()\`.\n`,
    `- Accepted is this command's \`command.recorded\` committed: the engine call that wrote it resolved. Commit times are read when \`SessionEngine.observe\` / \`submit\` resolve and are checked against the SQLite read-back. \`turn-queue\` → \`turn.started\` committed is one fact's durable write; commit → subscriber is its publish. Artifact and ledger timings wrap the real store and ledger and are filed per Session through \`AsyncLocalStorage\`, which also joins VC-119 envelopes to turns.\n`,
    `- Cross-check facts (VC-119 envelope ↔ ledger event): turn start (\`turn-queue\` ↔ \`turn.started\`), first attempt (first \`provider-attempt\` ↔ first \`usage.recorded\`), authority answer (wait-bearing \`authority\` ↔ \`interaction.resolved\`), compaction (\`compaction\` ↔ \`context.compacted\`), final attempt (last of each), turn end (\`turn\` ↔ \`turn.completed\`).\n`,
    `- ${control === "none" ? "No diagnostic control arm ran." : "The control arms swap only the transcript-artifact store for the in-memory one."} Unwatched arms have no subscriber; their stand-in person answers when \`interaction.opened\` commits.\n`,
    `File sync on the profile's volume (\`FileHandle.sync()\`, 600-byte file): ${fileSyncLine(env["fileSyncProbe"])}.\n`,
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
    deltasPerReply: input.parameters?.deltasPerReply ?? DEFAULT_DELTAS_PER_REPLY,
    watch: input.parameters?.watch ?? ["all", "none"],
    cliff: input.parameters?.cliff ?? true,
  };
  if (
    parameters.watch.length === 0 ||
    !parameters.watch.every((mode) => mode === "all" || mode === "none")
  ) {
    throw new Error("watch accepts all and/or none.");
  }
  if (!Number.isInteger(parameters.deltasPerReply) || parameters.deltasPerReply < 1) {
    throw new Error("deltasPerReply must be a positive integer.");
  }
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
  const env = { ...environment(), fileSyncProbe: await probeFileSync() };
  const arms: ArmReport[] = [];
  const stores: ArtifactStoreKind[] = parameters.control === "none" ? ["file"] : ["file", "memory"];
  for (const artifactStore of stores) {
    for (const watch of parameters.watch) {
      for (const concurrency of concurrencies) {
        arms.push(
          await runArm({
            artifactStore,
            watch,
            concurrency,
            repetitions: parameters.repetitions,
            deltasPerReply: parameters.deltasPerReply,
          }),
        );
      }
    }
  }
  if (parameters.cliff) {
    for (const watch of ["all", "none"] as const) {
      for (const deltasPerReply of CLIFF_DELTAS) {
        for (const concurrency of CLIFF_CONCURRENCIES) {
          arms.push(
            await runArm({
              section: "cliff",
              artifactStore: "memory",
              watch,
              concurrency,
              repetitions: parameters.repetitions,
              deltasPerReply,
            }),
          );
        }
      }
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
  for (const [temporary, , contents] of staged)
    await writeFile(join(directory, temporary), contents);
  for (const [temporary, final] of staged)
    await rename(join(directory, temporary), join(directory, final));
  return { report, failures };
}
