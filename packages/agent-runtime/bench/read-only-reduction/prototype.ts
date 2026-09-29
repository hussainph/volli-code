/**
 * Off-by-default, fixture-only VC-442 prototype. Nothing in this module is
 * imported by the runtime or placed on any Session's Agent Tool Surface.
 */

import { countTokens } from "gpt-tokenizer/encoding/cl100k_base";
import {
  FIXTURE_PATHS,
  FIXTURE_READ_LATENCY_MS,
  FIXTURES,
  SCRIPTED_PROVIDER_ROUND_MS,
  TASKS,
  type FixturePath,
  type FixtureTaskId,
} from "./fixtures";

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

/**
 * The closed filter AST. Its source is either explicit `paths`, or an
 * `indexPath` whose fixed `files` field names the paths; the index is read and
 * its entries pass the same capability check as explicit paths. Never code.
 */
export type FilterProgram = {
  version: 1;
  operation: "select-lines";
  containsAny: string[];
  maxMatches: number;
} & ({ paths: FixturePath[]; indexPath?: never } | { indexPath: FixturePath; paths?: never });

/** One observable nested-read event, in the order it happened. */
export interface NestedReadEvent {
  readId: number;
  kind: "read-start" | "read-end" | "read-cancelled";
  path: FixturePath;
  /** Milliseconds since the run started. */
  atMs: number;
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
  /** Tool-call ids in the order their results were committed to history. */
  resultOrder: string[];
  /** Nested-read paths in the order their reads finished. */
  completionOrder: FixturePath[];
  readEvents: NestedReadEvent[];
  maxConcurrency: number;
  historyMessages: number;
}

export interface FixtureRunOptions {
  signal?: AbortSignal;
  limits?: Partial<ReductionLimits>;
  /** Per-fixture read delay overrides, used to make completion order differ from call order. */
  readLatencyMs?: Partial<Record<FixturePath, number>>;
  /** Observer for every nested read, including reads cancelled by a failed run. */
  onReadEvent?: (event: NestedReadEvent) => void;
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

/** An abortable timer: the only "I/O" anything in this prototype performs. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
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

export async function readSequential<T, U>(
  items: readonly T[],
  read: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const result: U[] = [];
  for (let index = 0; index < items.length; index += 1)
    result.push(await read(items[index]!, index));
  return result;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median needs at least one value.");
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
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
    !hasOnlyKeys(value, ["version", "operation", "paths", "indexPath", "containsAny", "maxMatches"])
  ) {
    throw new Error("filter program must be a closed object with no executable fields.");
  }
  if (value.version !== 1 || value.operation !== "select-lines") {
    throw new Error("filter program version or operation is unsupported.");
  }
  const hasPaths = Object.hasOwn(value, "paths");
  const hasIndex = Object.hasOwn(value, "indexPath");
  if (hasPaths === hasIndex) {
    throw new Error("filter program needs exactly one source: paths or indexPath.");
  }
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
  const common = {
    version: 1 as const,
    operation: "select-lines" as const,
    containsAny,
    maxMatches: value.maxMatches,
  };
  if (hasIndex) {
    const [indexPath] = validatePaths([value.indexPath], "filter indexPath");
    return { ...common, indexPath: indexPath! };
  }
  return { ...common, paths: validatePaths(value.paths, "filter paths") };
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
 * Per-task budget. Memory is bounded through bytes: every value the harness
 * holds is an immutable in-memory fixture, and every returned result is
 * charged against a per-result and an aggregate byte ceiling before it is kept.
 */
export class RunBudget {
  readonly startedAt: number;
  readonly limits: Readonly<ReductionLimits>;
  toolCalls = 0;
  nestedReads = 0;
  resultBytes = 0;

  constructor(
    limits: Partial<ReductionLimits> = {},
    private readonly clock: () => number = nowMs,
  ) {
    this.startedAt = clock();
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
  }

  check(signal: AbortSignal): void {
    throwIfAborted(signal);
    if (this.clock() - this.startedAt > this.limits.maxTaskMs)
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

  recordResult(text: string): number {
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > this.limits.maxToolResultBytes)
      throw new Error("fixture tool result exceeded its per-result byte budget.");
    if (this.resultBytes + bytes > this.limits.maxRunResultBytes)
      throw new Error("fixture task exceeded its aggregate result byte budget.");
    this.resultBytes += bytes;
    return bytes;
  }
}

/** The only read capability: exact fixture keys, no filesystem or host APIs. */
export class FixtureReader {
  readonly events: NestedReadEvent[] = [];
  private nextReadId = 0;

  constructor(
    private readonly budget: RunBudget,
    private readonly signal: AbortSignal,
    private readonly options: Pick<FixtureRunOptions, "readLatencyMs" | "onReadEvent"> = {},
  ) {}

