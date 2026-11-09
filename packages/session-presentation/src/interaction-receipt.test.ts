import type { UIMessage } from "ai";
import { expect, it } from "vite-plus/test";
import {
  cloudInteractionArtifact,
  cloudInteractionResolve,
  scrubSessionEvent,
  type CommandReceipt,
  type RunnerIdentity,
  type SessionEvent,
  type SessionInteractionResolution,
  type SessionPresentationProjection,
  type TranscriptReference,
} from "@volli/shared";
import {
  appendFrames,
  EMPTY_TRANSCRIPT,
  prependTranscriptHistory,
  seedTranscriptWindow,
  type ChatSessionFrame,
} from "./transcript";
import { chatSessionFrame } from "./wire";
import {
  indexInteractionResolutionMessages,
  readInteractionResolutionMessage,
} from "./interaction";

const resolution = { optionIds: ["once"], response: null };
const reference: TranscriptReference = {
  id: "artifact-resolution",
  digest: "digest",
  mediaType: "application/json",
};
const receipt: UIMessage = {
  id: "resolve-command",
  role: "user",
  metadata: { kind: "interaction-resolution", interactionId: "permission:p1" },
  parts: [{ type: "data-interaction-resolution", data: resolution }],
};
const projection: SessionPresentationProjection = {
  session: {
    id: "session",
    projectId: "project",
    ticketId: null,
    role: "project",
    parentSessionId: null,
    title: "Audit",
    createdAt: 0,
  },
  status: "open",
  liveExecutor: { id: "attachment" },
  attention: { active: [], primary: null },
  interactions: { active: [], resolved: [] },
  signal: null,
  modelSelection: null,
  modelTier: null,
  turnActive: false,
  lastActivityAt: 10,
  bornTicketless: true,
  scheduledResume: null,
};
interface FrameOptions {
  commandId?: string;
  resolution?: SessionInteractionResolution;
  attachmentId?: string;
  routeAttachmentId?: string | null;
  venue?: RunnerIdentity | null;
}
function decode(
  sequence: number,
  payload: SessionEvent["payload"],
  message: UIMessage | null,
  envelope: {
    source: "user" | "adapter";
    venue?: RunnerIdentity | null;
    attachmentId?: string | null;
    commandId?: string;
  },
): ChatSessionFrame {
  const event: SessionEvent = {
    id: `event-${sequence}`,
    sessionId: "session",
    sequence,
    occurredAt: sequence,
    recordedAt: sequence,
    ...(envelope.attachmentId == null ? {} : { attachmentId: envelope.attachmentId }),
    ...(envelope.commandId === undefined ? {} : { commandId: envelope.commandId }),
    provenance: {
      source: {
        kind: envelope.source,
        id: envelope.source === "adapter" ? "pi" : "session-client",
        detail: envelope.source === "adapter" ? null : { sessionOrigin: { kind: "user" } },
      },
      venue: envelope.venue ?? null,
    },
    payload,
  };
  const decoded = chatSessionFrame(
    JSON.parse(
      JSON.stringify({
        sessionId: "session",
        sequence,
        event: scrubSessionEvent(event),
        transcript: message ? { message } : null,
      }),
    ),
  );
  if (!decoded) throw new Error("Expected real RPC receipt-shaped frame");
  return decoded;
}
function frame(
  sequence: number,
  message: UIMessage,
  kind: "resolve" | "submit" | "observation",
  ref = reference,
  options: FrameOptions = {},
): ChatSessionFrame {
  const attachmentId = options.attachmentId ?? "attachment";
  const payload: SessionEvent["payload"] =
    kind === "observation"
      ? {
          kind: "transcript.referenced",
          attachmentId: "attachment",
          turnId: "turn",
          reference: ref,
        }
      : {
          kind: "command.recorded",
          command: {
            id: kind === "resolve" ? (options.commandId ?? message.id) : `submit-${sequence}`,
            sessionId: "session",
            createdAt: sequence,
            route:
              kind === "resolve" && options.routeAttachmentId !== null
                ? { adapterId: "pi", attachmentId: options.routeAttachmentId ?? attachmentId }
                : null,
            intent:
              kind === "resolve"
                ? {
                    kind: "interaction.resolve",
                    attachmentId,
                    interactionId: "permission:p1",
                    resolution: options.resolution ?? resolution,
                    reference: ref,
                  }
                : { kind: "message.submit", reference: ref },
          },
        };
  return decode(sequence, payload, message, {
    source: kind === "observation" ? "adapter" : "user",
    venue: options.venue,
  });
}
function opened(
  sequence: number,
  attachmentId = "attachment",
  venue: RunnerIdentity | null = null,
) {
  return decode(
    sequence,
    {
      kind: "interaction.opened",
      interaction: {
        id: "permission:p1",
        attachmentId,
        kind: "permission",
        title: "Read DESIGN.md",
        detail: null,
        options: [
          { id: "once", label: "Allow once", description: null },
          { id: "reject", label: "Deny", description: null },
        ],
        multiple: false,
        native: { id: null, detail: null },
      },
    },
    null,
    { source: "adapter", venue, attachmentId },
  );
}
function resolvedFact(
  sequence: number,
  answer: SessionInteractionResolution = resolution,
  attachmentId = "attachment",
  venue: RunnerIdentity | null = null,
  commandId?: string,
) {
  return decode(
    sequence,
    {
      kind: "interaction.resolved",
      attachmentId,
      interactionId: "permission:p1",
      resolution: answer,
    },
    null,
    { source: "adapter", venue, attachmentId, ...(commandId === undefined ? {} : { commandId }) },
  );
}
function cancelledFact(sequence: number) {
  return decode(
    sequence,
    {
      kind: "interaction.cancelled",
      attachmentId: "attachment",
      interactionId: "permission:p1",
      reason: "withdrawn",
    },
    null,
    { source: "user", attachmentId: "attachment" },
  );
}
type ReceiptStatus = "accepted" | "completed" | "rejected" | "unreconciled";
function receiptFrame(
  sequence: number,
  commandId: string,
  status: ReceiptStatus,
  options: {
    code?: string;
    resultKind?: "interaction.resolved" | "message.submitted";
    attachmentId?: string | null;
    venue?: RunnerIdentity | null;
  } = {},
) {
  const base = { id: `receipt-${sequence}`, commandId, sequence, recordedAt: sequence };
  const result = {
    kind: options.resultKind ?? "interaction.resolved",
    sessionId: "session",
  } as const;
  const recorded: CommandReceipt =
    status === "accepted"
      ? { ...base, status, acceptedAt: sequence, result }
      : status === "completed"
        ? { ...base, status, result }
        : status === "rejected"
          ? { ...base, status, code: options.code ?? "PI_INTERACTION_NOT_RECORDED", detail: null }
          : { ...base, status, detail: null };
  return decode(sequence, { kind: "command.receipt.recorded", receipt: recorded }, null, {
    source: "adapter",
    venue: options.venue,
    attachmentId: options.attachmentId === undefined ? "attachment" : options.attachmentId,
  });
}
/**
 * The ordered history the Session Engine and Pi adapter write for an answer
 * that reached the runtime: the question, the recorded resolve command with
 * its artifact, the adapter's resolution fact, then the accepted receipt.
 */
