/**
 * VC-442 decision sweep for independent, read-only, MCP-like calls.
 *
 * Nothing here opens a transport, calls a provider or runs a tool. The mocked
 * "network tool" is an abortable timer that returns a fixed per-call value.
 * Two halves:
 * - `runMockReadonlyLatencySweep` measures real timer scheduling for each
 *   batching propensity at the harness's scripted round;
 * - `buildMcpDecisionSweep` evaluates the same turn model in closed form, so
 *   the wider grid (declared 2 s rounds, output volume) is exactly
 *   reproducible. The bench asserts the model against every measured row.
 * Barrier figures are formula-only and describe a dispatcher Pi does not have.
 */

import { countTokens } from "gpt-tokenizer/encoding/cl100k_base";
import { MOCK_CALL_LATENCIES_MS, SCRIPTED_PROVIDER_ROUND_MS } from "./fixtures";
import { delay, median, readSequential } from "./prototype";

const TOKEN_OPTIONS = { disallowedSpecial: new Set<string>() };

/** Independent calls the task needs, and how many the model puts in one reply. */
export const SWEEP_CALLS = 4;
export const SWEEP_BATCH_SIZES = [4, 2, 1] as const;
export const SWEEP_OUTPUT_BYTES = [512, 16_384] as const;
/** The harness's scripted round, and a declared (not measured) real-model round. */
export const SWEEP_PROVIDER_ROUND_MS = [SCRIPTED_PROVIDER_ROUND_MS, 2_000] as const;
/** Fixed system + tool-schema prefix re-sent on every provider round. */
const PREFIX_TOKENS = 2_000;
/**
 * Within one reply, earlier calls wait longer (by this step), so a parallel
 * reply finishes in reverse call order and ordered commit is actually tested.
 */
const WITHIN_REPLY_STAGGER_MS = 2;
const MAX_REPEATS = 20;

/** Per-call waits grouped by assistant reply, earlier calls slowest. */
export function replyLatencies(
  calls: number,
  batchSize: number,
  baseLatencyMs: number,
  staggerMs = WITHIN_REPLY_STAGGER_MS,
): number[][] {
  const replies: number[][] = [];
  for (let start = 0; start < calls; start += batchSize) {
    const size = Math.min(batchSize, calls - start);
    replies.push(
      Array.from({ length: size }, (_, index) => baseLatencyMs + (size - 1 - index) * staggerMs),
    );
  }
  return replies;
}

/**
 * Wall time for one turn: one provider round per tool-calling reply plus the
 * final answer round, and each reply's network wait. Sequential dispatch
 * waits for every call in turn; selective parallel dispatch waits for the
 * slowest call of each reply.
 */
export function modelTurnMs(
  replies: readonly (readonly number[])[],
  providerRoundMs: number,
  parallel: boolean,
): number {
  const networkMs = replies.reduce(
    (total, reply) =>
      total + (parallel ? Math.max(...reply) : reply.reduce((sum, wait) => sum + wait, 0)),
    0,
  );
  return (replies.length + 1) * providerRoundMs + networkMs;
}

export interface MeasuredLatencyRow {
  latencyMs: number;
  batchSize: number;
  calls: number;
  providerRounds: number;
  sequentialMs: number;
  parallelMs: number;
  modelSequentialMs: number;
  modelParallelMs: number;
  savedMs: number;
  turnSavedPercent: number;
  maxConcurrency: number;
  /** Every sample committed results in call order. */
  orderedResults: boolean;
  /** Some parallel sample finished in an order different from call order. */
  completionDiffered: boolean;
}

interface MeasuredSample {
  elapsedMs: number;
  maxConcurrency: number;
  results: string[];
  completion: number[];
}

