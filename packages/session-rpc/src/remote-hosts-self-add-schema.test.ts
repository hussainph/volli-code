import { describe, expect, it } from "vite-plus/test";
import { addHostEventSchema, hostAddAnswerInputSchema } from "./remote-hosts-schema";

const input = { flowId: "flow", questionId: "question" };

describe("the additive, closed self-add question", () => {
  it("uses the existing closed open answer without widening the wire vocabulary", () => {
    for (const kind of ["accept-host-key", "update", "adopt", "open", "user-install", "repair"]) {
      expect(hostAddAnswerInputSchema.safeParse({ ...input, answer: { kind } }).success).toBe(true);
    }
    for (const kind of ["add-anyway", "cancel", "maybe"]) {
      expect(hostAddAnswerInputSchema.safeParse({ ...input, answer: { kind } }).success).toBe(
        false,
      );
    }
    expect(
      hostAddAnswerInputSchema.safeParse({ ...input, answer: { kind: "open", confirm: true } })
        .success,
    ).toBe(false);
  });
  it("carries the self-add question through the existing JSON question envelope", () => {
    const question = { id: "question", kind: "self-add", step: "probe" };
    const event = {
      kind: "view",
      view: {
        flowId: "flow",
        target: "localhost",
        name: "localhost",
        status: "question",
        steps: [{ id: "probe", status: "running" }],
        question,
        failure: null,
        hostId: null,
        startup: null,
      },
    };
    expect(addHostEventSchema.parse(event)).toEqual(event);
  });
});
