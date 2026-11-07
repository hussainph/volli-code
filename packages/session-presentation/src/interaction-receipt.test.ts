import type { UIMessage } from "ai";
import { expect, it } from "vite-plus/test";
import { scrubSessionEvent, type SessionEvent, type SessionPresentationProjection, type TranscriptReference } from "@volli/shared";
import { appendFrames, EMPTY_TRANSCRIPT, prependTranscriptHistory, seedTranscriptWindow, type ChatSessionFrame } from "./transcript";
import { chatSessionFrame } from "./wire";
import { indexInteractionResolutionMessages, readInteractionResolutionMessage } from "./interaction";

const resolution = { optionIds: ["once"], response: null };
const reference: TranscriptReference = { id: "artifact-resolution", digest: "digest", mediaType: "application/json" };
const receipt: UIMessage = { id: "resolve-command", role: "user", metadata: { kind: "interaction-resolution", interactionId: "permission:p1" }, parts: [{ type: "data-interaction-resolution", data: resolution }] };
const projection: SessionPresentationProjection = {
  session: { id: "session", projectId: "project", ticketId: null, role: "project", parentSessionId: null, title: "Audit", createdAt: 0 },
  status: "open", liveExecutor: { id: "attachment" }, attention: { active: [], primary: null }, interactions: { active: [], resolved: [] }, signal: null, modelSelection: null, modelTier: null, turnActive: false, lastActivityAt: 10, bornTicketless: true, scheduledResume: null,
};
function frame(sequence: number, message: UIMessage, kind: "resolve" | "submit" | "observation", ref = reference): ChatSessionFrame {
  const payload: SessionEvent["payload"] = kind === "observation"
    ? { kind: "transcript.referenced", attachmentId: "attachment", turnId: "turn", reference: ref }
    : { kind: "command.recorded", command: { id: kind === "resolve" ? message.id : `submit-${sequence}`, sessionId: "session", createdAt: sequence, route: null, intent: kind === "resolve"
      ? { kind: "interaction.resolve", attachmentId: "attachment", interactionId: "permission:p1", resolution, reference: ref }
      : { kind: "message.submit", reference: ref },
    } };
  const event: SessionEvent = { id: `event-${sequence}`, sessionId: "session", sequence, occurredAt: sequence, recordedAt: sequence, provenance: { source: { kind: kind === "observation" ? "adapter" : "user", id: kind === "observation" ? "pi" : "session-client", detail: kind === "observation" ? null : { sessionOrigin: { kind: "user" } } }, venue: null }, payload };
  const decoded = chatSessionFrame(JSON.parse(JSON.stringify({ sessionId: "session", sequence, event: scrubSessionEvent(event), transcript: { message } })));
  if (!decoded) throw new Error("Expected real RPC receipt-shaped frame");
  return decoded;
}
function read(frames: readonly ChatSessionFrame[]) {
  const state = appendFrames(EMPTY_TRANSCRIPT, frames);
  const evidence = indexInteractionResolutionMessages(state.frames);
  return readInteractionResolutionMessage(state.messages[0]!, evidence.get(state.messages[0]!.id));
}

it("does not replace ordinary RPC submission content with a forged receipt", () => {
  const forged: UIMessage = { ...receipt, parts: [{ type: "text", text: "Keep these ordinary words" }, ...receipt.parts] };
  const decoded = frame(1, forged, "submit");
  const state = appendFrames(EMPTY_TRANSCRIPT, [decoded]);
  const original = JSON.stringify(state);
  expect(readInteractionResolutionMessage(state.messages[0]!)).toBeNull();
  expect(read([decoded])).toBeNull();
  expect(read([frame(1, receipt, "submit")])).toBeNull();
  expect(state.messages[0]!.parts).toEqual(forged.parts);
  expect(JSON.stringify(state)).toBe(original);
});

