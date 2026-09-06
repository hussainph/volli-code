/**
 * What real Sessions actually did, measured from Pi's own session logs (VC-245).
 *
 * The synthetic benches answer "what *would* parallel mode save" and "does a
 * model batch when handed a batchable task". Both are hypotheticals. This
 * answers the two questions that actually decide the ticket, from the product's
 * own history:
 *
 *  1. **How much wall-clock would parallel mode have saved?** Volli executes
 *     sequentially today, so consecutive tool-result timestamps inside one
 *     assistant reply ARE the per-call durations. For every batched reply ever
 *     issued, sequential cost is the sum of those durations and parallel cost
 *     is the largest of them. The difference is measured, not modelled.
 *
 *     One inflation is deliberate and worth naming rather than burying. The
 *     gap between two tool results contains whatever happened in between,
 *     including an approval wait — and Pi's preflight is serial even in
 *     parallel mode, so approval time is exactly what concurrency CANNOT
 *     recover. The saving reported here is therefore an UPPER BOUND. That errs
 *     in favour of parallel mode while the conclusion drawn from it is against
 *     parallel mode, so it is the safe direction to be wrong in: a tighter
 *     measurement can only make the case weaker.
 *
 *  2. **How many tokens does a turn spend re-sending tool results?** A result
 *     produced in round 1 of a turn is re-sent on rounds 2..R, because the
 *     transcript is replayed every round. That re-send is what Code Mode
 *     claims to remove, and its size is the whole of Code Mode's case.
 *
 *   node --experimental-strip-types bench/parallel-tools/transcript-audit.ts
 *   VOLLI_PI_SESSIONS="/path/to/pi-sessions" node ... transcript-audit.ts
 *
 * PRIVACY. This reads the developer's own local Session history, so it is
 * opt-in, read-only, and aggregate-only by construction: it accumulates
 * lengths, counts, durations and tool names, and never retains, prints or
 * writes message text, tool arguments, command lines, file paths or session
 * ids. The output is a table of numbers. Nothing leaves the machine.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Volli's own estimator, so these numbers are commensurable with the app's. */
const CHARS_PER_TOKEN = 4;
const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

/**
 * Durations above this are read as a person, not a tool.
 *
 * A gap between tool results can contain an approval prompt, a laptop lid, or
 * an overnight pause. Ten minutes is far above any real tool call in this
 * product and far below the pauses that would otherwise dominate the mean.
 * Capped samples are counted and reported rather than dropped silently.
 */
const DURATION_CAP_MS = 600_000;

/**
 * Prose below this, in the reply that consumed a fan-out, reads as "the model
 * looked and moved on" rather than "the model synthesised".
 *
 * 600 characters is roughly a short paragraph — about 150 tokens. It is a
 * judgement call and the number it produces is a bound, not a measurement,
 * which is why the report prints it alongside the result.
 */
const TRANSIENT_PROSE_CHARS = 600;

const DEFAULT_ROOT = join(homedir(), "Library", "Application Support", "Volli Code", "pi-sessions");

/** One assistant reply and the tool calls it issued. */
interface Round {
  toolCalls: number;
  /** Measured duration of each call in this reply, in issue order. */
  durationsMs: number[];
  toolNames: string[];
  resultChars: number;
  /** Result characters by tool, so fan-out volume can be attributed. */
  resultCharsByTool: Map<string, number>;
  /** Assistant text and thinking, which is re-sent on later rounds too. */
  assistantChars: number;
}

interface Totals {
  sessions: number;
  turns: number;
  rounds: number;
  toolCalls: number;
  callingRounds: number;
  batchedRounds: number;

  /** Wall-clock actually spent on tool calls inside batched replies. */
  batchedSequentialMs: number;
  /** What those same replies would have cost with concurrent execution. */
  batchedParallelMs: number;
  /** Total measured tool time across every call, batched or not. */
  allToolMs: number;
  /** Samples discarded by {@link DURATION_CAP_MS}. */
  cappedSamples: number;

