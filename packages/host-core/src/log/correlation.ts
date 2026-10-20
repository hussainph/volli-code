/**
 * Which trace a Session's background work belongs to (VC-699).
 *
 * The ambient context (`./context`) is right for a request's own promise
 * chain and wrong for anything that outlives it. A Session's later work, a
 * turn its executor opens from a listener it registered at attach, a queued
 * follow-up released when another turn ends, a receipt reconciled after a
 * restart, is joined to the operation that caused it here, by identifier:
 *
 * - **A command** is remembered with the trace it was recorded under (the
 *   door's), and a queued follow-up's delivery command with its message's.
 * - **A turn** is remembered with the trace it started under, so its end,
 *   reported later from wherever, joins the same trace.
 *
 * Known, it wins over the ambient trace; unknown, a line carries the ambient
 * trace only when that ambient context is the request's own chain, which the
 * detached producers guarantee (`withRootLogContext`). Bounded: the newest
 * {@link MAX_REMEMBERED} of each, the oldest forgotten first.
 */
import { isTraceId } from "@volli/shared";

/** Identifiers remembered per kind: hours of a busy host's commands and turns. */
export const MAX_REMEMBERED = 4_096;

const commands = new Map<string, string>();
const turns = new Map<string, string>();

function remember(map: Map<string, string>, key: string, traceId: string): void {
  if (!isTraceId(traceId) || key.length === 0) return;
  map.delete(key);
  map.set(key, traceId);
  // Insertion order is age order: the first key is the oldest.
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value!);
}

/** Joins `commandId` to `traceId`, unless it is already joined: the first operation to name a command owns it. */
export function rememberCommandTrace(commandId: string, traceId: string): void {
  if (!commands.has(commandId)) remember(commands, commandId, traceId);
}

/** The trace a command was recorded under, when this host saw it. */
export function commandTrace(commandId: string | undefined): string | undefined {
  return commandId === undefined ? undefined : commands.get(commandId);
}

/** Joins a Session's turn to the trace it started under. */
export function rememberTurnTrace(sessionId: string, turnId: string, traceId: string): void {
  const key = `${sessionId}\u0000${turnId}`;
  if (!turns.has(key)) remember(turns, key, traceId);
}

/** The trace a Session's turn started under, when this host saw it start. */
export function turnTrace(sessionId: string, turnId: string | undefined): string | undefined {
  return turnId === undefined ? undefined : turns.get(`${sessionId}\u0000${turnId}`);
}

/** For tests: forgets everything. */
export function resetLogCorrelation(): void {
  commands.clear();
  turns.clear();
}
