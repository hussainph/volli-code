/**
 * Off-by-default, fixture-only VC-442 prototype. Nothing in this module is
 * imported by the runtime or exposed on a Session's frozen tool surface.
 */

import { countTokens } from "gpt-tokenizer/encoding/cl100k_base";
import { FIXTURES, FIXTURE_PATHS, TASKS, type FixturePath, type FixtureTaskId } from "./fixtures";

const PROVIDER_LATENCY_MS = 35;
const FIXTURE_READ_LATENCY_MS = 8;
const MAX_TASK_MS = 2_000;
const MAX_TOOL_CALLS = 16;
const MAX_NESTED_READS = 16;
const MAX_PATHS_PER_CALL = 8;
const MAX_TOOL_RESULT_BYTES = 64 * 1024;
const MAX_RUN_RESULT_BYTES = 128 * 1024;
const MAX_FILTER_TERMS = 8;
const MAX_FILTER_TERM_CHARS = 80;
const MAX_FILTER_MATCHES = 20;
const MAX_FILTER_LINES_SCANNED = 8_192;
const TOKEN_OPTIONS = { disallowedSpecial: new Set<string>() };

export type ReductionLane =
  | "direct-sequential"
  | "safe-batch-serial"
  | "safe-batch-parallel"
  | "fixed-read-many"
  | "filter-program";

export interface ToolSchemaFixture {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface FilterProgram {
  version: 1;
  operation: "select-lines";
  paths: FixturePath[];
  containsAny: string[];
  maxMatches: number;
}

export interface FixtureRunResult {
  taskId: FixtureTaskId;
  lane: ReductionLane;
  elapsedMs: number;
  providerRounds: number;
  toolCalls: number;
  nestedReads: number;
  toolMs: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  resultTokens: number;
  resultBytes: number;
  schemaTokens: number;
  correct: boolean;
  retainedEvidence: number;
  evidenceCount: number;
  retries: number;
  resultOrder: string[];
  maxConcurrency: number;
  historyMessages: number;
}

interface FixtureMessage {
  role: "assistant" | "tool";
  text: string;
}

interface ToolCall {
  name: "read" | "read_many" | "filter_lines";
  args: Readonly<Record<string, unknown>>;
}

interface ToolResponse {
  name: ToolCall["name"];
  callId: string;
  text: string;
}

interface ReadSample {
  startedAt: number;
  endedAt: number;
}

function tokenCount(text: string): number {
  return countTokens(text, TOKEN_OPTIONS);
}

function nowMs(): number {
  return performance.now();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error("fixture run cancelled");
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : new Error("fixture run cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isFixturePath(value: unknown): value is FixturePath {
  return typeof value === "string" && Object.hasOwn(FIXTURES, value);
}

function validatePaths(value: unknown, field: string): FixturePath[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PATHS_PER_CALL) {
    throw new Error(`${field} must contain between 1 and ${MAX_PATHS_PER_CALL} fixture paths.`);
  }
  const paths = value.map((candidate): FixturePath => {
    if (!isFixturePath(candidate))
      throw new Error(`${field} contains a path outside the fixture capability.`);
    return candidate;
  });
  if (new Set(paths).size !== paths.length)
    throw new Error(`${field} must not repeat a fixture path.`);
  return paths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Validate the closed filter AST; source text is never compiled or evaluated. */
export function validateFilterProgram(value: unknown): FilterProgram {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "operation", "paths", "containsAny", "maxMatches"])
  ) {
    throw new Error("filter program must be a closed object with no executable fields.");
  }
  if (value.version !== 1 || value.operation !== "select-lines") {
    throw new Error("filter program version or operation is unsupported.");
  }
  const paths = validatePaths(value.paths, "filter paths");
  const terms = value.containsAny;
  if (!Array.isArray(terms) || terms.length < 1 || terms.length > MAX_FILTER_TERMS) {
    throw new Error(`containsAny must contain between 1 and ${MAX_FILTER_TERMS} literal terms.`);
  }
  const containsAny = terms.map((term): string => {
    if (
      typeof term !== "string" ||
      term.trim().length === 0 ||
      term.length > MAX_FILTER_TERM_CHARS
    ) {
      throw new Error(
        `filter terms must be non-empty strings of at most ${MAX_FILTER_TERM_CHARS} characters.`,
      );
    }
    return term;
  });
  if (
    typeof value.maxMatches !== "number" ||
    !Number.isInteger(value.maxMatches) ||
    value.maxMatches < 1 ||
    value.maxMatches > MAX_FILTER_MATCHES
  ) {
    throw new Error(`maxMatches must be an integer from 1 to ${MAX_FILTER_MATCHES}.`);
  }
  return {
    version: 1,
    operation: "select-lines",
    paths,
    containsAny,
    maxMatches: value.maxMatches,
  };
}

