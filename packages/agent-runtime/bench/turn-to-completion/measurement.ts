/**
 * Fixture-only turn critical-path benchmark (VC-441).
 *
 * This drives Volli's real metadata-only reducer and provider-stream
 * instrumentation with a local stream stand-in. It never creates an Agent,
 * opens a Session, reads app data, contacts a provider, or enables OTLP.
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
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type StopReason,
} from "@earendil-works/pi-ai";
import type { AgentOptions } from "@earendil-works/pi-agent-core";
import {
  ObservabilityReducer,
  type ObservabilityEvent,
  type ObservabilitySink,
  type RuntimeObservation,
} from "@volli/shared";
import {
  instrumentStreamFn,
  recordObservationToSink,
  teeObservationsToSink,
} from "../../src/pi/observability";

export const FIXTURE_VERSION = "vc441-turn-critical-path-v2";
const DEFAULT_CONCURRENCIES = [1, 5, 15, 20] as const;
const DEFAULT_REPETITIONS = 20;
const WARMUP_WAVES = 1;
const DISPATCH_DELAY_MS = 2;
const AUTHORITY_WAIT_MS = 12;
const RETRY_BACKOFF_MS = 6;
const COMPACTION_WORK_UNITS = 18_000;
const PRIVATE_CONTENT_CANARY = "fixture-private-prompt-and-tool-output-canary";
const TOOL_IDS = ["read", "bash", "mcp-batch"] as const;
const TOOL_REPORT_NAMES = ["read", "bash", "fetch-url"] as const;
const MCP_BATCH_LATENCIES_MS = [18, 26, 34] as const;
const ATTEMPT_PLAN: readonly {
  stopReason: Extract<StopReason, "toolUse" | "error" | "stop">;
  serviceMs: number;
  ttftMs: number;
  errorMessage?: string;
}[] = [
  { stopReason: "toolUse", serviceMs: 34, ttftMs: 11 },
  {
    stopReason: "error",
    serviceMs: 23,
    ttftMs: 9,
    errorMessage: `fixture invalid request after synthetic overflow: ${PRIVATE_CONTENT_CANARY}`,
  },
  { stopReason: "stop", serviceMs: 31, ttftMs: 10 },
];

const MODEL: Model<Api> = {
  id: "fixture-model-v1",
  name: "VC-441 local model stand-in",
  api: "anthropic-messages",
  provider: "fixture-local",
  baseUrl: "http://fixture.invalid/never-contacted",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 256,
};

export interface RecordedFixtureEvent {
  event: ObservabilityEvent;
  recordedAt: number;
  order: number;
}

export interface TurnExpectations {
  modelAttempts: number;
  toolsByName: Readonly<Record<string, number>>;
  authorityWaits: number;
  compactions: number;
  retries: number;
}

export interface TurnSample {
  sampleId: string;
  concurrency: number;
  wave: number;
  firstMessageToCompletionMs: number | null;
  submissionToTurnStartMs: number | null;
  runtimeTurnMs: number | null;
  modelAttemptCount: number;
  providerDurationMs: number | null;
  ttftMs: number | null;
  ttftSampleCount: number;
  attempts: Array<{
    durationMs: number | null;
    ttftMs: number | null;
    stopReason: string;
    providerErrorClass: string | null;
  }>;
  toolRoundCount: number;
  toolCallCount: number;
  toolsByName: Record<string, { count: number; durationMs: number | null }>;
  authorityWaitCount: number;
  authorityWaitMs: number | null;
  compactionCount: number;
  retryCount: number | null;
  unaccountedGapMs: number | null;
  gapIncludesMissingSpans: boolean;
  eventOrderValid: boolean;
  eventOrderViolations: number;
  /** Signed: negative when Node fired a timer before its performance.now() target. */
  localTimerLateness: TimerLateness[];
  rawEvents: SafeRawEvent[];
}

export interface SafeRawEvent {
  kind: string;
  recordedAtOffsetMs: number;
  durationMs?: number | null;
  ttftMs?: number | null;
  stopReason?: string;
  providerErrorClass?: string | null;
  providerId?: string;
  modelId?: string;
  outcome?: string;
  toolId?: string | null;
  activityKind?: string;
  waitDurationMs?: number | null;
  reason?: string;
  count?: number;
}