  private emit(event: NestedReadEvent): void {
    this.events.push(event);
    this.options.onReadEvent?.(event);
  }

  private async readReserved(path: FixturePath): Promise<string> {
    const contents = FIXTURES[path];
    const bytes = new TextEncoder().encode(contents).byteLength;
    if (bytes > this.budget.limits.maxToolResultBytes)
      throw new Error("fixture exceeds the per-read byte budget.");
    const readId = (this.nextReadId += 1);
    const at = (): number => nowMs() - this.budget.startedAt;
    this.emit({ readId, kind: "read-start", path, atMs: at() });
    try {
      await delay(this.options.readLatencyMs?.[path] ?? FIXTURE_READ_LATENCY_MS, this.signal);
      this.budget.check(this.signal);
    } catch (error) {
      this.emit({ readId, kind: "read-cancelled", path, atMs: at() });
      throw error;
    }
    this.emit({ readId, kind: "read-end", path, atMs: at() });
    return contents;
  }

  async read(path: unknown): Promise<string> {
    const [fixturePath] = validatePaths([path], "read path");
    this.budget.reserveReads(1, this.signal);
    return this.readReserved(fixturePath!);
  }

  /** The compound tool reads its explicit paths one after another, in caller order. */
  async readMany(value: unknown): Promise<readonly { path: FixturePath; text: string }[]> {
    const paths = validatePaths(value, "read_many paths");
    this.budget.reserveReads(paths.length, this.signal);
    const contents = await readSequential(paths, (path) => this.readReserved(path));
    return paths.map((path, index) => ({ path, text: contents[index]! }));
  }

