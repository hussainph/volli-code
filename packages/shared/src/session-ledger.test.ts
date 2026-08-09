import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_INTERACTION_PROMPT_ID,
  isSessionAttentionKind,
  isSessionAttachmentContinuity,
  observationPayload,
  projectSession,
  sameCommandReceipt,
  sameCommandReceiptOutcome,
  sameSessionCommand,
  sameSessionCommandRequest,
  sameSessionEventPayload,
  sameSessionEventProvenance,
  promptId,
  readInteractionAnswers,
  readInteractionPrompts,
  SESSION_ATTACHMENT_CONTINUITIES,
  SESSION_ATTENTION_KINDS,
  SESSION_INTERACTION_CANCEL_REASONS,
  SESSION_USER_BLOCKING_ATTENTION_KINDS,
  sessionAwaitsUser,
} from "./session-ledger";
import type {
  Session,
  SessionAttention,
  SessionAttentionKind,
  SessionEvent,
  SessionInteraction,
  SessionInteractionPrompt,
  SessionObservation,
} from "./session-ledger";

const session: Session = {
  id: "session-1",
  projectId: "project-1",
  ticketId: "ticket-1",
  title: "A durable Session",
  createdAt: 100,
};

const localVenue = { id: "machine-1", kind: "local" as const };
const systemProvenance = {
  source: { kind: "system" as const, id: "session-engine", detail: null },
  venue: localVenue,
};

function event(sequence: number, payload: SessionEvent["payload"]): SessionEvent {
  return {
    id: `event-${sequence}`,
    sessionId: session.id,
    sequence,
    occurredAt: sequence * 10,
    recordedAt: sequence * 10 + 1,
    provenance: systemProvenance,
    payload,
  };
}

describe("Session ledger vocabularies", () => {
  it("accepts the named continuity modes and rejects unknown values", () => {
    expect(SESSION_ATTACHMENT_CONTINUITIES).toEqual([
      "fresh",
      "native_resume",
      "context_replay",
      "recreate",
    ]);
    for (const continuity of SESSION_ATTACHMENT_CONTINUITIES) {
      expect(isSessionAttachmentContinuity(continuity)).toBe(true);
    }
    expect(isSessionAttachmentContinuity("history_only")).toBe(false);
    expect(isSessionAttachmentContinuity(null)).toBe(false);
  });

  it("keeps attention states structured and finite", () => {
    for (const attention of SESSION_ATTENTION_KINDS)
      expect(isSessionAttentionKind(attention)).toBe(true);
    expect(isSessionAttentionKind("waiting")).toBe(false);
    expect(isSessionAttentionKind(undefined)).toBe(false);
  });
});

describe("interaction prompts", () => {
  const flatPermission: SessionInteraction = {
    id: "permission-1",
    attachmentId: "attachment-1",
    kind: "permission",
    title: "Allow file write?",
    detail: "src/main.ts",
    options: [
      { id: "once", label: "Allow once", description: null },
      { id: "reject", label: "Deny", description: null },
    ],
    multiple: false,
    native: { id: "native-permission-1", detail: null },
  };
  const declaredPrompts: readonly SessionInteractionPrompt[] = [
    {
      id: "prompt:0",
      label: "Which files should I read?",
      detail: null,
      options: [{ id: "prompt:0/option:0", label: "All of them", description: null }],
      multiple: true,
      custom: true,
    },
    {
      id: "prompt:1",
      label: "Run the tests after?",
      detail: null,
      options: [{ id: "prompt:1/option:0", label: "Yes", description: null }],
      multiple: false,
      custom: false,
    },
  ];

  it("synthesizes one prompt from a record written before prompts existed", () => {
    expect(readInteractionPrompts(flatPermission)).toEqual([
      {
        id: DEFAULT_INTERACTION_PROMPT_ID,
        label: "Allow file write?",
        detail: "src/main.ts",
        options: flatPermission.options,
        multiple: false,
        custom: false,
      },
    ]);
  });

  it("keeps a declared empty prompt list distinct from an absent one", () => {
    expect(readInteractionPrompts({ ...flatPermission, prompts: [] })).toEqual([]);
    expect(readInteractionPrompts(flatPermission)).toHaveLength(1);
  });

  it("names every synthesized prompt through one definition", () => {
    expect(promptId(0)).toBe(DEFAULT_INTERACTION_PROMPT_ID);
    expect(promptId(2)).toBe("prompt:2");
  });

  it("returns declared prompts untouched", () => {
    expect(readInteractionPrompts({ ...flatPermission, prompts: declaredPrompts })).toBe(
      declaredPrompts,
    );
  });

  it("gives a single declared prompt the same id a legacy record projects to", () => {
    const prompts = readInteractionPrompts({
      ...flatPermission,
      prompts: declaredPrompts.slice(0, 1),
    });
    expect(prompts.map((prompt) => prompt.id)).toEqual([DEFAULT_INTERACTION_PROMPT_ID]);
  });

  it("maps a flat resolution onto the synthesized prompt", () => {
    expect(readInteractionAnswers(flatPermission, { optionIds: ["once"], response: null })).toEqual(
      [{ promptId: DEFAULT_INTERACTION_PROMPT_ID, optionIds: ["once"], response: null }],
    );
  });

  it("maps a flat resolution onto the first declared prompt", () => {
    expect(
      readInteractionAnswers(
        { ...flatPermission, prompts: declaredPrompts },
        { optionIds: ["prompt:0/option:0"], response: "and src/preload too" },
      ),
    ).toEqual([
      {
        promptId: "prompt:0",
        optionIds: ["prompt:0/option:0"],
        response: "and src/preload too",
      },
    ]);
  });

  it("falls back to the default prompt id when the prompt list is empty", () => {
    expect(
      readInteractionAnswers({ ...flatPermission, prompts: [] }, { optionIds: [], response: null }),
    ).toEqual([{ promptId: DEFAULT_INTERACTION_PROMPT_ID, optionIds: [], response: null }]);
  });

  // A resolution that answered nothing is not a resolution that was never
  // written with `answers`. Synthesizing one here hands the reader an answer
  // with no options selected, which every downstream reader takes for a refusal
  // the user never made.
  it("keeps a declared empty answer list distinct from an absent one", () => {
    expect(
      readInteractionAnswers(flatPermission, {
        optionIds: [],
        response: null,
        answers: [],
      }),
    ).toEqual([]);
    expect(readInteractionAnswers(flatPermission, { optionIds: [], response: null })).toEqual([
      { promptId: DEFAULT_INTERACTION_PROMPT_ID, optionIds: [], response: null },
    ]);
  });

  it("returns declared answers untouched", () => {
    const answers = [
      { promptId: "prompt:0", optionIds: ["prompt:0/option:0"], response: "plus the tests" },
      { promptId: "prompt:1", optionIds: [], response: null },
    ];
    expect(
      readInteractionAnswers(
        { ...flatPermission, prompts: declaredPrompts },
        { optionIds: [], response: null, answers },
      ),
    ).toBe(answers);
  });
});

