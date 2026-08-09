/**
 * The fold the transcript's frame budget rests on.
 *
 * `appendFrames` replaced three rescans of the whole Session — the message
 * projection, the opened-interaction index and the turn flag — with one pass
 * over each batch. A fold is only worth having if it says exactly what the scan
 * it replaced said, so the durable half is written against
 * {@link projectTranscriptMessages}'s own rule rather than against the fold's
 * implementation: latest shape per message id, in the order the ids first spoke.
 *
 * The transient half is the delta contract, and its rules are the ones a batch
 * can break silently: appends that must not collapse, a baseline that must not
 * outlive the settle it predates, and an orphan that must not become a message.
 */
import type { SessionStreamOverlay, TranscriptDelta } from "@volli/session-engine";
import type { SessionEvent, SessionInteraction } from "@volli/shared";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vite-plus/test";

import { projectTranscriptMessages } from "@renderer/chat/message-projection";

import {
  appendFrames,
  EMPTY_TRANSCRIPT,
  mergeTranscriptMessages,
  movesProjection,
  type ChatSessionFrame,
} from "./transcript";

function message(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

/**
 * One transient emission. `throughSequence` is the durable sequence it was
 * emitted beside — the whole input to the staleness guard — so every helper
 * below takes it explicitly rather than inventing one.
 */
function overlay(
  throughSequence: number,
  messageId: string,
  delta: TranscriptDelta,
): SessionStreamOverlay {
  return { kind: "overlay", sessionId: "session-1", throughSequence, messageId, delta };
}

/** The baseline every message's first delta is, keyed on one provider part. */
function baseline(id: string, text: string): TranscriptDelta {
  return {
    op: "reset",
    message: { id, role: "assistant", parts: [{ key: "prt_1", part: { type: "text", text } }] },
  };
}

function append(text: string): TranscriptDelta {
  return { op: "part.append", key: "prt_1", text };
}

/**
 * One committed frame. Only `payload` and `transcript` are read here, so the
 * envelope around them is the minimum a `SessionEvent` requires.
 */
function frame(
  sequence: number,
  payload: SessionEvent["payload"],
  transcript: UIMessage | null = null,
): ChatSessionFrame {
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

function transcriptFrame(sequence: number, held: UIMessage): ChatSessionFrame {
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

function turn(
  sequence: number,
  kind: "turn.started" | "turn.completed" | "turn.interrupted",
): ChatSessionFrame {
  return frame(sequence, { kind, attachmentId: "attachment-1", turnId: "turn-1" });
}

function opening(sequence: number, id: string): ChatSessionFrame {
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

    const folded = streaming.reduce((state, next) => appendFrames(state, [next]), EMPTY_TRANSCRIPT);

    // The scan this replaced, run over the same stream, is the specification.
    expect(folded.messages).toEqual(projectTranscriptMessages(streaming));
    expect(folded.messages.map((held) => held.id)).toEqual(["m1", "m2"]);
    expect(folded.messages[0]?.parts).toEqual([{ type: "text", text: "thinking" }]);
  });

  it("holds every derived value a batch had nothing to say about", () => {
    const opened = appendFrames(EMPTY_TRANSCRIPT, [opening(1, "permission:1")]);

    const next = appendFrames(opened, [turn(2, "turn.started")]);

    // Identity, not equality: a batch of pure turn traffic must not hand the
    // plane a new message list to re-group, or a new index to re-key turns on.
    expect(next.messages).toBe(opened.messages);
    expect(next.openedInteractions).toBe(opened.openedInteractions);
    expect(next.turnActive).toBe(true);
  });

  it("carries every interaction the Session has opened, not only the live ones", () => {
    const first = appendFrames(EMPTY_TRANSCRIPT, [opening(1, "permission:1")]);

    const second = appendFrames(first, [opening(2, "question:2")]);

    expect([...second.openedInteractions.keys()]).toEqual(["permission:1", "question:2"]);
  });

  it("drops a replayed frame so a turn boundary cannot be counted twice", () => {
    const started = appendFrames(EMPTY_TRANSCRIPT, [
      turn(1, "turn.started"),
      turn(2, "turn.completed"),
    ]);

    const replayed = appendFrames(started, [turn(1, "turn.started")]);

    expect(replayed).toBe(started);
    expect(replayed.turnActive).toBe(false);
    expect(replayed.turnEpoch).toBe(started.turnEpoch);
  });

  it("counts a turn that opened and closed inside one batch", () => {
    // The flag reads the same at both ends of this batch as it does across one
    // that never mentioned a turn, and the two mean opposite things to a Session
    // waiting on the turn it just delivered into.
    const quiet = appendFrames(EMPTY_TRANSCRIPT, [opening(1, "permission:1")]);
    expect(quiet.turnEpoch).toBe(0);

    const whole = appendFrames(quiet, [turn(2, "turn.started"), turn(3, "turn.completed")]);

    expect(whole.turnActive).toBe(false);
    expect(whole.turnEpoch).toBe(2);
  });

  it("ends the working state when durable history says the turn was interrupted", () => {
    const interrupted = appendFrames(EMPTY_TRANSCRIPT, [
      turn(1, "turn.started"),
      turn(2, "turn.interrupted"),
    ]);

    expect(interrupted.turnActive).toBe(false);
    expect(interrupted.turnEpoch).toBe(2);
  });
});