/** Every bound the prototype enforces, overridable only by tests to prove enforcement. */
export interface ReductionLimits {
  maxTaskMs: number;
  maxToolCalls: number;
  maxNestedReads: number;
  maxToolResultBytes: number;
  maxRunResultBytes: number;
  maxFilterLinesScanned: number;
}

const DEFAULT_LIMITS: Readonly<ReductionLimits> = Object.freeze({
  maxTaskMs: MAX_TASK_MS,
  maxToolCalls: MAX_TOOL_CALLS,
  maxNestedReads: MAX_NESTED_READS,
  maxToolResultBytes: MAX_TOOL_RESULT_BYTES,
  maxRunResultBytes: MAX_RUN_RESULT_BYTES,
  maxFilterLinesScanned: MAX_FILTER_LINES_SCANNED,
});

/**
 * Per-run budget. Memory is bounded through bytes: every value the harness
 * holds is an immutable in-memory fixture, and every returned result is
 * charged against a per-result and an aggregate byte ceiling before it is kept.
 */
export class RunBudget {
  readonly startedAt: number;
  readonly limits: Readonly<ReductionLimits>;
  toolCalls = 0;
  nestedReads = 0;
  resultBytes = 0;
  maxConcurrency = 0;
  private activeReads = 0;

  constructor(limits: Partial<ReductionLimits> = {}) {
    this.startedAt = nowMs();
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
  }

  check(signal: AbortSignal): void {
    throwIfAborted(signal);
    if (nowMs() - this.startedAt > this.limits.maxTaskMs)
      throw new Error("fixture task exceeded its time budget.");
  }

  recordToolCall(signal: AbortSignal): void {
    this.check(signal);
    this.toolCalls += 1;
    if (this.toolCalls > this.limits.maxToolCalls)
      throw new Error("fixture task exceeded its tool-call budget.");
  }

  reserveReads(count: number, signal: AbortSignal): void {
    this.check(signal);
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      this.nestedReads + count > this.limits.maxNestedReads
    ) {
      throw new Error("fixture task exceeded its nested-read budget.");
    }
    this.nestedReads += count;
  }

  beginRead(): void {
    this.activeReads += 1;
    this.maxConcurrency = Math.max(this.maxConcurrency, this.activeReads);
  }

  endRead(): void {
    this.activeReads -= 1;
  }

  recordResult(text: string): number {
    const bytes = new TextEncoder().encode(text).byteLength;
    if (
      bytes > this.limits.maxToolResultBytes ||
      this.resultBytes + bytes > this.limits.maxRunResultBytes
    ) {
      throw new Error("fixture tool result exceeded its byte budget.");
    }
    this.resultBytes += bytes;
    return bytes;
  }
}

/** The only read capability: exact fixture keys, no filesystem or process APIs. */
export class FixtureReader {
  readonly samples: ReadSample[] = [];

  constructor(
    private readonly budget: RunBudget,
    private readonly signal: AbortSignal,
  ) {}

