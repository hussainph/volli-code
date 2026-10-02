/** A real Engine-port proof, not desktop boot recovery or a production binding. */
import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createSessionEngine,
} from "@volli/session-engine";
import type { SessionEventProvenance } from "@volli/shared";
import type { TranslatedObservation } from "../../../session-engine/src/observation-translation.ts";

export async function proveEngineProjection(
  facts: readonly TranslatedObservation[],
  acceptedAt: number,
) {
  let sequence = 0;
  const engine = createSessionEngine({
    ledger: createInMemorySessionLedger(),
    clock: { now: () => 0 },
    ids: { next: (kind) => `${kind}-${++sequence}` },
  });
  const artifacts = createInMemoryTranscriptArtifactStore();
  const sessionId = "session-497";
  const attachmentId = "attachment-497";
  const venue = { kind: "local" as const, id: "fixture-machine" };
  const provenance: SessionEventProvenance = {
    source: { kind: "adapter", id: "pi", detail: { spike: "pi-durable-1.0.0" } },
    venue,
  };
  await engine.createSession({
    commandId: "create-session",
    requestedSessionId: sessionId,
    projectId: "project",
    ticketId: "VC-497",
    role: "ticket",
    parentSessionId: null,
    title: "Fixture",
    provenance,
  });
  await engine.observe({
    id: "attachment-open",
    sessionId,
    occurredAt: 0,
    provenance,
    kind: "attachment.opened",
    attachment: {
      id: attachmentId,
      sessionId,
      adapterId: "pi",
      venue,
      continuity: "fresh",
      native: null,
      authority: null,
    },
  });
  const reference = await artifacts.write({
    version: 1,
    threadId: "thread",
    branchId: "branch",
    attemptId: "user",
    turnId: null,
    message: {
      id: "user-command-497",
      role: "user",
      parts: [{ type: "text", text: "fixture command" }],
    },
  });
  const intent = { kind: "message.submit" as const, reference };
  // Canonical command recorded BEFORE the execution admission evidence.
  await engine.submit({ commandId: "command-497", sessionId, intent, provenance });
  const apply = async () => {
    for (const fact of facts) {
      const base = {
        id: fact.id,
        sessionId,
        attachmentId,
        occurredAt: fact.occurredAt,
        provenance,
      };
      if (
        fact.kind === "turn.started" ||
        fact.kind === "turn.completed" ||
        fact.kind === "turn.interrupted"
      ) {
        await engine.observe({ ...base, kind: fact.kind, turnId: fact.turnId });
      } else if (fact.kind === "transcript.message") {
        const held = await artifacts.write({
          version: 1,
          threadId: fact.threadId,
          branchId: fact.branchId,
          attemptId: fact.attemptId,
          turnId: fact.turnId,
          message: fact.message,
        });
        await engine.observe({
          ...base,
          kind: "transcript.referenced",
          turnId: fact.turnId,
          reference: held,
        });
      }
    }
    await engine.observe({
      id: "receipt-admitted-command-497",
      sessionId,
      attachmentId,
      occurredAt: acceptedAt,
      provenance,
      kind: "command.receipt",
      receipt: {
        id: "accepted-command-497",
        commandId: "command-497",
        status: "accepted",
        acceptedAt,
        result: { kind: "message.submitted", sessionId },
      },
    });
  };
  await apply();
  const before = await engine.latestEventSequence({ sessionId });
  await engine.submit({ commandId: "command-497", sessionId, intent, provenance });
  await apply(); // lost projection acknowledgment and lost receipt reply
  const after = await engine.latestEventSequence({ sessionId });
  const projection = await engine.getSession({ sessionId });
  return {
    before,
    after,
    lastTurnOutcome: projection?.lastTurnOutcome,
    acceptedReceipts: projection?.receipts.filter(
      (r) => r.commandId === "command-497" && r.status === "accepted",
    ).length,
    userCommands: projection?.commands.filter((c) => c.id === "command-497").length,
  };
}
