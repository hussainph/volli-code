import { expect, it } from "vite-plus/test";
import {
  scrubSessionEvent,
  sessionHostNoticeMetadata,
  type RuntimeObservation,
  type SessionEvent,
} from "@volli/shared";
// Test the actual production producer without making its internal translator
// a new public package export or adding any runtime/caller choice.
import {
  RuntimeObservationTranslator,
  type TranslatedObservation,
} from "../../session-engine/src/observation-translation";
import { appendFrames, EMPTY_TRANSCRIPT, type ChatSessionFrame } from "./transcript";
import { chatSessionFrame, chatSessionOverlay } from "./wire";
import { groupTurns } from "./activity";
import { projectTranscriptRows } from "./transcript-rows";
import { transcriptMessageOrigins } from "./transcript-message-origin";
import { projectWorkWindows, transcriptMessageTimes, workDurationLabel } from "./work-windows";
import type { SessionStreamOverlay } from "@volli/session-engine";

function harness() {
  let state = EMPTY_TRANSCRIPT;
  let sequence = 0;
  let now = 1000;
  let pendingFrames: ChatSessionFrame[] = [];
  let pendingOverlays: SessionStreamOverlay[] = [];
  const translator = new RuntimeObservationTranslator({
    namespace: "pi",
    sessionId: "session",
    attachmentId: "attachment",
    now: () => now++,
  });
  const record = (
    payload: SessionEvent["payload"],
    at: number,
    message: ChatSessionFrame["transcript"] = null,
    host = false,
  ) => {
    sequence += 1;
    const event: SessionEvent = {
      id: `event-${sequence}`,
      sessionId: "session",
      sequence,
      occurredAt: at,
      recordedAt: at,
      attachmentId: "attachment",
      provenance: host
        ? {
            source: {
              kind: "user",
              id: "session-client",
              detail: { sessionOrigin: { kind: "volli", reason: "browser-notice" } },
            },
            venue: null,
          }
        : { source: { kind: "adapter", id: "pi", detail: null }, venue: null },
      payload,
    };
    const decoded = chatSessionFrame(
      JSON.parse(
        JSON.stringify({
          sessionId: "session",
          sequence,
          event: scrubSessionEvent(event),
          transcript: message,
        }),
      ),
    );
    if (!decoded) throw new Error("Expected decoded production frame");
    pendingFrames.push(decoded);
  };
  const emit = async (observation: TranslatedObservation) => {
    if (observation.kind === "transcript.delta") {
      const decoded = chatSessionOverlay(
        JSON.parse(
          JSON.stringify({
            kind: "overlay",
            sessionId: "session",
            throughSequence: sequence,
            messageId: observation.messageId,
            delta: observation.delta,
          }),
        ),
      );
      if (!decoded) throw new Error("Expected decoded production overlay");
      pendingOverlays.push(decoded);
    } else if (observation.kind === "transcript.message") {
      record(
        {
          kind: "transcript.referenced",
          attachmentId: "attachment",
          turnId: observation.turnId,
          reference: { id: observation.id, digest: null, mediaType: null },
        },
        observation.occurredAt,
        { message: observation.message },
      );
    } else if (
      observation.kind === "turn.started" ||
      observation.kind === "turn.completed" ||
      observation.kind === "turn.interrupted"
    ) {
      record(
        { kind: observation.kind, attachmentId: "attachment", turnId: observation.turnId },
        observation.occurredAt,
      );
    }
  };
  const flush = () => {
    state = appendFrames(state, pendingFrames, pendingOverlays);
    pendingFrames = [];
    pendingOverlays = [];
    return state;
  };
  return {
    translator,
    advance(count: number) {
      for (let index = 0; index < count; index += 1)
        record({ kind: "session.retitled", title: "Audit" }, now++);
    },
    get state() {
      return state;
    },
    translate: (observation: RuntimeObservation) => translator.translate(observation, emit),
    flush,
    flushRemoveBeforeSettle() {
      // Exercise both possible client batches: remove may be observed before
      // the hydrated settled artifact reaches the next resident fold.
      state = appendFrames(state, [], pendingOverlays);
      pendingOverlays = [];
      return flush();
    },
    notice() {
      const id = "notice";
      record(
        {
          kind: "command.recorded",
          command: {
            id: "notice-command",
            sessionId: "session",
            createdAt: now,
            route: null,
            intent: {
              kind: "message.submit",
              reference: { id: "notice-artifact", digest: null, mediaType: null },
            },
          },
        },
        now++,
        {
          message: {
            id,
            role: "user",
            metadata: sessionHostNoticeMetadata({
              kind: "browser-hold",
              tabId: "tab",
              tabTitle: "Page",
              tabHostname: "example.org",
              action: "person-took",
            }),
            parts: [{ type: "text", text: "Browser hold changed" }],
          },
        },
        true,
      );
      return flush();
    },
  };
}
function rows(state: ReturnType<typeof harness>["state"]) {
  return projectWorkWindows(
    projectTranscriptRows(
      groupTurns(state.messages),
      state.compactions,
      state.reasoningDrops,
      state.toolRefreshes,
      transcriptMessageOrigins(state.frames),
    ),
    transcriptMessageTimes(state.frames),
    state.turnActive,
    state,
  );
}
function work(state: ReturnType<typeof harness>["state"]) {
  return rows(state)
    .filter((row) => row.kind === "work")
    .map((row) => row.work);
}

