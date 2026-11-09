/**
 * Renderer stalls (VC-1091): the wire a window uses to tell main its frames
 * and inputs ran long, and the vocabulary every field is drawn from.
 *
 * A window observes two Chromium timelines — Long Animation Frames (a frame
 * whose work held the page past a threshold, with the scripts that ran in it)
 * and Event Timing (an input whose delay, handlers or next paint took long) —
 * and labels each entry with the interaction a person was in the middle of.
 * Main writes one `renderer-stall` line per entry beside its own
 * `main-stall` lines, and rolls them up hourly.
 *
 * Nothing on this wire is free text. Labels, operations and invoker types are
 * closed vocabularies; a script is reduced to its file's base name and its
 * function's name, both identifier-shaped or dropped; every number is a
 * rounded, bounded duration. {@link readRendererStallBatch} applies the same
 * rules on arrival that the window applied before sending, so a window that
 * sends anything else has it dropped, never logged.
 *
 * These identifiers are what later readers (a perf store, a bench comparing
 * builds) key on: a label or operation renamed here splits one series into
 * two. Add, never rename.
 */

/**
 * What a person was doing when a frame or input ran long, set by the code at
 * the start of each interaction. `idle` is "none of these": the label a stall
 * gets when no interaction claims it.
 */
export const INTERACTION_LABELS = Object.freeze([
  "pane-switch",
  "workspace-switch",
  "ticket-open",
  "board-return",
  "draft-typing",
  "send",
  "stream",
  "idle",
] as const);

export type InteractionLabel = (typeof INTERACTION_LABELS)[number];

/** Where a frame stall came from: Long Animation Frames, or Long Tasks where a build has no LoAF. */
export const RENDERER_FRAME_OPERATIONS = Object.freeze([
  "long-animation-frame",
  "longtask",
] as const);

export type RendererFrameOperation = (typeof RENDERER_FRAME_OPERATIONS)[number];

/**
 * The input events an input stall names. Event Timing reports more kinds
 * than these; anything else is `other`, so an unforeseen name never reaches
 * the log as written.
 */
export const RENDERER_INPUT_OPERATIONS = Object.freeze([
  "keydown",
  "keyup",
  "keypress",
  "beforeinput",
  "input",
  "pointerdown",
  "pointerup",
  "pointerover",
  "pointerenter",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "dragstart",
  "drop",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "other",
] as const);

export type RendererInputOperation = (typeof RENDERER_INPUT_OPERATIONS)[number];

/** How a frame's longest script was entered (LoAF's `invokerType`), or `other`. */
export const RENDERER_SCRIPT_INVOKERS = Object.freeze([
  "user-callback",
  "event-listener",
  "resolve-promise",
  "reject-promise",
  "classic-script",
  "module-script",
  "other",
] as const);

export type RendererScriptInvoker = (typeof RENDERER_SCRIPT_INVOKERS)[number];

/** The longest script that ran in a long frame: where it lives, never what it did. */
export interface RendererStallScript {
  /** Its source file's base name (`chat-plane.tsx`, `index-3f9a.js`); `no-url` when it has none. */
  readonly file: string;
  /** Its function's name, when it has one that reads as an identifier. */
  readonly function?: string;
  readonly invoker: RendererScriptInvoker;
  readonly durationMs: number;
}

/** A frame whose work held the page. */
export interface RendererFrameStall {
  readonly kind: "frame";
  readonly operation: RendererFrameOperation;
  readonly label: InteractionLabel;
  readonly durationMs: number;
  /** The part of the frame that blocked input (LoAF `blockingDuration`). */
  readonly blockingMs?: number;
  /**
   * Total attributed script duration (sum of LoAF `scripts[].duration`).
   * Absent when attribution is unavailable, not proof that no script ran.
   * May overlap style/layout (forced layout inside a script).
   */
  readonly scriptTotalMs?: number;
  /** Rendering: from the frame's render start to its end, including style/layout. */
  readonly renderMs?: number;
  /** Style and layout inside rendering. */
  readonly styleLayoutMs?: number;
  /**
   * How many attributed scripts ran in it. Absent when none were: Chromium
   * attributes only scripts served over http(s) or inline, so a bundle on the
   * app's own scheme has frames without attribution, not frames without script.
   */
  readonly scripts?: number;
  /** The longest attributed script. */
  readonly script?: RendererStallScript;
}

/** An input whose response was slow, in its three parts. */
export interface RendererInputStall {
  readonly kind: "input";
  readonly operation: RendererInputOperation;
  readonly label: InteractionLabel;
  /** From the input to the next paint. */
  readonly durationMs: number;
  /** Before its first handler ran. */
  readonly inputDelayMs: number;
  /** Its handlers. */
  readonly processingMs: number;
  /** From its handlers ending to the next paint. */
  readonly presentationMs: number;
}

export type RendererStall = RendererFrameStall | RendererInputStall;

/** What a window sends at once: its stalls, and how many it had to drop since the last batch. */
export interface RendererStallBatch {
  readonly stalls: readonly RendererStall[];
  readonly dropped: number;
}

/** The wire's bounds, applied on both sides of the IPC door. */
export const RENDERER_STALL_BOUNDS = Object.freeze({
  /** Stalls in one batch; the rest of a longer one are counted as dropped. */
  maxStalls: 32,
  /** Characters of a file or function name. */
  maxName: 120,
  /** The longest duration a line claims: past it a clock jumped (a sleep), not a frame. */
  maxDurationMs: 10 * 60 * 1000,
  /** The largest count (dropped stalls, scripts in a frame) a batch claims. */
  maxCount: 1_000_000,
});

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/u;
const FUNCTION_NAME = /^[A-Za-z_$][\w$.<>]*$/u;

