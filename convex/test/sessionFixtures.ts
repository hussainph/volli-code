/**
 * Real Session histories for the intake tests: written by the real Session
 * Engine over its in-memory ledger, so `accept` is fed exactly what a runner's
 * drain would read from its local ledger, through the real codec.
 */

import { randomUUID } from "node:crypto";

import {
  projectSession,
  type SessionAttachment,
  type SessionEvent,
  type SessionEventProvenance,
} from "@volli/shared";
import { createSessionEngine, type SessionEngine } from "@volli/session-engine";
import { createInMemorySessionLedger } from "@volli/session-engine/testing";

const venue = { id: "local", kind: "local" } as const;
export const userProvenance: SessionEventProvenance = {
  source: { kind: "user", id: "desktop", detail: { sessionOrigin: { kind: "user" } } },
  venue,
};
const adapterProvenance: SessionEventProvenance = {
  source: { kind: "adapter", id: "pi", detail: { channel: "rpc" } },
  venue,
};

export interface SessionScript {
  sessionId?: string;
  projectId: string;
  ticketId?: string | null;
  parentSessionId?: string | null;
  /** Extra turns after the first, each a message, a turn and its usage. */
  turns?: number;
  /** A `$`-keyed object deep in one payload, as an MCP tool schema carries. */
  dollarKeys?: boolean;
}

/** One Session's whole ledger: created, a model, an executor, turns with attention, a blocked signal. */
export async function writeSession(script: SessionScript): Promise<{
  sessionId: string;
  events: SessionEvent[];
  engine: SessionEngine;
}> {
  const sessionId = script.sessionId ?? randomUUID();
  let now = 1_000;
  const engine = createSessionEngine({
    ledger: createInMemorySessionLedger(),
    clock: { now: () => now++ },
    ids: { next: () => randomUUID() },
  });
  const ticketId = script.ticketId ?? null;
  await engine.createSession({
    commandId: randomUUID(),
    requestedSessionId: sessionId,
    projectId: script.projectId,
    ticketId,
    role: script.parentSessionId ? "subagent" : ticketId === null ? "project" : "ticket",
    parentSessionId: script.parentSessionId ?? null,
    title: "Intake",
    provenance: userProvenance,
  });
  if (script.dollarKeys) {
    await engine.getOrRecordSessionInput({
      sessionId,
      input: { kind: "runtime-brief", text: "brief" },
      provenance: userProvenance,
    });
  }
  await engine.submit({
    commandId: randomUUID(),
    sessionId,
    intent: {
      kind: "model.select",
      selection: { providerId: "anthropic", modelId: "opus", reasoningLevel: "high" },
    },
    provenance: userProvenance,
  });
  const start = await engine.submit({
    commandId: randomUUID(),
    sessionId,
    intent: { kind: "executor.start", adapterId: "pi", continuity: "fresh" },
    provenance: userProvenance,
  });
  const attachment: SessionAttachment = {
    id: randomUUID(),
    sessionId,
    adapterId: "pi",
    venue,
    continuity: "fresh",
    native: { id: "native-1", detail: { file: "pi.jsonl" } },
    authority: null,
  };
  const observe = (fields: Record<string, unknown>) =>
    engine.observe({
      id: randomUUID(),
      sessionId,
      occurredAt: now++,
      provenance: adapterProvenance,
      ...fields,
    } as never);
  await observe({ kind: "attachment.opened", commandId: start.command.id, attachment });
  for (let turn = 0; turn <= (script.turns ?? 0); turn += 1) {
    const turnId = randomUUID();
    await engine.submit({
      commandId: randomUUID(),
      sessionId,
      intent: {
        kind: "message.submit",
        reference: { id: `sha256:${"a".repeat(64)}`, mediaType: "application/json", digest: null },
      },
      provenance: userProvenance,
    });
    await observe({ kind: "turn.started", attachmentId: attachment.id, turnId });
    if (turn === 0) {
      await observe({
        kind: "attention.raised",
        attachmentId: attachment.id,
        attention: {
          id: `attention-${turn}`,
          kind: "input_required",
          attachmentId: attachment.id,
          detail: "Which branch?",
          diagnostic: script.dollarKeys ? { $schema: "x", ключ: 1 } : null,
        },
      });
      await observe({
        kind: "interaction.opened",
        attachmentId: attachment.id,
        interaction: {
          id: `interaction-${turn}`,
          attachmentId: attachment.id,
          kind: "permission",
          title: "Allow write?",
          detail: null,
          options: [{ id: "once", label: "Allow once", description: null }],
          multiple: false,
          native: { id: "native-permission", detail: null },
        },
      });
    }
    await observe({
      kind: "usage.recorded",
      attachmentId: attachment.id,
      turnId,
      usage: {
        cause: "assistant",
        providerId: "anthropic",
        modelId: "opus",
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.5,
        costBasis: "catalog-estimate",
      },
    });
    if (turn === 0) {
      await observe({
        kind: "interaction.resolved",
        attachmentId: attachment.id,
        interactionId: `interaction-${turn}`,
        resolution: { optionIds: ["once"], response: null },
      });
      await observe({
        kind: "attention.cleared",
        attachmentId: attachment.id,
        attentionId: `attention-${turn}`,
      });
    }
    await observe({ kind: "turn.completed", attachmentId: attachment.id, turnId });
  }
  await engine.submit({
    commandId: randomUUID(),
    sessionId,
    intent: { kind: "session.signal", signal: "blocked", reason: "Need a key" },
    provenance: userProvenance,
  });
  return { sessionId, events: [...(await engine.listEvents({ sessionId }))], engine };
}