export interface Distribution {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

const EXPECTED: TurnExpectations = {
  modelAttempts: ATTEMPT_PLAN.length,
  toolsByName: { read: 1, bash: 1, "fetch-url": 1 },
  authorityWaits: 1,
  compactions: 1,
  retries: 1,
};

type StreamFunction = NonNullable<AgentOptions["streamFn"]>;
const LOCAL_TIMER_KINDS = ["dispatch", "ttft", "completion", "mcp-batch", "authority"] as const;
type LocalTimerKind = (typeof LOCAL_TIMER_KINDS)[number];
export interface TimerLateness {
  kind: LocalTimerKind;
  latenessMs: number;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function finiteNonNegative(value: number | null | undefined): value is number {
  return value !== undefined && value !== null && Number.isFinite(value) && value >= 0;
}

export function summarize(
  values: readonly (number | null | undefined)[],
  options: { allowNegative?: boolean } = {},
): Distribution | null {
  const sorted = values
    .filter((value): value is number =>
      options.allowNegative === true
        ? value !== null && value !== undefined && Number.isFinite(value)
        : finiteNonNegative(value),
    )
    .toSorted((left, right) => left - right);
  if (sorted.length === 0) return null;
  const quantile = (q: number): number => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]!;
  return {
    n: sorted.length,
    min: round(sorted[0]!),
    p50: round(quantile(0.5)),
    p95: round(quantile(0.95)),
    max: round(sorted.at(-1)!),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

function eventIntervalMs(
  events: readonly RecordedFixtureEvent[],
  turnStart: number,
  turnEnd: number,
): number {
  const intervals = events.flatMap(({ event, recordedAt }) => {
    let duration: number | undefined;
    if (event.kind === "provider-attempt") duration = event.durationMs;
    else if (event.kind === "tool") duration = event.durationMs;
    else if (event.kind === "authority") duration = event.waitDurationMs;
    if (!finiteNonNegative(duration) || duration === 0) return [];
    const start = Math.max(turnStart, recordedAt - duration);
    const end = Math.min(turnEnd, recordedAt);
    return end > start ? [{ start, end }] : [];
  });
  intervals.sort((left, right) => left.start - right.start || left.end - right.end);
  let total = 0;
  let currentStart: number | undefined;
  let currentEnd: number | undefined;
  for (const interval of intervals) {
    if (currentStart === undefined || currentEnd === undefined || interval.start > currentEnd) {
      if (currentStart !== undefined && currentEnd !== undefined)
        total += currentEnd - currentStart;
      currentStart = interval.start;
      currentEnd = interval.end;
    } else {
      currentEnd = Math.max(currentEnd, interval.end);
    }
  }
  if (currentStart !== undefined && currentEnd !== undefined) total += currentEnd - currentStart;
  return total;
}

function safeRawEvent(entry: RecordedFixtureEvent, origin: number): SafeRawEvent {
  const { event } = entry;
  const recordedAtOffsetMs = round(entry.recordedAt - origin);
  switch (event.kind) {
    case "provider-attempt":
      return {
        kind: event.kind,
        recordedAtOffsetMs,
        durationMs: event.durationMs,
        ttftMs: event.ttftMs ?? null,
        stopReason: event.stopReason,
        providerErrorClass: event.providerErrorClass ?? null,
        providerId: event.providerId,
        modelId: event.modelId,
      };
    case "turn":
      return {
        kind: event.kind,
        recordedAtOffsetMs,
        durationMs: event.durationMs ?? null,
        outcome: event.outcome,
      };
    case "tool":
      return {
        kind: event.kind,
        recordedAtOffsetMs,
        durationMs: event.durationMs ?? null,
        waitDurationMs: event.waitDurationMs ?? null,
        outcome: event.outcome,
        toolId: event.toolId ?? null,
        activityKind: event.activityKind,
      };
    case "authority":
      return {
        kind: event.kind,
        recordedAtOffsetMs,
        durationMs: event.waitDurationMs ?? null,
        outcome: event.outcome,
      };
    case "compaction":
      return {
        kind: event.kind,
        recordedAtOffsetMs,
        outcome: event.outcome,
        reason: event.reason,
      };
    case "provider-reasoning-dropped":
      return { kind: event.kind, recordedAtOffsetMs, count: event.count };
    case "dropped":
      return { kind: event.kind, recordedAtOffsetMs, count: event.count, reason: event.reason };
    case "attachment":
      return { kind: event.kind, recordedAtOffsetMs, outcome: event.phase };
    case "attention":
      return { kind: event.kind, recordedAtOffsetMs, outcome: event.phase, reason: event.reason };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/**
 * Checks the sink's emission order (by `order`) against the turn's causal
 * shape: timestamps never go backwards; tool and authority envelopes belong to
 * a tool round opened by a `toolUse` provider attempt; nothing follows the
 * terminal turn envelope. Tool rounds are derived from that shape, not assumed.
 */
export function checkEventOrder(events: readonly RecordedFixtureEvent[]): {
  violations: number;
  toolRoundCount: number;
} {
  const byOrder = events.toSorted((left, right) => left.order - right.order);
  let violations = 0;
  let toolRoundCount = 0;
  let inToolRound = false;
  let roundHasTools = false;
  let terminalSeen = false;
  for (const [index, { event, recordedAt }] of byOrder.entries()) {
    const previous = byOrder[index - 1];
    if (previous !== undefined && recordedAt < previous.recordedAt) violations += 1;
    if (terminalSeen) violations += 1;
    if (event.kind === "provider-attempt") {
      if (roundHasTools) toolRoundCount += 1;
      inToolRound = event.stopReason === "toolUse";
      roundHasTools = false;
    } else if (event.kind === "tool" || event.kind === "authority") {
      if (!inToolRound) violations += 1;
      else if (event.kind === "tool") roundHasTools = true;
    } else if (event.kind === "turn" && event.outcome !== "interrupted") {
      if (roundHasTools) toolRoundCount += 1;
      // A turn that ends inside an unanswered tool round never saw its final attempt.
      if (inToolRound) violations += 1;
      inToolRound = false;
      roundHasTools = false;
      terminalSeen = true;
    }
  }
  if (roundHasTools) toolRoundCount += 1;
  return { violations, toolRoundCount };
}

/**
 * Converts VC-119's safe event envelopes into one fixture-turn accounting row.
 * Absent spans stay null; a missing observation is never interpreted as zero.
 */
export function analyzeTurn(input: {
  sampleId: string;
  concurrency: number;
  wave: number;
  submittedAt: number;
  turnStartedAt: number | null;
  events: readonly RecordedFixtureEvent[];
  localTimerLatenessMs: readonly TimerLateness[];
  expected?: TurnExpectations;
}): TurnSample {
  const expected = input.expected ?? EXPECTED;
  const terminal = input.events.find(
    ({ event }) => event.kind === "turn" && event.outcome !== "interrupted",
  );
  const completionAt = terminal?.recordedAt;
  const runtimeTurnMs =
    terminal?.event.kind === "turn" ? (terminal.event.durationMs ?? null) : null;
  const firstMessageToCompletionMs =
    completionAt === undefined ? null : round(completionAt - input.submittedAt);
  const submissionToTurnStartMs =
    input.turnStartedAt === null ? null : round(input.turnStartedAt - input.submittedAt);
  const turnStart =
    input.turnStartedAt === null || runtimeTurnMs === null ? null : input.turnStartedAt;
  const turnEnd = completionAt ?? null;
  const attempts = input.events.flatMap(({ event }) =>
    event.kind === "provider-attempt" ? [event] : [],
  );
  const providerDurationsComplete =
    attempts.length === expected.modelAttempts &&
    attempts.every(({ durationMs }) => finiteNonNegative(durationMs));
  const providerDurationMs = providerDurationsComplete
    ? round(attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0))
    : null;
  const ttftValues = attempts.flatMap(({ ttftMs }) => (finiteNonNegative(ttftMs) ? [ttftMs] : []));
  const ttftComplete =
    attempts.length === expected.modelAttempts && ttftValues.length === expected.modelAttempts;
  const tools = input.events.flatMap(({ event }) => (event.kind === "tool" ? [event] : []));
  const toolsByName: TurnSample["toolsByName"] = {};
  const toolDurationsCompleteByName: boolean[] = [];
  for (const [toolId, expectedCount] of Object.entries(expected.toolsByName)) {
    const matches = tools.filter((tool) => (tool.toolId ?? tool.activityKind) === toolId);
    const durationsComplete =
      matches.length === expectedCount &&
      matches.every(({ durationMs }) => finiteNonNegative(durationMs));
    toolDurationsCompleteByName.push(durationsComplete);
    toolsByName[toolId] = {
      count: matches.length,
      durationMs: durationsComplete
        ? round(matches.reduce((sum, tool) => sum + tool.durationMs!, 0))
        : null,
    };
  }
  const authority = input.events.flatMap(({ event }) =>
    event.kind === "authority" && event.waitDurationMs !== undefined ? [event] : [],
  );
  const authorityWaitComplete =
    authority.length === expected.authorityWaits &&
    authority.every(({ waitDurationMs }) => finiteNonNegative(waitDurationMs));
  const authorityWaitMs = authorityWaitComplete
    ? round(authority.reduce((sum, entry) => sum + entry.waitDurationMs!, 0))
    : null;
  const compactionCount = input.events.filter(({ event }) => event.kind === "compaction").length;
  const retryCountObserved = attempts.filter(
    (attempt, index) => attempt.stopReason === "error" && index < attempts.length - 1,
  ).length;
  const retryCount = attempts.length === expected.modelAttempts ? retryCountObserved : null;
  const allExpectedSpansPresent =
    terminal !== undefined &&
    runtimeTurnMs !== null &&
    input.turnStartedAt !== null &&
    providerDurationsComplete &&
    toolDurationsCompleteByName.every(Boolean) &&
    authorityWaitComplete &&
    compactionCount === expected.compactions &&
    retryCount === expected.retries;
  let unaccountedGapMs: number | null = null;
  if (turnStart !== null && turnEnd !== null && runtimeTurnMs !== null) {
    const knownIntervals = eventIntervalMs(input.events, turnStart, turnEnd);
    unaccountedGapMs = round(Math.max(0, runtimeTurnMs - knownIntervals));
  }
  const { violations: eventOrderViolations, toolRoundCount } = checkEventOrder(input.events);
  return {
    sampleId: input.sampleId,
    concurrency: input.concurrency,
    wave: input.wave,
    firstMessageToCompletionMs,
    submissionToTurnStartMs,
    runtimeTurnMs: runtimeTurnMs === null ? null : round(runtimeTurnMs),
    modelAttemptCount: attempts.length,
    providerDurationMs,
    ttftMs: ttftComplete
      ? round(ttftValues.reduce((sum, value) => sum + value, 0) / ttftValues.length)
      : null,
    ttftSampleCount: ttftValues.length,
    attempts: attempts.map((attempt) => ({
      durationMs: finiteNonNegative(attempt.durationMs) ? round(attempt.durationMs) : null,
      ttftMs: finiteNonNegative(attempt.ttftMs) ? round(attempt.ttftMs) : null,
      stopReason: attempt.stopReason,
      providerErrorClass: attempt.providerErrorClass ?? null,
    })),
    toolRoundCount,
    toolCallCount: tools.length,
    toolsByName,
    authorityWaitCount: authority.length,
    authorityWaitMs,
    compactionCount,
    retryCount,
    unaccountedGapMs,
    gapIncludesMissingSpans: !allExpectedSpansPresent,
    eventOrderValid: eventOrderViolations === 0,
    eventOrderViolations,
    localTimerLateness: input.localTimerLatenessMs.map(({ kind, latenessMs }) => ({
      kind,
      latenessMs: round(latenessMs),
    })),
    rawEvents: input.events.map((entry) => safeRawEvent(entry, input.submittedAt)),
  };
}

function recordSink(events: RecordedFixtureEvent[]): ObservabilitySink {
  return {
    record(event) {
      events.push({ event, recordedAt: performance.now(), order: events.length });
    },
  };
}

function makeAssistantMessage(attemptIndex: number): AssistantMessage {
  const plan = ATTEMPT_PLAN[attemptIndex];
  if (plan === undefined) throw new Error(`No scripted provider attempt ${attemptIndex}`);
  return {
    role: "assistant",
    content: [{ type: "text", text: PRIVATE_CONTENT_CANARY }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input: 24,
      output: 8,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 32,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: plan.stopReason,
    timestamp: Date.now(),
    ...(plan.errorMessage === undefined ? {} : { errorMessage: plan.errorMessage }),
  };
}

function scheduledTimer(
  targetAt: number,
  kind: LocalTimerKind,
  lateness: TimerLateness[],
): Promise<void> {
  return new Promise((resolvePromise) => {
    const delayMs = Math.max(0, targetAt - performance.now());
    setTimeout(() => {
      // Signed on purpose: libuv's cached loop clock can fire a timer before
      // its performance.now() target, and flooring that at 0 hides lateness.
      lateness.push({ kind, latenessMs: performance.now() - targetAt });
      resolvePromise();
    }, delayMs);
  });
}

function standInStreamFn(timerLateness: TimerLateness[]): StreamFunction {
  let attemptIndex = 0;
  return () => {
    const currentIndex = attemptIndex;
    attemptIndex += 1;
    const plan = ATTEMPT_PLAN[currentIndex];
    if (plan === undefined) throw new Error(`Unexpected scripted request ${currentIndex + 1}`);
    const message = makeAssistantMessage(currentIndex);
    const stream: AssistantMessageEventStream = createAssistantMessageEventStream();
    const requestStartedAt = performance.now();
    void (async () => {
      stream.push({ type: "start", partial: message });
      await scheduledTimer(requestStartedAt + plan.ttftMs, "ttft", timerLateness);
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: PRIVATE_CONTENT_CANARY,
        partial: message,
      });
      await scheduledTimer(requestStartedAt + plan.serviceMs, "completion", timerLateness);
      if (plan.stopReason === "error") {
        stream.push({ type: "error", reason: "error", error: message });
      } else {
        stream.push({ type: "done", reason: plan.stopReason, message });
      }
    })();
    return stream;
  };
}

function fixtureWork(workUnits: number, seed: number): number {
  let checksum = seed >>> 0;
  for (let index = 0; index < workUnits; index += 1) {
    checksum = (Math.imul(checksum ^ index, 0x45d9f3b) + index) >>> 0;
  }
  return checksum;
}

async function scriptedTool(input: {
  toolId: (typeof TOOL_IDS)[number];
  sessionIndex: number;
  turnId: string;
  runId: string;
  reducer: ObservabilityReducer;
  sink: ObservabilitySink;
  timerLateness: TimerLateness[];
  observe: ReturnType<typeof teeObservationsToSink>;
}): Promise<void> {
  const { toolId, sessionIndex, turnId, runId, reducer, sink, timerLateness, observe } = input;
  const callId = `fixture-call-${sessionIndex}-${toolId}`;
  const startedAt = performance.now();
  if (toolId === "read") {
    const waitStartedAt = performance.now();
    await scheduledTimer(waitStartedAt + AUTHORITY_WAIT_MS, "authority", timerLateness);
    const waitDurationMs = performance.now() - waitStartedAt;
    recordObservationToSink(reducer, sink, runId, {
      kind: "authority",
      state: "allowed",
      turnId,
      toolCallId: callId,
      waitDurationMs,
    });
  }
  let checksum: number;
  if (toolId === "mcp-batch") {
    // Three concurrent in-memory timers model a latency-bound batched MCP
    // request. They deliberately open no socket and expose no remote names.
    const childResults = await Promise.all(
      MCP_BATCH_LATENCIES_MS.map(async (latencyMs, index) => {
        await scheduledTimer(performance.now() + latencyMs, "mcp-batch", timerLateness);
        return fixtureWork(4_000 + index * 250, sessionIndex + index + 17);
      }),
    );
    checksum = childResults.reduce((sum, value) => (sum ^ value) >>> 0, 0);
  } else {
    checksum = fixtureWork(toolId === "read" ? 42_000 : 110_000, sessionIndex + 7);
  }
  const endedAt = performance.now();
  const observation: RuntimeObservation = {
    kind: "activity",
    state: "completed",
    turnId,
    activityId: callId,
    descriptor: {
      kind: toolId === "read" ? "read-file" : toolId === "bash" ? "run-command" : "fetch-url",
      nativeToolName: toolId === "mcp-batch" ? "fixture_mcp_batch" : toolId,
      subject: {
        label: PRIVATE_CONTENT_CANARY,
        path: PRIVATE_CONTENT_CANARY,
        lineRange: null,
      },
      outcome: null,
      startedAt,
      endedAt,
    },
    input: { fixture: PRIVATE_CONTENT_CANARY },
    output: { content: PRIVATE_CONTENT_CANARY, checksum },
  };
  await observe(observation);
}

export async function runScriptedTurn(input: {
  concurrency: number;
  wave: number;
  sessionIndex: number;
  sampleId: string;
  /** Receives the raw envelopes the VC-119 sink recorded, for privacy tests. */
  captureEvents?: RecordedFixtureEvent[];
}): Promise<TurnSample> {
  const events: RecordedFixtureEvent[] = [];
  const timerLateness: TimerLateness[] = [];
  const runId = `fixture-run-${input.concurrency}-${input.wave}-${input.sessionIndex}`;
  const turnId = `fixture-turn-${input.concurrency}-${input.wave}-${input.sessionIndex}`;
  const sink = recordSink(events);
  const reducer = new ObservabilityReducer(() => performance.now());
  const observe = teeObservationsToSink(async () => {}, reducer, sink, runId);
  const submittedAt = performance.now();
  await scheduledTimer(submittedAt + DISPATCH_DELAY_MS, "dispatch", timerLateness);
  const turnStartedAt = performance.now();
  await observe({ kind: "turn", state: "started", turnId });
  const wrappedStream = instrumentStreamFn(standInStreamFn(timerLateness), {
    sink,
    runId,
    now: () => performance.now(),
  });
  // The request carries private-looking content so tests can prove the
  // instrumentation drops it; the stand-in never sends it anywhere.
  const context = normalizeContext({
    systemPrompt: PRIVATE_CONTENT_CANARY,
    messages: [{ role: "user", content: PRIVATE_CONTENT_CANARY, timestamp: Date.now() }],
  });
  const runAttempt = async (attemptIndex: number): Promise<void> => {
    if (attemptIndex !== 0)
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1));
    const produced = wrappedStream(MODEL, context);
    const stream = produced instanceof Promise ? await produced : produced;
    await stream.result();
    // instrumentStreamFn attaches its metadata callback before the consumer's
    // result continuation. Yield once so the attempt envelope is recorded.
    await Promise.resolve();
  };

