/**
 * How an add flow reads on the wire (VC-700): the step machine's state as an
 * `AddHostView`, its questions and failures as plain JSON with the lab's line
 * and recovery, and its log as `AddHostLogLine`s. Nothing here ever sees a
 * secret: the state holds none, and the sudo password lives in the flow's
 * `ProvisionSecrets` only.
 */
import type {
  AddHostFacts,
  AddHostFailure,
  AddHostLogLine,
  AddHostQuestion,
  AddHostStepStatus,
  AddHostView,
} from "@volli/shared";

import { describeFailure, STEP_ORDER, type StepId } from "./failures";
import type { LogFields } from "./logger";
import {
  nextStep,
  type ProvisionDecisions,
  type ProvisionResults,
  type ProvisionState,
} from "./provision";
import type { SshStepResults } from "./ssh-provider";

/** How many log lines a flow keeps for Details. */
export const ADD_HOST_LOG_LIMIT = 500;

/**
 * The most log a subscriber's first event carries (UTF-8 bytes of its lines'
 * JSON): one bounded event, however long the flow ran, so a late subscriber
 * reads it through any bounded stream. Earlier lines are counted, not sent.
 */
export const ADD_HOST_REPLAY_BYTES = 64 * 1024;

export const isSkipped = (result: unknown): boolean =>
  typeof result === "object" &&
  result !== null &&
  (result as { skipped?: unknown }).skipped === true;

/**
 * Each step's status: a result is done (or skipped); the step a stop names is
 * failed (a failure) or running (a question waits on it); `active` runs.
 */
export function stepStatuses(
  results: ProvisionResults,
  stopped: { readonly step: StepId; readonly failed: boolean } | null,
  active: StepId | null,
): AddHostView["steps"] {
  return STEP_ORDER.map((id) => {
    const result = results[id];
    let status: AddHostStepStatus = "pending";
    if (result !== undefined) status = isSkipped(result) ? "skipped" : "done";
    else if (stopped?.step === id) status = stopped.failed ? "failed" : "running";
    else if (active === id) status = "running";
    return { id, status };
  });
}

/** Where a stopped state stopped: the step without a result, which the stop came from. */
export function stoppedAt(
  state: ProvisionState,
): { readonly step: StepId; readonly failed: boolean } | null {
  const step = nextStep(state);
  if (state.stop === null || step === null) return null;
  return { step, failed: state.stop.kind === "failed" };
}

/** The question a state stopped on, as plain JSON, under the id an answer must name. */
export function questionJson(state: ProvisionState, id: string): AddHostQuestion | null {
  if (state.stop?.kind !== "question") return null;
  // Plain JSON already: a kind, a step, and the question's own facts.
  return { ...(JSON.parse(JSON.stringify(state.stop.question)) as AddHostQuestion), id };
}

/**
 * The newest lines that fit in `maxBytes`, oldest first, and how many before
 * them are left out. A line too big on its own ends the tail there.
 */
export function logTail(
  lines: readonly AddHostLogLine[],
  maxBytes: number = ADD_HOST_REPLAY_BYTES,
): { readonly lines: readonly AddHostLogLine[]; readonly omitted: number } {
  let start = lines.length;
  let bytes = 0;
  while (start > 0) {
    const size = Buffer.byteLength(JSON.stringify(lines[start - 1]));
    if (bytes + size > maxBytes) break;
    bytes += size;
    start -= 1;
  }
  return { lines: lines.slice(start), omitted: start };
}

export function failureJson(state: ProvisionState, host: string): AddHostFailure | null {
  if (state.stop?.kind !== "failed") return null;
  const { failure } = state.stop;
  const { line, recovery } = describeFailure(failure, host);
  const raw = (failure as { detail?: string | readonly string[] }).detail;
  const detail = Array.isArray(raw) ? raw.join("\n") : (raw as string | undefined);
  return {
    code: failure.code,
    step: failure.step,
    line,
    recovery,
    detail: detail === undefined || detail === "" ? null : detail,
  };
}

/** One logger call as a log line: flat fields, anything else written as JSON. */
export function logLine(
  at: string,
  level: AddHostLogLine["level"],
  message: string,
  fields: LogFields,
): AddHostLogLine {
  const flat: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    flat[key] =
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
        ? value
        : JSON.stringify(value);
  }
  return { at, level, message, fields: flat };
}

/** `uname -m` as people read it. */
export function archName(arch: string): string {
  if (arch === "x86_64" || arch === "amd64") return "x86-64";
  if (arch === "aarch64" || arch === "arm64") return "arm64";
  return arch;
}

const textOrNull = (value: string | undefined): string | null =>
  value === undefined || value.trim() === "" ? null : value.trim();

/** A step's result that carries a version, if it ran (a skipped one has none). */
const versionOf = (result: unknown): string | null => {
  const version = (result as { version?: unknown } | undefined)?.version;
  return typeof version === "string" && version !== "" ? version : null;
};

/**
 * What the steps so far have found, for the checklist's completed rows. Each
 * fact comes from a step's own result; one not yet said is `null`.
 */
export function flowFacts(results: SshStepResults, decisions: ProvisionDecisions): AddHostFacts {
  const { probe, install, start, enroll } = results;
  const os = probe === undefined ? null : probe.kernel === "Darwin" ? "macos" : "linux";
  const started = start === undefined || "skipped" in start ? null : start;
  let keepsRunning: boolean | null = null;
  if (started !== null && os !== "macos") {
    keepsRunning = started.mode === "system" ? true : started.linger;
  }
  return {
    user: textOrNull(probe?.user),
    os,
    system: textOrNull(probe?.os.name),
    arch: probe === undefined ? null : textOrNull(archName(probe.arch)),
    memoryBytes: probe?.memoryBytes ?? null,
    version: versionOf(install) ?? versionOf(started ?? undefined) ?? versionOf(enroll),
    keepsRunning,
    alreadyPaired: decisions.alreadyPaired === true || enroll?.created === false,
  };
}
