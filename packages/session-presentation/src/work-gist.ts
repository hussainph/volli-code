import type { ActivityDescriptor, ActivityKind } from "@volli/shared";
import type { DynamicToolUIPart } from "ai";
import {
  activityDescriptor,
  describeActivity,
  isBundleStreaming,
  type BundleRow,
} from "./activity";
import { presentTranscriptTool } from "./tool-presentation";

const EXPLORATION = new Set<ActivityKind>(["read-file", "search", "list-directory"]);
const MEASURED = new Set<ActivityKind>([
  ...EXPLORATION,
  "edit-file",
  "write-file",
  "fetch-url",
  "run-command",
]);
const PHRASES: Record<ActivityKind, readonly [string, string, string, string]> = {
  "read-file": ["read", "reading", "file", "files"],
  "edit-file": ["edited", "editing", "file", "files"],
  "write-file": ["created", "creating", "file", "files"],
  "run-command": ["ran", "running", "command", "commands"],
  search: ["searched", "searching", "time", "times"],
  "list-directory": ["listed", "listing", "directory", "directories"],
  "fetch-url": ["fetched", "fetching", "page", "pages"],
  plan: ["updated", "updating", "plan", "plans"],
  delegate: ["delegated", "delegating", "task", "tasks"],
  browse: ["browsed", "browsing", "time", "times"],
  other: ["used", "using", "tool", "tools"],
};

type Tool = { part: DynamicToolUIPart; descriptor: ActivityDescriptor };

/** Match the visible specialized row, including failures inside successful tool envelopes. */
function toolStatus(part: DynamicToolUIPart) {
  return presentTranscriptTool(part)?.status ?? describeActivity(part).status;
}

function fileIdentity(tool: Tool): string | null {
  return tool.descriptor.subject.path?.trim() || tool.descriptor.subject.label?.trim() || null;
}

/** These rows observe/control an existing command; they did not run a new one. */
function commandObservation(tool: Tool): boolean {
  return /\(background · (?:read|killed)\)$/.test(tool.descriptor.subject.label ?? "");
}

function phrase(kind: ActivityKind, tools: readonly Tool[], active: boolean): string {
  const [past, present, one, many] = PHRASES[kind];
  let count = tools.length;
  if (["read-file", "edit-file", "write-file"].includes(kind)) {
    const identities = tools.map(fileIdentity);
    // An unnamed call proves an operation, not another distinct file.
    if (identities.some((identity) => identity === null)) {
      const operation = { "read-file": "read", "edit-file": "edit", "write-file": "write" }[
        kind as "read-file" | "edit-file" | "write-file"
      ];
      return `${active ? "making" : "made"} ${count} file ${operation}${count === 1 ? "" : "s"}`;
    }
    count = new Set(identities).size;
  }
  return `${active ? present : past} ${count} ${count === 1 ? one : many}`;
}

function measured(tool: Tool): boolean {
  if (!MEASURED.has(tool.descriptor.kind) || commandObservation(tool)) return false;
  if (tool.descriptor.kind !== "run-command") return true;
  const input: unknown = tool.part.input;
  const command =
    typeof input === "object" && input !== null && "command" in input
      ? input.command
      : tool.descriptor.subject.label;
  // Deliberately conservative, not a shell parser: even `echo sleep` loses its
  // duration. Wait/poll/sleep wrappers and mixed `build; sleep 60` never earn it.
  return typeof command === "string" && !/\b(?:sleep|wait|poll)\b/i.test(command);
}

/**
 * Recorded execution occupancy, NOT turn elapsed time or model/CPU time.
 * Union the completed, non-delegate file/search/list/fetch/command intervals;
 * overlapping calls count once, gaps and delegate waits count zero. Reasoning,
 * generic tools (which may hide programs/waits), browser interaction, plans,
 * explicit sleep/wait/poll commands and background read/kill observations are
 * unmeasured. A background start measures dispatch only, not the process life.
 *
 * If any measured call is unfinished, lacks either clock, steps backwards, or
 * exceeds one hour, omit the entire duration rather than extrapolate, truncate
 * or present a timed subset as complete. One hour is an outlier guard against
 * stale/suspended host clocks, not a claim that longer jobs did no work. The
 * window's boundary clocks are deliberately never inputs. Sub-second totals
 * are omitted. This restricted occupancy estimate excludes unobservable model
 * work, but is NOT a lower bound on active work: hidden script sleeps and host
 * suspension inside a recorded interval can overcount it. The outlier guard
 * limits that uncertainty; it does not establish CPU activity or detect
 * suspension.
 */