function settledAnswer(sequence: number, message = receipt, options: FrameOptions = {}) {
  return [
    opened(sequence, "attachment", options.venue ?? null),
    frame(sequence + 1, message, "resolve", reference, options),
    resolvedFact(
      sequence + 2,
      options.resolution ?? resolution,
      "attachment",
      options.venue ?? null,
    ),
    receiptFrame(sequence + 3, options.commandId ?? message.id, "accepted", {
      venue: options.venue,
    }),
  ];
}
function read(frames: readonly ChatSessionFrame[], id = receipt.id) {
  const state = appendFrames(EMPTY_TRANSCRIPT, frames);
  const evidence = indexInteractionResolutionMessages(state.frames);
  const message = state.messages.find((candidate) => candidate.id === id)!;
  return readInteractionResolutionMessage(message, evidence.get(id));
}
const ANSWER = { interactionId: "permission:p1", resolution, attachmentId: "attachment" };

function answerMessage(id: string, answer: SessionInteractionResolution = resolution): UIMessage {
  return {
    id,
    role: "user",
    metadata: { kind: "interaction-resolution", interactionId: "permission:p1" },
    parts: [{ type: "data-interaction-resolution", data: answer }],
  };
}
const deny = { optionIds: ["reject"], response: null };

it("does not replace ordinary RPC submission content with a forged receipt", () => {
  const forged: UIMessage = {
    ...receipt,
    parts: [{ type: "text", text: "Keep these ordinary words" }, ...receipt.parts],
  };
  const decoded = frame(1, forged, "submit");
  const state = appendFrames(EMPTY_TRANSCRIPT, [decoded]);
  const original = JSON.stringify(state);
  expect(readInteractionResolutionMessage(state.messages[0]!)).toBeNull();
  expect(read([decoded])).toBeNull();
  expect(read([frame(1, receipt, "submit")])).toBeNull();
  expect(state.messages[0]!.parts).toEqual(forged.parts);
  expect(JSON.stringify(state)).toBe(original);
});