/** A fact as the drain sends it: its JSON text. */
export const wire = (event: SessionEvent | Record<string, unknown>): string =>
  JSON.stringify(event);

/** The local projection of a written history, for parity checks. */
export function localProjection(events: readonly SessionEvent[]) {
  const created = events.find(({ payload }) => payload.kind === "session.created")?.payload;
  if (created?.kind !== "session.created") throw new Error("no session.created fact");
  return projectSession(created.session, events);
}

/**
 * `turns` more turns after a written history, each four codec-valid facts
 * (start, a settled reply, its usage, the end), numbered on from its last
 * sequence: a long Session without driving the Engine through every turn.
 */
export function moreTurns(history: readonly SessionEvent[], turns: number): SessionEvent[] {
  const last = history.at(-1)!;
  const opened = history.findLast(({ payload }) => payload.kind === "attachment.opened")!;
  if (opened.payload.kind !== "attachment.opened") throw new Error("no attachment");
  const attachmentId = opened.payload.attachment.id;
  const created = history.find(({ payload }) => payload.kind === "session.created")!.payload;
  if (created.kind !== "session.created") throw new Error("no session.created fact");
  const attribution = { projectId: created.session.projectId, ticketId: created.session.ticketId };
  let sequence = last.sequence;
  let clock = last.occurredAt;
  const fact = (payload: SessionEvent["payload"]): SessionEvent => {
    sequence += 1;
    clock += 1;
    return {
      id: randomUUID(),
      sessionId: last.sessionId,
      sequence,
      occurredAt: clock,
      recordedAt: clock,
      provenance: adapterProvenance,
      attachmentId,
      payload,
    };
  };
  const out: SessionEvent[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const turnId = randomUUID();
    out.push(
      fact({ kind: "turn.started", attachmentId, turnId }),
      fact({
        kind: "transcript.referenced",
        attachmentId,
        turnId,
        reference: { id: `sha256:${"b".repeat(64)}`, mediaType: "application/json", digest: null },
        digest: { role: "assistant", reply: true },
      }),
      fact({
        kind: "usage.recorded",
        attachmentId,
        turnId,
        attribution,
        usage: {
          cause: "assistant",
          providerId: "anthropic",
          modelId: "opus",
          inputTokens: 10,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.001,
          costBasis: "catalog-estimate",
        },
      }),
      fact({ kind: "turn.completed", attachmentId, turnId }),
    );
  }
  return out;
}