describe("observationPayload", () => {
  it("canonicalizes an omitted adapter-observation attachment id to null", () => {
    expect(
      observationPayload({
        id: "adapter-observation-omitted-attachment",
        sessionId: session.id,
        occurredAt: 1,
        provenance: systemProvenance,
        kind: "adapter.observed",
        name: "native.session-signal",
        native: null,
      } as SessionObservation),
    ).toEqual({
      kind: "adapter.observed",
      attachmentId: null,
      name: "native.session-signal",
      native: null,
    });
  });

  it("maps every externally observed fact without inventing a command", () => {
    const attachment = {
      id: "attachment-1",
      sessionId: session.id,
      adapterId: "opencode",
      venue: localVenue,
      continuity: "fresh" as const,
      native: { id: "native-1", detail: { model: "local" } },
    };
    const provenance = {
      source: { kind: "adapter" as const, id: "opencode", detail: { plugin: "hook" } },
      venue: localVenue,
    };
    const observations: readonly SessionObservation[] = [
      {
        id: "1",
        sessionId: session.id,
        occurredAt: 1,
        provenance,
        kind: "attachment.opened",
        attachment,
      },
      {
        id: "1-native",
        sessionId: session.id,
        occurredAt: 1,
        provenance,
        kind: "attachment.native_referenced",
        attachmentId: attachment.id,
        native: { id: "native-continuation", detail: { cursor: ["opaque", 3] } },
      },
      {
        id: "1-failed",
        sessionId: session.id,
        occurredAt: 1,
        provenance,
        kind: "attachment.failed",
        attachment: { ...attachment, id: "attachment-failed" },
        failure: { code: "spawn_failed", detail: "Unavailable", diagnostic: { retryable: false } },
      },
      {
        id: "2",
        sessionId: session.id,
        occurredAt: 2,
        provenance,
        kind: "attachment.closed",
        attachmentId: attachment.id,
        outcome: "completed",
      },
      {
        id: "3",
        sessionId: session.id,
        occurredAt: 3,
        provenance,
        kind: "run.started",
        attachmentId: attachment.id,
        runId: "run-1",
      },
      {
        id: "4",
        sessionId: session.id,
        occurredAt: 4,
        provenance,
        kind: "run.completed",
        attachmentId: attachment.id,
        runId: "run-1",
      },
      {
        id: "5",
        sessionId: session.id,
        occurredAt: 5,
        provenance,
        kind: "turn.started",
        attachmentId: attachment.id,
        turnId: "turn-1",
      },
      {
        id: "6",
        sessionId: session.id,
        occurredAt: 6,
        provenance,
        kind: "turn.completed",
        attachmentId: attachment.id,
        turnId: "turn-1",
      },
      {
        id: "7",
        sessionId: session.id,
        occurredAt: 7,
        provenance,
        kind: "transcript.referenced",
        attachmentId: attachment.id,
        turnId: "turn-1",
        reference: { id: "transcript-1", mediaType: "text/markdown", digest: "sha256:1" },
      },
      {
        id: "8",
        sessionId: session.id,
        occurredAt: 8,
        provenance,
        kind: "attention.raised",
        attention: {
          id: "attention-1",
          kind: "input_required",
          attachmentId: attachment.id,
          detail: null,
          diagnostic: null,
        },
      },
      {
        id: "9",
        sessionId: session.id,
        occurredAt: 9,
        provenance,
        kind: "attention.cleared",
        attentionId: "attention-1",
      },
      {
        id: "10",
        sessionId: session.id,
        occurredAt: 10,
        provenance,
        kind: "adapter.observed",
        attachmentId: attachment.id,
        name: "native.signal",
        native: ["opaque", true],
      },
      {
        id: "11-capabilities",
        sessionId: session.id,
        occurredAt: 11,
        provenance,
        kind: "capabilities.updated",
        snapshot: {
          id: "capabilities-1",
          adapterId: "opencode",
          attachmentId: attachment.id,
          profileId: "native",
          revision: 1,
          observedAt: 11,
          expiresAt: 71,
          features: [
            {
              id: "message.submit",
              state: "available",
              evidence: "verified",
              detail: null,
            },
          ],
          catalog: [
            {
              kind: "model",
              id: "openai/gpt-5",
              label: "GPT-5",
              state: "available",
              evidence: "reported",
              detail: null,
            },
          ],
        },
      },
      {
        id: "12-interaction-opened",
        sessionId: session.id,
        occurredAt: 12,
        provenance,
        kind: "interaction.opened",
        interaction: {
          id: "permission-1",
          attachmentId: attachment.id,
          kind: "permission",
          title: "Allow file write?",
          detail: null,
          options: [{ id: "once", label: "Allow once", description: null }],
          multiple: false,
          native: { id: "native-permission-1", detail: null },
        },
      },
      {
        id: "13-interaction-resolved",
        sessionId: session.id,
        occurredAt: 13,
        provenance,
        kind: "interaction.resolved",
        attachmentId: attachment.id,
        interactionId: "permission-1",
        resolution: { optionIds: ["once"], response: null },
      },
      {
        id: "14-interaction-cancelled",
        sessionId: session.id,
        occurredAt: 14,
        provenance,
        kind: "interaction.cancelled",
        attachmentId: attachment.id,
        interactionId: "question-1",
        reason: "abandoned",
      },
    ];

    expect(observationPayload(observations.at(-1)!)).toEqual({
      kind: "interaction.cancelled",
      attachmentId: attachment.id,
      interactionId: "question-1",
      reason: "abandoned",
    });
    expect(observations.map(observationPayload).map(({ kind }) => kind)).toEqual([
      "attachment.opened",
      "attachment.native_referenced",
      "attachment.failed",
      "attachment.closed",
      "run.started",
      "run.completed",
      "turn.started",
      "turn.completed",
      "transcript.referenced",
      "attention.raised",
      "attention.cleared",
      "adapter.observed",
      "capabilities.updated",
      "interaction.opened",
      "interaction.resolved",
      "interaction.cancelled",
    ]);
    expect(
      observationPayload({
        id: "10-session-wide",
        sessionId: session.id,
        occurredAt: 10,
        provenance,
        kind: "adapter.observed",
        attachmentId: null,
        name: "native.session-signal",
        native: null,
      }),
    ).toMatchObject({ kind: "adapter.observed", attachmentId: null });
    expect(() =>
      observationPayload({
        id: "11",
        sessionId: session.id,
        occurredAt: 11,
        provenance,
        kind: "command.receipt",
        receipt: {
          id: "receipt-1",
          commandId: "command-1",
          status: "unreconciled",
          detail: "Awaiting reconciliation",
        },
      }),
    ).toThrow("require Session Engine stamping");
  });

  it("projects the latest binding capabilities and unresolved interactions", () => {
    const firstSnapshot = {
      id: "capabilities-1",
      adapterId: "opencode",
      attachmentId: "attachment-1",
      profileId: "native",
      revision: 1,
      observedAt: 10,
      expiresAt: null,
      features: [
        {
          id: "message.submit",
          state: "available" as const,
          evidence: "verified" as const,
          detail: null,
        },
      ],
      catalog: [],
    };
    const latestSnapshot = { ...firstSnapshot, id: "capabilities-2", revision: 2, observedAt: 20 };
    const sessionSnapshot = {
      ...latestSnapshot,
      id: "capabilities-session",
      attachmentId: null,
      revision: 1,
    };
    const interaction = {
      id: "permission-1",
      attachmentId: "attachment-1",
      kind: "permission" as const,
      title: "Allow file write?",
      detail: null,
      options: [{ id: "once", label: "Allow once", description: null }],
      multiple: false,
      native: { id: "native-permission-1", detail: null },
    };
    const remaining = { ...interaction, id: "question-1", kind: "question" as const };

    const reorderedSnapshot = {
      ...latestSnapshot,
      id: "capabilities-3",
      revision: 3,
      observedAt: 30,
    };
    const projection = projectSession(session, [
      event(1, { kind: "capabilities.updated", snapshot: firstSnapshot }),
      event(2, { kind: "interaction.opened", interaction }),
      event(3, { kind: "interaction.opened", interaction: remaining }),
      event(4, {
        kind: "interaction.resolved",
        attachmentId: interaction.attachmentId,
        interactionId: interaction.id,
        resolution: { optionIds: ["once"], response: null },
      }),
      event(5, { kind: "capabilities.updated", snapshot: latestSnapshot }),
      event(6, { kind: "capabilities.updated", snapshot: sessionSnapshot }),
      event(7, {
        kind: "interaction.resolved",
        attachmentId: "attachment-1",
        interactionId: "missing",
        resolution: { optionIds: [], response: null },
      }),
      event(8, { kind: "capabilities.updated", snapshot: reorderedSnapshot }),
    ]);

    expect(projection.capabilities).toEqual([sessionSnapshot, reorderedSnapshot]);
    expect(projection.interactions.active).toEqual([remaining]);
    expect(projection.interactions.resolved).toEqual([
      {
        interaction,
        resolution: { optionIds: ["once"], response: null },
        resolvedAt: 40,
      },
    ]);
  });

  it("drops a cancelled interaction without recording a decision for it", () => {
    const interaction = {
      id: "question-1",
      attachmentId: "attachment-1",
      kind: "question" as const,
      title: "Which files?",
      detail: null,
      options: [{ id: "all", label: "All of them", description: null }],
      multiple: false,
      native: { id: "native-question-1", detail: null },
    };
    const remaining = { ...interaction, id: "question-2" };

    const projection = projectSession(session, [
      event(1, { kind: "interaction.opened", interaction }),
      event(2, { kind: "interaction.opened", interaction: remaining }),
      event(3, {
        kind: "interaction.cancelled",
        attachmentId: interaction.attachmentId,
        interactionId: interaction.id,
        reason: "abandoned",
      }),
      // A cancellation for something no longer open is inert, exactly as a
      // resolution for one is.
      event(4, {
        kind: "interaction.cancelled",
        attachmentId: interaction.attachmentId,
        interactionId: "missing",
        reason: "withdrawn",
      }),
    ]);

    expect(projection.interactions).toEqual({ active: [remaining], resolved: [] });
  });

  it("keeps every cancel reason in the vocabulary", () => {
    expect(SESSION_INTERACTION_CANCEL_REASONS).toEqual(["abandoned", "superseded", "withdrawn"]);
  });

  it("does not project an expired capability snapshot", () => {
    const expired = {
      id: "capabilities-expired",
      adapterId: "opencode",
      attachmentId: "attachment-1",
      profileId: "native",
      revision: 1,
      observedAt: 10,
      expiresAt: 20,
      features: [],
      catalog: [],
    };

    expect(
      projectSession(session, [event(1, { kind: "capabilities.updated", snapshot: expired })], 20),
    ).toMatchObject({ capabilities: [] });
  });
});