  private async readReserved(path: FixturePath): Promise<string> {
    const contents = FIXTURES[path];
    const bytes = new TextEncoder().encode(contents).byteLength;
    if (bytes > this.budget.limits.maxToolResultBytes)
      throw new Error("fixture exceeds the per-read byte budget.");
    this.budget.beginRead();
    const startedAt = nowMs();
    try {
      await delay(FIXTURE_READ_LATENCY_MS, this.signal);
      this.budget.check(this.signal);
      const endedAt = nowMs();
      this.samples.push({ startedAt, endedAt });
      return contents;
    } finally {
      this.budget.endRead();
    }
  }

  async read(path: unknown): Promise<string> {
    const [fixturePath] = validatePaths([path], "read path");
    this.budget.reserveReads(1, this.signal);
    return this.readReserved(fixturePath!);
  }

  async readMany(
    value: unknown,
    parallel: boolean,
  ): Promise<readonly { path: FixturePath; text: string }[]> {
    const paths = validatePaths(value, "read_many paths");
    this.budget.reserveReads(paths.length, this.signal);
    const contents = parallel
      ? await Promise.all(paths.map((path) => this.readReserved(path)))
      : await readSequential(paths, (path) => this.readReserved(path));
    return paths.map((path, index) => ({ path, text: contents[index]! }));
  }

  async filter(value: unknown): Promise<string> {
    const program = validateFilterProgram(value);
    this.budget.reserveReads(program.paths.length, this.signal);
    const sources = await readSequential(program.paths, async (path) => ({
      path,
      text: await this.readReserved(path),
    }));
    const matches: { path: FixturePath; line: number; text: string }[] = [];
    let scanned = 0;
    for (const source of sources) {
      const lines = source.text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        scanned += 1;
        if (scanned > this.budget.limits.maxFilterLinesScanned)
          throw new Error("filter program exceeded its line-scan budget.");
        const text = lines[index]!;
        if (program.containsAny.some((term) => text.includes(term))) {
          matches.push({ path: source.path, line: index + 1, text });
          if (matches.length >= program.maxMatches) break;
        }
      }
      if (matches.length >= program.maxMatches) break;
    }
    return JSON.stringify({ operation: program.operation, matches });
  }
}

async function readSequential<T, U>(
  items: readonly T[],
  read: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const result: U[] = [];
  for (let index = 0; index < items.length; index += 1)
    result.push(await read(items[index]!, index));
  return result;
}

function pathSchema(): Record<string, unknown> {
  return { type: "string", enum: [...FIXTURE_PATHS] };
}

function directCall(path: FixturePath): ToolCall {
  return { name: "read", args: { path } };
}

function toolSchemas(lane: ReductionLane): ToolSchemaFixture[] {
  const read: ToolSchemaFixture = {
    name: "read",
    description: "Read one exact member of the benchmark fixture set.",
    parameters: {
      type: "object",
      properties: { path: pathSchema() },
      required: ["path"],
      additionalProperties: false,
    },
  };
  if (lane === "fixed-read-many") {
    return [
      read,
      {
        name: "read_many",
        description:
          "Read up to eight explicit fixture paths in caller order; no path discovery or shell is available.",
        parameters: {
          type: "object",
          properties: {
            paths: {
              type: "array",
              items: pathSchema(),
              minItems: 1,
              maxItems: MAX_PATHS_PER_CALL,
              uniqueItems: true,
            },
          },
          required: ["paths"],
          additionalProperties: false,
        },
      },
    ];
  }
  if (lane === "filter-program") {
    return [
      read,
      {
        name: "filter_lines",
        description:
          "Run the closed select-lines fixture filter. This accepts literals only, never source code.",
        parameters: {
          type: "object",
          properties: {
            program: {
              type: "object",
              properties: {
                version: { type: "integer", const: 1 },
                operation: { type: "string", const: "select-lines" },
                paths: {
                  type: "array",
                  items: pathSchema(),
                  minItems: 1,
                  maxItems: MAX_PATHS_PER_CALL,
                  uniqueItems: true,
                },
                containsAny: {
                  type: "array",
                  items: { type: "string", maxLength: MAX_FILTER_TERM_CHARS },
                  minItems: 1,
                  maxItems: MAX_FILTER_TERMS,
                },
                maxMatches: { type: "integer", minimum: 1, maximum: MAX_FILTER_MATCHES },
              },
              required: ["version", "operation", "paths", "containsAny", "maxMatches"],
              additionalProperties: false,
            },
          },
          required: ["program"],
          additionalProperties: false,
        },
      },
    ];
  }
  return [read];
}

