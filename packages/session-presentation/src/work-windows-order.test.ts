import { expect, it } from "vite-plus/test";
import {
  EMPTY_ACTIVITY_SUBJECT,
  scrubSessionEvent,
  type RuntimeObservation,
  type SessionEvent,
} from "@volli/shared";
// The actual production producer of activity and settled reasoning messages,
// replayed the way a cold Session re-reads them (no overlays, no live starts).
import {
  RuntimeObservationTranslator,
  type TranslatedObservation,
} from "../../session-engine/src/observation-translation";
import type { SessionStreamOverlay } from "@volli/session-engine";
import { groupTurns } from "./activity";
import { appendFrames, EMPTY_TRANSCRIPT, type ChatSessionFrame } from "./transcript";
import { projectTranscriptRows } from "./transcript-rows";
import { transcriptMessageOrigins } from "./transcript-message-origin";
import { chatSessionFrame, chatSessionOverlay } from "./wire";
import { projectWorkWindows, transcriptMessageTimes } from "./work-windows";

function frame(
  sequence: number,
  payload: SessionEvent["payload"],
  at: number,
  message: NonNullable<ChatSessionFrame["transcript"]>["message"],
): ChatSessionFrame {
  const user = message.role === "user";
  const event: SessionEvent = {
    id: `event-${sequence}`,
    sessionId: "session",
    sequence,
    occurredAt: at,
    recordedAt: at,
    attachmentId: "attachment",
    provenance: {
      source: user
        ? { kind: "user", id: "session-client", detail: { sessionOrigin: { kind: "user" } } }
        : { kind: "adapter", id: "pi", detail: null },
      venue: null,
    },
    payload,
  };
  const decoded = chatSessionFrame(
    JSON.parse(
      JSON.stringify({
        sessionId: "session",
        sequence,
        event: scrubSessionEvent(event),
        transcript: { message },
      }),
    ),
  );
  if (!decoded) throw new Error("Expected decoded production frame");
  return decoded;
}

type Step =
  | { tool: string; start: number; end: number }
  | { reasoning: string }
  | { prompt: string; at: number };

/** Cold replay of one turn: each step's real message, at its own ledger sequence. */
function replay(steps: readonly Step[]) {
  let now = 1000;
  const translator = new RuntimeObservationTranslator({
    namespace: "pi",
    sessionId: "session",
    attachmentId: "attachment",
    now: () => now++,
  });
  const frames = steps.map((step, index) => {
    const sequence = index + 1;
    if ("prompt" in step)
      return frame(
        sequence,
        {
          kind: "command.recorded",
          command: {
            id: `prompt-${sequence}`,
            sessionId: "session",
            createdAt: step.at,
            route: null,
            intent: {
              kind: "message.submit",
              reference: { id: `prompt-${sequence}`, digest: null, mediaType: null },
            },
          },
        },
        step.at,
        { id: `prompt-${sequence}`, role: "user", parts: [{ type: "text", text: step.prompt }] },
      );
    const observation: RuntimeObservation =
      "tool" in step
        ? {
            kind: "activity",
            state: "completed",
            turnId: "turn",
            activityId: step.tool,
            descriptor: {
              kind: "other",
              nativeToolName: "fixture",
              subject: EMPTY_ACTIVITY_SUBJECT,
              outcome: null,
              startedAt: step.start,
              endedAt: step.end,
            },
            input: {},
            output: "done",
            occurredAt: step.end,
          }
        : {
            kind: "message-settled",
            turnId: "turn",
            message: {
              entryId: `e${sequence}`,
              role: "assistant",
              text: "",
              reasoning: step.reasoning,
            },
          };
    const [translated] = translator.replay(observation);
    if (translated?.kind !== "transcript.message") throw new Error("Expected a settled message");
    return frame(
      sequence,
      {
        kind: "transcript.referenced",
        attachmentId: "attachment",
        turnId: "turn",
        reference: { id: translated.id, digest: null, mediaType: null },
      },
      translated.occurredAt,
      translated.message,
    );
  });
  const state = appendFrames(EMPTY_TRANSCRIPT, frames);
  const rows = projectWorkWindows(
    projectTranscriptRows(
      groupTurns(state.messages),
      state.compactions,
      state.reasoningDrops,
      state.toolRefreshes,
      transcriptMessageOrigins(state.frames),
    ),
    transcriptMessageTimes(state.frames),
    false,
    state,
  );
  return rows.flatMap((row) =>
    row.kind === "work"
      ? [
          row.work.rows.map((activity) =>
            activity.kind === "tool" ? activity.part.toolCallId : "R",
          ),
        ]
      : [],
  );
}