  await runAttempt(0);
  for (const toolId of TOOL_IDS) {
    await scriptedTool({
      toolId,
      sessionIndex: input.sessionIndex,
      turnId,
      runId,
      reducer,
      sink,
      timerLateness,
      observe,
    });
  }
  await runAttempt(1);
  fixtureWork(COMPACTION_WORK_UNITS, input.sessionIndex + 13);
  recordObservationToSink(reducer, sink, runId, {
    kind: "compaction",
    state: "compacted",
    reason: "overflow",
    entryId: `fixture-compaction-${input.sessionIndex}`,
    tokensBefore: 2_000,
    tokensAfter: 1_200,
  });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, RETRY_BACKOFF_MS));
  await runAttempt(2);
  await observe({ kind: "turn", state: "completed", turnId });

  const sample = analyzeTurn({
    sampleId: input.sampleId,
    concurrency: input.concurrency,
    wave: input.wave,
    submittedAt,
    turnStartedAt,
    events,
    localTimerLatenessMs: timerLateness,
  });
  input.captureEvents?.push(...events);
  const expectedToolCalls = Object.values(EXPECTED.toolsByName).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (
    sample.modelAttemptCount !== EXPECTED.modelAttempts ||
    sample.toolRoundCount !== 1 ||
    sample.toolCallCount !== expectedToolCalls ||
    Object.entries(EXPECTED.toolsByName).some(
      ([toolId, count]) => sample.toolsByName[toolId]?.count !== count,
    ) ||
    sample.authorityWaitCount !== EXPECTED.authorityWaits ||
    sample.compactionCount !== EXPECTED.compactions ||
    sample.retryCount !== EXPECTED.retries ||
    sample.gapIncludesMissingSpans ||
    !sample.eventOrderValid
  ) {
    throw new Error("The VC-441 fixture did not match its scripted accounting expectations.");
  }
  return sample;
}

