/**
 * The fold the transcript's frame budget now rests on.
 *
 * `appendFrames` replaced three rescans of the whole Session — the message
 * projection, the opened-interaction index and the turn flag — with one pass
 * over each batch. A fold is only worth having if it says exactly what the scan
 * it replaced said, so these are written against {@link projectTranscriptMessages}'s
 * own rule rather than against the fold's implementation: latest shape per
 * message id, in the order the ids first spoke.
 */
import type { SessionEvent, SessionInteraction } from "@volli/shared";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vite-plus/test";

import { appendFrames, mergeTranscriptMessages, type LabSessionFrame } from "./session-controller";
import { projectTranscriptMessages } from "./message-projection";

const EMPTY = {
  frames: [] as readonly LabSessionFrame[],
  throughSequence: 0,
  turnActive: false,
  messages: [] as readonly UIMessage[],
  openedInteractions: new Map<string, SessionInteraction>() as ReadonlyMap<
    string,
    SessionInteraction
  >,
};

function message(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

/**
 * One committed frame. Only `payload` and `transcript` are read here, so the
 * envelope around them is the minimum a `SessionEvent` requires.
 */
function frame(
  sequence: number,
  payload: SessionEvent["payload"],
  transcript: UIMessage | null = null,
): LabSessionFrame {
  return {
    sessionId: "session-1",
    sequence,
    event: {
      id: `event-${sequence}`,
      sessionId: "session-1",
      sequence,
      occurredAt: sequence,
      recordedAt: sequence,
      attachmentId: "attachment-1",
      commandId: null,
      provenance: {
        source: { kind: "adapter", id: "lab-scenarios", detail: null },
        venue: { id: "lab-machine", kind: "local" },
      },
      payload,
    },
    transcript: transcript === null ? null : { message: transcript },
  };
}

function transcriptFrame(sequence: number, held: UIMessage): LabSessionFrame {
  return frame(
    sequence,
    {
      kind: "transcript.referenced",
      attachmentId: "attachment-1",
      turnId: "turn-1",
      reference: { id: `artifact-${sequence}`, mediaType: null, digest: null },
    },
    held,
  );
}

function turn(sequence: number, kind: "turn.started" | "turn.completed"): LabSessionFrame {
  return frame(sequence, { kind, attachmentId: "attachment-1", turnId: "turn-1" });
}

function opening(sequence: number, id: string): LabSessionFrame {
  const interaction: SessionInteraction = {
    id,
    attachmentId: "attachment-1",
    kind: "permission",
    title: "Run a command",
    detail: null,
    options: [],
    multiple: false,
    native: { id, detail: null },
  };
  return frame(sequence, { kind: "interaction.opened", interaction });
}

describe("appendFrames", () => {
  it("keeps a message's first position and shows its latest shape", () => {
    const streaming = [
      transcriptFrame(1, message("m1", "thin")),
      transcriptFrame(2, message("m2", "second")),
      transcriptFrame(3, message("m1", "thinking")),
    ];

    const folded = streaming.reduce((state, next) => appendFrames(state, [next]), EMPTY);

    // The scan this replaced, run over the same stream, is the specification.
    expect(folded.messages).toEqual(projectTranscriptMessages(streaming));
    expect(folded.messages.map((held) => held.id)).toEqual(["m1", "m2"]);
    expect(folded.messages[0]?.parts).toEqual([{ type: "text", text: "thinking" }]);
  });

  it("holds every derived value a batch had nothing to say about", () => {
    const opened = appendFrames(EMPTY, [opening(1, "permission:1")]);

    const next = appendFrames(opened, [turn(2, "turn.started")]);

    // Identity, not equality: a batch of pure turn traffic must not hand the
    // plane a new message list to re-group, or a new index to re-key turns on.
    expect(next.messages).toBe(opened.messages);
    expect(next.openedInteractions).toBe(opened.openedInteractions);
    expect(next.turnActive).toBe(true);
  });

  it("carries every interaction the Session has opened, not only the live ones", () => {
    const first = appendFrames(EMPTY, [opening(1, "permission:1")]);

    const second = appendFrames(first, [opening(2, "question:2")]);

    expect([...second.openedInteractions.keys()]).toEqual(["permission:1", "question:2"]);
  });

  it("drops a replayed frame so a turn boundary cannot be counted twice", () => {
    const started = appendFrames(EMPTY, [turn(1, "turn.started"), turn(2, "turn.completed")]);

    const replayed = appendFrames(started, [turn(1, "turn.started")]);

    expect(replayed).toBe(started);
    expect(replayed.turnActive).toBe(false);
  });
});

describe("mergeTranscriptMessages", () => {
  it("keeps the list it was given when the batch projected nothing", () => {
    const current = [message("m1", "one")];

    expect(mergeTranscriptMessages(current, [])).toBe(current);
  });

  it("replaces a re-emitted message in place and appends a new one", () => {
    const current = [message("m1", "one"), message("m2", "two")];

    const merged = mergeTranscriptMessages(current, [
      message("m1", "one!"),
      message("m3", "three"),
    ]);

    expect(merged.map((held) => held.id)).toEqual(["m1", "m2", "m3"]);
    expect(merged[0]?.parts).toEqual([{ type: "text", text: "one!" }]);
    expect(merged[1]).toBe(current[1]);
  });
});