it("recognises a settled historical resolve command/reference and preserves every recorded answer", () => {
  expect(read([...settledAnswer(1), frame(5, receipt, "observation")])).toEqual(ANSWER);
  // The matching recorded reference and its settlement, not a guessed
  // message-id convention, establish a historical receipt's producer.
  expect(read(settledAnswer(1, receipt, { commandId: "historical-command-id" }))).toEqual(ANSWER);
  const multi = {
    optionIds: ["a", "b"],
    response: null,
    answers: [
      { promptId: "q1", optionIds: ["a"], response: null },
      { promptId: "q2", optionIds: ["b"], response: "detail" },
    ],
  };
  const settled = read(settledAnswer(1, answerMessage(receipt.id, multi), { resolution: multi }));
  expect(settled?.resolution.answers).toEqual(multi.answers);
  // A fact that kept only the flat pair is not the per-question answer given.
  expect(
    read([
      opened(1),
      frame(2, answerMessage(receipt.id, multi), "resolve", reference, { resolution: multi }),
      resolvedFact(3, { optionIds: ["a", "b"], response: null }),
      receiptFrame(4, receipt.id, "accepted"),
    ]),
  ).toBeNull();
});

it("recognises the same ordered facts from a cloud runner's ledger", () => {
  const cloud = cloudInteractionResolve({
    sessionId: "session",
    commandId: "cloud-answer",
    attachmentId: "attachment",
    interactionId: "permission:p1",
    resolution,
  });
  const message = cloudInteractionArtifact({
    sessionId: "session",
    commandId: "cloud-answer",
    interactionId: "permission:p1",
    resolution,
  }).message as UIMessage;
  const venue: RunnerIdentity = { id: "runner-1", kind: "cloud" };
  const frames = [
    opened(1, "attachment", venue),
    frame(2, message, "resolve", cloud.reference, { venue }),
    resolvedFact(3, resolution, "attachment", venue),
    receiptFrame(4, "cloud-answer", "accepted", { venue }),
  ];
  expect(read(frames, "cloud-answer")).toEqual(ANSWER);
  // A queued cloud answer whose runner has not answered yet is not an answer.
  expect(read(frames.slice(0, 2), "cloud-answer")).toBeNull();
});

it("never credits a refused first answer, whether the accepted retry chose differently or the same", () => {
  const first = answerMessage("answer-a");
  const history = (retry: SessionInteractionResolution) => [
    opened(1),
    frame(2, first, "resolve"),
    receiptFrame(3, "answer-a", "rejected", { code: "PI_INTERACTION_NOT_RECORDED" }),
    frame(4, answerMessage("answer-b", retry), "resolve", reference, { resolution: retry }),
    resolvedFact(5, retry),
    receiptFrame(6, "answer-b", "accepted"),
  ];
  expect(read(history(deny), "answer-a")).toBeNull();
  expect(read(history(deny), "answer-b")).toEqual({ ...ANSWER, resolution: deny });
  expect(read(history(resolution), "answer-a")).toBeNull();
  expect(read(history(resolution), "answer-b")).toEqual(ANSWER);
  // An earlier attempt with no receipt at all earns no credit from a later one.
  const silent = [
    opened(1),
    frame(2, first, "resolve"),
    frame(3, answerMessage("answer-b"), "resolve"),
    resolvedFact(4),
    receiptFrame(5, "answer-b", "accepted"),
  ];
  expect(read(silent, "answer-a")).toBeNull();
  expect(read(silent, "answer-b")).toEqual(ANSWER);
});