describe("projectSession", () => {
  it("projects retitle and native-continuation facts without mutating immutable inputs", () => {
    const attachment = {
      id: "attachment-1",
      sessionId: session.id,
      adapterId: "codex",
      venue: localVenue,
      continuity: "native_resume" as const,
      native: null,
    };
    const native = { id: "native-continuation", detail: { cursor: ["opaque", 3] } };

    const projection = projectSession(session, [
      event(1, { kind: "attachment.opened", attachment }),
      event(2, { kind: "session.retitled", title: "Retitled Session" }),
      event(3, {
        kind: "session.input.recorded",
        input: { kind: "runtime-brief", text: "Implement the Ticket faithfully." },
      }),
      event(4, { kind: "attachment.native_referenced", attachmentId: attachment.id, native }),
      event(5, {
        kind: "attachment.native_referenced",
        attachmentId: "missing",
        native: { id: null, detail: null },
      }),
    ]);

    expect(projection.session).toEqual({ ...session, title: "Retitled Session" });
    expect(session.title).toBe("A durable Session");
    expect(projection.attachments).toMatchObject([{ id: attachment.id, native }]);
    expect(attachment.native).toBeNull();
  });

  it("projects the latest durable Session signal in ledger order", () => {
    const projection = projectSession(session, [
      event(3, { kind: "session.signaled", signal: "blocked", reason: null }),
      event(1, { kind: "session.signaled", signal: "done", reason: "Initial result" }),
      event(2, { kind: "session.signaled", signal: "blocked", reason: "Needs input" }),
    ]);

    expect(projection.signal).toEqual({
      signal: "blocked",
      reason: null,
      occurredAt: 30,
    });
  });

  it("keeps the Session open when its own creation, runs, turns, and an executor end", () => {
    const attachment = {
      id: "attachment-1",
      sessionId: session.id,
      adapterId: "codex",
      venue: localVenue,
      continuity: "native_resume" as const,
      native: null,
    };
    const projection = projectSession({ ...session, title: "Seeded" }, [
      event(0, { kind: "attachment.closed", attachmentId: "unknown", outcome: "failed" }),
      // The Session's own creation fact, folded over the row it created. It is
      // the seed of this fold, not an update to it — a projection that took its
      // `session` from here would let a stale copy of the row win over the one
      // the caller read.
      event(1, { kind: "session.created", session: { ...session, title: "Superseded" } }),
      event(2, { kind: "attachment.opened", attachment }),
      event(3, { kind: "run.started", attachmentId: attachment.id, runId: "run-1" }),
      event(4, { kind: "turn.started", attachmentId: attachment.id, turnId: "turn-1" }),
      event(5, { kind: "turn.completed", attachmentId: attachment.id, turnId: "turn-1" }),
      event(6, { kind: "run.completed", attachmentId: attachment.id, runId: "run-1" }),
      event(7, { kind: "attachment.closed", attachmentId: attachment.id, outcome: "completed" }),
    ]);

    expect(projection.session.title).toBe("Seeded");
    expect(projection.status).toBe("open");
    expect(projection.liveExecutor).toBeNull();
    expect(projection.attachments).toMatchObject([
      { id: attachment.id, status: "closed", closedAt: 70, outcome: "completed" },
    ]);
  });

  it("projects attachment, structured attention, and explicit archive facts", () => {
    const attachment = {
      id: "attachment-1",
      sessionId: session.id,
      adapterId: "claude",
      venue: localVenue,
      continuity: "context_replay" as const,
      native: { id: null, detail: null },
    };
    const projection = projectSession(session, [
      { ...event(0, { kind: "session.created", session }), sessionId: "other-session" },
      event(1, { kind: "attachment.opened", attachment }),
      {
        ...event(2, {
          kind: "attention.raised",
          attention: {
            id: "attention-1",
            kind: "permission_required",
            attachmentId: attachment.id,
            detail: "Approve",
            diagnostic: null,
          },
        }),
      },
      event(3, { kind: "attention.cleared", attentionId: "missing" }),
      event(4, { kind: "attention.cleared", attentionId: "attention-1" }),
      event(5, {
        kind: "attention.raised",
        attention: {
          id: "attention-2",
          kind: "quota_exhausted",
          attachmentId: null,
          detail: null,
          diagnostic: null,
          resetAt: 99,
        },
      }),
      event(6, { kind: "session.archived" }),
    ]);

    expect(projection.status).toBe("archived");
    expect(projection.liveExecutor?.id).toBe(attachment.id);
    expect(projection.attention).toEqual({
      active: [
        {
          id: "attention-2",
          kind: "quota_exhausted",
          attachmentId: null,
          detail: null,
          diagnostic: null,
          resetAt: 99,
        },
      ],
      primary: {
        id: "attention-2",
        kind: "quota_exhausted",
        attachmentId: null,
        detail: null,
        diagnostic: null,
        resetAt: 99,
      },
    });
  });

  it("retains a failed attachment as durable evidence without closing the Session", () => {
    const failed = {
      id: "attachment-failed",
      sessionId: session.id,
      adapterId: "codex",
      venue: localVenue,
      continuity: "fresh" as const,
      native: null,
    };
    const projection = projectSession(session, [
      event(1, {
        kind: "attachment.failed",
        attachment: failed,
        failure: { code: "spawn_failed", detail: null, diagnostic: { retryable: true } },
      }),
    ]);

    expect(projection).toMatchObject({
      status: "open",
      liveExecutor: null,
      attachments: [{ id: failed.id, status: "failed", failure: { code: "spawn_failed" } }],
    });
  });

  it("makes a re-raised Attention primary according to its latest event sequence", () => {
    const first = {
      id: "attention-first",
      kind: "input_required" as const,
      attachmentId: null,
      detail: "First",
      diagnostic: null,
    };
    const second = {
      id: "attention-second",
      kind: "permission_required" as const,
      attachmentId: null,
      detail: "Second",
      diagnostic: null,
    };
    const projection = projectSession(session, [
      event(1, { kind: "attention.raised", attention: first }),
      event(2, { kind: "attention.raised", attention: second }),
      event(3, { kind: "attention.raised", attention: { ...first, detail: "Re-raised" } }),
    ]);

    expect(projection.attention.primary).toMatchObject({ id: first.id, detail: "Re-raised" });
  });

  it("replays command and receipt history in sequence order even when a reader returns facts unordered", () => {
    const attachment = {
      id: "attachment-ordered",
      sessionId: session.id,
      adapterId: "opencode",
      venue: localVenue,
      continuity: "fresh" as const,
      native: null,
    };
    const command = {
      id: "command-ordered",
      sessionId: session.id,
      createdAt: 1,
      route: { adapterId: "opencode", attachmentId: "attachment-ordered" },
      intent: {
        kind: "message.submit" as const,
        reference: { id: "message-ordered", mediaType: null, digest: null },
      },
    };
    const receipt = {
      id: "receipt-ordered",
      commandId: command.id,
      status: "completed" as const,
      recordedAt: 4,
      sequence: 4,
      result: { kind: "message.submitted" as const, sessionId: session.id },
    };

    const projection = projectSession(session, [
      event(3, { kind: "attachment.closed", attachmentId: attachment.id, outcome: "completed" }),
      event(4, { kind: "command.receipt.recorded", receipt }),
      event(2, { kind: "attachment.opened", attachment }),
      event(1, { kind: "command.recorded", command }),
    ]);

    expect(projection.commands).toEqual([command]);
    expect(projection.receipts).toEqual([receipt]);
    expect(projection.attachments).toMatchObject([
      { id: attachment.id, status: "closed", outcome: "completed" },
    ]);
  });

  it("keeps only unresolved executor starts pending and clears them by matching facts", () => {
    const first = {
      id: "command-start-a",
      sessionId: session.id,
      createdAt: 1,
      route: { adapterId: "opencode", attachmentId: null },
      intent: {
        kind: "executor.start" as const,
        adapterId: "opencode",
        continuity: "fresh" as const,
      },
    };
    const second = {
      id: "command-start-b",
      sessionId: session.id,
      createdAt: 2,
      route: { adapterId: "claude", attachmentId: null },
      intent: {
        kind: "executor.start" as const,
        adapterId: "claude",
        continuity: "fresh" as const,
      },
    };
    const failedAttachment = {
      id: "attachment-start-a",
      sessionId: session.id,
      adapterId: "opencode",
      venue: localVenue,
      continuity: "fresh" as const,
      native: null,
    };
    const pending = projectSession(session, [
      event(1, { kind: "command.recorded", command: first }),
      event(2, { kind: "command.recorded", command: second }),
      {
        ...event(3, {
          kind: "attachment.failed",
          attachment: failedAttachment,
          failure: { code: "spawn_failed", detail: null, diagnostic: null },
        }),
        commandId: first.id,
      },
    ]);
    expect(pending).toMatchObject({ pendingExecutorStart: second });

    const openedAttachment = {
      ...failedAttachment,
      id: "attachment-start-b",
      adapterId: "claude",
    };
    const onlyFirstRemains = projectSession(session, [
      event(1, { kind: "command.recorded", command: first }),
      event(2, { kind: "command.recorded", command: second }),
      {
        ...event(3, { kind: "attachment.opened", attachment: openedAttachment }),
        commandId: second.id,
      },
    ]);
    expect(onlyFirstRemains).toMatchObject({ pendingExecutorStart: first });

    const settled = projectSession(session, [
      event(1, { kind: "command.recorded", command: first }),
      event(2, { kind: "command.recorded", command: second }),
      {
        ...event(3, {
          kind: "attachment.failed",
          attachment: failedAttachment,
          failure: { code: "spawn_failed", detail: null, diagnostic: null },
        }),
        commandId: first.id,
      },
      event(4, {
        kind: "command.receipt.recorded",
        receipt: {
          id: "receipt-start-b-rejected",
          commandId: second.id,
          status: "rejected",
          code: "adapter_rejected",
          detail: null,
          recordedAt: 4,
          sequence: 4,
        },
      }),
    ]);
    expect(settled).toMatchObject({ pendingExecutorStart: null });
  });
});