function taskPathsAfterIndex(indexText: string): FixturePath[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(indexText);
  } catch {
    throw new Error("fixture index is not valid JSON.");
  }
  if (!isRecord(parsed)) throw new Error("fixture index must be an object.");
  return validatePaths(parsed.files, "fixture index files");
}

function ordinaryTaskPaths(taskId: FixtureTaskId): readonly FixturePath[] {
  switch (taskId) {
    case "single-call":
      return TASKS[taskId].paths;
    case "independent-multi-read":
      return TASKS[taskId].paths;
    case "dependent-loop-filter":
      return [];
    case "noisy-large-output":
      return TASKS[taskId].paths;
  }
}

function resultTextForMany(items: readonly { path: FixturePath; text: string }[]): string {
  return items.map(({ path, text }) => `--- ${path} ---\n${text}`).join("\n");
}

function readSamplesMetrics(samples: readonly ReadSample[]): {
  toolMs: number;
  maxConcurrency: number;
} {
  const toolMs = samples.reduce((total, sample) => total + sample.endedAt - sample.startedAt, 0);
  const edges = samples
    .flatMap((sample) => [
      { at: sample.startedAt, delta: 1 },
      { at: sample.endedAt, delta: -1 },
    ])
    .toSorted((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let maxConcurrency = 0;
  for (const edge of edges) {
    active += edge.delta;
    maxConcurrency = Math.max(maxConcurrency, active);
  }
  return { toolMs, maxConcurrency };
}

function strategyForLane(lane: ReductionLane): "direct" | "batch" | "compound" | "filter" {
  if (lane === "direct-sequential") return "direct";
  if (lane === "safe-batch-serial" || lane === "safe-batch-parallel") return "batch";
  if (lane === "fixed-read-many") return "compound";
  return "filter";
}

/** One scripted-provider task run. This is a deterministic harness, not Pi or a model. */
export async function runFixtureTask(
  taskId: FixtureTaskId,
  lane: ReductionLane,
  options: { signal?: AbortSignal; limits?: Partial<ReductionLimits> } = {},
): Promise<FixtureRunResult> {
  const startedAt = nowMs();
  const controller = new AbortController();
  const parentSignal = options.signal;
  const forwardAbort = (): void => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) forwardAbort();
  else parentSignal?.addEventListener("abort", forwardAbort, { once: true });
  const budget = new RunBudget(options.limits);
  const deadline = setTimeout(
    () => controller.abort(new Error("fixture task time budget expired.")),
    budget.limits.maxTaskMs,
  );
  const { signal } = controller;
  const task = TASKS[taskId];
  const reader = new FixtureReader(budget, signal);
  const schemas = toolSchemas(lane);
  const stablePrefix = [
    "VC-442 scripted fixture benchmark; no production Session, model, shell or workspace is attached.",
    `Tools: ${JSON.stringify(schemas)}`,
  ].join("\n");
  const userPrompt = `<user>\n${task.prompt}`;
  const prefixTokens = tokenCount(stablePrefix);
  const schemaTokens = tokenCount(JSON.stringify(schemas));
  const history: FixtureMessage[] = [];
  const toolOutputs: string[] = [];
  const resultOrder: string[] = [];
  let providerRounds = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let resultTokens = 0;
  let callId = 0;
  const strategy = strategyForLane(lane);
  const parallelBatch = lane === "safe-batch-parallel";

  const providerRound = async (): Promise<void> => {
    budget.check(signal);
    const requestText = `${stablePrefix}\n${userPrompt}\n${history.map(({ role, text }) => `<${role}>\n${text}`).join("\n")}`;
    inputTokens += tokenCount(requestText);
    if (providerRounds === 0) cacheWriteTokens += prefixTokens;
    else cacheReadTokens += prefixTokens;
    await delay(PROVIDER_LATENCY_MS, signal);
    providerRounds += 1;
    budget.check(signal);
  };

  const persistResult = (response: ToolResponse): void => {
    budget.recordResult(response.text);
    resultTokens += tokenCount(response.text);
    toolOutputs.push(response.text);
    resultOrder.push(response.callId);
    history.push({
      role: "tool",
      text: `${response.name} result (${response.callId}):\n${response.text}`,
    });
  };

  const runToolRound = async (
    calls: readonly ToolCall[],
    runParallel: boolean,
  ): Promise<ToolResponse[]> => {
    await providerRound();
    history.push({ role: "assistant", text: JSON.stringify({ toolCalls: calls }) });
    const execute = async (call: ToolCall, index: number): Promise<ToolResponse> => {
      budget.recordToolCall(signal);
      const id = `call-${callId + index + 1}`;
      let text: string;
      if (call.name === "read") {
        text = await reader.read(call.args.path);
      } else if (call.name === "read_many") {
        text = resultTextForMany(await reader.readMany(call.args.paths, false));
      } else {
        const program = call.args.program;
        text = await reader.filter(program);
      }
      return { name: call.name, callId: id, text };
    };
    const responses = runParallel
      ? await Promise.all(calls.map((call, index) => execute(call, index)))
      : await readSequential(calls, (call, index) => execute(call, index));
    callId += calls.length;
    for (const response of responses) persistResult(response);
    return responses;
  };

  const runDirectOneByOne = async (paths: readonly FixturePath[]): Promise<ToolResponse[]> => {
    const results: ToolResponse[] = [];
    for (const path of paths) results.push(...(await runToolRound([directCall(path)], false)));
    return results;
  };
  const runBatchedReads = (paths: readonly FixturePath[]): Promise<ToolResponse[]> =>
    runToolRound(paths.map(directCall), parallelBatch);
  const runCompound = (paths: readonly FixturePath[]): Promise<ToolResponse[]> =>
    runToolRound([{ name: "read_many", args: { paths } }], false);
  const runFilter = (paths: readonly FixturePath[]): Promise<ToolResponse[]> =>
    runToolRound(
      [
        {
          name: "filter_lines",
          args: {
            program: {
              version: 1,
              operation: "select-lines",
              paths: [...paths],
              containsAny: [...task.filterTerms],
              maxMatches: MAX_FILTER_MATCHES,
            },
          },
        },
      ],
      false,
    );

  try {
    if (strategy === "direct") {
      if (taskId === "dependent-loop-filter") {
        const index = await runDirectOneByOne([TASKS["dependent-loop-filter"].indexPath]);
        const paths = taskPathsAfterIndex(index[0]!.text);
        await runDirectOneByOne(paths);
      } else {
        await runDirectOneByOne(ordinaryTaskPaths(taskId));
      }
    } else if (strategy === "batch") {
      if (taskId === "dependent-loop-filter") {
        const index = await runDirectOneByOne([TASKS["dependent-loop-filter"].indexPath]);
        const paths = taskPathsAfterIndex(index[0]!.text);
        await runBatchedReads(paths);
      } else {
        await runBatchedReads(ordinaryTaskPaths(taskId));
      }
    } else if (strategy === "compound") {
      if (taskId === "dependent-loop-filter") {
        const index = await runDirectOneByOne([TASKS["dependent-loop-filter"].indexPath]);
        const paths = taskPathsAfterIndex(index[0]!.text);
        await runCompound(paths);
      } else {
        await runCompound(ordinaryTaskPaths(taskId));
      }
    } else if (strategy === "filter") {
      if (taskId === "dependent-loop-filter") {
        const index = await runDirectOneByOne([TASKS["dependent-loop-filter"].indexPath]);
        const paths = taskPathsAfterIndex(index[0]!.text);
        await runFilter(paths);
      } else {
        await runFilter(ordinaryTaskPaths(taskId));
      }
    }

    // All prior results remain in the transcript and are serialized again on
    // every later request. This final scripted response is an evidence oracle,
    // not model inference: it succeeds only if the exact ground-truth lines made
    // it through the tool-result history.
    await providerRound();
    const taskResults = taskOutputs(taskId, toolOutputs);
    const retainedEvidence = task.requiredEvidence.filter((line) =>
      taskResults.includes(line),
    ).length;
    const answer =
      retainedEvidence === task.requiredEvidence.length
        ? task.expectedAnswer
        : "INSUFFICIENT_EVIDENCE";
    const readMetrics = readSamplesMetrics(reader.samples);
    return {
      taskId,
      lane,
      elapsedMs: nowMs() - startedAt,
      providerRounds,
      toolCalls: budget.toolCalls,
      nestedReads: budget.nestedReads,
      toolMs: readMetrics.toolMs,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      resultTokens,
      resultBytes: budget.resultBytes,
      schemaTokens,
      correct: answer === task.expectedAnswer,
      retainedEvidence,
      evidenceCount: task.requiredEvidence.length,
      retries: 0,
      resultOrder,
      maxConcurrency: readMetrics.maxConcurrency,
      historyMessages: history.length,
    };
  } finally {
    clearTimeout(deadline);
    parentSignal?.removeEventListener("abort", forwardAbort);
    // A failed sibling in a parallel batch must not leave the others running:
    // aborting here cancels any still-pending read delay. Reads are
    // side-effect-free and never retried, so nothing needs undoing.
    if (!controller.signal.aborted) controller.abort(new Error("fixture run settled."));
  }
}

export interface MockReadonlyLatencySensitivity {
  latencyMs: number;
  reads: number;
  sequentialMs: number;
  parallelMs: number;
  savedMs: number;
  turnSavedPercent: number;
  providerRounds: number;
  maxConcurrency: number;
  sameResults: boolean;
}

/**
 * Isolated synthetic MCP-like latency sweep. These delayed calls return fixed
 * in-memory values and open no network connection; only their declared latency
 * changes. Provider rounds stay fixed so the result isolates read-only overlap.
 */
export async function runMockReadonlyLatencySensitivity(
  options: { latenciesMs?: readonly number[]; reads?: number; repeats?: number } = {},
): Promise<MockReadonlyLatencySensitivity[]> {
  const latencies = options.latenciesMs ?? [50, 250, 900];
  const reads = options.reads ?? 4;
  const repeats = options.repeats ?? 3;
  if (!Number.isInteger(reads) || reads < 2 || reads > MAX_PATHS_PER_CALL) {
    throw new Error(`latency sweep reads must be between 2 and ${MAX_PATHS_PER_CALL}.`);
  }
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) {
    throw new Error("latency sweep repeats must be an integer from 1 to 20.");
  }
  if (
    latencies.length === 0 ||
    latencies.some((latency) => !Number.isFinite(latency) || latency < 1 || latency > 2_000)
  ) {
    throw new Error("latency sweep values must be from 1 to 2000 milliseconds.");
  }

  const measure = async (
    latencyMs: number,
    parallel: boolean,
  ): Promise<{ elapsedMs: number; maxConcurrency: number; results: string[] }> => {
    const controller = new AbortController();
    const budgetTimer = setTimeout(
      () => controller.abort(new Error("latency sensitivity task exceeded its bound.")),
      latencyMs * reads + 2_000,
    );
    const startedAt = nowMs();
    let active = 0;
    let maxConcurrency = 0;
    const read = async (index: number): Promise<string> => {
      active += 1;
      maxConcurrency = Math.max(maxConcurrency, active);
      try {
        await delay(latencyMs, controller.signal);
        return `fixed-read-result-${index}`;
      } finally {
        active -= 1;
      }
    };
    try {
      await delay(PROVIDER_LATENCY_MS, controller.signal);
      const indices = Array.from({ length: reads }, (_, index) => index);
      const results = parallel
        ? await Promise.all(indices.map((index) => read(index)))
        : await readSequential(indices, (index) => read(index));
      await delay(PROVIDER_LATENCY_MS, controller.signal);
      return { elapsedMs: nowMs() - startedAt, maxConcurrency, results };
    } finally {
      clearTimeout(budgetTimer);
    }
  };

  const rows: MockReadonlyLatencySensitivity[] = [];
  for (const latencyMs of latencies) {
    const serialSamples = [];
    const parallelSamples = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      serialSamples.push(await measure(latencyMs, false));
      parallelSamples.push(await measure(latencyMs, true));
    }
    const serialMs = medianNumbers(serialSamples.map((sample) => sample.elapsedMs));
    const parallelMs = medianNumbers(parallelSamples.map((sample) => sample.elapsedMs));
    const expected = serialSamples[0]!.results.join(",");
    const sameResults = [...serialSamples, ...parallelSamples].every(
      (sample) => sample.results.join(",") === expected,
    );
    rows.push({
      latencyMs,
      reads,
      sequentialMs: serialMs,
      parallelMs,
      savedMs: serialMs - parallelMs,
      turnSavedPercent: serialMs === 0 ? 0 : ((serialMs - parallelMs) / serialMs) * 100,
      providerRounds: 2,
      maxConcurrency: Math.max(...parallelSamples.map((sample) => sample.maxConcurrency)),
      sameResults,
    });
  }
  return rows;
}