it("keeps rejected, unknown, cancelled and delivery-uncertain answers neutral", () => {
  // The withdrawal won the claim after the fact committed: recorded, not delivered.
  expect(
    read([
      opened(1),
      frame(2, receipt, "resolve"),
      resolvedFact(3),
      receiptFrame(4, receipt.id, "rejected", { code: "PI_INTERACTION_UNKNOWN" }),
    ]),
  ).toBeNull();
  // Cancelled before it was answered: the engine refuses the late answer.
  expect(
    read([
      opened(1),
      cancelledFact(2),
      frame(3, receipt, "resolve", reference, { routeAttachmentId: null }),
      // The engine's own refusal: no route, so its receipt names no attachment.
      receiptFrame(4, receipt.id, "rejected", {
        code: "interaction_unavailable",
        attachmentId: null,
      }),
    ]),
  ).toBeNull();
  // A cancellation beside an apparently settled answer is a contradiction.
  expect(read([...settledAnswer(1), cancelledFact(5)])).toBeNull();
  expect(read([opened(1), cancelledFact(2), ...settledAnswer(2).slice(1)])).toBeNull();
  // Uncertain delivery stays uncertain until a terminal receipt settles it.
  const pending = [opened(1), frame(2, receipt, "resolve"), resolvedFact(3)];
  expect(read([...pending, receiptFrame(4, receipt.id, "unreconciled")])).toBeNull();
  expect(
    read([
      ...pending,
      receiptFrame(4, receipt.id, "unreconciled"),
      receiptFrame(5, receipt.id, "accepted"),
    ]),
  ).toEqual(ANSWER);
  expect(
    read([
      ...pending,
      receiptFrame(4, receipt.id, "unreconciled"),
      receiptFrame(5, receipt.id, "rejected"),
    ]),
  ).toBeNull();
  expect(read([...settledAnswer(1), receiptFrame(5, receipt.id, "rejected")])).toBeNull();
  expect(read([...settledAnswer(1), receiptFrame(5, receipt.id, "completed")])).toEqual(ANSWER);
});

it("requires the question, fact, route and receipt on the command's own attachment", () => {
  const [, command, fact, accepted] = settledAnswer(1);
  expect(read([opened(1, "attachment-old"), command!, fact!, accepted!])).toBeNull();
  expect(
    read([opened(1), command!, resolvedFact(3, resolution, "attachment-old"), accepted!]),
  ).toBeNull();
  expect(
    read([
      opened(1),
      command!,
      fact!,
      receiptFrame(4, receipt.id, "accepted", { attachmentId: "x" }),
    ]),
  ).toBeNull();
  expect(
    read([
      opened(1),
      frame(2, receipt, "resolve", reference, { routeAttachmentId: "attachment-old" }),
      fact!,
      accepted!,
    ]),
  ).toBeNull();
  expect(
    read([
      opened(1),
      frame(2, receipt, "resolve", reference, { routeAttachmentId: null }),
      fact!,
      accepted!,
    ]),
  ).toBeNull();
});