async function measureTurn(
  replies: readonly (readonly number[])[],
  parallel: boolean,
): Promise<MeasuredSample> {
  const controller = new AbortController();
  const bound = modelTurnMs(replies, SCRIPTED_PROVIDER_ROUND_MS, false) + 2_000;
  const timer = setTimeout(
    () => controller.abort(new Error("latency sweep turn exceeded its bound.")),
    bound,
  );
  const startedAt = performance.now();
  let active = 0;
  let maxConcurrency = 0;
  const completion: number[] = [];
  const results: string[] = [];
  let callIndex = 0;
  const call = async (index: number, waitMs: number): Promise<string> => {
    active += 1;
    maxConcurrency = Math.max(maxConcurrency, active);
    try {
      await delay(waitMs, controller.signal);
      completion.push(index);
      return `fixed-call-result-${index}`;
    } finally {
      active -= 1;
    }
  };
  try {
    for (const reply of replies) {
      await delay(SCRIPTED_PROVIDER_ROUND_MS, controller.signal);
      const first = callIndex;
      callIndex += reply.length;
      const calls = reply.map((waitMs, offset) => ({ index: first + offset, waitMs }));
      const replyResults = parallel
        ? await Promise.all(calls.map(({ index, waitMs }) => call(index, waitMs)))
        : await readSequential(calls, ({ index, waitMs }) => call(index, waitMs));
      results.push(...replyResults);
    }
    await delay(SCRIPTED_PROVIDER_ROUND_MS, controller.signal);
    return { elapsedMs: performance.now() - startedAt, maxConcurrency, results, completion };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Measured sweep: every latency at every batching propensity, except the
 * slowest latency is measured only fully batched (the unbatched 900 ms turns
 * add ~20 s and nothing the model does not already predict at 50/250 ms).
 */
export async function runMockReadonlyLatencySweep(
  options: { latenciesMs?: readonly number[]; repeats?: number } = {},
): Promise<MeasuredLatencyRow[]> {
  const latencies = options.latenciesMs ?? MOCK_CALL_LATENCIES_MS;
  const repeats = options.repeats ?? 3;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > MAX_REPEATS) {
    throw new Error(`latency sweep repeats must be an integer from 1 to ${MAX_REPEATS}.`);
  }
  if (
    latencies.length === 0 ||
    latencies.some((latency) => !Number.isFinite(latency) || latency < 1 || latency > 2_000)
  ) {
    throw new Error("latency sweep values must be from 1 to 2000 milliseconds.");
  }
  const slowest = Math.max(...latencies);
  const rows: MeasuredLatencyRow[] = [];
  for (const batchSize of SWEEP_BATCH_SIZES) {
    for (const latencyMs of latencies) {
      if (batchSize !== SWEEP_CALLS && latencyMs === slowest && latencies.length > 1) continue;
      const replies = replyLatencies(SWEEP_CALLS, batchSize, latencyMs);
      const serial: MeasuredSample[] = [];
      const parallel: MeasuredSample[] = [];
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        serial.push(await measureTurn(replies, false));
        parallel.push(await measureTurn(replies, true));
      }
      const sequentialMs = median(serial.map((sample) => sample.elapsedMs));
      const parallelMs = median(parallel.map((sample) => sample.elapsedMs));
      const expected = Array.from(
        { length: SWEEP_CALLS },
        (_, index) => `fixed-call-result-${index}`,
      ).join(",");
      const callOrder = Array.from({ length: SWEEP_CALLS }, (_, index) => index).join(",");
      rows.push({
        latencyMs,
        batchSize,
        calls: SWEEP_CALLS,
        providerRounds: replies.length + 1,
        sequentialMs,
        parallelMs,
        modelSequentialMs: modelTurnMs(replies, SCRIPTED_PROVIDER_ROUND_MS, false),
        modelParallelMs: modelTurnMs(replies, SCRIPTED_PROVIDER_ROUND_MS, true),
        savedMs: sequentialMs - parallelMs,
        turnSavedPercent: ((sequentialMs - parallelMs) / sequentialMs) * 100,
        maxConcurrency: Math.max(...parallel.map((sample) => sample.maxConcurrency)),
        orderedResults: [...serial, ...parallel].every(
          (sample) => sample.results.join(",") === expected,
        ),
        completionDiffered: parallel.some((sample) => sample.completion.join(",") !== callOrder),
      });
    }
  }
  return rows;
}