function oneOf<const T extends string>(vocabulary: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (vocabulary as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** An interaction label, or null for anything outside {@link INTERACTION_LABELS}. */
export function readInteractionLabel(value: unknown): InteractionLabel | null {
  return oneOf(INTERACTION_LABELS, value);
}

/** An Event Timing entry's name as an operation: `other` for a name the vocabulary lacks. */
export function rendererInputOperation(name: unknown): RendererInputOperation {
  return oneOf(RENDERER_INPUT_OPERATIONS, name) ?? "other";
}

/** A LoAF script's `invokerType` as an invoker: `other` for a type the vocabulary lacks. */
export function rendererScriptInvoker(type: unknown): RendererScriptInvoker {
  return oneOf(RENDERER_SCRIPT_INVOKERS, type) ?? "other";
}

/**
 * A duration as the wire carries it: whole milliseconds, never negative,
 * never past {@link RENDERER_STALL_BOUNDS}`.maxDurationMs`. Null for a value
 * that is not a finite number.
 */
export function rendererStallMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(RENDERER_STALL_BOUNDS.maxDurationMs, Math.max(0, Math.round(value)));
}

/**
 * A script's source URL as a file name: the last path segment, without its
 * query or fragment. `no-url` for a script Chromium gave none (an inline
 * handler, an eval, a native callback such as a promise's resolve);
 * `unknown` for a name that does not read as a file name — never the URL
 * itself, which in a dev build carries a path on this Mac.
 */
export function rendererStallFile(url: unknown): string {
  if (typeof url !== "string" || url === "") return "no-url";
  const path = url.split(/[?#]/u, 1)[0]!;
  return rendererStallFileName(path.slice(path.lastIndexOf("/") + 1));
}

/** A file name as the wire carries it: itself when it reads as one, else `unknown`. */
function rendererStallFileName(name: unknown): string {
  return typeof name === "string" &&
    name.length <= RENDERER_STALL_BOUNDS.maxName &&
    FILE_NAME.test(name)
    ? name
    : "unknown";
}

/** A script's function name, when it reads as an identifier (`render`, `Object.flush`); else none. */
export function rendererStallFunction(name: unknown): string | undefined {
  return typeof name === "string" &&
    name.length <= RENDERER_STALL_BOUNDS.maxName &&
    FUNCTION_NAME.test(name)
    ? name
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A count: a whole number from zero, at most `max`. Null for a value that is not a number. */
function count(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(0, Math.round(value)));
}

/** An optional duration: absent stays absent, a malformed one is dropped. */
function optionalMs<K extends string>(key: K, value: unknown): { [P in K]?: number } {
  const ms = rendererStallMs(value);
  return (ms === null ? {} : { [key]: ms }) as { [P in K]?: number };
}

function readScript(value: unknown): RendererStallScript | null {
  if (!isRecord(value)) return null;
  const durationMs = rendererStallMs(value["durationMs"]);
  if (durationMs === null) return null;
  const fn = rendererStallFunction(value["function"]);
  return {
    file: rendererStallFileName(value["file"]),
    ...(fn === undefined ? {} : { function: fn }),
    invoker: rendererScriptInvoker(value["invoker"]),
    durationMs,
  };
}

/** One stall off the wire, made safe; null for anything that is not one. */
export function readRendererStall(value: unknown): RendererStall | null {
  if (!isRecord(value)) return null;
  const label = readInteractionLabel(value["label"]);
  const durationMs = rendererStallMs(value["durationMs"]);
  if (label === null || durationMs === null) return null;
  if (value["kind"] === "frame") {
    const operation = oneOf(RENDERER_FRAME_OPERATIONS, value["operation"]);
    if (operation === null) return null;
    const scripts = count(value["scripts"], RENDERER_STALL_BOUNDS.maxCount);
    const script = readScript(value["script"]);
    return {
      kind: "frame",
      operation,
      label,
      durationMs,
      ...optionalMs("scriptTotalMs", value["scriptTotalMs"]),
      ...optionalMs("blockingMs", value["blockingMs"]),
      ...optionalMs("renderMs", value["renderMs"]),
      ...optionalMs("styleLayoutMs", value["styleLayoutMs"]),
      ...(scripts === null ? {} : { scripts }),
      ...(script === null ? {} : { script }),
    };
  }
  if (value["kind"] === "input") {
    const inputDelayMs = rendererStallMs(value["inputDelayMs"]);
    const processingMs = rendererStallMs(value["processingMs"]);
    const presentationMs = rendererStallMs(value["presentationMs"]);
    if (inputDelayMs === null || processingMs === null || presentationMs === null) return null;
    return {
      kind: "input",
      operation: rendererInputOperation(value["operation"]),
      label,
      durationMs,
      inputDelayMs,
      processingMs,
      presentationMs,
    };
  }
  return null;
}

/**
 * A batch off the wire, made safe: each stall read by {@link readRendererStall}
 * (a malformed one counts as dropped), at most
 * {@link RENDERER_STALL_BOUNDS}`.maxStalls` kept. Null for anything that is
 * not a batch.
 */
export function readRendererStallBatch(value: unknown): RendererStallBatch | null {
  if (!isRecord(value) || !Array.isArray(value["stalls"])) return null;
  const raw = value["stalls"] as readonly unknown[];
  const stalls: RendererStall[] = [];
  for (const entry of raw.slice(0, RENDERER_STALL_BOUNDS.maxStalls)) {
    const stall = readRendererStall(entry);
    if (stall !== null) stalls.push(stall);
  }
  const claimed = count(value["dropped"], RENDERER_STALL_BOUNDS.maxCount) ?? 0;
  const dropped = Math.min(RENDERER_STALL_BOUNDS.maxCount, claimed + (raw.length - stalls.length));
  return { stalls, dropped };
}