it("keeps settled reasoning between the tools around it after the wall clock steps back", () => {
  const order = replay([
    { prompt: "Audit", at: 10 },
    // A fast parallel call settles first.
    { tool: "w", start: 101, end: 110 },
    { tool: "x", start: 100, end: 150 },
    { reasoning: "Weighing results" },
    // The clock stepped back before the next model step.
    { tool: "y", start: 50, end: 60 },
  ]);
  expect(order).toEqual([["x", "w", "R", "y"]]);
});

it("orders equal-start parallel calls by view key without crossing unplaced reasoning", () => {
  expect(
    replay([
      { prompt: "Audit", at: 10 },
      { tool: "z", start: 100, end: 120 },
      { tool: "m", start: 100, end: 110 },
      { reasoning: "Weighing results" },
      { tool: "a", start: 100, end: 130 },
    ]),
  ).toEqual([["m", "z", "R", "a"]]);
});

const call = (id: string, phase: "started" | "completed"): RuntimeObservation => ({
  kind: "activity",
  state: phase,
  turnId: "turn",
  activityId: id,
  descriptor: {
    kind: "other",
    nativeToolName: "fixture",
    subject: EMPTY_ACTIVITY_SUBJECT,
    outcome: null,
    startedAt: 100,
    endedAt: phase === "completed" ? 200 : null,
  },
  input: {},
  output: phase === "completed" ? "done" : null,
  occurredAt: 200,
});

it("orders tied parallel calls with and without an observed position by one key", async () => {
  // Live: z and a open overlays at different ledger positions; m only settles.
  const translator = new RuntimeObservationTranslator({
    namespace: "pi",
    sessionId: "session",
    attachmentId: "attachment",
    now: () => 1000,
  });
  let sequence = 0;
  let state = EMPTY_TRANSCRIPT;
  const frames: ChatSessionFrame[] = [];
  const overlays: SessionStreamOverlay[] = [];
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
      overlays.push(decoded);
    } else if (observation.kind === "transcript.message") {
      sequence += 1;
      frames.push(
        frame(
          sequence,
          {
            kind: "transcript.referenced",
            attachmentId: "attachment",
            turnId: "turn",
            reference: { id: observation.id, digest: null, mediaType: null },
          },
          observation.occurredAt,
          observation.message,
        ),
      );
    }
  };
  const flush = () => {
    state = appendFrames(state, frames.splice(0), overlays.splice(0));
  };
  frames.push(
    frame(
      ++sequence,
      {
        kind: "command.recorded",
        command: {
          id: "prompt",
          sessionId: "session",
          createdAt: 10,
          route: null,
          intent: {
            kind: "message.submit",
            reference: { id: "prompt", digest: null, mediaType: null },
          },
        },
      },
      10,
      { id: "prompt", role: "user", parts: [{ type: "text", text: "Audit" }] },
    ),
  );
  flush();
  await translator.translate(call("z", "started"), emit);
  flush();
  await translator.translate(call("m", "completed"), emit);
  flush();
  await translator.translate(call("a", "started"), emit);
  flush();
  await translator.translate(call("a", "completed"), emit);
  await translator.translate(call("z", "completed"), emit);
  flush();
  expect(state.activityFirstOverlaySequence.size).toBe(2);
  const rows = projectWorkWindows(
    projectTranscriptRows(
      groupTurns(state.messages),
      [],
      [],
      [],
      transcriptMessageOrigins(state.frames),
    ),
    transcriptMessageTimes(state.frames),
    false,
    state,
  );
  expect(
    rows.flatMap((row) =>
      row.kind === "work"
        ? [
            row.work.rows.map((activity) =>
              activity.kind === "tool" ? activity.part.toolCallId : "R",
            ),
          ]
        : [],
    ),
  ).toEqual([["a", "m", "z"]]);
});