describe("projectSession turn activity", () => {
  const attachment = {
    id: "attachment-turn",
    sessionId: session.id,
    adapterId: "opencode",
    venue: localVenue,
    continuity: "fresh" as const,
    native: null,
  };

  it("opens on a started turn and closes on the completed one", () => {
    const started = projectSession(session, [
      event(1, { kind: "attachment.opened", attachment }),
      event(2, { kind: "turn.started", attachmentId: attachment.id, turnId: "turn-1" }),
    ]);
    expect(started.turnActive).toBe(true);

    const completed = projectSession(session, [
      event(1, { kind: "attachment.opened", attachment }),
      event(2, { kind: "turn.started", attachmentId: attachment.id, turnId: "turn-1" }),
      event(3, { kind: "turn.completed", attachmentId: attachment.id, turnId: "turn-1" }),
    ]);
    expect(completed.turnActive).toBe(false);
  });

  // The wedge: an executor that crashes or is interrupted mid-turn never writes
  // the `turn.completed`. Without the attachment ending the turn too, the
  // Session would read "working" durably, for as long as its history survives.
  it("closes an unfinished turn when its attachment ends, however it ended", () => {
    const crashed = projectSession(session, [
      event(1, { kind: "attachment.opened", attachment }),
      event(2, { kind: "turn.started", attachmentId: attachment.id, turnId: "turn-1" }),
      event(3, { kind: "attachment.closed", attachmentId: attachment.id, outcome: "interrupted" }),
    ]);
    expect(crashed.turnActive).toBe(false);

    const failed = projectSession(session, [
      event(1, { kind: "attachment.opened", attachment }),
      event(2, { kind: "turn.started", attachmentId: attachment.id, turnId: "turn-1" }),
      event(3, {
        kind: "attachment.failed",
        attachment,
        failure: { code: "spawn_failed", detail: null, diagnostic: null },
      }),
    ]);
    expect(failed.turnActive).toBe(false);
  });

  it("tracks the live attachment's turn across a second attachment", () => {
    const second = { ...attachment, id: "attachment-turn-2" };
    const projection = projectSession(session, [
      event(1, { kind: "attachment.opened", attachment }),
      event(2, { kind: "turn.started", attachmentId: attachment.id, turnId: "turn-1" }),
      event(3, { kind: "attachment.closed", attachmentId: attachment.id, outcome: "completed" }),
      event(4, { kind: "attachment.opened", attachment: second }),
      event(5, { kind: "turn.started", attachmentId: second.id, turnId: "turn-2" }),
    ]);
    expect(projection).toMatchObject({ turnActive: true, liveExecutor: { id: second.id } });
  });
});

