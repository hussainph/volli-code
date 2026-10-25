import { LOCAL_RUNNER } from "@volli/shared";
import { afterEach } from "vite-plus/test";
import type {
  Session,
  SessionEventProvenance,
  SessionLedger,
  SessionOrigin,
  SessionProjectionEvent,
  SessionUsage,
} from "@volli/shared";
import {
  createSessionEngine,
  type CreateSessionRequest,
  type SessionEngine,
} from "../session-engine";

/** The audit door every contract fact comes through. */
export const contractProvenance: SessionEventProvenance = {
  source: { kind: "system", id: "contract", detail: null },
  venue: LOCAL_RUNNER,
};

/** {@link contractProvenance}, naming the origin a trusted door records for a command. */
export function provenanceWithOrigin(origin: SessionOrigin): SessionEventProvenance {
  return {
    ...contractProvenance,
    source: { ...contractProvenance.source, detail: { sessionOrigin: origin } },
  };
}

/**
 * Opens one store per call and disposes every store a case opened once it
 * ends. Call it inside the contract's `describe`.
 */
export function storePerCase<Store extends { dispose(): void | Promise<void> }>(
  open: () => Store | Promise<Store>,
): () => Promise<Store> {
  let opened: Store[] = [];
  afterEach(async () => {
    const stores = opened;
    opened = [];
    for (const store of stores) await store.dispose();
  });
  return async () => {
    const store = await open();
    opened.push(store);
    return store;
  };
}

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

/** A create request for the Session `name`, under that id; a ticket makes it a Ticket Session. */
export function contractCreateRequest(
  name: string,
  projectId: string,
  options: { ticketId?: string | null; origin?: SessionOrigin } = {},
): CreateSessionRequest {
  const ticketId = options.ticketId ?? null;
  return {
    commandId: `create-${name}`,
    requestedSessionId: name,
    projectId,
    ticketId,
    role: ticketId === null ? "project" : "ticket",
    parentSessionId: null,
    title: name,
    provenance:
      options.origin === undefined ? contractProvenance : provenanceWithOrigin(options.origin),
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
 * The port types `attachmentId` and `commandId` as optional AND nullable, and
 * a fold reads absent and `null` the same way for both, so a store may keep
 * either spelling. Comparing through this keeps the contract about meaning
 * rather than one adapter's encoding.
 */
export function asStored<T extends SessionProjectionEvent>(event: T): T {
  const copy = { ...event } as Record<string, unknown>;
  for (const field of ["attachmentId", "commandId"] as const) {
    if (copy[field] === null || copy[field] === undefined) delete copy[field];
  }
  return copy as T;
}
