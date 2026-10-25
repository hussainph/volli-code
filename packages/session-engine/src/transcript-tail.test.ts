import { describe, expect, it } from "vite-plus/test";
import { ACTIVITY_METADATA_KEY } from "@volli/shared";
import type { CommandReceipt, SessionEvent, TranscriptReference } from "@volli/shared";
import type { UIMessage } from "ai";

import type { SessionTranscriptArtifact } from "./transcript-artifacts";
import {
  readSessionTranscriptTail,
  TRANSCRIPT_TAIL_TEXT_LIMIT,
  transcriptReferenceFor,
} from "./transcript-tail";
import { createInMemorySessionLedger, createInMemoryTranscriptArtifactStore } from "./testing";

const PROVENANCE = {
  source: { kind: "adapter", id: "pi", detail: null },
  venue: { id: "local", kind: "local" },
} as const;

function artifactOf(message: UIMessage): SessionTranscriptArtifact {
  return {
    version: 1,
    threadId: "thread-1",
    branchId: "branch-1",
    attemptId: "attempt-1",
    turnId: null,
    message,
  };
}

/** One `transcript.referenced` fact, sequenced in arrival order. */
function transcriptEvent(
  sequence: number,
  reference: TranscriptReference,
  occurredAt = sequence * 10,
): SessionEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "session-1",
    sequence,
    occurredAt,
    recordedAt: occurredAt,
    provenance: PROVENANCE,
    payload: {
      kind: "transcript.referenced",
      attachmentId: "attachment-1",
      turnId: null,
      reference,
    },
  };
}

function turnStarted(sequence: number): SessionEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "session-1",
    sequence,
    occurredAt: sequence * 10,
    recordedAt: sequence * 10,
    provenance: PROVENANCE,
    payload: { kind: "turn.started", attachmentId: "attachment-1", turnId: `turn-${sequence}` },
  };
}

/** A user message: recorded as the `message.submit` command that carried it. */
function submitEvent(sequence: number, reference: TranscriptReference): SessionEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "session-1",
    sequence,
    occurredAt: sequence * 10,
    recordedAt: sequence * 10,
    provenance: PROVENANCE,
    payload: {
      kind: "command.recorded",
      command: {
        id: `command-${sequence}`,
        sessionId: "session-1",
        createdAt: sequence * 10,
        route: null,
        intent: { kind: "message.submit", reference },
      },
    },
  };
}

/**
 * Writes run the durable ledger codec, not hand-waved projection fixtures. The
 * reference checks are off: these histories name commands they never stored,
 * which is exactly what the tail reader must not trust.
 */
async function ledgerPorts(events: readonly SessionEvent[]) {
  const ledger = createInMemorySessionLedger({ checkReferences: false });
  await ledger.transaction((transaction) => {
    transaction.insertSession({
      id: "session-1",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: null,
      createdAt: 0,
    });
    for (const event of events) transaction.appendEvent(event);
  });
  return {
    listEvents: (query: { sessionId: string }) =>
      ledger.transaction((transaction) => transaction.listEvents(query)),
  };
}

function receiptEvent(
  sequence: number,
  status: CommandReceipt["status"],
  commandId = "command-1",
): SessionEvent {
  const base = { id: `receipt-${sequence}`, commandId, sequence, recordedAt: sequence * 10 };
  const result = { kind: "message.submitted", sessionId: "session-1" } as const;
  const receipt: CommandReceipt =
    status === "accepted"
      ? { ...base, status, acceptedAt: sequence * 10, result }
      : status === "completed"
        ? { ...base, status, result }
        : status === "rejected"
          ? { ...base, status, code: "not_available", detail: "No live executor" }
          : { ...base, status, detail: "Runtime outcome could not be reconciled" };
  return {
    ...turnStarted(sequence),
    commandId,
    payload: { kind: "command.receipt.recorded", receipt },
  };
}

