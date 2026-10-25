import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vite-plus/test";

import {
  assertCloudInteractionReference,
  CLOUD_MESSAGE_MEDIA_TYPE,
  cloudInteractionArtifact,
  cloudInteractionResolve,
  cloudMessageArtifact,
  cloudMessageSubmit,
  readCloudMessageBody,
} from "./cloud-message-artifact";
import { INLINE_ARTIFACT_MAX_BYTES } from "./cloud/transcript-pack";
import { decodeSessionCommandIntent } from "./session-event-codec";

const scope = { sessionId: "s-1", commandId: "c-1" };
const message = {
  id: "m-1",
  role: "user" as const,
  parts: [{ type: "text", text: "Hello ✓" }],
};

describe("cloudMessageSubmit", () => {
  test("stages the runtime's artifact for the command, named by its digest", () => {
    const built = cloudMessageSubmit({ ...scope, message });
    const id = `sha256:${bytesToHex(sha256(utf8ToBytes(built.body)))}`;
    expect(built.reference).toEqual({ id, digest: id, mediaType: CLOUD_MESSAGE_MEDIA_TYPE });
    expect(JSON.parse(built.body)).toEqual({
      version: 1,
      threadId: "thread:s-1:root",
      branchId: "branch:s-1:main",
      attemptId: "attempt:c-1",
      turnId: "turn:c-1",
      message,
    });
    // Canonical: keys sorted at every depth.
    expect(built.body.startsWith('{"attemptId":"attempt:c-1","branchId"')).toBe(true);
    expect(decodeSessionCommandIntent(JSON.parse(built.intent), "intent")).toEqual({
      kind: "message.submit",
      reference: built.reference,
    });
    expect(cloudMessageSubmit({ ...scope, message })).toEqual(built);
    expect(cloudMessageArtifact({ ...scope, message }).message).toBe(message);
  });

  test("refuses a body past the inline limit", () => {
    const large = {
      ...message,
      parts: [{ type: "text", text: "x".repeat(INLINE_ARTIFACT_MAX_BYTES) }],
    };
    expect(() => cloudMessageSubmit({ ...scope, message: large })).toThrow("limited");
  });
});

describe("readCloudMessageBody", () => {
  const built = cloudMessageSubmit({ ...scope, message });
  const read = (body: string, reference = built.reference) =>
    readCloudMessageBody({ ...scope, reference, body });

  test("returns the artifact of a body that is this command's", () => {
    expect(read(built.body)).toEqual(cloudMessageArtifact({ ...scope, message }));
  });

  test("refuses every other body, naming no location", () => {
    const artifact = JSON.parse(built.body) as Record<string, unknown>;
    const withMessage = (patch: Record<string, unknown>) =>
      JSON.stringify({ ...artifact, message: { ...message, ...patch } });
    const cases: [string, string][] = [
      ["x".repeat(INLINE_ARTIFACT_MAX_BYTES + 1), "limited"],
      ["{", "not JSON"],
      ["[]", "not a transcript artifact"],
      ["null", "not a transcript artifact"],
      [JSON.stringify({ ...artifact, message: "text" }), "not a transcript artifact"],
      [withMessage({ id: 1 }), "not a user message"],
      [withMessage({ id: "" }), "not a user message"],
      [withMessage({ role: "assistant" }), "not a user message"],
      [withMessage({ parts: {} }), "not a user message"],
      [JSON.stringify(artifact, null, 1), "canonical artifact"],
      [cloudMessageSubmit({ ...scope, commandId: "c-2", message }).body, "canonical artifact"],
    ];
    for (const [body, reason] of cases) expect(() => read(body)).toThrow(reason);
  });

  test("refuses a body whose reference differs in any field", () => {
    const { reference } = built;
    for (const other of [
      { ...reference, id: "sha256:00" },
      { ...reference, digest: null },
      { ...reference, mediaType: "application/json" },
    ]) {
      expect(() => read(built.body, other)).toThrow("does not match its reference");
    }
  });
});

describe("cloudInteractionResolve", () => {
  const answer = {
    ...scope,
    attachmentId: "a-1",
    interactionId: "i-1",
    resolution: { optionIds: ["yes"], response: null },
  };

  test("names the runtime's resolution artifact and carries no body", () => {
    const built = cloudInteractionResolve(answer);
    expect(built).not.toHaveProperty("body");
    const intent = decodeSessionCommandIntent(JSON.parse(built.intent), "intent");
    expect(intent).toEqual({
      kind: "interaction.resolve",
      attachmentId: "a-1",
      interactionId: "i-1",
      resolution: answer.resolution,
      reference: built.reference,
    });
    expect(cloudInteractionArtifact(answer)).toMatchObject({
      turnId: null,
      message: { id: "c-1", role: "user", metadata: { interactionId: "i-1" } },
    });
    if (intent.kind !== "interaction.resolve") throw new Error("unreachable");
    expect(() => assertCloudInteractionReference(scope, intent)).not.toThrow();
    expect(() => assertCloudInteractionReference({ ...scope, commandId: "c-2" }, intent)).toThrow(
      "not this command's",
    );
  });

  test("hashes what the codec reads back, not what the caller passed", () => {
    const loose = {
      ...answer,
      resolution: { ...answer.resolution, extra: true } as typeof answer.resolution,
    };
    expect(cloudInteractionResolve(loose).reference).toEqual(
      cloudInteractionResolve(answer).reference,
    );
  });
});
