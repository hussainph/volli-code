import { describe, expect, it } from "vite-plus/test";

import {
  signInPromptIsSecret,
  signInUpdateIsFinal,
  type ModelAccessSignInPrompt,
  type ModelAccessSignInUpdate,
} from "./model-access-sign-in";

function step(kind: ModelAccessSignInPrompt["kind"]): ModelAccessSignInPrompt {
  return { promptId: "p1", kind, message: "Enter it", placeholder: null, options: [] };
}

describe("sign-in step secrecy", () => {
  it("treats only a secret step's answer as a credential", () => {
    expect(signInPromptIsSecret(step("secret"))).toBe(true);
    expect(signInPromptIsSecret(step("text"))).toBe(false);
    expect(signInPromptIsSecret(step("select"))).toBe(false);
  });

  it("leaves a manual code visible, because masking a transcribed value only hides typos", () => {
    // An OAuth authorization code is single-use and already on screen in the
    // browser it was copied from; masking it protects nothing and costs the one
    // check a person can make — reading back what they pasted.
    expect(signInPromptIsSecret(step("manual-code"))).toBe(false);
  });
});

describe("sign-in attempt endings", () => {
  const attemptId = "a1";

  it("treats every settled verdict as the end, whichever verdict it is", () => {
    const endings: readonly ModelAccessSignInUpdate[] = [
      { attemptId, kind: "settled", outcome: { kind: "signed-in" } },
      { attemptId, kind: "settled", outcome: { kind: "cancelled" } },
      { attemptId, kind: "settled", outcome: { kind: "failed", message: "Refused." } },
    ];
    for (const ending of endings) expect(signInUpdateIsFinal(ending)).toBe(true);
  });

  it("treats a question, a withdrawal and a progress note as the attempt continuing", () => {
    const middles: readonly ModelAccessSignInUpdate[] = [
      { attemptId, kind: "prompt", prompt: step("secret") },
      { attemptId, kind: "prompt-withdrawn", promptId: "p1" },
      { attemptId, kind: "event", event: { kind: "progress", message: "Exchanging…" } },
    ];
    for (const middle of middles) expect(signInUpdateIsFinal(middle)).toBe(false);
  });
});
