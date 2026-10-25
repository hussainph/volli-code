import type {
  Session,
  SessionEventProvenance,
  SessionProjectionEvent,
  SessionUsage,
} from "@volli/shared";
import { createSessionEngine, type SessionEngine } from "../session-engine";
import type { SessionLedger } from "@volli/shared";

/** The audit door every contract fact comes through. */
export const contractProvenance: SessionEventProvenance = {
  source: { kind: "system", id: "contract", detail: null },
  venue: { id: "local", kind: "local" },
};

/** An Engine over `ledger` whose clock a case can move by hand. */
export function contractEngine(ledger: SessionLedger): {
  engine: SessionEngine;
  clock: { now: number };
} {
  const clock = { now: 100 };
  let id = 0;
  return {
    clock,
    engine: createSessionEngine({
      ledger,
      clock: { now: () => clock.now },
      ids: { next: (kind) => `contract-${kind}-${++id}` },
    }),
  };
}

/** A root Session row, as `insertSession` takes it. */
export function contractSession(
  id: string,
  projectId: string,
  overrides: Partial<Omit<Session, "id" | "projectId">> = {},
): Session {
  return {
    id,
    projectId,
    ticketId: null,
    role: "project",
    parentSessionId: null,
    title: id,
    createdAt: 100,
    ...overrides,
  };
}

export function contractUsage(overrides: Partial<SessionUsage> = {}): SessionUsage {
  return {
    cause: "assistant",
    providerId: "anthropic",
    modelId: "claude-opus-4-1",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 400,
    cacheWriteTokens: 0,
    costUsd: 0.25,
    costBasis: "catalog-estimate",
    ...overrides,
  };
}

/**
 * An event as any conforming store may hand it back.
 *
 * The port types `attachmentId`, `commandId` and `commandOrigin` as optional
 * AND nullable, and a fold reads absent and `null` the same way, so a store
 * may keep either spelling. Comparing through this keeps the contract about
 * meaning rather than one adapter's encoding.
 */
export function asStored<T extends SessionProjectionEvent>(event: T): T {
  const copy = { ...event } as Record<string, unknown>;
  for (const field of ["attachmentId", "commandId", "commandOrigin"] as const) {
    if (copy[field] === null || copy[field] === undefined) delete copy[field];
  }
  return copy as T;
}