  resultChars: number;
  /** Result chars weighted by how many rounds re-sent them. */
  shippedChars: number;
  /** Result chars produced before a turn's final round. */
  intermediateChars: number;
  /** Assistant chars weighted the same way, for the model-vs-reality check. */
  assistantShippedChars: number;
  /**
   * Result chars produced by replies carrying 2+ calls.
   *
   * The honest Code Mode target. A program can absorb a fan-out whose calls
   * were issued together; it cannot absorb a dependent chain where the model
   * had to read each result to choose the next call. Quoting the whole
   * intermediate figure as addressable would be the optimistic reading.
   */
  fanoutResultChars: number;
  /** Fan-out result chars weighted by the rounds that re-sent them. */
  fanoutShippedChars: number;
  /** Number of fan-out replies, i.e. how many programs would have been written. */
  fanoutRounds: number;

  /**
   * Narrowing the fan-out ceiling by structure rather than by guessing at
   * meaning.
   *
   * A fan-out is only capturable if a program can do the reduction the model
   * would have done, and nothing in a transcript states that outright. Rather
   * than one classifier pretending to know, two independent structural signals
   * are recorded and reported as bounds:
   *
   *  - **homogeneous** — every call in the reply hit the same tool. That is
   *    the loop shape Code Mode exists for: read twelve files, search six
   *    terms, stat every package. A heterogeneous batch is more likely to be
   *    the model pursuing several unrelated threads at once, which a single
   *    program has no natural shape for.
   *  - **transient** — how much prose the model wrote about the results before
   *    its next tool call. A fan-out that returned 20k tokens and produced two
   *    sentences spent that context on nothing a program could not have
   *    discarded in-process. Heavy prose means the model was synthesising, and
   *    synthesis is the part code cannot do.
   *
   * Neither is proof. Together they bracket the honest capture rate, which is
   * what the ceiling on its own does not.
   */
  fanoutHomogeneousChars: number;
  fanoutHomogeneousRounds: number;
  /** Homogeneous fan-out volume by the tool it looped over. */
  perToolHomogeneousChars: Map<string, number>;
  /** Prose the model wrote in the reply that consumed a fan-out's results. */
  fanoutFollowOnProseChars: number;
  /** Fan-out volume whose consuming reply wrote very little prose. */
  fanoutTransientChars: number;

  /**
   * Real context actually billed, from Volli's own usage observations.
   *
   * `inputTokens` alone is near-zero on a caching provider; the prompt lives
   * in `cacheReadTokens` and `cacheWriteTokens`. Summing all three is the only
   * reading that means "what the model was given".
   */
  realContextTokens: number;
  realCacheReadTokens: number;
  realCacheWriteTokens: number;
  compactions: number;

  roundHistogram: Map<number, number>;
  batchHistogram: Map<number, number>;
  perTool: Map<string, { calls: number; chars: number; totalMs: number; samples: number }>;
  /** Per-tool time recoverable by overlapping, i.e. inside batched replies. */
  perToolSavedMs: Map<string, number>;
  /**
   * Per-tool result volume produced inside fan-out replies.
   *
   * This is what decides which tools would have to be callable from a program
   * for Code Mode to be worth building: a design that excludes the tools at
   * the top of this list cannot collect the saving the rest of the audit
   * attributes to it.
   */
  perToolFanoutChars: Map<string, number>;

  costUsd: number;
  outputTokens: number;
}

function emptyTotals(): Totals {
  return {
    sessions: 0,
    turns: 0,
    rounds: 0,
    toolCalls: 0,
    callingRounds: 0,
    batchedRounds: 0,
    batchedSequentialMs: 0,
    batchedParallelMs: 0,
    allToolMs: 0,
    cappedSamples: 0,
    resultChars: 0,
    shippedChars: 0,
    intermediateChars: 0,
    assistantShippedChars: 0,
    fanoutResultChars: 0,
    fanoutShippedChars: 0,
    fanoutRounds: 0,
    fanoutHomogeneousChars: 0,
    fanoutHomogeneousRounds: 0,
    perToolHomogeneousChars: new Map(),
    fanoutFollowOnProseChars: 0,
    fanoutTransientChars: 0,
    realContextTokens: 0,
    realCacheReadTokens: 0,
    realCacheWriteTokens: 0,
    compactions: 0,
    roundHistogram: new Map(),
    batchHistogram: new Map(),
    perTool: new Map(),
    perToolSavedMs: new Map(),
    perToolFanoutChars: new Map(),
    costUsd: 0,
    outputTokens: 0,
  };
}