interface HostSnapshot {
  rssBytes: number;
  heapUsedBytes: number;
  freeMemoryBytes: number;
  loadAverage: number[] | null;
}

function hostSnapshot(): HostSnapshot {
  const load = loadavg();
  return {
    rssBytes: process.memoryUsage.rss(),
    heapUsedBytes: process.memoryUsage().heapUsed,
    freeMemoryBytes: freemem(),
    loadAverage: platform() === "win32" ? null : load.map(round),
  };
}

function histogramSummary(histogram: ReturnType<typeof monitorEventLoopDelay>): {
  sampleCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  meanMs: number | null;
} {
  const toMs = (ns: number): number | null => (Number.isFinite(ns) ? round(ns / 1e6) : null);
  return {
    sampleCount: histogram.count,
    p50Ms: toMs(histogram.percentile(50)),
    p95Ms: toMs(histogram.percentile(95)),
    maxMs: toMs(histogram.max),
    meanMs: toMs(histogram.mean),
  };
}

function armSummary(
  samples: readonly TurnSample[],
  concurrency: number,
  host: {
    cpuPercentOfOneCore: number | null;
    wallMs: number;
    before: HostSnapshot;
    after: HostSnapshot;
    peakRssBytes: number;
    eventLoopDelay: ReturnType<typeof histogramSummary>;
  },
): Record<string, unknown> {
  const attemptDurations = samples.flatMap((sample) =>
    sample.attempts.map(({ durationMs }) => durationMs),
  );
  const ttfts = samples.flatMap((sample) => sample.attempts.map(({ ttftMs }) => ttftMs));
  const toolsByName: Record<string, unknown> = {};
  for (const toolId of TOOL_REPORT_NAMES) {
    const calls = samples.flatMap((sample) => {
      const tool = sample.toolsByName[toolId];
      return tool === undefined ? [] : Array.from({ length: tool.count }, () => tool.durationMs);
    });
    const perTurn = samples.map((sample) => sample.toolsByName[toolId]?.durationMs ?? null);
    toolsByName[toolId] = {
      calls: summarize(calls),
      perTurnTotal: summarize(perTurn),
    };
  }
  return {
    concurrency,
    warmupWavesDiscarded: WARMUP_WAVES,
    wavesMeasured: samples.reduce((maximum, sample) => Math.max(maximum, sample.wave + 1), 0),
    turnSampleCount: samples.length,
    firstMessageToCompletionMs: summarize(
      samples.map(({ firstMessageToCompletionMs }) => firstMessageToCompletionMs),
    ),
    submissionToTurnStartMs: summarize(
      samples.map(({ submissionToTurnStartMs }) => submissionToTurnStartMs),
    ),
    runtimeTurnMs: summarize(samples.map(({ runtimeTurnMs }) => runtimeTurnMs)),
    modelAttemptsPerTurn: summarize(samples.map(({ modelAttemptCount }) => modelAttemptCount)),
    providerAttemptDurationMs: summarize(attemptDurations),
    ttftMs: summarize(ttfts),
    toolRoundsPerTurn: summarize(samples.map(({ toolRoundCount }) => toolRoundCount)),
    toolCallsPerTurn: summarize(samples.map(({ toolCallCount }) => toolCallCount)),
    toolsByName,
    authorityWaitsPerTurn: summarize(samples.map(({ authorityWaitCount }) => authorityWaitCount)),
    authorityWaitMs: summarize(samples.map(({ authorityWaitMs }) => authorityWaitMs)),
    compactionsPerTurn: summarize(samples.map(({ compactionCount }) => compactionCount)),
    retriesPerTurn: summarize(samples.map(({ retryCount }) => retryCount)),
    unaccountedGapMs: summarize(samples.map(({ unaccountedGapMs }) => unaccountedGapMs)),
    completeTurnAccountingCount: samples.filter(
      ({ gapIncludesMissingSpans }) => !gapIncludesMissingSpans,
    ).length,
    orderViolationCount: samples.reduce((sum, sample) => sum + sample.eventOrderViolations, 0),
    // Signed lateness per local timer kind; negative values are early fires.
    localTimerLatenessMsByKind: Object.fromEntries(
      LOCAL_TIMER_KINDS.map((kind) => [
        kind,
        summarize(
          samples.flatMap(({ localTimerLateness }) =>
            localTimerLateness.flatMap((entry) => (entry.kind === kind ? [entry.latenessMs] : [])),
          ),
          { allowNegative: true },
        ),
      ]),
    ),
    host: {
      processCpuPercentOfOneCore: host.cpuPercentOfOneCore,
      wallMs: round(host.wallMs),
      rssBeforeBytes: host.before.rssBytes,
      rssPeakBytes: host.peakRssBytes,
      rssAfterBytes: host.after.rssBytes,
      heapUsedBeforeBytes: host.before.heapUsedBytes,
      heapUsedAfterBytes: host.after.heapUsedBytes,
      freeMemoryBeforeBytes: host.before.freeMemoryBytes,
      freeMemoryAfterBytes: host.after.freeMemoryBytes,
      loadAverageBefore: host.before.loadAverage,
      loadAverageAfter: host.after.loadAverage,
      eventLoopDelayMs: host.eventLoopDelay,
    },
  };
}