  async filter(value: unknown): Promise<string> {
    const program = validateFilterProgram(value);
    let paths: FixturePath[];
    if (program.indexPath === undefined) {
      paths = program.paths;
    } else {
      // The one data-dependent step: a fixed field of a fixture index names
      // the paths. They pass the same capability check and read budget.
      this.budget.reserveReads(1, this.signal);
      paths = taskPathsAfterIndex(await this.readReserved(program.indexPath));
    }
    this.budget.reserveReads(paths.length, this.signal);
    const sources = await readSequential(paths, async (path) => ({
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

function pathSchema(): Record<string, unknown> {
  return { type: "string", enum: [...FIXTURE_PATHS] };
}

function pathListSchema(): Record<string, unknown> {
  return {
    type: "array",
    items: pathSchema(),
    minItems: 1,
    maxItems: MAX_PATHS_PER_CALL,
    uniqueItems: true,
  };
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
          properties: { paths: pathListSchema() },
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
          "Run the closed select-lines fixture filter over explicit paths or the files a fixture index lists. Literals only, never source code.",
        parameters: {
          type: "object",
          properties: {
            program: {
              type: "object",
              properties: {
                version: { type: "integer", const: 1 },
                operation: { type: "string", const: "select-lines" },
                paths: pathListSchema(),
                indexPath: pathSchema(),
                containsAny: {
                  type: "array",
                  items: { type: "string", maxLength: MAX_FILTER_TERM_CHARS },
                  minItems: 1,
                  maxItems: MAX_FILTER_TERMS,
                },
                maxMatches: { type: "integer", minimum: 1, maximum: MAX_FILTER_MATCHES },
              },
              required: ["version", "operation", "containsAny", "maxMatches"],
              oneOf: [{ required: ["paths"] }, { required: ["indexPath"] }],
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

function resultTextForMany(items: readonly { path: FixturePath; text: string }[]): string {
  return items.map(({ path, text }) => `--- ${path} ---\n${text}`).join("\n");
}

function readEventMetrics(events: readonly NestedReadEvent[]): {
  toolMs: number;
  maxConcurrency: number;
  completionOrder: FixturePath[];
} {
  const starts = new Map<number, number>();
  let toolMs = 0;
  let active = 0;
  let maxConcurrency = 0;
  const completionOrder: FixturePath[] = [];
  for (const event of events) {
    if (event.kind === "read-start") {
      starts.set(event.readId, event.atMs);
      active += 1;
      maxConcurrency = Math.max(maxConcurrency, active);
    } else {
      active -= 1;
      toolMs += event.atMs - (starts.get(event.readId) ?? event.atMs);
      if (event.kind === "read-end") completionOrder.push(event.path);
    }
  }
  return { toolMs, maxConcurrency, completionOrder };
}

/** One scripted-provider task run. This is a deterministic harness, not Pi or a model. */
export async function runFixtureTask(
  taskId: FixtureTaskId,
  lane: ReductionLane,
  options: FixtureRunOptions = {},
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
  const reader = new FixtureReader(budget, signal, options);
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

  const providerRound = async (): Promise<void> => {
    budget.check(signal);
    const requestText = `${stablePrefix}\n${userPrompt}\n${history.map(({ role, text }) => `<${role}>\n${text}`).join("\n")}`;
    inputTokens += tokenCount(requestText);
    if (providerRounds === 0) cacheWriteTokens += prefixTokens;
    else cacheReadTokens += prefixTokens;
    await delay(SCRIPTED_PROVIDER_ROUND_MS, signal);
    providerRounds += 1;
    budget.check(signal);
  };

  // Results are committed to history in call order, whatever order they
  // finished in. There is no retry path: a failed call fails the whole run.
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
      if (call.name === "read") text = await reader.read(call.args.path);
      else if (call.name === "read_many")
        text = resultTextForMany(await reader.readMany(call.args.paths));
      else text = await reader.filter(call.args.program);
      return { name: call.name, callId: id, text };
    };
    const responses = runParallel
      ? await Promise.all(calls.map((call, index) => execute(call, index)))
      : await readSequential(calls, (call, index) => execute(call, index));
    callId += calls.length;
    for (const response of responses) persistResult(response);
    return responses;
  };

  const filterCall = (source: { paths: FixturePath[] } | { indexPath: FixturePath }): ToolCall => ({
    name: "filter_lines",
    args: {
      program: {
        version: 1,
        operation: "select-lines",
        ...source,
        containsAny: [...task.filterTerms],
        maxMatches: MAX_FILTER_MATCHES,
      },
    },
  });

  /** How each lane reads a known list of independent paths. */
  const readPaths: Record<ReductionLane, (paths: readonly FixturePath[]) => Promise<unknown>> = {
    "direct-sequential": async (paths) => {
      for (const path of paths) await runToolRound([directCall(path)], false);
    },
    "safe-batch-serial": (paths) => runToolRound(paths.map(directCall), false),
    "safe-batch-parallel": (paths) => runToolRound(paths.map(directCall), true),
    "fixed-read-many": (paths) =>
      runToolRound([{ name: "read_many", args: { paths: [...paths] } }], false),
    "filter-program": (paths) => runToolRound([filterCall({ paths: [...paths] })], false),
  };

  try {
    if (!("indexPath" in task)) {
      await readPaths[lane](task.paths);
    } else if (lane === "filter-program") {
      // The filter follows the index inside one call, so it needs no round
      // to learn the shard paths. Every other lane must read the index first.
      await runToolRound([filterCall({ indexPath: task.indexPath })], false);
    } else {
      const [index] = await runToolRound([directCall(task.indexPath)], false);
      await readPaths[lane](taskPathsAfterIndex(index!.text));
    }

    // All prior results remain in the transcript and are serialized again on
    // every later request. This final scripted response is an evidence oracle,
    // not model inference: it succeeds only if the exact ground-truth lines made
    // it through the tool-result history.
    await providerRound();
    const allResults = toolOutputs.join("\n");
    const retainedEvidence = task.requiredEvidence.filter((line) =>
      allResults.includes(line),
    ).length;
    const answer =
      retainedEvidence === task.requiredEvidence.length
        ? task.expectedAnswer
        : "INSUFFICIENT_EVIDENCE";
    const readMetrics = readEventMetrics(reader.events);
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
      resultOrder,
      completionOrder: readMetrics.completionOrder,
      readEvents: [...reader.events],
      maxConcurrency: readMetrics.maxConcurrency,
      historyMessages: history.length,
    };
  } finally {
    clearTimeout(deadline);
    parentSignal?.removeEventListener("abort", forwardAbort);
    // A failed sibling in a parallel batch must not leave the others running:
    // aborting here cancels any still-pending read. Reads are side-effect-free
    // and never retried, so nothing needs undoing.
    if (!controller.signal.aborted) controller.abort(new Error("fixture run settled."));
  }
}

/** Fresh schemas used only to measure local construction/JSON overhead. */
export { toolSchemas as buildToolSchemasForBenchmark };

export const REDUCTION_BOUNDS = Object.freeze({
  maxPathsPerCall: MAX_PATHS_PER_CALL,
  maxFilterTerms: MAX_FILTER_TERMS,
  maxFilterTermChars: MAX_FILTER_TERM_CHARS,
  maxFilterMatches: MAX_FILTER_MATCHES,
  ...DEFAULT_LIMITS,
});

export const READ_ONLY_REDUCTION_LANES: readonly ReductionLane[] = [
  "direct-sequential",
  "safe-batch-serial",
  "safe-batch-parallel",
  "fixed-read-many",
  "filter-program",
];