function bump(map: Map<number, number>, key: number): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const part of content) {
    if (typeof part === "string") {
      chars += part.length;
      continue;
    }
    if (part === null || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    // Image parts carry no text and are counted as zero rather than guessed
    // at: images are their own design question in VC-245, and inventing a
    // token price for them here would quietly move the headline number.
    for (const key of ["text", "thinking", "content"]) {
      const value = record[key];
      if (typeof value === "string") chars += value.length;
    }
  }
  return chars;
}

/** Fold one session file into the totals. */
async function foldSession(path: string, totals: Totals): Promise<void> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let turnId: string | undefined;
  let rounds: Round[] = [];
  let current: Round | undefined;
  /** Timestamp the previous tool result (or the assistant reply) landed at. */
  let lastAt: number | undefined;

  const closeRound = (): void => {
    if (current !== undefined) rounds.push(current);
    current = undefined;
  };

  const closeTurn = (): void => {
    closeRound();
    if (rounds.length === 0) return;

    totals.turns += 1;
    totals.rounds += rounds.length;
    bump(totals.roundHistogram, rounds.length);

    rounds.forEach((round, index) => {
      totals.toolCalls += round.toolCalls;
      if (round.toolCalls > 0) {
        totals.callingRounds += 1;
        bump(totals.batchHistogram, round.toolCalls);
      }

      // The measurement at the heart of this file. Volli runs sequentially, so
      // these durations are what a batch actually cost; the largest of them is
      // what it would have cost run concurrently.
      const durations = round.durationsMs;
      if (round.toolCalls >= 2 && durations.length >= 2) {
        totals.batchedRounds += 1;
        const sum = durations.reduce((total, value) => total + value, 0);
        const slowest = Math.max(...durations);
        totals.batchedSequentialMs += sum;
        totals.batchedParallelMs += slowest;
        // Attribute the recoverable time to the tools that were waited on
        // rather than to the one that set the floor.
        durations.forEach((duration, position) => {
          if (duration === slowest) return;
          const name = round.toolNames[position] ?? "unknown";
          totals.perToolSavedMs.set(name, (totals.perToolSavedMs.get(name) ?? 0) + duration);
        });
      }

      if (round.toolCalls >= 2) {
        totals.fanoutResultChars += round.resultChars;
        totals.fanoutShippedChars += round.resultChars * (rounds.length - index);
        totals.fanoutRounds += 1;
        for (const [name, chars] of round.resultCharsByTool) {
          totals.perToolFanoutChars.set(name, (totals.perToolFanoutChars.get(name) ?? 0) + chars);
        }

        // Signal one: did this reply loop over a single tool?
        const names = round.toolNames;
        const looped = names.length >= 2 && names.every((name) => name === names[0]);
        if (looped) {
          const tool = names[0] ?? "unknown";
          totals.fanoutHomogeneousChars += round.resultChars;
          totals.fanoutHomogeneousRounds += 1;
          totals.perToolHomogeneousChars.set(
            tool,
            (totals.perToolHomogeneousChars.get(tool) ?? 0) + round.resultChars,
          );
        }

        // Signal two: how much did the model say about what came back? The
        // reply that consumed these results is the next round in the turn; a
        // fan-out at the very end of a turn has no consumer and is skipped
        // rather than counted as either kind.
        const consumer = rounds[index + 1];
        if (consumer !== undefined) {
          totals.fanoutFollowOnProseChars += consumer.assistantChars;
          if (consumer.assistantChars <= TRANSIENT_PROSE_CHARS) {
            totals.fanoutTransientChars += round.resultChars;
          }
        }
      }

      totals.resultChars += round.resultChars;
      const roundsAfter = rounds.length - 1 - index;
      totals.shippedChars += round.resultChars * (1 + roundsAfter);
      totals.assistantShippedChars += round.assistantChars * (1 + roundsAfter);
      if (roundsAfter > 0) totals.intermediateChars += round.resultChars;
    });

    rounds = [];
  };

  for await (const line of lines) {
    if (line === "") continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const at = typeof entry["timestamp"] === "number" ? entry["timestamp"] : undefined;

    // Volli's own turn boundary, carried on every observation it writes. Using
    // it rather than guessing from user messages is what makes a "turn" here
    // mean the same thing it means in the product.
    if (entry["type"] === "custom") {
      const data = entry["data"] as Record<string, unknown> | undefined;
      if (data === undefined) continue;
      const seen = typeof data["turnId"] === "string" ? data["turnId"] : undefined;
      if (seen !== undefined && seen !== turnId) {
        closeTurn();
        turnId = seen;
      }
      if (data["kind"] === "compaction") totals.compactions += 1;
      // `usage` is the billed record and the only ground truth here for how
      // big the context actually was. `message-settled` carries a usage block
      // too, but without the cache fields, so it is used for nothing.
      if (data["kind"] === "usage") {
        const usage = data["usage"] as Record<string, unknown> | undefined;
        const number = (key: string): number =>
          typeof usage?.[key] === "number" ? (usage[key] as number) : 0;
        const input = number("inputTokens");
        const cacheRead = number("cacheReadTokens");
        const cacheWrite = number("cacheWriteTokens");
        totals.realContextTokens += input + cacheRead + cacheWrite;
        totals.realCacheReadTokens += cacheRead;
        totals.realCacheWriteTokens += cacheWrite;
        totals.outputTokens += number("outputTokens");
        totals.costUsd += number("costUsd");
      }
      continue;
    }

    if (entry["type"] !== "message") continue;
    const message = entry["message"] as Record<string, unknown> | undefined;
    if (message === undefined) continue;
    const role = message["role"];

    if (role === "user") {
      closeTurn();
      turnId = undefined;
      continue;
    }

    if (role === "assistant") {
      closeRound();
      const content = message["content"];
      const toolCalls = Array.isArray(content)
        ? content.filter(
            (part) =>
              part !== null &&
              typeof part === "object" &&
              (part as { type?: string }).type === "toolCall",
          ).length
        : 0;
      current = {
        toolCalls,
        durationsMs: [],
        toolNames: [],
        resultChars: 0,
        resultCharsByTool: new Map(),
        assistantChars: contentChars(content),
      };
      lastAt = at;
      continue;
    }

    if (role === "toolResult") {
      const chars = contentChars(message["content"]);
      const name = typeof message["toolName"] === "string" ? message["toolName"] : "unknown";
      const seen = totals.perTool.get(name) ?? { calls: 0, chars: 0, totalMs: 0, samples: 0 };
      seen.calls += 1;
      seen.chars += chars;

      if (current !== undefined) {
        current.resultChars += chars;
        current.resultCharsByTool.set(name, (current.resultCharsByTool.get(name) ?? 0) + chars);
        current.toolNames.push(name);
        if (at !== undefined && lastAt !== undefined) {
          const duration = at - lastAt;
          if (duration >= 0 && duration <= DURATION_CAP_MS) {
            current.durationsMs.push(duration);
            totals.allToolMs += duration;
            seen.totalMs += duration;
            seen.samples += 1;
          } else {
            // Keep the slot aligned with toolNames so attribution stays honest.
            current.durationsMs.push(0);
            totals.cappedSamples += 1;
          }
        }
      }
      totals.perTool.set(name, seen);
      if (at !== undefined) lastAt = at;
    }
  }

  closeTurn();
  totals.sessions += 1;
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    `| ${cells.map((cell, column) => (cell ?? "").padEnd(widths[column]!)).join(" | ")} |`;
  return [
    line(headers),
    `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`,
    ...rows.map((row) => line(row)),
  ].join("\n");
}

