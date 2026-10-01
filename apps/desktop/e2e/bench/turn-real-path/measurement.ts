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
import { dirname, join, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DELTAS_PER_REPLY,
  REAL_PATH_REQUEST_PLAN,
} from "@volli/agent-runtime/bench/turn-to-completion";

import {
  analyzeRealTurn,
  REAL_PATH_EXPECTED,
  round,
  summarizeTurns,
  type Distribution,
  type RealTurnSample,
  type TurnSummary,
} from "./analysis";
import { AUTHORITY_THINK_MS, type SubscriberMode } from "./constants";
import { createRealPathComposition, type ArtifactStoreKind } from "./harness";

export const FIXTURE_VERSION = "vc456-turn-real-path-v2";
const DEFAULT_CONCURRENCIES = [1, 5, 15, 20] as const;
const DEFAULT_REPETITIONS = 20;
const WARMUP_WAVES = 1;
const ARTIFACTS = ["benchmark.json", "benchmark.md", "run-manifest.json"] as const;
const FSYNC_PROBE = join(dirname(fileURLToPath(import.meta.url)), "fsync-probe.mjs");

export interface BenchmarkParameters {
  concurrencies: readonly number[];
  repetitions: number;
  /**
   * `memory-artifacts` adds diagnostic arms on the in-memory artifact store;
   * `none` runs the production store only.
   */
  control: "memory-artifacts" | "none";
  /** Which subscriber postures to run: every Session subscribed, none, or both. */
  subscribers: readonly SubscriberMode[];
  /** Text deltas per stand-in reply. */
  deltasPerReply: number;
  /**
   * Adds the overlay-cache sweep: in-memory artifacts, both subscriber
   * postures, {@link CLIFF_DELTAS} deltas per reply, at
   * {@link CLIFF_CONCURRENCIES} in flight — either side of the Session
   * runtime's eight-entry overlay cache.
   */
  cliff: boolean;
}

/** One side of the eight-entry overlay cache, the other, and the matrix's top. */
export const CLIFF_CONCURRENCIES = [8, 9, 20] as const;
/** The matrix's reply against one that streams more like a provider's. */
export const CLIFF_DELTAS = [8, 256] as const;

export interface ArmHost {
  wallMs: number;
  /**
   * Process CPU (user + system, so the libuv thread pool's work too) over the
   * measured phases only, per turn and as a share of one core.
   */
  measuredCpuMsPerTurn: number | null;
  measuredCpuPercentOfOneCore: number | null;
  eventLoopDelayMs: { p50: number | null; p95: number | null; max: number | null };
  loadAverageBefore: number[] | null;
  loadAverageAfter: number[] | null;
  freeMemoryBeforeBytes: number;
  freeMemoryAfterBytes: number;
  peakRssBytes: number;
}

export interface ArmReport {
  section: "matrix" | "cliff";
  artifactStore: ArtifactStoreKind;
  subscribers: SubscriberMode;
  deltasPerReply: number;
  concurrency: number;
  warmupWavesDiscarded: number;
  waves: number;
  summary: TurnSummary;
  integrity: {
    networkAttempts: number;
    unscopedEnvelopes: number;
    runIdConflicts: number;
    providerRequests: Record<string, number>;
  };
  host: ArmHost;
}

/** The same file-sync probe, once under the default pool and once under 64 threads. */
export interface FileSyncProbe {
  uvThreadpoolSize: string;
  count: number;
  oneAtATimeP50Ms: number;
  oneAtATimeP95Ms: number;
  /** The syncs' own durations, one after another, summed. */
  oneAtATimeSyncTotalMs: number;
  concurrentWallMs: number;
  concurrentSyncsPerSecond: number;
  /** One-at-a-time sync total over the all-at-once wall: how many ran side by side. */
  parallelism: number;
}