export interface McpDecisionRow {
  latencyMs: number;
  /** Calls per assistant reply: 4 = all independent calls batched, 1 = never batched. */
  batchSize: number;
  outputBytesPerCall: number;
  providerRoundMs: number;
  providerRounds: number;
  sequentialMs: number;
  selectiveParallelMs: number;
  savedMs: number;
  savedPercent: number;
  /** Identical under both dispatch modes: parallelism never changes context volume. */
  inputTokens: number;
  resultTokensPerCall: number;
}

function payloadTokens(bytes: number): number {
  // A deterministic JSON-ish record stream, closer to real tool output than a
  // single repeated character (which BPE would compress unrealistically).
  const lines: string[] = [];
  let size = 0;
  for (let index = 0; size < bytes; index += 1) {
    const line = `{"id":"item-${index}","status":"ok","region":"r${index % 7}","latency_ms":${(index * 37) % 400}}`;
    lines.push(line);
    size += line.length + 1;
  }
  return countTokens(lines.join("\n").slice(0, bytes), TOKEN_OPTIONS);
}

/** Prefix on every round plus every earlier result re-sent on each later round. */
function turnInputTokens(calls: number, batchSize: number, resultTokens: number): number {
  const replies = Math.ceil(calls / batchSize);
  let total = 0;
  for (let round = 0; round <= replies; round += 1) {
    const priorCalls = Math.min(calls, round * batchSize);
    total += PREFIX_TOKENS + priorCalls * resultTokens;
  }
  return total;
}

/** Closed-form grid with uniform per-call waits (no stagger). */
export function buildMcpDecisionSweep(): McpDecisionRow[] {
  const rows: McpDecisionRow[] = [];
  for (const providerRoundMs of SWEEP_PROVIDER_ROUND_MS) {
    for (const latencyMs of MOCK_CALL_LATENCIES_MS) {
      for (const batchSize of SWEEP_BATCH_SIZES) {
        const replies = replyLatencies(SWEEP_CALLS, batchSize, latencyMs, 0);
        const sequentialMs = modelTurnMs(replies, providerRoundMs, false);
        const selectiveParallelMs = modelTurnMs(replies, providerRoundMs, true);
        for (const outputBytesPerCall of SWEEP_OUTPUT_BYTES) {
          const resultTokensPerCall = payloadTokens(outputBytesPerCall);
          rows.push({
            latencyMs,
            batchSize,
            outputBytesPerCall,
            providerRoundMs,
            providerRounds: replies.length + 1,
            sequentialMs,
            selectiveParallelMs,
            savedMs: sequentialMs - selectiveParallelMs,
            savedPercent: ((sequentialMs - selectiveParallelMs) / sequentialMs) * 100,
            inputTokens: turnInputTokens(SWEEP_CALLS, batchSize, resultTokensPerCall),
            resultTokensPerCall,
          });
        }
      }
    }
  }
  return rows;
}

/**
 * Hypothetical network wait for one reply of four calls when one of them is a
 * write or an approval-gated call, under a custom barrier dispatcher: earlier
 * reads overlap, the barrier runs alone after them, later reads start after
 * it. Pi has no such dispatcher: one sequential-mode call makes Pi run the
 * whole reply in order (`SWEEP_CALLS × wait`), which the report shows beside it.
 */
export function barrierNetworkMs(latencyMs: number, barrierIndex: number): number {
  if (!Number.isInteger(barrierIndex) || barrierIndex < 0 || barrierIndex >= SWEEP_CALLS) {
    throw new Error(`barrier index must be an integer from 0 to ${SWEEP_CALLS - 1}.`);
  }
  const before = barrierIndex > 0 ? 1 : 0;
  const after = barrierIndex < SWEEP_CALLS - 1 ? 1 : 0;
  return (before + 1 + after) * latencyMs;
}