describe("projectSession recency", () => {
  const command = {
    id: "command-recency",
    sessionId: session.id,
    createdAt: 1,
    route: null,
    intent: { kind: "session.retitle" as const, title: "Renamed" },
  };
  const receipt = {
    id: "receipt-recency",
    commandId: command.id,
    status: "completed" as const,
    recordedAt: 400,
    sequence: 40,
    result: { kind: "session.retitled" as const, sessionId: session.id },
  };

  it("seeds from the Session's own creation when nothing has happened yet", () => {
    expect(projectSession(session, []).lastActivityAt).toBe(session.createdAt);
  });

  it("advances to the newest ordinary fact", () => {
    const projection = projectSession(session, [
      event(30, { kind: "run.started", attachmentId: "attachment-recency", runId: "run-1" }),
      event(20, { kind: "turn.started", attachmentId: "attachment-recency", turnId: "turn-1" }),
    ]);
    expect(projection.lastActivityAt).toBe(300);
  });

  // Renaming a Session is Volli bookkeeping, not the agent doing something, and
  // a recency-sorted listing must not float it to the top for that.
  it("ignores command and receipt bookkeeping", () => {
    const projection = projectSession(session, [
      event(20, { kind: "turn.started", attachmentId: "attachment-recency", turnId: "turn-1" }),
      event(30, { kind: "command.recorded", command }),
      event(40, { kind: "command.receipt.recorded", receipt }),
    ]);
    expect(projection.lastActivityAt).toBe(200);
    expect(projection.commands).toEqual([command]);
  });

  it("ignores session.retitled after real activity", () => {
    const projection = projectSession(session, [
      event(20, { kind: "turn.started", attachmentId: "attachment-recency", turnId: "turn-1" }),
      event(50, { kind: "session.retitled", title: "Renamed" }),
    ]);
    expect(projection.lastActivityAt).toBe(200);
    expect(projection.session.title).toBe("Renamed");
  });
});