export interface BenchmarkEnvironment {
  nodeVersion: string;
  platform: string;
  osRelease: string;
  architecture: string;
  cpuModel: string;
  logicalCores: number;
  availableParallelism: number;
  totalMemoryBytes: number;
  uvThreadpoolSize: string;
  gitSha: string;
  dirty: boolean;
  initialLoadAverage: number[] | null;
  fileSyncProbes: FileSyncProbe[];
}

function toMs(ns: number): number | null {
  return Number.isFinite(ns) ? round(ns / 1e6) : null;
}

function hostLoad(): number[] | null {
  return platform() === "win32" ? null : loadavg().map(round);
}

export async function runArm(input: {
  section?: ArmReport["section"];
  artifactStore: ArtifactStoreKind;
  subscribers?: SubscriberMode;
  concurrency: number;
  repetitions: number;
  deltasPerReply?: number;
  /** Receives every analyzed sample, for tests that inspect them. */
  onSample?: (sample: RealTurnSample) => void;
}): Promise<ArmReport> {
  const { artifactStore, concurrency, repetitions } = input;
  const subscribers = input.subscribers ?? "all";
  const deltasPerReply = input.deltasPerReply ?? DEFAULT_DELTAS_PER_REPLY;
  const composition = await createRealPathComposition({
    artifactStore,
    subscribers,
    deltasPerReply,
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
          `${artifactStore}-${subscribers}-${deltasPerReply}-${concurrency}-${wave + 1}-${index + 1}`,
        );
        samples.push(sample);
        input.onSample?.(sample);
      }
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
    }
    const wallMs = performance.now() - startedAt;
    loopDelay.disable();
    const requests = composition.requests();
    const providerRequests = Object.fromEntries(
      Object.entries(requests).map(([kind, count]) => [
        kind,
        count - requestsBefore[kind as keyof typeof requestsBefore],
      ]),
    );
    return {
      section: input.section ?? "matrix",
      artifactStore,
      subscribers,
      deltasPerReply,
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
        measuredCpuMsPerTurn: samples.length > 0 ? round(measuredCpuMs / samples.length) : null,
        measuredCpuPercentOfOneCore:
          measuredWallMs > 0 ? round((measuredCpuMs / measuredWallMs) * 100) : null,
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

export function armLabel(arm: ArmReport): string {
  return `${arm.artifactStore}/${arm.subscribers}/${arm.deltasPerReply}d@${arm.concurrency}`;
}

/**
 * Refuses a run whose harness could not vouch for what it measured, or whose
 * two views of a turn disagree. VC-441's runner stopped on an order violation
 * because its script fixes the order; this script fixes the ledger's too, so a
 * disagreement is something to investigate before any number is published.
 */
export function integrityFailures(arm: ArmReport): string[] {
  const failures: string[] = [];
  const label = armLabel(arm);
  const { summary } = arm;
  const turns = summary.turnSampleCount;
  if (arm.integrity.networkAttempts !== 0) failures.push(`${label}: network was attempted`);
  if (arm.integrity.unscopedEnvelopes !== 0)
    failures.push(`${label}: an envelope escaped every Session scope`);
  if (arm.integrity.runIdConflicts !== 0) failures.push(`${label}: a runId crossed Sessions`);
  if (summary.completeTurnCount !== turns)
    failures.push(`${label}: ${turns - summary.completeTurnCount} incomplete turns`);
  if (summary.vc119OrderViolations !== 0)
    failures.push(`${label}: ${summary.vc119OrderViolations} VC-119 order violations`);
  if (summary.crossCheck.orderInversions !== 0)
    failures.push(`${label}: ${summary.crossCheck.orderInversions} envelope/ledger inversions`);
  if (summary.crossCheck.causalityViolations !== 0)
    failures.push(`${label}: ${summary.crossCheck.causalityViolations} causality violations`);
  if (summary.crossCheck.commitMismatches !== 0)
    failures.push(`${label}: ${summary.crossCheck.commitMismatches} commit/read-back mismatches`);
  if (summary.crossCheck.streamMismatches !== 0)
    failures.push(`${label}: ${summary.crossCheck.streamMismatches} stream/read-back mismatches`);
  if (summary.ledgerShapes.length > 1)
    failures.push(`${label}: ${summary.ledgerShapes.length} different ledger shapes`);
  for (const [kind, count] of Object.entries(arm.integrity.providerRequests)) {
    if (count !== turns) failures.push(`${label}: ${count} ${kind} requests for ${turns} turns`);
  }
  return failures;
}

function probeFileSync(uvThreadpoolSize: string | undefined): FileSyncProbe {
  const probeEnvironment: NodeJS.ProcessEnv = { ...process.env };
  if (uvThreadpoolSize === undefined) delete probeEnvironment["UV_THREADPOOL_SIZE"];
  else probeEnvironment["UV_THREADPOOL_SIZE"] = uvThreadpoolSize;
  return JSON.parse(
    execFileSync(process.execPath, [FSYNC_PROBE], { encoding: "utf8", env: probeEnvironment }),
  ) as FileSyncProbe;
}

/** Git output, or a thrown error: a guard that reads it must not be skipped silently. */
function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function environment(fileSyncProbes: FileSyncProbe[]): BenchmarkEnvironment {
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
    dirty: git(["status", "--porcelain"]) !== "",
    initialLoadAverage: hostLoad(),
    fileSyncProbes,
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

function timingRow(arm: ArmReport): string {
  const { summary: s, host } = arm;
  return `| ${arm.concurrency} | ${s.turnSampleCount} | ${fmt(s.submitToAcceptedMs)} | ${fmt(s.queuedMs)} | ${fmt(s.turnStartDurableLagMs)} | ${fmt(s.runtimeTurnMs)} | ${fmt(s.firstMessageToCompletionMs)} | ${fmt(s.submitToResolvedMs)} | ${fmt(s.subscriberLagMs, 2)} | ${host.eventLoopDelayMs.p95 ?? "n/a"} / ${host.eventLoopDelayMs.max ?? "n/a"} | ${host.measuredCpuMsPerTurn ?? "n/a"} | ${host.measuredCpuPercentOfOneCore ?? "n/a"} | ${host.loadAverageAfter?.[0] ?? "n/a"} |`;
}

function attributionRow(arm: ArmReport): string {
  const s = arm.summary;
  return `| ${arm.concurrency} | ${fmt(s.providerPerTurnMs)} | ${fmt(s.toolsByName["read"])} | ${fmt(s.toolsByName["bash"])} | ${fmt(s.authorityWaitMs)} | ${fmt(s.questionDeliveryMs)} | ${fmt(s.answerCommandMs)} | ${fmt(s.compactionDurationMs)} | ${fmt(s.unaccountedGapMs)} | ${fmt(s.artifactWriteMs)} | ${fmt(s.artifactWriteTotalPerTurnMs)} | ${fmt(s.ledgerReadsPerTurn, 0)} | ${fmt(s.ledgerTransactionsPerTurn, 0)} | ${fmt(s.ledgerServicePerTurnMs, 2)} | ${fmt(s.ledgerTransactionWaitMs, 2)} |`;
}

function checkRow(arm: ArmReport): string {
  const s = arm.summary;
  return `| ${arm.section} | ${arm.artifactStore} | ${arm.subscribers} | ${arm.deltasPerReply} | ${arm.concurrency} | ${s.completeTurnCount} / ${s.turnSampleCount} | ${s.vc119OrderViolations} | ${s.crossCheck.turnsWithAllFactsPaired} | ${s.crossCheck.orderInversions} | ${s.crossCheck.causalityViolations} | ${s.crossCheck.commitMismatches} | ${s.crossCheck.streamMismatches} | ${s.ledgerShapes.length} | ${arm.integrity.networkAttempts} |`;
}

function cliffRow(arm: ArmReport): string {
  const { summary: s, host } = arm;
  return `| ${arm.subscribers} | ${arm.deltasPerReply} | ${arm.concurrency} | ${fmt(s.ledgerReadsPerTurn, 0)} | ${fmt(s.ledgerTransactionsPerTurn, 0)} | ${fmt(s.ledgerServicePerTurnMs, 1)} | ${host.measuredCpuMsPerTurn ?? "n/a"} | ${host.measuredCpuPercentOfOneCore ?? "n/a"} | ${fmt(s.providerPerTurnMs)} | ${fmt(s.runtimeTurnMs)} | ${fmt(s.firstMessageToCompletionMs)} |`;
}

function fileSyncRow(probe: FileSyncProbe): string {
  return `| ${probe.uvThreadpoolSize} | ${probe.oneAtATimeP50Ms} / ${probe.oneAtATimeP95Ms} | ${probe.oneAtATimeSyncTotalMs} | ${probe.concurrentWallMs} | ${probe.concurrentSyncsPerSecond} | ${probe.parallelism}× |`;
}

function sectionTitle(store: ArtifactStoreKind, subscribers: SubscriberMode): string {
  return `## ${store === "file" ? "Production path" : "Diagnostic control"}: ${store === "file" ? "file" : "in-memory"} transcript artifacts, ${subscribers === "all" ? "every Session subscribed" : "no subscribers"}\n`;
}

export function formatMarkdown(report: {
  generatedAt: string;
  environment: BenchmarkEnvironment;
  parameters: BenchmarkParameters;
  arms: ArmReport[];
}): string {
  const { concurrencies, repetitions, control } = report.parameters;
  const env = report.environment;
  const timingHeader =
    "| In flight | Turns | Submit → accepted | Submit → turn start (`queuedMs`) | `turn-queue` → `turn.started` committed | Runtime turn (VC-119) | First message → completion | Submit → `command()` resolved | Commit → subscriber (`turn.completed`) | Loop delay p95 / max (ms) | Process CPU per turn (ms) | Process CPU (% one core) | Load 1m after |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const attributionHeader =
    "| In flight | Provider per turn (VC-119) | `read` ×2 per turn | `bash` | Authority wait | Wait start → question seen | `interaction.resolve` round trip | Compaction | Unaccounted gap (runtime turn) | Artifact write, per call | Artifact writes, per turn | Ledger reads per turn | Ledger txns per turn | Ledger txn CPU per turn | Ledger txn queue wait |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const shape = report.arms[0]?.summary.ledgerShapes[0]?.shape ?? "n/a";
  const sections = [
    `# Agent turn critical path on the real Session path (VC-456)\n`,
    `Fixture \`${FIXTURE_VERSION}\` · generated ${report.generatedAt} · ${repetitions} measured waves per arm after ${WARMUP_WAVES} discarded warm-up wave · in flight ${concurrencies.join(" / ")}.\n`,
    `Reproduction: \`VC456_OUTPUT=$PWD/performance-results/vc-456-turn-real-path pnpm -C apps/desktop bench:turn-real-path\`.\n`,
    `All values are p50 / p95 in ms, nearest-rank, over individual turns. Turns in one wave share a host interval and are not independent. "Every Session subscribed" means one live \`SessionRuntime.subscribe\` listener per Session, as a chat open in a tab; "no subscribers" is Sessions working in the background.\n`,
  ];
  const groups = new Map<string, ArmReport[]>();
  for (const arm of report.arms.filter(({ section }) => section === "matrix")) {
    const key = `${arm.artifactStore}|${arm.subscribers}`;
    groups.set(key, [...(groups.get(key) ?? []), arm]);
  }
  for (const arms of groups.values()) {
    const first = arms[0]!;
    sections.push(sectionTitle(first.artifactStore, first.subscribers));
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
      `In-memory artifacts (so bottleneck 1 is out of the way), ${repetitions} waves per row. The Session runtime keeps a live overlay for at most eight Sessions (\`OVERLAY_CACHE_LIMIT\`), and a fold for at most eight Sessions without a subscriber (\`PROJECTION_CACHE_LIMIT\`).\n`,
      `| Subscribers | Deltas per reply | In flight | Ledger reads per turn | Ledger txns per turn | Ledger txn CPU per turn | Process CPU per turn (ms) | Process CPU (% one core) | Provider per turn (VC-119) | Runtime turn | First message → completion |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
      ...cliff.map(cliffRow),
      ``,
    );
  }
  sections.push(
    `## Accounting and cross-checks\n`,
    `| Section | Artifact store | Subscribers | Deltas | In flight | Complete turns | VC-119 order violations | Turns with all 6 facts paired | Envelope/ledger order inversions | Causality violations | Commits ≠ SQLite read-back | Live stream ≠ SQLite read-back | Distinct ledger shapes | Network attempts |\n| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
    ...report.arms.map(checkRow),
    ``,
    `Ledger shape of a turn, \`command.recorded\` → \`turn.completed\`: \`${shape}\`.\n`,
    `## File sync on the profile's volume\n`,
    `\`FileHandle.sync()\` on a 600-byte file, ${env.fileSyncProbes[0]?.count ?? 40} one at a time and then all at once, in a separate process per libuv pool size. On macOS libuv implements it with \`F_FULLFSYNC\`. Parallelism is the one-at-a-time syncs' summed time over the all-at-once wall: how many ran side by side. If the pool were the limit, 64 threads would raise it well above 4's.\n`,
    `| UV_THREADPOOL_SIZE | One sync p50 / p95 (ms) | One at a time, syncs summed (ms) | All at once, wall (ms) | Syncs/s at once | Parallelism |\n| --- | ---: | ---: | ---: | ---: | ---: |`,
    ...env.fileSyncProbes.map(fileSyncRow),
    ``,
    `## Method\n`,
    `- Composition: \`SessionRuntime\` + the desktop Pi adapter over \`createPiAgentRuntime\` + the desktop \`SqliteSessionLedger\` on a migrated \`volli.db\` opened by \`openVolliDb\`, the file transcript-artifact store, and one VC-119 sink shared by the Session runtime and the Pi runtime, as \`createDesktopSessionRuntime\` composes them. Differences: an Electron-free location resolver answering a fixed directory, a fixed \`resolveRuntimeContext\`, and no connectivity, compaction-policy, execution-environment, web, browser, shell or MCP host options (Pi's defaults apply).\n`,
    `- Script per turn (${report.parameters.deltasPerReply} text deltas per reply): a tool round (\`read\` inside the workspace, \`read\` outside it, \`write\` outside it, \`bash printf\`), a provider overflow error, Pi's local overflow compaction, and a final reply. Provider stand-in timings per request: ${Object.values(
      REAL_PATH_REQUEST_PLAN,
    )
      .map((plan) => `${plan.kind} ${plan.serviceMs} ms (first event ${plan.ttftMs} ms)`)
      .join(
        ", ",
      )}. Expected per turn: ${REAL_PATH_EXPECTED.modelAttempts} provider attempts, ${Object.values(REAL_PATH_EXPECTED.toolsByName).reduce((sum, count) => sum + count, 0)} tools, ${REAL_PATH_EXPECTED.authorityWaits} authority wait, ${REAL_PATH_EXPECTED.compactions} compaction, ${REAL_PATH_EXPECTED.retries} retry, ${REAL_PATH_EXPECTED.turnQueues} \`turn-queue\`.\n`,
    `- Authority: \`enforcement: "enforce"\` with a one-refusal fallback (the shipped default is \`observe\`, which installs no gate). The outside write is refused by \`path.outside-workspace\` and escalated (reads off the secrets denylist are not refused since VC-45); a stand-in person answers \`once\` via \`interaction.resolve\` ${AUTHORITY_THINK_MS} ms after the question reaches them — from their live stream when subscribed, when \`interaction.opened\` commits otherwise.\n`,
    `- Clocks: \`queuedMs\` and every VC-119 duration come from the product's own \`Date.now\` clocks, so they have 1 ms resolution. Submit, commit, frame arrival and envelope record times are the harness's \`performance.now()\`.\n`,
    `- Accepted is this command's \`command.recorded\` committed: the engine call that wrote it resolved. It is not the runtime's Receipt, which for a \`message.submit\` settles only after the turn ends. Commit times are read when \`SessionEngine.observe\` / \`submit\` resolve and are checked against the SQLite read-back. \`turn-queue\` → \`turn.started\` committed is one fact's durable write; commit → subscriber is its publish. Artifact and ledger timings wrap the real store and ledger and are filed per Session through \`AsyncLocalStorage\`, which also joins VC-119 envelopes to turns.\n`,
    `- Cross-check facts (VC-119 envelope ↔ ledger event): turn start (\`turn-queue\` ↔ \`turn.started\`), first attempt (first \`provider-attempt\` ↔ first \`usage.recorded\`), authority answer (wait-bearing \`authority\` ↔ \`interaction.resolved\`), compaction (\`compaction\` ↔ \`context.compacted\`), final attempt (last of each), turn end (\`turn\` ↔ \`turn.completed\`). Any inversion, causality violation, read-back mismatch or second ledger shape refuses publication.\n`,
    `- Process CPU is user + system time for the whole process, the libuv thread pool included, over the measured phases only.\n`,
    `- ${control === "none" ? "No diagnostic control arm ran." : "The control arms swap only the transcript-artifact store for the in-memory one."}\n`,
    `Environment: Node ${env.nodeVersion} · ${env.platform} ${env.osRelease} · ${env.cpuModel} · ${env.logicalCores} logical cores · ${env.totalMemoryBytes} bytes RAM · UV_THREADPOOL_SIZE ${env.uvThreadpoolSize} · initial load ${JSON.stringify(env.initialLoadAverage)} · commit ${env.gitSha} (dirty=${String(env.dirty)}).\n`,
  );
  return sections.join("\n");
}

export async function runBenchmark(input: {
  output: string;
  parameters?: Partial<BenchmarkParameters>;
}): Promise<{ failures: string[] }> {
  const parameters: BenchmarkParameters = {
    concurrencies: input.parameters?.concurrencies ?? DEFAULT_CONCURRENCIES,
    repetitions: input.parameters?.repetitions ?? DEFAULT_REPETITIONS,
    control: input.parameters?.control ?? "memory-artifacts",
    deltasPerReply: input.parameters?.deltasPerReply ?? DEFAULT_DELTAS_PER_REPLY,
    subscribers: input.parameters?.subscribers ?? ["all", "none"],
    cliff: input.parameters?.cliff ?? true,
  };
  if (
    parameters.subscribers.length === 0 ||
    !parameters.subscribers.every((mode) => mode === "all" || mode === "none")
  ) {
    throw new Error("subscribers accepts all and/or none.");
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
  const env = environment([probeFileSync(undefined), probeFileSync("64")]);
  const arms: ArmReport[] = [];
  const stores: ArtifactStoreKind[] = parameters.control === "none" ? ["file"] : ["file", "memory"];
  for (const artifactStore of stores) {
    for (const subscribers of parameters.subscribers) {
      for (const concurrency of concurrencies) {
        arms.push(
          await runArm({
            artifactStore,
            subscribers,
            concurrency,
            repetitions: parameters.repetitions,
            deltasPerReply: parameters.deltasPerReply,
          }),
        );
      }
    }
  }
  if (parameters.cliff) {
    for (const subscribers of ["all", "none"] as const) {
      for (const deltasPerReply of CLIFF_DELTAS) {
        for (const concurrency of CLIFF_CONCURRENCIES) {
          arms.push(
            await runArm({
              section: "cliff",
              artifactStore: "memory",
              subscribers,
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
  // A run the harness cannot vouch for is not published.
  if (failures.length > 0) return { failures };
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
    arms,
  };
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
  // `wx`: a staged name is never written through something already there.
  for (const [temporary, , contents] of staged)
    await writeFile(join(directory, temporary), contents, { flag: "wx", mode: 0o644 });
  for (const [temporary, final] of staged)
    await rename(join(directory, temporary), join(directory, final));
  return { failures };
}