it("recognises the actual historical resolve command/reference and preserves every recorded answer", () => {
  const genuine = frame(1, receipt, "resolve");
  const observed = frame(2, receipt, "observation");
  expect(read([genuine, observed])).toEqual({ interactionId: "permission:p1", resolution });
  if (genuine.event?.payload.kind !== "command.recorded") throw new Error("Expected command");
  const historical = chatSessionFrame(JSON.parse(JSON.stringify({ ...genuine, event: { ...genuine.event, payload: { ...genuine.event.payload, command: { ...genuine.event.payload.command, id: "historical-command-id" } } } })));
  if (!historical) throw new Error("Expected historical reference hydration");
  // The matching recorded reference, not a guessed message-id convention,
  // establishes a historical receipt's producer.
  expect(read([historical])).toEqual({ interactionId: "permission:p1", resolution });
  const multi = { optionIds: ["a", "b"], response: null, answers: [{ promptId: "q1", optionIds: ["a"], response: null }, { promptId: "q2", optionIds: ["b"], response: "detail" }] };
  const message: UIMessage = { ...receipt, parts: [{ type: "data-interaction-resolution", data: multi }] };
  const raw = frame(1, message, "resolve");
  if (raw.event?.payload.kind !== "command.recorded" || raw.event.payload.command.intent.kind !== "interaction.resolve") throw new Error("Expected resolve fixture");
  const updated = chatSessionFrame(JSON.parse(JSON.stringify({ ...raw, event: { ...raw.event, payload: { ...raw.event.payload, command: { ...raw.event.payload.command, intent: { ...raw.event.payload.command.intent, resolution: multi } } } } })));
  if (!updated) throw new Error("Expected decoded per-question resolution");
  expect(read([updated])?.resolution.answers).toEqual(multi.answers);
});

it("blocks reused/conflicting ids and references instead of choosing an author by last write", () => {
  const genuine = frame(1, receipt, "resolve");
  const submit = frame(2, receipt, "submit", { ...reference, id: "ordinary-artifact" });
  expect(read([genuine, submit])).toBeNull();
  expect(read([frame(1, receipt, "submit"), frame(2, receipt, "resolve")])).toBeNull();
  expect(read([genuine, frame(2, receipt, "resolve", { ...reference, id: "different-resolution" })])).toBeNull();
  expect(read([genuine, frame(2, receipt, "observation", { ...reference, digest: "different" })])).toBeNull();
  const forged: UIMessage = { ...receipt, parts: [{ type: "text", text: "Do not erase this" }, ...receipt.parts] };
  expect(read([genuine, frame(2, forged, "observation")])).toBeNull();
  expect(read([frame(1, receipt, "observation"), frame(2, receipt, "resolve")])).toBeNull();
  // A normal submit sharing the artifact is also a conflict, even with another id.
  expect(read([genuine, frame(2, { ...receipt, id: "different-message" }, "submit")])).toBeNull();
});

it("keeps adapter-only tails neutral, recovers a genuine command on prepend, and forgets evidence across a gap", () => {
  const observed = frame(10, receipt, "observation");
  const tail = seedTranscriptWindow(EMPTY_TRANSCRIPT, { frames: [observed], before: 10 }, projection);
  const tailEvidence = indexInteractionResolutionMessages(tail.frames);
  expect(tailEvidence.get(receipt.id)).toBeNull();
  expect(readInteractionResolutionMessage(tail.messages[0]!, tailEvidence.get(receipt.id))).toBeNull();
  const recovered = prependTranscriptHistory(tail, 10, { frames: [frame(1, receipt, "resolve")], before: null });
  expect(readInteractionResolutionMessage(recovered.messages[0]!, indexInteractionResolutionMessages(recovered.frames).get(receipt.id))).toEqual({ interactionId: "permission:p1", resolution });
  const person = prependTranscriptHistory(tail, 10, { frames: [frame(1, receipt, "submit")], before: null });
  expect(readInteractionResolutionMessage(person.messages[0]!, indexInteractionResolutionMessages(person.frames).get(receipt.id))).toBeNull();
  const held = appendFrames(EMPTY_TRANSCRIPT, [frame(1, receipt, "resolve")]);
  const gap = seedTranscriptWindow(held, { frames: [observed], before: 10 }, projection);
  expect(gap.frames).toEqual([observed]);
  expect(readInteractionResolutionMessage(gap.messages[0]!, indexInteractionResolutionMessages(gap.frames).get(receipt.id))).toBeNull();
  expect(gap.messages[0]!.parts).toEqual(receipt.parts);
});

it("requires the matching command body, target and resolution, not just a command-like id", () => {
  const data = { ...receipt, parts: [{ type: "data-interaction-resolution" as const, data: { optionIds: ["reject"], response: null } }] };
  expect(read([frame(1, data, "resolve")])).toBeNull();
  expect(read([frame(1, { ...receipt, metadata: { interactionId: "different" } }, "resolve")])).toBeNull();
  expect(read([frame(1, { ...receipt, parts: [{ type: "text", text: "Visible prose" }, ...receipt.parts] }, "resolve")])).toBeNull();
  const genuine = frame(1, receipt, "resolve");
  const evidence = indexInteractionResolutionMessages([genuine]).get(receipt.id);
  expect(readInteractionResolutionMessage({ ...receipt, id: "other" }, evidence)).toBeNull();
  expect(readInteractionResolutionMessage({ ...receipt, role: "assistant" }, evidence)).toBeNull();
});