describe("projectSession bornTicketless", () => {
  it("seeds from the live session row when no session.created event is present", () => {
    expect(projectSession(session, []).bornTicketless).toBe(false);
    expect(projectSession({ ...session, ticketId: null }, []).bornTicketless).toBe(true);
  });

  // The immutable birth fact, not the live row: a session.created event's own
  // ticketId is what a later ticket delete (ON DELETE SET NULL) cannot touch.
  it("reads bornTicketless off the session.created event's ticketId, ignoring the live row", () => {
    const projection = projectSession(session, [
      event(1, { kind: "session.created", session: { ...session, ticketId: null } }),
    ]);
    expect(projection.bornTicketless).toBe(true);
    // The live `session` param passed in still says ticketed — proving the
    // fold read the event's snapshot, not the param.
    expect(session.ticketId).toBe("ticket-1");
  });

  it("reads false for a Session born with a ticket", () => {
    const projection = projectSession({ ...session, ticketId: null }, [
      event(1, { kind: "session.created", session: { ...session, ticketId: "ticket-1" } }),
    ]);
    expect(projection.bornTicketless).toBe(false);
  });
});

function raised(
  kind: Exclude<SessionAttentionKind, "rate_limited" | "quota_exhausted">,
): SessionAttention {
  return { id: `attention-${kind}`, kind, attachmentId: null, detail: null, diagnostic: null };
}