function fmt(distribution: Distribution | null): string {
  return distribution === null
    ? "n/a"
    : `${distribution.p50} / ${distribution.p95} ms (n=${distribution.n})`;
}

function fmtSigned(distribution: Distribution | null): string {
  return distribution === null
    ? "n/a"
    : `${distribution.min} / ${distribution.p50} / ${distribution.p95}`;
}

function armReportMarkdown(arm: Record<string, unknown>): string {
  const summary = arm as {
    concurrency: number;
    turnSampleCount: number;
    wavesMeasured: number;
    firstMessageToCompletionMs: Distribution | null;
    runtimeTurnMs: Distribution | null;
    submissionToTurnStartMs: Distribution | null;
    providerAttemptDurationMs: Distribution | null;
    ttftMs: Distribution | null;
    toolsByName: Record<string, { perTurnTotal: Distribution | null }>;
    authorityWaitMs: Distribution | null;
    unaccountedGapMs: Distribution | null;
    localTimerLatenessMsByKind: Record<LocalTimerKind, Distribution | null>;
    host: {
      processCpuPercentOfOneCore: number | null;
      rssPeakBytes: number;
      loadAverageAfter: number[] | null;
      eventLoopDelayMs: { p95Ms: number | null; maxMs: number | null };
    };
  };
  const load = summary.host.loadAverageAfter?.[0];
  const cpu = summary.host.processCpuPercentOfOneCore;
  const rssMb = round(summary.host.rssPeakBytes / (1024 * 1024));
  return [
    `| ${summary.concurrency} | ${summary.turnSampleCount} | ${summary.wavesMeasured} | ${fmt(summary.firstMessageToCompletionMs)} | ${fmt(summary.runtimeTurnMs)} | ${fmt(summary.submissionToTurnStartMs)} | ${fmt(summary.providerAttemptDurationMs)} | ${fmt(summary.ttftMs)} | ${fmt(summary.toolsByName.read?.perTurnTotal ?? null)} | ${fmt(summary.toolsByName.bash?.perTurnTotal ?? null)} | ${fmt(summary.toolsByName["fetch-url"]?.perTurnTotal ?? null)} | ${fmt(summary.authorityWaitMs)} | ${fmt(summary.unaccountedGapMs)} | ${summary.host.eventLoopDelayMs.p95Ms ?? "n/a"} / ${summary.host.eventLoopDelayMs.maxMs ?? "n/a"} | ${fmtSigned(summary.localTimerLatenessMsByKind.authority)} | ${cpu === null ? "n/a" : round(cpu)} | ${load ?? "n/a"} | ${rssMb} |`,
  ].join("");
}