it.each(["coalesced", "separate"] as const)(
  "keeps reasoning placement unknown across unlinked provisional -> entry ids in %s batches",
  async (batch) => {
    const host = harness();
    await host.translate({ kind: "turn", state: "started", turnId: "turn" });
    host.flush();
    // The producer's streaming channel order can differ from settledParts,
    // which always places reasoning first. This makes the index transition real.
    await host.translate({ kind: "delta", turnId: "turn", channel: "text", text: "" });
    await host.translate({
      kind: "delta",
      turnId: "turn",
      channel: "reasoning",
      text: "Checking contrast",
    });
    host.flush();
    const streamingId = [...host.state.overlay.keys()][0]!;
    expect(streamingId).toBe("pi:attachment:turn:0");
    const originalKey = work(host.state)[0]!.key;
    host.notice();
    expect(rows(host.state).map((row) => row.kind)).toEqual(["work", "host-notice"]);
    await host.translate({
      kind: "message-settled",
      turnId: "turn",
      message: {
        entryId: "entry-7",
        role: "assistant",
        text: "Done",
        reasoning: "Checking contrast",
      },
    });
    const settled = batch === "separate" ? host.flushRemoveBeforeSettle() : host.flush();
    expect(settled.durableMessages.at(-1)?.id).toBe("pi:attachment:entry:entry-7");
    expect(settled.overlay.size).toBe(0);
    expect(rows(settled).map((row) => row.kind)).toEqual(["host-notice", "work", "turn"]);
    expect(work(settled)[0]!.key).not.toBe(originalKey);
    expect(work(settled)[0]!.rows).toHaveLength(1);
    expect(work(settled)[0]!.rows[0]!.part).toMatchObject({
      type: "reasoning",
      text: "Checking contrast",
      state: "done",
    });
    expect(settled.activityFirstOverlaySequence.size).toBe(0);
    expect(
      [...settled.activityFirstOverlaySequence.keys()].some((key) => key.includes(streamingId)),
    ).toBe(false);
    // Cold history cannot recreate an unrecorded reasoning start. It preserves
    // full content and canonical order, but does not claim an active duration.
    const cold = appendFrames(EMPTY_TRANSCRIPT, settled.frames);
    expect(cold.messages).toEqual(settled.durableMessages);
    expect(cold.activityFirstOverlaySequence.size).toBe(0);
    expect(work(cold).map(workDurationLabel)).toEqual(["Work details"]);
  },
);

it("retires unreachable reasoning after actual tool-only withdrawals without speculative handoffs", async () => {
  const host = harness();
  await host.translate({ kind: "turn", state: "started", turnId: "turn" });
  host.flush();
  for (let index = 0; index < 100; index += 1) {
    await host.translate({
      kind: "delta",
      turnId: "turn",
      channel: "reasoning",
      text: `Attempt ${index}`,
    });
    host.flush();
    await host.translate({
      kind: "message-settled",
      turnId: "turn",
      message: { entryId: `empty-${index}`, role: "assistant", text: "" },
    });
    host.flush();
    expect(host.state.overlay.size).toBe(0);
    expect(host.state.activityFirstOverlaySequence.size).toBe(0);
  }
  expect(work(host.state)).toHaveLength(0);
  await host.translate({
    kind: "delta",
    turnId: "turn",
    channel: "reasoning",
    text: "Final thought",
  });
  host.flush();
  const key = work(host.state)[0]!.key;
  host.notice();
  await host.translate({
    kind: "message-settled",
    turnId: "turn",
    message: { entryId: "final", role: "assistant", text: "Done", reasoning: "Final thought" },
  });
  host.flush();
  expect(work(host.state)[0]!.key).not.toBe(key);
  await host.translate({ kind: "turn", state: "completed", turnId: "turn" });
  host.flush();
  expect(work(host.state)).toHaveLength(1);
});

it.each(["no-reset", "turn-close", "age-window"] as const)(
  "never adopts a withdrawn thought for an unrelated entry across %s",
  async (barrier) => {
    const host = harness();
    await host.translate({ kind: "turn", state: "started", turnId: "turn" });
    host.flush();
    await host.translate({
      kind: "delta",
      turnId: "turn",
      channel: "reasoning",
      text: "Withdrawn thought",
    });
    host.flush();
    const oldKey = work(host.state)[0]!.key;
    host.notice();
    await host.translate({
      kind: "message-settled",
      turnId: "turn",
      message: { entryId: "withdrawn", role: "assistant", text: "" },
    });
    host.flush();
    expect(host.state.activityFirstOverlaySequence.size).toBe(0);
    if (barrier === "turn-close")
      await host.translate({ kind: "turn", state: "completed", turnId: "turn" });
    if (barrier === "age-window") host.advance(129);
    // No new delta/reset. This is a separate settled thought, despite sharing
    // the attachment and turn prefix. Barrier and settlement fold in one batch.
    await host.translate({
      kind: "message-settled",
      turnId: "turn",
      message: {
        entryId: "unrelated",
        role: "assistant",
        text: "New answer",
        reasoning: "Unrelated thought",
      },
    });
    host.flush();
    expect(rows(host.state).map((row) => row.kind)).toEqual(["host-notice", "work", "turn"]);
    expect(work(host.state)[0]!.key).not.toBe(oldKey);
    expect(work(host.state)[0]!.rows[0]!.part).toMatchObject({
      type: "reasoning",
      text: "Unrelated thought",
    });
    expect(work(host.state).map(workDurationLabel)).toEqual(["Work details"]);
    expect(host.state.activityFirstOverlaySequence.size).toBe(0);
    expect(host.state.messages.at(-1)?.id).toBe("pi:attachment:entry:unrelated");
    expect(host.state.frames.map((frame) => frame.sequence)).toEqual(
      host.state.frames.map((frame) => frame.sequence).toSorted((left, right) => left - right),
    );
  },
);