const pct = (part: number, whole: number): string =>
  whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(1)}%`;
const hours = (ms: number): string => `${(ms / 3_600_000).toFixed(2)}h`;

async function main(): Promise<void> {
  const root = process.env["VOLLI_PI_SESSIONS"] ?? DEFAULT_ROOT;
  const totals = emptyTotals();

  const files: string[] = [];
  for (const dir of await readdir(root)) {
    const full = join(root, dir);
    try {
      if (!(await stat(full)).isDirectory()) continue;
      for (const name of await readdir(full)) {
        if (name.endsWith(".jsonl")) files.push(join(full, name));
      }
    } catch {
      continue;
    }
  }

  for (const file of files) {
    try {
      await foldSession(file, totals);
    } catch {
      continue;
    }
  }

  console.log("# Real Session transcript audit (VC-245)\n");
  console.log(
    `sessions ${totals.sessions}   turns ${totals.turns}   ` +
      `assistant rounds ${totals.rounds.toLocaleString()}   ` +
      `tool calls ${totals.toolCalls.toLocaleString()}`,
  );
  console.log(
    `recorded spend $${totals.costUsd.toFixed(2)}   ` +
      `output tokens ${totals.outputTokens.toLocaleString()}   ` +
      `compactions ${totals.compactions}   ` +
      `duration samples over cap: ${totals.cappedSamples}\n`,
  );

  // --- 1. what parallel mode would really have saved -----------------------
  console.log("## 1. Measured wall-clock, batched replies only\n");
  const savedMs = totals.batchedSequentialMs - totals.batchedParallelMs;
  console.log(
    table(
      ["quantity", "value"],
      [
        ["replies carrying 2+ calls", `${totals.batchedRounds.toLocaleString()}`],
        ["  as share of tool-calling replies", pct(totals.batchedRounds, totals.callingRounds)],
        [
          "tool calls that could overlap",
          `${(totals.toolCalls - totals.callingRounds).toLocaleString()} ` +
            `(${pct(totals.toolCalls - totals.callingRounds, totals.toolCalls)} of all calls)`,
        ],
        ["time those batches actually took", hours(totals.batchedSequentialMs)],
        ["time they would take overlapped", hours(totals.batchedParallelMs)],
        [
          "WALL-CLOCK SAVED",
          `${hours(savedMs)}  (${pct(savedMs, totals.batchedSequentialMs)} of batched tool time)`,
        ],
        ["total measured tool time", hours(totals.allToolMs)],
        ["saved as share of ALL tool time", pct(savedMs, totals.allToolMs)],
      ],
    ),
  );

  console.log("\n### Where that saving comes from\n");
  const savedRows = [...totals.perToolSavedMs.entries()]
    .toSorted((left, right) => right[1] - left[1])
    .slice(0, 10)
    .map(([name, ms]) => [name, hours(ms), pct(ms, savedMs)]);
  console.log(table(["tool", "time recoverable", "share of saving"], savedRows));

  // --- 2. real batch rate --------------------------------------------------
  console.log("\n## 2. Real batch-size distribution\n");
  const batchRows = [...totals.batchHistogram.entries()]
    .toSorted((left, right) => left[0] - right[0])
    .slice(0, 10)
    .map(([size, count]) => [
      String(size),
      count.toLocaleString(),
      pct(count, totals.callingRounds),
    ]);
  console.log(table(["calls in one reply", "replies", "share"], batchRows));

  // --- 3. the Code Mode number ---------------------------------------------
  //
  // Two independent readings of the same quantity. The modelled one replays
  // the re-send rule over the transcript; the real one is what the provider
  // billed. Printing them side by side is the only way to know whether the
  // model is worth quoting — and the ratio between them is what compaction
  // and cache behaviour actually did.
  console.log("\n## 3. Context: modelled vs billed\n");
  const resultTokens = estimateTokens(totals.resultChars);
  const shippedTokens = estimateTokens(totals.shippedChars);
  const intermediateTokens = estimateTokens(totals.intermediateChars);
  const assistantShippedTokens = estimateTokens(totals.assistantShippedChars);
  const modelledTotal = shippedTokens + assistantShippedTokens;
  const fanoutTokens = estimateTokens(totals.fanoutResultChars);

  console.log(
    table(
      ["quantity", "tokens", "note"],
      [
        [
          "BILLED context (ground truth)",
          totals.realContextTokens.toLocaleString(),
          "input + cacheRead + cacheWrite, from usage records",
        ],
        [
          "modelled context",
          modelledTotal.toLocaleString(),
          `tool results + assistant text, re-sent per round (${(modelledTotal / Math.max(totals.realContextTokens, 1)).toFixed(2)}x billed)`,
        ],
        ["", "", ""],
        ["tool results produced once", resultTokens.toLocaleString(), "sum of every result body"],
        [
          "  of which intermediate",
          intermediateTokens.toLocaleString(),
          `${pct(intermediateTokens, resultTokens)} were not the turn's last round`,
        ],
        [
          "  of which from fan-outs",
          fanoutTokens.toLocaleString(),
          `${pct(fanoutTokens, resultTokens)} came from replies issuing 2+ calls`,
        ],
        ["", "", ""],
        [
          "tool-result share of context",
          "—",
          `${pct(shippedTokens, modelledTotal)} of modelled context is tool results`,
        ],
      ],
    ),
  );

  // Scale the addressable figure onto billed reality rather than quoting the
  // model's own inflated total.
  const resultShare = shippedTokens / Math.max(modelledTotal, 1);
  const billedOnResults = totals.realContextTokens * resultShare;
  const fanoutShareOfResults = fanoutTokens / Math.max(resultTokens, 1);
  console.log(
    `\nBilled context attributable to tool results: ~${Math.round(billedOnResults).toLocaleString()} tokens ` +
      `(${pct(billedOnResults, totals.realContextTokens)} of all context).`,
  );
  console.log(
    `Of tool-result volume, ${pct(fanoutTokens, resultTokens)} came from fan-out replies — the shape a ` +
      `program could absorb. That is ~${Math.round(billedOnResults * fanoutShareOfResults).toLocaleString()} ` +
      `billed tokens, or ${pct(billedOnResults * fanoutShareOfResults, totals.realContextTokens)} of all context.`,
  );
  console.log(
    `Cache split: ${totals.realCacheReadTokens.toLocaleString()} read / ` +
      `${totals.realCacheWriteTokens.toLocaleString()} written — re-sent context is mostly cache reads, ` +
      `billed at roughly a tenth of fresh input.`,
  );

  console.log("\n### Which tools produce the fan-out volume\n");
  const fanoutRows = [...totals.perToolFanoutChars.entries()]
    .toSorted((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([name, chars]) => [
      name,
      estimateTokens(chars).toLocaleString(),
      pct(chars, totals.fanoutResultChars),
      pct(chars, totals.perTool.get(name)?.chars ?? 0),
    ]);
  console.log(
    table(
      ["tool", "fan-out result tokens", "share of fan-out", "share of that tool's output"],
      fanoutRows,
    ),
  );

  // --- the counterfactual --------------------------------------------------
  //
  // What a program would actually have cost on the fan-outs that really
  // happened. Two overheads are charged rather than wished away: the program
  // source itself is output tokens the model must write, and whatever the
  // program returns still enters context and is still re-sent on later rounds.
  // The only free parameter is how much the program manages to condense, so it
  // is swept instead of chosen.
  console.log("\n### Code Mode counterfactual on the fan-outs that really happened\n");
  const fanoutShippedTokens = estimateTokens(totals.fanoutShippedChars);
  const PROGRAM_TOKENS = 250;
  const programCost = PROGRAM_TOKENS * totals.fanoutRounds;
  const counterfactualRows = [0.05, 0.1, 0.25, 0.5].map((keep) => {
    const kept = fanoutShippedTokens * keep;
    const saved = fanoutShippedTokens - kept - programCost;
    return [
      `${(keep * 100).toFixed(0)}%`,
      Math.round(kept).toLocaleString(),
      Math.round(saved).toLocaleString(),
      pct(saved, totals.realContextTokens),
    ];
  });
  console.log(
    table(
      ["program returns", "tokens kept", "context tokens saved", "share of ALL billed context"],
      counterfactualRows,
    ),
  );
  console.log(
    `\nfan-out replies: ${totals.fanoutRounds.toLocaleString()} × ~${PROGRAM_TOKENS} tokens of program source ` +
      `= ${programCost.toLocaleString()} output tokens of overhead, already subtracted.`,
  );

  // --- narrowing the ceiling ----------------------------------------------
  console.log("\n### How much of the fan-out pool is actually programmable\n");
  const homogeneousShare = totals.fanoutHomogeneousChars / Math.max(totals.fanoutResultChars, 1);
  const transientShare = totals.fanoutTransientChars / Math.max(totals.fanoutResultChars, 1);
  console.log(
    table(
      ["signal", "share of fan-out volume", "reading"],
      [
        [
          "homogeneous (one tool looped)",
          pct(totals.fanoutHomogeneousChars, totals.fanoutResultChars),
          `${totals.fanoutHomogeneousRounds.toLocaleString()} of ${totals.fanoutRounds.toLocaleString()} fan-out replies`,
        ],
        [
          `transient (consumer wrote <${TRANSIENT_PROSE_CHARS} chars)`,
          pct(totals.fanoutTransientChars, totals.fanoutResultChars),
          "results the model barely spoke about",
        ],
        [
          "mean prose per fan-out",
          "—",
          `${Math.round(totals.fanoutFollowOnProseChars / Math.max(totals.fanoutRounds, 1)).toLocaleString()} chars written about each fan-out's results`,
        ],
      ],
    ),
  );

  console.log("\nHomogeneous fan-out volume by the tool it looped over:\n");
  const loopRows = [...totals.perToolHomogeneousChars.entries()]
    .toSorted((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([name, chars]) => [
      name,
      estimateTokens(chars).toLocaleString(),
      pct(chars, totals.fanoutHomogeneousChars),
    ]);
  console.log(table(["tool", "tokens", "share of homogeneous"], loopRows));

  // Both signals are necessary-ish conditions, not sufficient ones, so their
  // product is the conservative reading and the smaller of them is the
  // generous one. Reporting the band beats reporting a point estimate that
  // would be quoted as fact.
  const generous = Math.min(homogeneousShare, transientShare);
  const conservative = homogeneousShare * transientShare;
  const ceilingSaved = fanoutShippedTokens - fanoutShippedTokens * 0.1 - programCost;
  console.log(
    `\nCapture band: ${pct(conservative, 1)} – ${pct(generous, 1)} of fan-out volume ` +
      `(product of both signals … smaller of the two).`,
  );
  console.log(
    `Applied to the 10%-condensation row, that is ` +
      `${Math.round(ceilingSaved * conservative).toLocaleString()} – ` +
      `${Math.round(ceilingSaved * generous).toLocaleString()} context tokens, or ` +
      `${pct(ceilingSaved * conservative, totals.realContextTokens)} – ` +
      `${pct(ceilingSaved * generous, totals.realContextTokens)} of all billed context.`,
  );

  console.log("\n## 4. Rounds per turn\n");
  const roundRows = [...totals.roundHistogram.entries()]
    .toSorted((left, right) => left[0] - right[0])
    .slice(0, 10)
    .map(([count, turns]) => [String(count), turns.toLocaleString(), pct(turns, totals.turns)]);
  console.log(table(["rounds", "turns", "share"], roundRows));

  console.log("\n## 5. Result volume and latency by tool\n");
  const toolRows = [...totals.perTool.entries()]
    .toSorted((left, right) => right[1].chars - left[1].chars)
    .slice(0, 14)
    .map(([name, seen]) => [
      name,
      seen.calls.toLocaleString(),
      estimateTokens(seen.chars).toLocaleString(),
      estimateTokens(seen.chars / seen.calls).toLocaleString(),
      pct(seen.chars, totals.resultChars),
      seen.samples === 0 ? "-" : `${Math.round(seen.totalMs / seen.samples).toLocaleString()}ms`,
    ]);
  console.log(
    table(
      ["tool", "calls", "total tokens", "mean tokens", "share results", "mean duration"],
      toolRows,
    ),
  );
}

await main();