function medianNumbers(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function taskOutputs(taskId: FixtureTaskId, outputs: readonly string[]): string {
  // Preserve the complete set of tool results for the correctness oracle. The
  // transcript itself is held separately in `history` and never compacted.
  return `${taskId}\n${outputs.join("\n")}`;
}

/** Fresh schemas used only to measure local construction/JSON overhead. */
export function buildToolSchemasForBenchmark(lane: ReductionLane): ToolSchemaFixture[] {
  return toolSchemas(lane);
}

export const REDUCTION_BOUNDS = Object.freeze({
  providerLatencyMs: PROVIDER_LATENCY_MS,
  fixtureReadLatencyMs: FIXTURE_READ_LATENCY_MS,
  maxTaskMs: MAX_TASK_MS,
  maxToolCalls: MAX_TOOL_CALLS,
  maxNestedReads: MAX_NESTED_READS,
  maxPathsPerCall: MAX_PATHS_PER_CALL,
  maxToolResultBytes: MAX_TOOL_RESULT_BYTES,
  maxRunResultBytes: MAX_RUN_RESULT_BYTES,
  maxFilterTerms: MAX_FILTER_TERMS,
  maxFilterTermChars: MAX_FILTER_TERM_CHARS,
  maxFilterMatches: MAX_FILTER_MATCHES,
  maxFilterLinesScanned: MAX_FILTER_LINES_SCANNED,
});

export const READ_ONLY_REDUCTION_LANES: readonly ReductionLane[] = [
  "direct-sequential",
  "safe-batch-serial",
  "safe-batch-parallel",
  "fixed-read-many",
  "filter-program",
];
