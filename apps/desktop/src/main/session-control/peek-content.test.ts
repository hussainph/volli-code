import { describe, expect, it, vi } from "vite-plus/test";
import { createInMemoryTranscriptArtifactStore } from "@volli/session-engine";
import type { SessionTranscriptArtifact } from "@volli/session-engine";
import { EMPTY_SESSION_USAGE_SUMMARY, peekSummaryOf } from "@volli/shared";
import type {
  SessionEvent,
  SessionInteraction,
  SessionProjection,
  TranscriptReference,
} from "@volli/shared";
import type { UIMessage } from "ai";

import { PEEK_EXCERPT_CHARS, readSessionPeekContent } from "./peek-content";

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

function transcriptEvent(sequence: number, reference: TranscriptReference): SessionEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "session-1",
    sequence,
    occurredAt: sequence * 10,
    recordedAt: sequence * 10,
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

function question(overrides: Partial<SessionInteraction> = {}): SessionInteraction {
  return {
    id: "interaction-1",
    attachmentId: "attachment-1",
    kind: "question",
    title: "Which branch should I cut from?",
    detail: null,
    options: [],
    multiple: false,
    // The runtime's own correlation — the half the renderer must never see.
    native: { id: "pi-native-7", detail: "pi" },
    ...overrides,
  };
}

function projection(overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    session: {
      id: "session-1",
      projectId: "project-1",
      ticketId: "ticket-1",
      role: "ticket",
      parentSessionId: null,
      title: "Plan the migration",
      createdAt: 1,
    },
    status: "open",
    commands: [],
    resumptions: [],
    latestTurnId: null,
    latestTurnOrigin: null,
    resumedAfterStop: false,
    receipts: [],
    pendingExecutorStart: null,
    attachments: [],
    liveExecutor: null,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    signal: null,
    stopped: null,
    turnActive: false,
    lastTurnOutcome: null,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    lastActivityAt: 4_000,
    bornTicketless: false,
    modelSelection: null,
    modelTier: null,
    ...overrides,
  };
}

