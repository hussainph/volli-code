/**
 * VC-442 closed-form decision sweep for independent, read-only, MCP-like calls.
 *
 * Nothing here opens a transport, calls a provider or runs a tool. Every
 * number is computed from declared inputs so the table is exactly
 * reproducible; `runMockReadonlyLatencySensitivity` (prototype.ts) supplies the
 * timer-measured check that this model matches real scheduling for the
 * all-in-one-reply case. The sweep exists to show how four inputs change the
 * dispatch decision: model batching propensity, network wait, output volume,
 * and correctness constraints (dependencies and write/approval barriers).
 */

import { countTokens } from "gpt-tokenizer/encoding/cl100k_base";

const TOKEN_OPTIONS = { disallowedSpecial: new Set<string>() };

/** Independent calls the task needs, and how many the model puts in one reply. */
export const SWEEP_CALLS = 4;
export const SWEEP_BATCH_SIZES = [4, 2, 1] as const;
export const SWEEP_LATENCIES_MS = [50, 250, 900] as const;
export const SWEEP_OUTPUT_BYTES = [512, 16_384] as const;
/** The harness's scripted round, and a declared (not measured) real-model round. */
export const SWEEP_PROVIDER_ROUND_MS = [35, 2_000] as const;
/** Fixed system + tool-schema prefix re-sent on every provider round. */
const PREFIX_TOKENS = 2_000;

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

/**
 * Wall time for one turn: `replies` tool-calling rounds plus the final answer
 * round, and the network wait for each reply's calls. Sequential dispatch waits
 * for every call in turn; selective parallel dispatch waits once per reply.
 */
function turnMs(
  calls: number,
  batchSize: number,
  latencyMs: number,
  providerRoundMs: number,
  parallel: boolean,
): number {
  const replies = Math.ceil(calls / batchSize);
  const networkMs = parallel ? replies * latencyMs : calls * latencyMs;
  return (replies + 1) * providerRoundMs + networkMs;
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

export function buildMcpDecisionSweep(): McpDecisionRow[] {
  const rows: McpDecisionRow[] = [];
  for (const providerRoundMs of SWEEP_PROVIDER_ROUND_MS) {
    for (const latencyMs of SWEEP_LATENCIES_MS) {
      for (const batchSize of SWEEP_BATCH_SIZES) {
        for (const outputBytesPerCall of SWEEP_OUTPUT_BYTES) {
          const sequentialMs = turnMs(SWEEP_CALLS, batchSize, latencyMs, providerRoundMs, false);
          const selectiveParallelMs = turnMs(
            SWEEP_CALLS,
            batchSize,
            latencyMs,
            providerRoundMs,
            true,
          );
          const resultTokensPerCall = payloadTokens(outputBytesPerCall);
          rows.push({
            latencyMs,
            batchSize,
            outputBytesPerCall,
            providerRoundMs,
            providerRounds: Math.ceil(SWEEP_CALLS / batchSize) + 1,
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
 * Network wait for one reply of four calls when one of them is a write or an
 * approval-gated call. A safe scheduler treats it as a barrier: earlier reads
 * overlap each other, the barrier runs alone after them, later reads start
 * only after it. The result is ordered, and never faster than the segments.
 */
export function barrierNetworkMs(latencyMs: number, barrierIndex: number): number {
  if (!Number.isInteger(barrierIndex) || barrierIndex < 0 || barrierIndex >= SWEEP_CALLS) {
    throw new Error(`barrier index must be an integer from 0 to ${SWEEP_CALLS - 1}.`);
  }
  const before = barrierIndex > 0 ? 1 : 0;
  const after = barrierIndex < SWEEP_CALLS - 1 ? 1 : 0;
  return (before + 1 + after) * latencyMs;
}

/** The model's all-in-one prediction for a measured sweep row (two rounds, one reply). */
export function modelledAllInOneMs(
  latencyMs: number,
  reads: number,
  providerRoundMs: number,
  parallel: boolean,
): number {
  return turnMs(reads, reads, latencyMs, providerRoundMs, parallel);
}