describe("sessionAwaitsUser", () => {
  const idle = {
    interactions: { active: [], resolved: [] },
    attention: { active: [], primary: null },
  };

  it("is false for a Session nobody is being asked about", () => {
    expect(sessionAwaitsUser(idle)).toBe(false);
  });

  it("is true while an Interaction is unanswered", () => {
    const interaction: SessionInteraction = {
      id: "interaction-1",
      attachmentId: "attachment-1",
      kind: "question",
      title: "Which branch?",
      detail: null,
      options: [],
      multiple: false,
      native: { id: null, detail: null },
    };
    expect(
      sessionAwaitsUser({ ...idle, interactions: { active: [interaction], resolved: [] } }),
    ).toBe(true);
  });

  it("separates the Attentions a person clears from the ones they cannot", () => {
    for (const kind of SESSION_USER_BLOCKING_ATTENTION_KINDS) {
      const attention = raised(kind);
      expect(
        sessionAwaitsUser({ ...idle, attention: { active: [attention], primary: attention } }),
      ).toBe(true);
    }
    const limited: SessionAttention = {
      id: "attention-rate-limited",
      kind: "rate_limited",
      attachmentId: null,
      detail: null,
      diagnostic: null,
      retryAt: null,
    };
    expect(sessionAwaitsUser({ ...idle, attention: { active: [limited], primary: limited } })).toBe(
      false,
    );
  });
});

