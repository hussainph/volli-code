import { ACTIVITY_METADATA_KEY } from "@volli/shared";
import type { TodoStatus } from "@volli/shared";
import type { SessionEvent, TranscriptReference } from "@volli/shared";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vite-plus/test";

import { createInMemoryTranscriptArtifactStore } from "./transcript-artifacts";
import type { SessionTranscriptArtifact } from "./transcript-artifacts";
import { currentTodoList, readSessionTodoList } from "./session-todo";

let nextId = 0;

/** One durable `todo_write` call, exactly as `observation-translation` writes it. */
function todoCall(
  todos: readonly { content: string; status: TodoStatus }[],
  overrides: { kind?: string; state?: "input-available" | "output-error" } = {},
): UIMessage {
  nextId += 1;
  return {
    id: `message-${nextId}`,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "volli.activity",
        toolCallId: `call-${nextId}`,
        toolMetadata: {
          [ACTIVITY_METADATA_KEY]: {
            kind: overrides.kind ?? "plan",
            nativeToolName: "todo_write",
            subject: { label: null, path: null, lineRange: null },
            outcome: null,
            startedAt: null,
            endedAt: null,
          },
        },
        ...(overrides.state === "output-error"
          ? { state: "output-error" as const, input: { todos }, errorText: "boom" }
          : overrides.state === "input-available"
            ? { state: "input-available" as const, input: { todos } }
            : { state: "output-available" as const, input: { todos }, output: { ok: true } }),
      },
    ],
  } as UIMessage;
}

function say(text: string): UIMessage {
  nextId += 1;
  return { id: `message-${nextId}`, role: "assistant", parts: [{ type: "text", text }] };
}

describe("currentTodoList", () => {
  it("is null for a Session that has never written one", () => {
    expect(currentTodoList([])).toBeNull();
    expect(currentTodoList([say("no plan here")])).toBeNull();
  });

  it("is the newest call's whole list, because each call replaces the last", () => {
    const list = currentTodoList([
      todoCall([
        { content: "Read the ticket", status: "in_progress" },
        { content: "Write the tool", status: "pending" },
      ]),
      say("thinking"),
      todoCall([
        { content: "Read the ticket", status: "completed" },
        { content: "Write the tool", status: "in_progress" },
        { content: "Wire the island", status: "pending" },
      ]),
    ]);

    expect(list).toEqual([
      { content: "Read the ticket", status: "completed" },
      { content: "Write the tool", status: "in_progress" },
      { content: "Wire the island", status: "pending" },
    ]);
  });

  it("rebuilds the same list from history alone, so a relaunch loses nothing", () => {
    // The whole of "current state survives a relaunch": there is no resident
    // value to lose, because the fold's only input is the durable transcript
    // the Session replays on attach.
    const history = [
      todoCall([{ content: "Read the ticket", status: "in_progress" }]),
      todoCall([{ content: "Read the ticket", status: "completed" }]),
    ];

    expect(currentTodoList(history)).toEqual(currentTodoList([...history]));
    expect(currentTodoList(history.slice(0, 1))).toEqual([
      { content: "Read the ticket", status: "in_progress" },
    ]);
  });

  it("keeps a list the model deliberately cleared, rather than reviving the one before it", () => {
    expect(
      currentTodoList([
        todoCall([{ content: "Read the ticket", status: "pending" }]),
        todoCall([]),
      ]),
    ).toEqual([]);
  });

  it("ignores a call that failed, which never replaced anything", () => {
    expect(
      currentTodoList([
        todoCall([{ content: "Read the ticket", status: "completed" }]),
        todoCall([{ content: "Nonsense", status: "pending" }], { state: "output-error" }),
      ]),
    ).toEqual([{ content: "Read the ticket", status: "completed" }]);
  });

  it("ignores every activity that is not a plan", () => {
    expect(
      currentTodoList([todoCall([{ content: "Read", status: "pending" }], { kind: "read-file" })]),
    ).toBeNull();
  });

  it("keeps the last real list when a plan call carries something that is not one", () => {
    // The kind says `plan` but the arguments are not a todo payload — a second
    // harness whose own plan tool takes a different shape, or a model that
    // filled the call in wrong. It must not COUNT as a list: treating an
    // unreadable call as the current plan would blank a good one.
    const unreadable: UIMessage = {
      id: "message-odd",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "volli.activity",
          toolCallId: "call-odd",
          state: "output-available",
          input: { steps: ["not a todo payload"] },
          output: { ok: true },
          toolMetadata: {
            [ACTIVITY_METADATA_KEY]: {
              kind: "plan",
              nativeToolName: "update_plan",
              subject: { label: null, path: null, lineRange: null },
              outcome: null,
              startedAt: null,
              endedAt: null,
            },
          },
        },
      ],
    } as UIMessage;

    expect(
      currentTodoList([
        todoCall([{ content: "Read the ticket", status: "completed" }]),
        unreadable,
      ]),
    ).toEqual([{ content: "Read the ticket", status: "completed" }]);
    expect(currentTodoList([unreadable])).toBeNull();
  });
});

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