function recordedExecutionMs(tools: readonly Tool[]): number | null {
  const intervals: [number, number][] = [];
  for (const tool of tools.filter(measured)) {
    const { startedAt: start, endedAt: end } = tool.descriptor;
    const status = toolStatus(tool.part);
    if (
      (status !== "done" && status !== "failed") ||
      start === null ||
      end === null ||
      end < start ||
      end - start > 3_600_000
    )
      return null;
    intervals.push([start, end]);
  }
  intervals.sort((left, right) => left[0] - right[0]);
  let total = 0;
  let coveredUntil = -Infinity;
  for (const [start, end] of intervals) {
    total += Math.max(0, end - Math.max(start, coveredUntil));
    coveredUntil = Math.max(coveredUntil, end);
  }
  return total >= 1000 ? total : null;
}

/**
 * Shared closed/open group gist. File counts use distinct recorded paths (or
 * labels), never search match/file counts whose overlap is unknowable. Unknown
 * file identities fall back to operation counts. Outcomes remain explicit;
 * failed/denied/not-run calls never earn successful-edit verbs. Row breakdown
 * belongs in the expanded list, not a second expanded-header vocabulary.
 */
export function workGist(
  rows: readonly BundleRow[],
  state: "open" | "complete" | "interrupted" = isBundleStreaming(rows) ? "open" : "complete",
): string {
  const tools = rows.flatMap((row) =>
    row.kind === "tool" ? [{ part: row.part, descriptor: activityDescriptor(row.part) }] : [],
  );
  const completed: Tool[] = [];
  const active: Tool[] = [];
  const outcomes = new Map<string, number>();
  for (const tool of tools) {
    const status = toolStatus(tool.part);
    if (status === "done") completed.push(tool);
    else if (status === "running" || status === "pending") active.push(tool);
    else {
      const label = status === "not-run" ? "not run" : status;
      outcomes.set(label, (outcomes.get(label) ?? 0) + 1);
    }
  }
  const clauses: string[] = [];
  if (state === "interrupted") clauses.push("Work interrupted");
  const explorationOnly =
    tools.length > 0 && tools.every((tool) => EXPLORATION.has(tool.descriptor.kind));
  // Exploration has its own concise gist; its file count remains the title.
  const duration = explorationOnly ? null : recordedExecutionMs(tools);
  if (duration !== null) {
    const seconds = Math.floor(duration / 1000);
    const minutes = Math.floor(seconds / 60);
    clauses.push(`Worked for ${minutes > 0 ? `${minutes}m ` : ""}${seconds % 60}s`);
  }
  if (state === "interrupted" && active.length > 0) {
    clauses.push(`${active.length} unfinished`);
    active.length = 0;
  }
  if (explorationOnly && completed.length + active.length > 0) {
    const reads = [...completed, ...active].filter((tool) => tool.descriptor.kind === "read-file");
    const paths = reads.map(fileIdentity);
    const count = new Set(paths).size;
    clauses.push(
      `${active.length > 0 ? "exploring" : "explored"}${
        count > 0 && paths.every((path) => path !== null)
          ? ` ${count} ${count === 1 ? "file" : "files"}`
          : ""
      }`,
    );
  } else if (!explorationOnly) {
    // One progress tense for the whole group, just like the row breakdown.
    const groups = new Map<ActivityKind, Tool[]>();
    for (const tool of [...completed, ...active]) {
      if (commandObservation(tool)) continue;
      const kind = tool.descriptor.kind;
      const group = groups.get(kind) ?? [];
      group.push(tool);
      groups.set(kind, group);
    }
    for (const [kind, group] of groups) clauses.push(phrase(kind, group, active.length > 0));
  }
  for (const [label, count] of outcomes) clauses.push(`${count} ${label}`);
  if (clauses.length === 0) return state === "open" ? "Thinking" : "Thought";
  return clauses.join(" · ").replace(/^./, (letter) => letter.toUpperCase());
}