function formatMarkdown(report: {
  generatedAt: string;
  fixtureVersion: string;
  environment: Record<string, unknown>;
  parameters: { concurrencies: readonly number[]; repetitions: number };
  arms: Array<Record<string, unknown>>;
}): string {
  const arms = report.arms.map(armReportMarkdown).join("\n");
  const { concurrencies, repetitions } = report.parameters;
  const attemptShape = ATTEMPT_PLAN.map(({ stopReason }) => stopReason).join(" → ");
  const env = report.environment;
  return (
    `# Agent turn critical path under concurrent scripted turns (VC-441)\n\n` +
    `Fixture: \`${report.fixtureVersion}\` · generated ${report.generatedAt}.\n\n` +
    `Reproduction: \`pnpm -C packages/agent-runtime bench:turn-to-completion -- --output ../../performance-results/vc-441-agent-turn-time --repetitions ${repetitions} --concurrencies ${concurrencies.join(",")}\`.\n\n` +
    `"Concurrent" is the number of scripted turns in flight at once in one Node process, each standing in for one working Session. No Volli Session, Session runtime queue, ledger, or agent loop is created. The runner starts ${repetitions} measured waves after ${WARMUP_WAVES} discarded warm-up wave(s) at each concurrency. Summary values use individual completed turns as samples; turns in a wave share one host interval and are not independent. Percentiles are nearest-rank, using rank ceil(0.95 × n) for p95.\n\n` +
    `| Concurrent turns | Turns (n) | Waves | First message → completion p50 / p95 | Runtime turn p50 / p95 | Submission → turn start p50 / p95 | Provider attempt duration p50 / p95 | TTFT p50 / p95 | read tool per-turn p50 / p95 | bash tool per-turn p50 / p95 | MCP-like batch p50 / p95 | Authority wait p50 / p95 | Unaccounted gap p50 / p95 | Event-loop delay p95 / max (ms) | Authority timer lateness min / p50 / p95 (ms, signed) | Runner CPU (% one core) | Host load avg 1m | Peak runner RSS (MiB) |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${arms}\n\n` +
    `## Method and limits\n\n` +
    `- Each scripted turn uses the real VC-119 \`instrumentStreamFn\`, \`ObservabilityReducer\`, and \`teeObservationsToSink\`. The provider stand-in is an in-process Pi event stream driven by fixed local timers; it opens no socket and makes no provider request. The same script runs at concurrency ${concurrencies.join(", ")}.\n` +
    `- Each turn scripts ${ATTEMPT_PLAN.length} model attempts (${attemptShape}; the error is a synthetic invalid request), ${TOOL_IDS.length} tools in one tool round (CPU-fixture \`read\` and \`bash\`, plus a latency-bound MCP-like batch whose children wait ${MCP_BATCH_LATENCIES_MS.join("/")} ms concurrently on in-memory timers), a ${AUTHORITY_WAIT_MS} ms authority wait, one overflow-compaction event, a ${RETRY_BACKOFF_MS} ms retry backoff, and a ${DISPATCH_DELAY_MS} ms dispatch timer. The batch's unknown native name is reported only as the bounded \`fetch-url\` activity class. Attempt, tool, tool-round, wait, compaction, and retry counts and the causal event order are checked against the script.\n` +
    `- The MCP-like batch is not a proxy for real MCP/serverless quotas or a browser-backed app tool; do not extrapolate the \`read\`/\`bash\` figures to those tools.\n` +
    `- Provider-attempt duration and TTFT are the runtime instrument's measurements of the stand-in. Timer lateness is signed per timer (negative = Node fired it before its \`performance.now()\` target) and reported per timer kind in \`benchmark.json\`; it and Node's event-loop-delay histogram are local host-delay indicators and are not subtracted from provider duration. CPU, RSS, and heap are for the benchmark runner process—not Electron or a production Session.\n` +
    `- Unaccounted gap is runtime-turn wall time minus the union of known provider, tool-execution, and authority-wait intervals. The VC-119 compaction event has no duration, so compaction work, retry backoff and orchestration remain in this gap. Missing spans make it incomplete; absent values are null, never zero.\n` +
    `- The request context, stream deltas, error message, tool subject, input and output all carry a private-content canary; none of it reaches the output. The telemetry exporter stays off; no Session database, collector, or person’s profile is read.\n` +
    `- These results describe only this synthetic timer/CPU workload on the recorded host. They cannot establish real provider inference time, remote/provider queueing, quotas/rate limits, network variation, production Session resource costs, or how real tool commands scale.\n\n` +
    `Environment: Node ${String(env["nodeVersion"])} · ${String(env["platform"])} ${String(env["osRelease"])} · ${String(env["cpuModel"])} · ${String(env["logicalCores"])} logical cores · ${String(env["totalMemoryBytes"])} bytes RAM · initial load avg ${JSON.stringify(env["initialLoadAverage"])} · commit ${String(env["gitSha"])} (dirty=${String(env["dirty"])}).\n`
  );
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

async function hostEnvironment(): Promise<Record<string, unknown>> {
  const core = cpus()[0];
  return {
    nodeVersion: process.version,
    platform: platform(),
    osRelease: release(),
    architecture: process.arch,
    cpuModel: core?.model ?? "unknown",
    logicalCores: cpus().length,
    availableParallelism: availableParallelism(),
    totalMemoryBytes: totalmem(),
    gitSha: git(["rev-parse", "HEAD"]),
    dirty: (git(["status", "--porcelain"]) ?? "unavailable") !== "",
    initialLoadAverage: platform() === "win32" ? null : loadavg().map(round),
    initialFreeMemoryBytes: freemem(),
  };
}

async function runArm(concurrency: number, repetitions: number): Promise<Record<string, unknown>> {
  await Promise.all(
    Array.from({ length: concurrency }, (_value, sessionIndex) =>
      runScriptedTurn({
        concurrency,
        wave: -1,
        sessionIndex,
        sampleId: `warmup-${concurrency}-${sessionIndex}`,
      }),
    ),
  );
  const loopDelay = monitorEventLoopDelay({ resolution: 1 });
  loopDelay.enable();
  const before = hostSnapshot();
  const cpuBefore = process.cpuUsage();
  const startedAt = process.hrtime.bigint();
  let peakRssBytes = before.rssBytes;
  const samples: TurnSample[] = [];
  for (let wave = 0; wave < repetitions; wave += 1) {
    const measured = await Promise.all(
      Array.from({ length: concurrency }, (_value, sessionIndex) =>
        runScriptedTurn({
          concurrency,
          wave,
          sessionIndex,
          sampleId: `turn-${concurrency}-${wave + 1}-${sessionIndex + 1}`,
        }),
      ),
    );
    samples.push(...measured);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
  }
  const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const cpu = process.cpuUsage(cpuBefore);
  const after = hostSnapshot();
  peakRssBytes = Math.max(peakRssBytes, after.rssBytes);
  loopDelay.disable();
  const eventLoopDelay = histogramSummary(loopDelay);
  const cpuPercentOfOneCore =
    wallMs > 0 ? round(((cpu.user + cpu.system) / (wallMs * 1_000)) * 100) : null;
  const summary = armSummary(samples, concurrency, {
    cpuPercentOfOneCore,
    wallMs,
    before,
    after,
    peakRssBytes,
    eventLoopDelay,
  });
  return summary;
}

async function prepareOutputDirectory(outputPath: string): Promise<string> {
  const directory = resolve(outputPath);
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  if (directory === root || directory === resolve("/") || directory === homedir()) {
    throw new Error(
      "Output must be a dedicated child directory, not the repository root or filesystem root.",
    );
  }
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory);
  const allowed = new Set(["benchmark.json", "benchmark.md", "run-manifest.json"]);
  if (entries.some((entry) => !allowed.has(entry))) {
    throw new Error(
      `Refusing to write into ${directory}: it contains files not owned by this benchmark.`,
    );
  }
  if (entries.length > 0) {
    let oldManifest: { fixtureVersion?: string } | null = null;
    try {
      oldManifest = JSON.parse(await readFile(join(directory, "run-manifest.json"), "utf8")) as {
        fixtureVersion?: string;
      };
    } catch {
      throw new Error(
        `Refusing to replace existing output without this fixture's manifest: ${directory}`,
      );
    }
    if (oldManifest.fixtureVersion !== FIXTURE_VERSION) {
      throw new Error(`Refusing to replace output from another fixture version in ${directory}.`);
    }
  }
  return directory;
}