describe("appendFrames overlays", () => {
  it("keeps every append in one batch, in the order they were emitted", () => {
    // The rule the sequence-keyed frame map would have broken: all four of
    // these carry the same `throughSequence`, because the durable sequence does
    // not move while a message streams. Keyed by it, three of them vanish — and
    // an append is not a snapshot, so what is lost is the middle of a sentence
    // rather than a stale shape a fresher one replaces.
    const grown = appendFrames(
      EMPTY_TRANSCRIPT,
      [],
      [
        overlay(0, "m1", baseline("m1", "I")),
        overlay(0, "m1", append(" found")),
        overlay(0, "m1", append(" the")),
        overlay(0, "m1", append(" cause.")),
      ],
    );

    expect(grown.messages).toEqual([message("m1", "I found the cause.")]);
  });

  it("ignores a delta for a message it holds no baseline for", () => {
    // Self-healing: a subscriber that joined mid-message waits for the reset the
    // emitter owes it rather than inventing a message out of a suffix.
    const orphaned = appendFrames(
      EMPTY_TRANSCRIPT,
      [],
      [overlay(0, "m1", append("...the cause."))],
    );

    expect(orphaned).toBe(EMPTY_TRANSCRIPT);
  });

  it("drops a baseline that predates the settle it was delivered after", () => {
    const settled = appendFrames(EMPTY_TRANSCRIPT, [
      transcriptFrame(4, message("m1", "I found the cause.")),
    ]);

    // Emitted at 3, on its way while the settle at 4 was recorded. Applying it
    // would resurrect a message that has already finished, mid-word.
    const stale = appendFrames(settled, [], [overlay(3, "m1", baseline("m1", "I found"))]);

    expect(stale).toBe(settled);
    expect(stale.messages).toEqual([message("m1", "I found the cause.")]);
  });

  it("settles a stale baseline the same way whichever arm of the batch is read first", () => {
    const stale = overlay(3, "m1", baseline("m1", "I found"));
    const settle = transcriptFrame(4, message("m1", "I found the cause."));

    const durableFirst = appendFrames(EMPTY_TRANSCRIPT, [settle], [stale]);
    // The harder half of the same claim: the overlay does not merely arrive
    // first, it reaches the state — and the settle beside it still clears what
    // it wrote. The guard is what makes the two arms commute.
    const overlayFirst = appendFrames(appendFrames(EMPTY_TRANSCRIPT, [], [stale]), [settle]);

    expect(durableFirst.overlay.size).toBe(0);
    expect(overlayFirst.overlay.size).toBe(0);
    expect(overlayFirst.messages).toEqual(durableFirst.messages);
    expect(durableFirst.messages).toEqual([message("m1", "I found the cause.")]);
  });

  it("settles without a visual jump when the durable frame says what the overlay said", () => {
    const streaming = appendFrames(
      EMPTY_TRANSCRIPT,
      [],
      [overlay(0, "m1", baseline("m1", "I found")), overlay(0, "m1", append(" the cause."))],
    );
    expect(streaming.durableMessages).toEqual([]);
    expect(streaming.overlay.size).toBe(1);

    const settled = appendFrames(streaming, [
      transcriptFrame(1, message("m1", "I found the cause.")),
    ]);

    expect(settled.overlay.size).toBe(0);
    expect(settled.durableSequences.get("m1")).toBe(1);
    // The whole point of the settle point: the transient entry goes and the
    // transcript does not move.
    expect(settled.messages).toEqual(streaming.messages);
  });

  it("keeps a re-opened message at the position it first spoke at", () => {
    const durable = appendFrames(EMPTY_TRANSCRIPT, [
      transcriptFrame(1, message("m1", "First.")),
      transcriptFrame(2, message("m2", "Second.")),
    ]);

    // The emitter's other sequencing rule: the first delta after a message
    // settles is a reset. Durable position is what holds it in place.
    const regrown = appendFrames(
      durable,
      [],
      [overlay(2, "m1", baseline("m1", "First, and more."))],
    );

    expect(regrown.messages.map((held) => held.id)).toEqual(["m1", "m2"]);
    expect(regrown.messages[0]?.parts).toEqual([{ type: "text", text: "First, and more." }]);
    expect(regrown.messages[1]).toBe(durable.messages[1]);
  });

  it("renders an overlay-only message last and moves it to its durable position on settle", () => {
    const durable = appendFrames(EMPTY_TRANSCRIPT, [transcriptFrame(1, message("m1", "On it."))]);

    const streaming = appendFrames(
      durable,
      [],
      [overlay(1, "m2", baseline("m2", "second")), overlay(1, "m3", baseline("m3", "third"))],
    );
    // No durable position yet, so: after everything durable, in the order the
    // overlay first heard of them.
    expect(streaming.messages.map((held) => held.id)).toEqual(["m1", "m2", "m3"]);

    const settled = appendFrames(streaming, [transcriptFrame(2, message("m3", "third"))]);

    expect(settled.messages.map((held) => held.id)).toEqual(["m1", "m3", "m2"]);
  });

  it("drops a message the provider deleted while it was still in flight", () => {
    const streaming = appendFrames(
      EMPTY_TRANSCRIPT,
      [],
      [overlay(0, "m1", baseline("m1", "half a "))],
    );

    const removed = appendFrames(streaming, [], [overlay(0, "m1", { op: "message.remove" })]);

    expect(removed.overlay.size).toBe(0);
    expect(removed.messages).toEqual([]);
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

describe("movesProjection", () => {
  it("reads a transcript reference as settling only what this surface already has in frames", () => {
    expect(movesProjection(transcriptFrame(1, message("m1", "done")))).toBe(false);
  });

  it("reads every other fact as one that can move the projection", () => {
    expect(movesProjection(turn(1, "turn.started"))).toBe(true);
    expect(movesProjection(opening(1, "permission:1"))).toBe(true);
  });
});