/** An event that carries no transcript message, as most of a real ledger does. */
function turnEvent(sequence: number): SessionEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "session-1",
    sequence,
    occurredAt: sequence * 10,
    recordedAt: sequence * 10,
    provenance: PROVENANCE,
    payload: { kind: "turn.started", attachmentId: "attachment-1", turnId: "turn-1" },
  } as SessionEvent;
}

/**
 * A ledger holding these messages in order, and the ports that read it back.
 *
 * Every message is preceded by a `turn.started`, because a real ledger is
 * mostly events that carry no transcript at all and the walk has to step over
 * them rather than ask the blob store for a reference that is not there.
 */
async function ledgerOf(messages: readonly UIMessage[]) {
  const store = createInMemoryTranscriptArtifactStore();
  const events: SessionEvent[] = [];
  let sequence = 0;
  for (const message of messages) {
    const reference = await store.write(artifactOf(message));
    sequence += 1;
    events.push(turnEvent(sequence));
    sequence += 1;
    events.push(transcriptEvent(sequence, reference));
  }
  return {
    listEvents: async () => events,
    readArtifact: (reference: TranscriptReference) => store.read(reference),
  };
}

describe("readSessionTodoList", () => {
  it("reads the newest list back out of the ledger, for a Session nobody has open", async () => {
    const ports = await ledgerOf([
      todoCall([{ content: "Read the ticket", status: "in_progress" }]),
      say("working"),
      todoCall([
        { content: "Read the ticket", status: "completed" },
        { content: "Write the tool", status: "in_progress" },
      ]),
    ]);

    expect(await readSessionTodoList(ports, { sessionId: "session-1" })).toEqual([
      { content: "Read the ticket", status: "completed" },
      { content: "Write the tool", status: "in_progress" },
    ]);
  });

  it("is null for a Session that never wrote one, so nothing is posted for it", async () => {
    const ports = await ledgerOf([say("no plan here")]);

    expect(await readSessionTodoList(ports, { sessionId: "session-1" })).toBeNull();
  });

  it("is null rather than empty when this composition holds no artifact store", async () => {
    // Empty would claim the Session cleared a plan it may still be holding.
    expect(
      await readSessionTodoList({ listEvents: async () => [] }, { sessionId: "session-1" }),
    ).toBeNull();
  });

  it("keeps reading past an artifact the store cannot answer for", async () => {
    const ports = await ledgerOf([
      todoCall([{ content: "Read the ticket", status: "completed" }]),
      say("this one is lost"),
    ]);

    const broken = {
      listEvents: ports.listEvents,
      readArtifact: async (reference: TranscriptReference) => {
        const artifact = await ports.readArtifact(reference);
        if (artifact.message.parts[0]?.type === "text") throw new Error("blob is gone");
        return artifact;
      },
    };

    expect(await readSessionTodoList(broken, { sessionId: "session-1" })).toEqual([
      { content: "Read the ticket", status: "completed" },
    ]);
  });
});