it("keeps absent, partial, out-of-order and contradictory settlement neutral", () => {
  const [open, command, fact, accepted] = settledAnswer(1);
  expect(read([command!])).toBeNull();
  expect(read([open!, command!])).toBeNull();
  expect(read([open!, command!, fact!])).toBeNull();
  expect(read([open!, command!, accepted!])).toBeNull();
  // A tail window that starts after the question opened cannot prove it.
  expect(read([command!, fact!, accepted!])).toBeNull();
  // The fact must answer what the command said, after it was said.
  expect(read([open!, command!, resolvedFact(3, deny), accepted!])).toBeNull();
  expect(read([open!, resolvedFact(2), frame(3, receipt, "resolve"), accepted!])).toBeNull();
  expect(read([...settledAnswer(1), resolvedFact(5, deny)])).toBeNull();
  // A receipt for another verb, or recorded before the command, settles nothing.
  expect(
    read([
      open!,
      command!,
      fact!,
      receiptFrame(4, receipt.id, "accepted", { resultKind: "message.submitted" }),
    ]),
  ).toBeNull();
  expect(
    read([
      open!,
      receiptFrame(2, receipt.id, "accepted"),
      frame(3, receipt, "resolve"),
      resolvedFact(4),
    ]),
  ).toBeNull();
  // A fact attributed to this command still settles it; to another, never.
  expect(
    read([open!, command!, resolvedFact(3, resolution, "attachment", null, receipt.id), accepted!]),
  ).toEqual(ANSWER);
  expect(
    read([open!, command!, resolvedFact(3, resolution, "attachment", null, "other"), accepted!]),
  ).toBeNull();
  // A receipt with no attachment on its envelope is not a contradiction.
  expect(
    read([open!, command!, fact!, receiptFrame(4, receipt.id, "accepted", { attachmentId: null })]),
  ).toEqual(ANSWER);
  // A kind this build does not know is skipped, not read as settlement.
  const future = chatSessionFrame({
    sessionId: "session",
    sequence: 5,
    event: {
      ...JSON.parse(JSON.stringify(accepted!.event)),
      sequence: 5,
      id: "future",
      payload: { kind: "future.fact" },
    },
    transcript: null,
  });
  expect(future?.event).toBeNull();
  expect(read([...settledAnswer(1), future!])).toEqual(ANSWER);
  // Two delivered answers to one question: neither is credited.
  const twice = [
    opened(1),
    frame(2, answerMessage("answer-a"), "resolve"),
    frame(3, answerMessage("answer-b"), "resolve"),
    resolvedFact(4),
    receiptFrame(5, "answer-a", "accepted"),
    receiptFrame(6, "answer-b", "accepted"),
  ];
  expect(read(twice, "answer-a")).toBeNull();
  expect(read(twice, "answer-b")).toBeNull();
  // The same command id recorded with two different answers is corruption.
  expect(
    read([...settledAnswer(1), frame(5, receipt, "resolve", reference, { resolution: deny })]),
  ).toBeNull();
});

it("blocks reused/conflicting ids and references instead of choosing an author by last write", () => {
  const genuine = settledAnswer(1);
  const submit = frame(5, receipt, "submit", { ...reference, id: "ordinary-artifact" });
  expect(read([...genuine, submit])).toBeNull();
  expect(read([frame(1, receipt, "submit"), ...settledAnswer(2)])).toBeNull();
  expect(
    read([...genuine, frame(5, receipt, "resolve", { ...reference, id: "different-resolution" })]),
  ).toBeNull();
  expect(
    read([...genuine, frame(5, receipt, "observation", { ...reference, digest: "different" })]),
  ).toBeNull();
  const forged: UIMessage = {
    ...receipt,
    parts: [{ type: "text", text: "Do not erase this" }, ...receipt.parts],
  };
  expect(read([...genuine, frame(5, forged, "observation")])).toBeNull();
  expect(read([frame(1, receipt, "observation"), ...settledAnswer(2)])).toBeNull();
  // A normal submit sharing the artifact is also a conflict, even with another id.
  expect(
    read([...genuine, frame(5, { ...receipt, id: "different-message" }, "submit")]),
  ).toBeNull();
});

