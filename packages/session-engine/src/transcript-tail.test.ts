import { describe, expect, it } from "vite-plus/test";
import { ACTIVITY_METADATA_KEY } from "@volli/shared";
import type { SessionEvent, TranscriptReference } from "@volli/shared";
import type { UIMessage } from "ai";

import { createInMemoryTranscriptArtifactStore } from "./transcript-artifacts";
import type { SessionTranscriptArtifact } from "./transcript-artifacts";
import {
  readSessionTranscriptTail,
  TRANSCRIPT_TAIL_TEXT_LIMIT,
  transcriptReferenceFor,
} from "./transcript-tail";

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
  });
});