describe("readSessionTranscriptTail", () => {
  it("keeps the last N messages with roles, tool names, and truncated words", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const long = "word ".repeat(80);
    const asked = await artifacts.write(
      artifactOf({ id: "m1", role: "user", parts: [{ type: "text", text: " Ship\n  the\tCLI " }] }),
    );
    const ran = await artifacts.write(
      artifactOf({
        id: "m2",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "volli.activity",
            toolCallId: "call-1",
            state: "output-available",
            input: {},
            output: {},
            toolMetadata: {
              [ACTIVITY_METADATA_KEY]: {
                kind: "run-command",
                nativeToolName: "bash",
                subject: { label: "pnpm test", path: null, lineRange: null },
                outcome: null,
                startedAt: null,
                endedAt: null,
              },
            },
          },
        ],
      }),
    );
    const answered = await artifacts.write(
      artifactOf({
        id: "m3",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "thinking hard about it", state: "done" },
          { type: "text", text: long, state: "done" },
        ],
      }),
    );
    const events = [
      turnStarted(1),
      submitEvent(2, asked),
      transcriptEvent(3, ran),
      transcriptEvent(4, answered),
    ];

    const tail = await readSessionTranscriptTail(
      { listEvents: async () => events, readArtifact: (reference) => artifacts.read(reference) },
      { sessionId: "session-1", limit: 2 },
    );

    expect(tail).toEqual({
      entries: [
        { at: 30, role: "assistant", text: "", tools: ["bash"] },
        {
          at: 40,
          role: "assistant",
          // Reasoning never reaches the tail; the words are cut at the limit.
          text: `${"word ".repeat(80).slice(0, TRANSCRIPT_TAIL_TEXT_LIMIT)}…`,
          tools: [],
        },
      ],
      messages: 3,
      unreadable: 0,
      turns: 1,
      turnDepth: 3,
    });
  });

  it("allows longer bounded UI excerpts without truncating words within the requested limit", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const first = "word ".repeat(30).trim();
    const second = "more ".repeat(10).trim();
    const words = `${first} ${second}`;
    const reference = await artifacts.write(
      artifactOf({
        id: "m1",
        role: "assistant",
        parts: [
          { type: "text", text: `  ${first}\n` },
          { type: "text", text: `\t${second}  ` },
        ],
      }),
    );
    const ports = {
      listEvents: async () => [transcriptEvent(1, reference)],
      readArtifact: (requestedReference: TranscriptReference) => artifacts.read(requestedReference),
    };

    const tail = await readSessionTranscriptTail(ports, {
      sessionId: "session-1",
      limit: 1,
      textLimit: words.length,
    });

    expect(words.length).toBeGreaterThan(TRANSCRIPT_TAIL_TEXT_LIMIT);
    expect(tail.entries).toEqual([{ at: 10, role: "assistant", text: words, tools: [] }]);

    const capped = await readSessionTranscriptTail(ports, {
      sessionId: "session-1",
      limit: 1,
      textLimit: 160,
    });
    expect(capped.entries[0]?.text).toBe(`${words.slice(0, 160)}…`);
  });

  it.each([
    { textLimit: 3.9, expectedLimit: 3 },
    { textLimit: -3, expectedLimit: 0 },
    { textLimit: 0, expectedLimit: 0 },
    { textLimit: Number.NaN, expectedLimit: TRANSCRIPT_TAIL_TEXT_LIMIT },
    { textLimit: Number.POSITIVE_INFINITY, expectedLimit: TRANSCRIPT_TAIL_TEXT_LIMIT },
    { textLimit: Number.NEGATIVE_INFINITY, expectedLimit: TRANSCRIPT_TAIL_TEXT_LIMIT },
  ])("normalizes textLimit $textLimit to $expectedLimit", async ({ textLimit, expectedLimit }) => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const words = "x".repeat(200);
    const reference = await artifacts.write(
      artifactOf({ id: "m1", role: "assistant", parts: [{ type: "text", text: words }] }),
    );

    const tail = await readSessionTranscriptTail(
      {
        listEvents: async () => [transcriptEvent(1, reference)],
        readArtifact: (requestedReference) => artifacts.read(requestedReference),
      },
      { sessionId: "session-1", limit: 1, textLimit },
    );

    expect(tail.entries[0]?.text).toBe(`${words.slice(0, expectedLimit)}…`);
  });

  it("counts turns and the depth of the newest one over the Session's whole life", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const first = await artifacts.write(
      artifactOf({ id: "m1", role: "user", parts: [{ type: "text", text: "one" }] }),
    );
    const second = await artifacts.write(
      artifactOf({ id: "m2", role: "assistant", parts: [{ type: "text", text: "two" }] }),
    );
    const events = [
      turnStarted(1),
      transcriptEvent(2, first),
      transcriptEvent(3, second),
      turnStarted(4),
      transcriptEvent(5, first),
    ];

    const tail = await readSessionTranscriptTail(
      { listEvents: async () => events, readArtifact: (reference) => artifacts.read(reference) },
      { sessionId: "session-1", limit: 10 },
    );

    expect(tail).toMatchObject({ messages: 3, turns: 2, turnDepth: 1 });
    expect(tail.entries.map((entry) => entry.text)).toEqual(["one", "two", "one"]);
  });

  it("falls back to the raw tool name when the adapter stamped no descriptor", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const unstamped = await artifacts.write(
      artifactOf({
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "grep",
            toolCallId: "call-1",
            state: "input-available",
            input: {},
          },
        ],
      }),
    );

    const tail = await readSessionTranscriptTail(
      {
        listEvents: async () => [transcriptEvent(1, unstamped)],
        readArtifact: (reference) => artifacts.read(reference),
      },
      { sessionId: "session-1", limit: 5 },
    );

    expect(tail.entries).toEqual([{ at: 10, role: "assistant", text: "", tools: ["grep"] }]);
  });

  it("counts a message it could not read instead of inventing a blank one", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const readable = await artifacts.write(
      artifactOf({ id: "m1", role: "user", parts: [{ type: "text", text: "still here" }] }),
    );
    const missing: TranscriptReference = {
      id: "fnv1a64:0000000000000000",
      mediaType: readable.mediaType,
      digest: "fnv1a64:0000000000000000",
    };

    const tail = await readSessionTranscriptTail(
      {
        listEvents: async () => [transcriptEvent(1, missing), transcriptEvent(2, readable)],
        readArtifact: (reference) => artifacts.read(reference),
      },
      { sessionId: "session-1", limit: 5 },
    );

    expect(tail.unreadable).toBe(1);
    expect(tail.entries).toEqual([{ at: 20, role: "user", text: "still here", tools: [] }]);
  });

  it("answers with counts alone when the composition holds no artifact store", async () => {
    const reference: TranscriptReference = {
      id: "fnv1a64:1111111111111111",
      mediaType: "application/vnd.volli.ui-message+json",
      digest: "fnv1a64:1111111111111111",
    };

    const tail = await readSessionTranscriptTail(
      { listEvents: async () => [turnStarted(1), transcriptEvent(2, reference)] },
      { sessionId: "session-1", limit: 5 },
    );

    // No entries and no `unreadable`: nothing looked, so nothing failed.
    expect(tail).toEqual({ entries: [], messages: 1, unreadable: 0, turns: 1, turnDepth: 1 });
  });

  it("reads a Session with no transcript at all, and honors a zero-length tail", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const only = await artifacts.write(
      artifactOf({ id: "m1", role: "user", parts: [{ type: "text", text: "one" }] }),
    );
    const ports = {
      listEvents: async (query: { sessionId: string }) =>
        query.sessionId === "empty" ? [] : [transcriptEvent(1, only)],
      readArtifact: (reference: TranscriptReference) => artifacts.read(reference),
    };

    await expect(
      readSessionTranscriptTail(ports, { sessionId: "empty", limit: 5 }),
    ).resolves.toEqual({ entries: [], messages: 0, unreadable: 0, turns: 0, turnDepth: 0 });
    await expect(
      readSessionTranscriptTail(ports, { sessionId: "session-1", limit: 0 }),
    ).resolves.toMatchObject({ entries: [], messages: 1 });
    // A fractional or negative request floors to a sane tail rather than throwing.
    await expect(
      readSessionTranscriptTail(ports, { sessionId: "session-1", limit: -3 }),
    ).resolves.toMatchObject({ entries: [], messages: 1 });
  });

  it("names the events that carry a transcript message", () => {
    const reference: TranscriptReference = {
      id: "fnv1a64:2222222222222222",
      mediaType: "application/vnd.volli.ui-message+json",
      digest: "fnv1a64:2222222222222222",
    };

    expect(transcriptReferenceFor(transcriptEvent(1, reference))).toEqual(reference);
    expect(transcriptReferenceFor(submitEvent(2, reference))).toEqual(reference);
    expect(transcriptReferenceFor(turnStarted(3))).toBeNull();
    expect(
      transcriptReferenceFor({
        ...submitEvent(4, reference),
        payload: {
          kind: "command.recorded",
          command: {
            id: "command-4",
            sessionId: "session-1",
            createdAt: 40,
            route: null,
            intent: {
              kind: "interaction.resolve",
              attachmentId: "attachment-1",
              interactionId: "interaction-1",
              resolution: { optionIds: ["once"], response: null },
              reference,
            },
          },
        },
      }),
    ).toEqual(reference);
    expect(
      transcriptReferenceFor({
        ...submitEvent(5, reference),
        payload: {
          kind: "command.recorded",
          command: {
            id: "command-5",
            sessionId: "session-1",
            createdAt: 50,
            route: null,
            intent: { kind: "executor.stop", attachmentId: "attachment-1" },
          },
        },
      }),
    ).toBeNull();
  });
});