it("keeps adapter-only tails neutral, recovers a settled command on prepend, and forgets evidence across a gap", () => {
  const observed = frame(10, receipt, "observation");
  const tail = seedTranscriptWindow(
    EMPTY_TRANSCRIPT,
    { frames: [observed], before: 10 },
    projection,
  );
  const tailEvidence = indexInteractionResolutionMessages(tail.frames);
  expect(tailEvidence.get(receipt.id)).toBeNull();
  expect(
    readInteractionResolutionMessage(tail.messages[0]!, tailEvidence.get(receipt.id)),
  ).toBeNull();
  const recovered = prependTranscriptHistory(tail, 10, {
    frames: settledAnswer(1),
    before: null,
  });
  expect(
    readInteractionResolutionMessage(
      recovered.messages[0]!,
      indexInteractionResolutionMessages(recovered.frames).get(receipt.id),
    ),
  ).toEqual(ANSWER);
  const person = prependTranscriptHistory(tail, 10, {
    frames: [frame(1, receipt, "submit")],
    before: null,
  });
  expect(
    readInteractionResolutionMessage(
      person.messages[0]!,
      indexInteractionResolutionMessages(person.frames).get(receipt.id),
    ),
  ).toBeNull();
  const held = appendFrames(EMPTY_TRANSCRIPT, settledAnswer(1));
  const gap = seedTranscriptWindow(held, { frames: [observed], before: 10 }, projection);
  expect(gap.frames).toEqual([observed]);
  expect(
    readInteractionResolutionMessage(
      gap.messages[0]!,
      indexInteractionResolutionMessages(gap.frames).get(receipt.id),
    ),
  ).toBeNull();
  expect(gap.messages[0]!.parts).toEqual(receipt.parts);
});

it("keeps idempotent reference hydration while ignoring unrelated assistant frames", () => {
  const genuine = settledAnswer(1);
  const command = genuine[1]!;
  const duplicate = chatSessionFrame(
    JSON.parse(
      JSON.stringify({
        ...command,
        sequence: 5,
        event: { ...command.event, id: "replayed-command", sequence: 5 },
      }),
    ),
  );
  if (!duplicate) throw new Error("Expected duplicate hydration");
  const unrelated = frame(
    6,
    { id: "assistant", role: "assistant", parts: [{ type: "text", text: "Unrelated answer" }] },
    "observation",
  );
  expect(read([...genuine, duplicate, unrelated])).toEqual(ANSWER);
});

it("fails closed for unserialisable direct-call content without replacing it", () => {
  // RPC JSON cannot carry cycles; this separately proves reader totality for
  // an invalid in-memory caller instead of pretending it is a wire fixture.
  const cyclic: Record<string, unknown> = { interactionId: "permission:p1" };
  cyclic.self = cyclic;
  const malformed: UIMessage = { ...receipt, metadata: cyclic };
  const genuine = settledAnswer(1);
  const evidence = indexInteractionResolutionMessages(genuine).get(receipt.id);
  expect(evidence).not.toBeNull();
  expect(readInteractionResolutionMessage(malformed, evidence)).toBeNull();
  expect(
    indexInteractionResolutionMessages([
      genuine[0]!,
      { ...genuine[1]!, transcript: { message: malformed } },
      ...genuine.slice(2),
    ]).get(receipt.id),
  ).toBeNull();
  expect(malformed.metadata).toBe(cyclic);
});

it("requires the matching command body, target and resolution, not just a command-like id", () => {
  const data = {
    ...receipt,
    parts: [
      {
        type: "data-interaction-resolution" as const,
        data: { optionIds: ["reject"], response: null },
      },
    ],
  };
  expect(read(settledAnswer(1, data))).toBeNull();
  expect(
    read(settledAnswer(1, { ...receipt, metadata: { interactionId: "different" } })),
  ).toBeNull();
  expect(
    read(
      settledAnswer(1, {
        ...receipt,
        parts: [{ type: "text", text: "Visible prose" }, ...receipt.parts],
      }),
    ),
  ).toBeNull();
  const evidence = indexInteractionResolutionMessages(settledAnswer(1)).get(receipt.id);
  expect(readInteractionResolutionMessage({ ...receipt, id: "other" }, evidence)).toBeNull();
  expect(readInteractionResolutionMessage({ ...receipt, role: "assistant" }, evidence)).toBeNull();
});
