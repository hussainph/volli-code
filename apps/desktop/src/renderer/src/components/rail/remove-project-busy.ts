/**
 * What removing a project would end, for its confirm (VC-796).
 *
 * The host stops every kind of live work a project's Sessions hold before it
 * deletes the project, so the warning names each kind, never blended: a busy
 * terminal, a structured Session with a turn open, a running background shell.
 * Each read is what this window already holds; a count it cannot read yet is
 * zero, never a reason to hold the dialog back.
 */
import type { BackgroundShellState, ChatSessionRecord } from "@volli/shared";

import { describeBusy } from "@renderer/terminal/close-guard";

const TAIL = ". Removing the project will end";

/** Structured Sessions of the project with a turn open: working, or blocked on a question. */
export function openTurnCount(chat: readonly ChatSessionRecord[] | undefined): number {
  return (chat ?? []).filter(({ activity }) => activity === "working" || activity === "waiting")
    .length;
}

/** The project's background shells still running. */
export function runningShellCount(
  shells: Readonly<Record<string, BackgroundShellState>>,
  projectId: string,
): number {
  return Object.values(shells).filter(
    (shell) => shell.projectId === projectId && shell.state === "running",
  ).length;
}

/** One warning line per kind with anything at stake; empty when removing ends nothing. */
export function removeProjectBusyLines(work: {
  busyProcesses: string[];
  openTurns: number;
  runningShells: number;
}): string[] {
  const lines: string[] = [];
  if (work.busyProcesses.length > 0) lines.push(describeBusy(work.busyProcesses, TAIL));
  if (work.openTurns === 1) lines.push(`1 agent Session has a turn open${TAIL} it.`);
  else if (work.openTurns > 1) {
    lines.push(`${work.openTurns} agent Sessions have turns open${TAIL} them.`);
  }
  if (work.runningShells === 1) lines.push(`1 background shell is running${TAIL} it.`);
  else if (work.runningShells > 1) {
    lines.push(`${work.runningShells} background shells are running${TAIL} them.`);
  }
  return lines;
}
