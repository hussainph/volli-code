// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import type { UIMessage } from "ai";
import {
  scrubSessionEvent,
  type RendererSessionInteraction,
  type SessionEvent,
} from "@volli/shared";
import {
  appendFrames,
  EMPTY_TRANSCRIPT,
  chatSessionFrame,
  indexInteractionResolutionMessages,
  type ChatSessionFrame,
} from "@volli/session-presentation";
import { ChatTurn, type TurnContext } from "./chat-plane";

const interaction: RendererSessionInteraction = {
  id: "permission:p1",
  attachmentId: "attachment",
  kind: "permission",
  title: "Read DESIGN.md",
  detail: null,
  options: [{ id: "once", label: "Allow once", description: null }],
  multiple: false,
  native: { id: null, detail: null },
};
const resolution = { optionIds: ["once"], response: null };
const message: UIMessage = {
  id: "resolve-command",
  role: "user",
  metadata: { kind: "interaction-resolution", interactionId: interaction.id },
  parts: [{ type: "data-interaction-resolution", data: resolution }],
};
function factFrame(sequence: number, payload: SessionEvent["payload"]): ChatSessionFrame {
  const event: SessionEvent = {
    id: `event-${sequence}`,
    sessionId: "session",
    sequence,
    occurredAt: sequence,
    recordedAt: sequence,
    attachmentId: "attachment",
    provenance: { source: { kind: "adapter", id: "pi", detail: null }, venue: null },
    payload,
  };
  const decoded = chatSessionFrame(
    JSON.parse(
      JSON.stringify({
        sessionId: "session",
        sequence,
        event: scrubSessionEvent(event),
        transcript: null,
      }),
    ),
  );
  if (!decoded) throw new Error("Expected actual RPC/codec frame");
  return decoded;
}
/** What the engine and adapter record around an answer the runtime took. */
function settled(sequence: number, status: "accepted" | "rejected" = "accepted") {
  const receipt =
    status === "accepted"
      ? {
          id: "receipt",
          commandId: message.id,
          sequence: sequence + 3,
          recordedAt: sequence + 3,
          status,
          acceptedAt: sequence + 3,
          result: { kind: "interaction.resolved" as const, sessionId: "session" },
        }
      : {
          id: "receipt",
          commandId: message.id,
          sequence: sequence + 3,
          recordedAt: sequence + 3,
          status,
          code: "PI_INTERACTION_NOT_RECORDED",
          detail: null,
        };
  return [
    factFrame(sequence, {
      kind: "interaction.opened",
      interaction: { ...interaction, native: { id: null, detail: null } },
    }),
    frame(sequence + 1, message, "resolve"),
    factFrame(sequence + 2, {
      kind: "interaction.resolved",
      attachmentId: "attachment",
      interactionId: interaction.id,
      resolution,
    }),
    factFrame(sequence + 3, { kind: "command.receipt.recorded", receipt }),
  ];
}
function frame(
  sequence: number,
  held: UIMessage,
  kind: "submit" | "resolve" | "observation",
): ChatSessionFrame {
  const reference = {
    id: `artifact-${kind === "submit" ? "ordinary" : "resolution"}`,
    digest: null,
    mediaType: null,
  };
  const event: SessionEvent = {
    id: `event-${sequence}`,
    sessionId: "session",
    sequence,
    occurredAt: sequence,
    recordedAt: sequence,
    provenance: {
      source: { kind: kind === "observation" ? "adapter" : "user", id: "fixture", detail: null },
      venue: null,
    },
    payload:
      kind === "observation"
        ? { kind: "transcript.referenced", attachmentId: "attachment", turnId: "turn", reference }
        : {
            kind: "command.recorded",
            command: {
              id: kind === "resolve" ? held.id : `submit-${sequence}`,
              sessionId: "session",
              createdAt: sequence,
              route:
                kind === "resolve" ? { adapterId: "pi", attachmentId: "attachment" } : null,
              intent:
                kind === "resolve"
                  ? {
                      kind: "interaction.resolve",
                      attachmentId: "attachment",
                      interactionId: interaction.id,
                      resolution,
                      reference,
                    }
                  : { kind: "message.submit", reference },
            },
          },
  };
  const decoded = chatSessionFrame(
    JSON.parse(
      JSON.stringify({
        sessionId: "session",
        sequence,
        event: scrubSessionEvent(event),
        transcript: { message: held },
      }),
    ),
  );
  if (!decoded) throw new Error("Expected actual RPC/codec frame");
  return decoded;
}
function render(
  frames: readonly ChatSessionFrame[],
  opened: boolean | RendererSessionInteraction = true,
) {
  const state = appendFrames(EMPTY_TRANSCRIPT, frames);
  const known = opened === true ? interaction : opened === false ? null : opened;
  const context: TurnContext = {
    onOpenFile: () => {},
    interactions: known ? new Map([[known.id, known]]) : new Map(),
    interactionReceipts: indexInteractionResolutionMessages(state.frames),
  };
  return renderToStaticMarkup(
    <ChatTurn messages={state.messages} context={context} live={false} />,
  );
}

it.each([true, false])(
  "preserves forged normal submission prose and Original output with interaction available=%s",
  (opened) => {
    const forged: UIMessage = {
      ...message,
      parts: [{ type: "text", text: "Keep this ordinary prose" }, ...message.parts],
    };
    const html = render([frame(1, forged, "submit")], opened);
    expect(html).toContain("is-user");
    expect(html).toContain("Keep this ordinary prose");
    expect(html).toContain("Original output");
    expect(html).not.toContain(">Allowed<");
  },
);

it("renders a settled recorded resolution when its interaction is known and never drops the unknown one", () => {
  const frames = settled(1);
  const genuine = render(frames);
  expect(genuine).not.toContain("is-user");
  expect(genuine).toContain("Read DESIGN.md");
  expect(genuine).toContain("Original output");
  const unavailable = render(frames, false);
  expect(unavailable).toContain("is-user");
  expect(unavailable).toContain("Interaction record");
  expect(unavailable).toContain("Original output");
  expect(unavailable).not.toContain(">Allowed<");
});

it("keeps adapter-only and reused-id history neutral rather than producing a false receipt", () => {
  const tail = render([frame(10, message, "observation")]);
  expect(tail).toContain("is-user");
  expect(tail).toContain("Interaction record");
  expect(tail).toContain("Original output");
  const reused = render([...settled(1), frame(5, message, "submit")]);
  expect(reused).toContain("is-user");
  expect(reused).toContain("Interaction record");
  expect(reused).toContain("Original output");
  expect(reused).not.toContain(">Allowed<");
});

it("draws refused, unsettled and other-attachment answers as neutral records, never Allowed", () => {
  for (const frames of [
    settled(1, "rejected"),
    [frame(1, message, "resolve")],
    settled(1).slice(0, 3),
  ]) {
    const html = render(frames);
    expect(html).toContain("is-user");
    expect(html).toContain("Interaction record");
    expect(html).toContain("Original output");
    expect(html).not.toContain(">Allowed<");
  }
  const elsewhere = render(settled(1), { ...interaction, attachmentId: "attachment-old" });
  expect(elsewhere).toContain("Interaction record");
  expect(elsewhere).not.toContain(">Allowed<");
});