async function writeRunOutput(
  directory: string,
  report: Record<string, unknown>,
  markdown: string,
): Promise<void> {
  const manifestPath = join(directory, "run-manifest.json");
  const manifest = {
    fixtureVersion: FIXTURE_VERSION,
    artifacts: ["benchmark.json", "benchmark.md", "run-manifest.json"],
  };
  const temporary = `${process.pid}-${Date.now()}`;
  await writeFile(
    join(directory, `.benchmark-${temporary}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(join(directory, `.benchmark-${temporary}.md`), markdown);
  await writeFile(
    join(directory, `.manifest-${temporary}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await rename(join(directory, `.benchmark-${temporary}.json`), join(directory, "benchmark.json"));
  await rename(join(directory, `.benchmark-${temporary}.md`), join(directory, "benchmark.md"));
  await rename(join(directory, `.manifest-${temporary}.json`), manifestPath);
}

export async function runConcurrencyBenchmark(input: {
  output: string;
  repetitions?: number;
  concurrencies?: readonly number[];
}): Promise<Record<string, unknown>> {
  const repetitions = input.repetitions ?? DEFAULT_REPETITIONS;
  const concurrencies = input.concurrencies ?? DEFAULT_CONCURRENCIES;
  if (!Number.isInteger(repetitions) || repetitions < 20) {
    throw new Error("--repetitions must be an integer >= 20 so p95 is not just a maximum.");
  }
  if (
    concurrencies.length === 0 ||
    new Set(concurrencies).size !== concurrencies.length ||
    !concurrencies.every((value) => Number.isInteger(value) && value >= 1 && value <= 20)
  ) {
    throw new Error("--concurrencies accepts unique integers from 1 through 20.");
  }
  // Validate the destination before spending minutes measuring.
  const directory = await prepareOutputDirectory(input.output);
  const environment = await hostEnvironment();
  const arms: Array<Record<string, unknown>> = [];
  for (const concurrency of concurrencies) arms.push(await runArm(concurrency, repetitions));
  const generatedAt = new Date().toISOString();
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    fixtureVersion: FIXTURE_VERSION,
    generatedAt,
    methodology:
      "One script-controlled in-process local stream stand-in and deterministic CPU fixture tools; no provider/network/app profile access.",
    environment,
    parameters: {
      concurrencies,
      repetitions,
      warmupWaves: WARMUP_WAVES,
      expectedModelAttemptsPerTurn: EXPECTED.modelAttempts,
      expectedToolRoundsPerTurn: 1,
      expectedToolCallsPerTurn: Object.values(EXPECTED.toolsByName).reduce(
        (sum, value) => sum + value,
        0,
      ),
      expectedAuthorityWaitsPerTurn: EXPECTED.authorityWaits,
      expectedCompactionsPerTurn: EXPECTED.compactions,
      expectedRetriesPerTurn: EXPECTED.retries,
      dispatchDelayMs: DISPATCH_DELAY_MS,
      standInAuthorityWaitMs: AUTHORITY_WAIT_MS,
      standInRetryBackoffMs: RETRY_BACKOFF_MS,
      mcpLikeConcurrentChildLatenciesMs: MCP_BATCH_LATENCIES_MS,
      attemptPlan: ATTEMPT_PLAN.map(({ stopReason, serviceMs, ttftMs, errorMessage }) => ({
        stopReason,
        serviceMs,
        ttftMs,
        errorClass: errorMessage === undefined ? null : "invalid-request",
      })),
    },
    arms,
  };
  const markdown = formatMarkdown(report as Parameters<typeof formatMarkdown>[0]);
  await writeRunOutput(directory, report, markdown);
  return report;
}

export function parseConcurrencyArgs(argv: readonly string[]): {
  output: string;
  repetitions: number;
  concurrencies: number[];
} {
  let output: string | undefined;
  let repetitions = DEFAULT_REPETITIONS;
  let concurrencies: number[] = [...DEFAULT_CONCURRENCIES];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--output") output = argv[++index];
    else if (argument === "--repetitions") repetitions = Number(argv[++index]);
    else if (argument === "--concurrencies") {
      const value = argv[++index];
      concurrencies = value?.split(",").map(Number) ?? [];
    } else if (argument === "--help") {
      throw new Error(
        "Usage: pnpm -C packages/agent-runtime bench:turn-to-completion -- --output DIR [--repetitions 20] [--concurrencies 1,5,15,20]",
      );
    } else {
      throw new Error(`Unknown benchmark argument ${argument}`);
    }
  }
  if (output === undefined) throw new Error("--output DIR is required.");
  return { output, repetitions, concurrencies };
}

export async function runConcurrencyCli(argv: readonly string[]): Promise<void> {
  const args = parseConcurrencyArgs(argv);
  const report = await runConcurrencyBenchmark(args);
  const arms = report["arms"] as Array<{ concurrency: number; turnSampleCount: number }>;
  console.log(`VC-441 fixture report written to ${resolve(args.output)}`);
  for (const arm of arms)
    console.log(
      `  ${arm.concurrency} concurrent turns: ${arm.turnSampleCount} measured turn samples`,
    );
}