describe("submitted message delivery evidence", () => {
  it.each([
    { status: null, expected: "Pending" },
    { status: "accepted", expected: "Delivered" },
    { status: "completed", expected: "Delivered" },
    { status: "rejected", expected: "Not delivered" },
    { status: "unreconciled", expected: "Delivery unconfirmed" },
  ] as const)("labels receipt $status as $expected", async ({ status, expected }) => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const reference = await artifacts.write(
      artifactOf({ id: "intent", role: "user", parts: [{ type: "text", text: "Change course" }] }),
    );
    const ports = await ledgerPorts([
      submitEvent(1, reference),
      ...(status === null ? [] : [receiptEvent(2, status)]),
    ]);
    const tail = await readSessionTranscriptTail(
      { ...ports, readArtifact: (requested) => artifacts.read(requested) },
      { sessionId: "session-1", limit: 1 },
    );
    expect(tail.entries).toEqual([
      { at: 10, role: "user", text: "Change course", tools: [], delivery: expected },
    ]);
    expect(tail.unreadable).toBe(0);
  });

  it.each([undefined, null, "unknown-command", "command-1"])(
    "only believes a turn start correlated to this command (%s)",
    async (commandId) => {
      const artifacts = createInMemoryTranscriptArtifactStore();
      const reference = await artifacts.write(
        artifactOf({ id: "intent", role: "user", parts: [] }),
      );
      const ports = await ledgerPorts([
        submitEvent(1, reference),
        { ...turnStarted(2), ...(commandId === undefined ? {} : { commandId }) },
      ]);
      const tail = await readSessionTranscriptTail(
        { ...ports, readArtifact: (requested) => artifacts.read(requested) },
        { sessionId: "session-1", limit: 1 },
      );
      expect(tail.entries[0]?.delivery).toBe(commandId === "command-1" ? "Delivered" : "Pending");
    },
  );

  it.each(["accepted", "completed", "turn", "reference", "identity"] as const)(
    "does not downgrade %s proof after an unreconciled receipt",
    async (proof) => {
      const artifacts = createInMemoryTranscriptArtifactStore();
      const reference = await artifacts.write(
        artifactOf({ id: "intent", role: "user", parts: [{ type: "text", text: "Prompt" }] }),
      );
      const observed = await artifacts.write(
        artifactOf({
          id: "intent",
          role: "user",
          parts: [{ type: "text", text: "Prompt enriched" }],
        }),
      );
      const evidence =
        proof === "accepted" || proof === "completed"
          ? receiptEvent(2, proof)
          : proof === "turn"
            ? { ...turnStarted(2), commandId: "command-1" }
            : transcriptEvent(2, proof === "reference" ? reference : observed);
      const ports = await ledgerPorts([
        submitEvent(1, reference),
        evidence,
        receiptEvent(3, "unreconciled"),
      ]);
      const reads: string[] = [];
      const tail = await readSessionTranscriptTail(
        {
          ...ports,
          readArtifact: (requested) => {
            reads.push(requested.id);
            return artifacts.read(requested);
          },
        },
        { sessionId: "session-1", limit: 2 },
      );
      expect(tail.entries[0]?.delivery).toBe("Delivered");
      expect(tail.entries[1]?.delivery).toBeUndefined();
      expect(reads.length).toBe(proof === "identity" ? 2 : 1);
      expect(tail.unreadable).toBe(0);
    },
  );

  it("uses historical identical references without reading them or unrelated history", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const reference = await artifacts.write(artifactOf({ id: "intent", role: "user", parts: [] }));
    const missing: TranscriptReference = {
      ...reference,
      id: "fnv1a64:0000000000000000",
      digest: "fnv1a64:0000000000000000",
    };
    const ports = await ledgerPorts([
      transcriptEvent(1, reference),
      transcriptEvent(2, missing),
      submitEvent(3, reference),
    ]);
    const reads: string[] = [];
    const tail = await readSessionTranscriptTail(
      {
        ...ports,
        readArtifact: (requested) => {
          reads.push(requested.id);
          return artifacts.read(requested);
        },
      },
      { sessionId: "session-1", limit: 1 },
    );
    expect(tail.entries[0]?.delivery).toBe("Delivered");
    expect(reads).toEqual([reference.id]);
    expect(tail).toMatchObject({ messages: 3, unreadable: 0 });
  });

  it("does not mistake another message or an assistant's reused id for observation proof", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const reference = await artifacts.write(artifactOf({ id: "intent", role: "user", parts: [] }));
    const unrelated = await artifacts.write(
      artifactOf({ id: "unrelated", role: "user", parts: [] }),
    );
    const assistant = await artifacts.write(
      artifactOf({ id: "intent", role: "assistant", parts: [] }),
    );
    const ports = await ledgerPorts([
      submitEvent(1, reference),
      transcriptEvent(2, unrelated),
      transcriptEvent(3, assistant),
      receiptEvent(4, "accepted", "unknown-command"),
    ]);
    const tail = await readSessionTranscriptTail(
      { ...ports, readArtifact: (requested) => artifacts.read(requested) },
      { sessionId: "session-1", limit: 3 },
    );
    expect(tail.entries.map((entry) => entry.delivery)).toEqual(["Pending", undefined, undefined]);
  });

  it("never labels an interaction answer or non-user submit as pending", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const answer = await artifacts.write(artifactOf({ id: "answer", role: "user", parts: [] }));
    const assistant = await artifacts.write(
      artifactOf({ id: "assistant", role: "assistant", parts: [] }),
    );
    const command = submitEvent(1, answer);
    if (command.payload.kind !== "command.recorded") throw new Error("Expected command");
    const ports = await ledgerPorts([
      {
        ...command,
        payload: {
          kind: "command.recorded",
          command: {
            ...command.payload.command,
            intent: {
              kind: "interaction.resolve",
              attachmentId: "attachment-1",
              interactionId: "interaction-1",
              resolution: { optionIds: ["once"], response: null },
              reference: answer,
            },
          },
        },
      },
      submitEvent(2, assistant),
      receiptEvent(3, "accepted"),
    ]);
    const tail = await readSessionTranscriptTail(
      { ...ports, readArtifact: (requested) => artifacts.read(requested) },
      { sessionId: "session-1", limit: 2 },
    );
    expect(tail.entries.map((entry) => entry.delivery)).toEqual([undefined, undefined]);
  });

  it("counts malformed tail bodies as unreadable while retaining readable messages", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const malformed = await artifacts.write(
      artifactOf({ id: "broken", role: "user", parts: null } as unknown as UIMessage),
    );
    const readable = await artifacts.write(artifactOf({ id: "intent", role: "user", parts: [] }));
    const ports = await ledgerPorts([submitEvent(1, malformed), submitEvent(2, readable)]);
    const tail = await readSessionTranscriptTail(
      { ...ports, readArtifact: (requested) => artifacts.read(requested) },
      { sessionId: "session-1", limit: 2 },
    );
    expect(tail).toMatchObject({ messages: 2, unreadable: 1 });
    expect(tail.entries).toEqual([
      { at: 20, role: "user", text: "", tools: [], delivery: "Pending" },
    ]);
  });

  it("rejects unknown receipt statuses at the ledger codec rather than inventing delivery evidence", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const reference = await artifacts.write(artifactOf({ id: "intent", role: "user", parts: [] }));
    const receipt = receiptEvent(2, "unreconciled");
    if (receipt.payload.kind !== "command.receipt.recorded") throw new Error("Expected receipt");
    // Preserve a valid receipt envelope so the failure specifically names its status.
    const unknown = { ...receipt, payload: { ...receipt.payload } };
    Object.assign(unknown.payload, { receipt: { ...receipt.payload.receipt, status: "unknown" } });
    await expect(ledgerPorts([submitEvent(1, reference), unknown])).rejects.toThrow(
      "status is not a known receipt status",
    );
  });

  it("still returns counts without a store and reports unreadable intents without faking labels", async () => {
    const reference: TranscriptReference = {
      id: "fnv1a64:0000000000000000",
      mediaType: "application/vnd.volli.ui-message+json",
      digest: "fnv1a64:0000000000000000",
    };
    const ports = await ledgerPorts([submitEvent(1, reference), receiptEvent(2, "unreconciled")]);
    await expect(
      readSessionTranscriptTail(ports, { sessionId: "session-1", limit: 1 }),
    ).resolves.toEqual({
      entries: [],
      messages: 1,
      unreadable: 0,
      turns: 0,
      turnDepth: 1,
    });
    const artifacts = createInMemoryTranscriptArtifactStore();
    await expect(
      readSessionTranscriptTail(
        { ...ports, readArtifact: (requested) => artifacts.read(requested) },
        { sessionId: "session-1", limit: 1 },
      ),
    ).resolves.toEqual({ entries: [], messages: 1, unreadable: 1, turns: 0, turnDepth: 1 });
  });
});