describe("readSessionPeekContent", () => {
  it("folds the tail the CLI's own peek reads", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const asked = await artifacts.write(
      artifactOf({ id: "m1", role: "user", parts: [{ type: "text", text: "Start the   audit" }] }),
    );
    const answered = await artifacts.write(
      artifactOf({
        id: "m2",
        role: "assistant",
        parts: [
          { type: "text", text: "Reading the config" },
          {
            type: "dynamic-tool",
            toolName: "read_file",
            toolCallId: "t1",
            state: "input-streaming",
          },
        ],
      }),
    );
    const events = [turnStarted(1), transcriptEvent(2, asked), transcriptEvent(3, answered)];

    const content = await readSessionPeekContent(
      {
        listEvents: async () => events,
        readArtifact: (reference) => artifacts.read(reference),
        getSession: async () => projection(),
      },
      { sessionId: "session-1" },
    );

    expect(content).toEqual({
      sessionId: "session-1",
      entries: [
        // Whitespace collapsed by the engine's fold, not re-done here.
        { at: 20, role: "user", text: "Start the audit", tools: [] },
        { at: 30, role: "assistant", text: "Reading the config", tools: ["read_file"] },
      ],
      question: null,
      turns: 1,
      turnDepth: 2,
      unreadable: 0,
      lastActivityAt: 4_000,
    });
  });

  it("asks for a glance's worth of entries, which no caller picks", async () => {
    const listEvents = vi.fn(async () => []);

    const content = await readSessionPeekContent(
      { listEvents, getSession: async () => projection() },
      { sessionId: "session-1" },
    );

    // With no artifact store there are no entries to count, and `unreadable`
    // stays 0 — nothing looked.
    expect(content).toMatchObject({ entries: [], unreadable: 0 });
    expect(listEvents).toHaveBeenCalledTimes(1);
  });

  it("counts a tail message whose artifact could not be read", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const spoken = await artifacts.write(
      artifactOf({ id: "m1", role: "assistant", parts: [{ type: "text", text: "Done" }] }),
    );
    // A reference the store will not find: the artifact behind it is gone.
    const lost: TranscriptReference = {
      ...spoken,
      id: "fnv1a64:0000000000000000",
      digest: "fnv1a64:0000000000000000",
    };

    const content = await readSessionPeekContent(
      {
        listEvents: async () => [transcriptEvent(1, lost), transcriptEvent(2, spoken)],
        readArtifact: (reference) => artifacts.read(reference),
        getSession: async () => projection(),
      },
      { sessionId: "session-1" },
    );

    // Counted, never faked: a blank line here would report silence where there
    // were words.
    expect(content?.unreadable).toBe(1);
    expect(content?.entries).toEqual([{ at: 20, role: "assistant", text: "Done", tools: [] }]);
  });

  it("carries the open question with the runtime's correlation scrubbed", async () => {
    const content = await readSessionPeekContent(
      {
        listEvents: async () => [],
        getSession: async () =>
          projection({ interactions: { active: [question()], resolved: [] } }),
      },
      { sessionId: "session-1" },
    );

    expect(content?.question).toEqual({
      ...question(),
      // The renderer answers by `SessionInteraction.id` and can neither see nor
      // forge the harness's own handle.
      native: { id: null, detail: null },
    });
  });

  it("names the first active question, as every other surface does", async () => {
    const content = await readSessionPeekContent(
      {
        listEvents: async () => [],
        getSession: async () =>
          projection({
            interactions: {
              active: [question({ id: "asked-first" }), question({ id: "asked-later" })],
              resolved: [],
            },
          }),
      },
      { sessionId: "session-1" },
    );

    expect(content?.question?.id).toBe("asked-first");
  });

  it("passes longer bounded excerpts to one optional hover refinement", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const text = "Detailed progress. ".repeat(150);
    const spoken = await artifacts.write(
      artifactOf({ id: "m1", role: "assistant", parts: [{ type: "text", text }] }),
    );
    const summarize = vi.fn(async () => "The requested fix is ready for review.");
    const content = await readSessionPeekContent(
      {
        listEvents: async () => [transcriptEvent(1, spoken)],
        readArtifact: (reference) => artifacts.read(reference),
        getSession: async () => projection(),
        summarize,
      },
      { sessionId: "session-1", refine: true },
    );
    expect(content?.entries[0]?.text).toBe(`${text.trim().slice(0, PEEK_EXCERPT_CHARS)}…`);
    expect(summarize).toHaveBeenCalledExactlyOnceWith("session-1", content?.entries);
    expect(content?.summary).toBe("The requested fix is ready for review.");
  });

  it("keeps prose available to refinement through a tools-only tail without expanding the card's entries", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const messages: UIMessage[] = [
      { id: "request", role: "user", parts: [{ type: "text", text: "Fix the peek" }] },
      { id: "progress", role: "assistant", parts: [{ type: "text", text: "Testing the fix" }] },
      ...Array.from({ length: 6 }, (_, index): UIMessage => ({
        id: `tools-${index}`,
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "bash",
            toolCallId: `tool-${index}`,
            state: "input-streaming",
          },
        ],
      })),
    ];
    const references = await Promise.all(
      messages.map((message) => artifacts.write(artifactOf(message))),
    );
    const summarize = vi.fn(async (_id: string, entries: readonly { text: string }[]) =>
      entries
        .filter((entry) => entry.text !== "")
        .map((entry) => entry.text)
        .join(". "),
    );
    const content = await readSessionPeekContent(
      {
        listEvents: async () =>
          references.map((reference, index) => transcriptEvent(index + 1, reference)),
        readArtifact: (reference) => artifacts.read(reference),
        getSession: async () => projection(),
        summarize,
      },
      { sessionId: "session-1", refine: true },
    );
    expect(content?.summary).toBe("Fix the peek. Testing the fix");
    expect(content?.entries).toHaveLength(6);
    expect(content?.entries.every((entry) => entry.text === "")).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("carries null refinement without losing the durable fallback", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const requested = await artifacts.write(
      artifactOf({ id: "request", role: "user", parts: [{ type: "text", text: "Fix the peek" }] }),
    );
    const progress = await artifacts.write(
      artifactOf({
        id: "progress",
        role: "assistant",
        parts: [{ type: "text", text: "Testing the fix" }],
      }),
    );
    const content = await readSessionPeekContent(
      {
        listEvents: async () => [transcriptEvent(1, requested), transcriptEvent(2, progress)],
        readArtifact: (reference) => artifacts.read(reference),
        getSession: async () => projection(),
        summarize: async () => null,
      },
      { sessionId: "session-1", refine: true },
    );
    expect(content?.summary).toBeNull();
    expect(content?.entries).toEqual([
      { at: 10, role: "user", text: "Fix the peek", tools: [] },
      { at: 20, role: "assistant", text: "Testing the fix", tools: [] },
    ]);
    expect(peekSummaryOf(content!.entries)).toBe("Testing the fix");
  });

  it.each([undefined, false])(
    "local reads return readable content without waiting for utility work (%s)",
    async (refine) => {
      const artifacts = createInMemoryTranscriptArtifactStore();
      const spoken = await artifacts.write(
        artifactOf({
          id: "m1",
          role: "assistant",
          parts: [{ type: "text", text: "Local progress" }],
        }),
      );
      const pending = Promise.withResolvers<string | null>();
      const summarize = vi.fn(() => pending.promise);
      const ports = {
        listEvents: async () => [transcriptEvent(1, spoken)],
        readArtifact: (reference: TranscriptReference) => artifacts.read(reference),
        getSession: async () =>
          projection({ interactions: { active: [question()], resolved: [] } }),
        summarize,
      };
      const content = await readSessionPeekContent(ports, { sessionId: "session-1", refine });
      expect(content?.entries[0]?.text).toBe("Local progress");
      expect(content?.question?.id).toBe("interaction-1");
      expect(summarize).not.toHaveBeenCalled();
      const refined = readSessionPeekContent(ports, { sessionId: "session-1", refine: true });
      pending.resolve("Combined summary");
      expect((await refined)?.summary).toBe("Combined summary");
      expect(summarize).toHaveBeenCalledTimes(1);
    },
  );

  it("answers null for a Session the ledger no longer has", async () => {
    const listEvents = vi.fn(async () => []);
    const summarize = vi.fn(async () => "No work");

    const content = await readSessionPeekContent(
      { listEvents, getSession: async () => null, summarize },
      { sessionId: "gone" },
    );

    expect(content).toBeNull();
    // And it costs no transcript read or model refinement at all.
    expect(listEvents).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
  });
});