describe("sameSessionCommand", () => {
  it("keeps a create command owned by the Session it created", () => {
    const created = {
      id: "command-create",
      sessionId: session.id,
      createdAt: 1,
      route: null,
      intent: {
        kind: "session.create" as const,
        projectId: session.projectId,
        ticketId: session.ticketId,
        title: session.title,
      },
    };

    expect(created.sessionId).toBe(session.id);
    expect(sameSessionCommand(created, { ...created })).toBe(true);
    expect(sameSessionCommand(created, { ...created, sessionId: "other-session" })).toBe(false);
  });

  it("compares id, target and semantic intent while ignoring object-key order", () => {
    const left = {
      id: "command-1",
      sessionId: "session-1",
      createdAt: 1,
      route: { adapterId: "opencode", attachmentId: "attachment-1" },
      intent: {
        kind: "message.submit" as const,
        reference: { id: "message-1", mediaType: "text/plain", digest: "sha256:1" },
      },
    };
    expect(sameSessionCommand(left, { ...left, createdAt: 2 })).toBe(true);
    expect(sameSessionCommand(left, { ...left, id: "command-2" })).toBe(false);
    expect(sameSessionCommand(left, { ...left, sessionId: "session-2" })).toBe(false);
    expect(
      sameSessionCommand(left, {
        ...left,
        route: { adapterId: "opencode", attachmentId: "attachment-2" },
      }),
    ).toBe(false);
    expect(
      sameSessionCommand(left, {
        ...left,
        intent: {
          kind: "message.submit",
          reference: { digest: "sha256:1", id: "message-1", mediaType: "text/plain" },
        },
      }),
    ).toBe(true);
    expect(
      sameSessionCommand(left, {
        ...left,
        intent: {
          kind: "message.submit",
          reference: { id: "message-2", mediaType: "text/plain", digest: "sha256:1" },
        },
      }),
    ).toBe(false);
  });
});

describe("sameSessionCommandRequest", () => {
  it("compares caller intent for an existing Session without a durable route", () => {
    const command = {
      id: "command-1",
      sessionId: session.id,
      createdAt: 1,
      route: { adapterId: "opencode", attachmentId: "attachment-1" },
      intent: {
        kind: "message.submit" as const,
        reference: { id: "message-1", mediaType: "text/plain", digest: "sha256:1" },
      },
    };
    const request = {
      id: command.id,
      sessionId: command.sessionId,
      intent: command.intent,
    };

    expect(sameSessionCommandRequest(command, request)).toBe(true);
    expect(sameSessionCommandRequest(command, { ...request, id: "command-2" })).toBe(false);
    expect(sameSessionCommandRequest(command, { ...request, sessionId: "session-2" })).toBe(false);
    expect(
      sameSessionCommandRequest(command, {
        ...request,
        intent: {
          kind: "message.submit",
          reference: { id: "message-2", mediaType: "text/plain", digest: "sha256:1" },
        },
      }),
    ).toBe(false);
  });
});

describe("sameCommandReceipt", () => {
  it("compares durable receipt content rather than acceptance status alone", () => {
    const accepted = {
      id: "receipt-1",
      commandId: "command-1",
      status: "accepted" as const,
      acceptedAt: 1,
      recordedAt: 1,
      sequence: 1,
      result: { kind: "message.submitted" as const, sessionId: session.id },
    };
    expect(sameCommandReceipt(accepted, { ...accepted })).toBe(true);
    expect(sameCommandReceipt(accepted, { ...accepted, id: "receipt-2" })).toBe(false);
    expect(
      sameCommandReceiptOutcome(accepted, {
        id: accepted.id,
        commandId: accepted.commandId,
        status: accepted.status,
        acceptedAt: accepted.acceptedAt,
        result: accepted.result,
      }),
    ).toBe(true);
    expect(
      sameCommandReceiptOutcome(accepted, {
        id: accepted.id,
        commandId: accepted.commandId,
        status: "completed",
        result: accepted.result,
      }),
    ).toBe(false);
  });
});

describe("sameSessionEventPayload", () => {
  it("compares semantic event content independent of object-key order", () => {
    const left = {
      kind: "adapter.observed" as const,
      attachmentId: null,
      name: "signal",
      native: { source: "hook", retries: 1 },
    };
    expect(
      sameSessionEventPayload(left, {
        kind: "adapter.observed",
        attachmentId: null,
        name: "signal",
        native: { retries: 1, source: "hook" },
      }),
    ).toBe(true);
    expect(sameSessionEventPayload(left, { ...left, name: "different" })).toBe(false);
    expect(
      sameSessionEventPayload(
        { ...left, native: [null, true, 1] },
        { ...left, native: [null, true, 1] },
      ),
    ).toBe(true);
  });
});

describe("sameSessionEventProvenance", () => {
  it("compares source and venue provenance independent of object-key order", () => {
    expect(
      sameSessionEventProvenance(
        {
          source: { kind: "adapter", id: "claude", detail: { first: 1, second: 2 } },
          venue: localVenue,
        },
        {
          source: { kind: "adapter", id: "claude", detail: { second: 2, first: 1 } },
          venue: localVenue,
        },
      ),
    ).toBe(true);
    expect(
      sameSessionEventProvenance(systemProvenance, {
        ...systemProvenance,
        source: { ...systemProvenance.source, id: "other" },
      }),
    ).toBe(false);
  });
});
