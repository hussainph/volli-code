import { describe, expect, it } from "vite-plus/test";
import { reasoningDropNoticeCopy } from "./reasoning-drop-notice";
import type { TranscriptReasoningDrop } from "./transcript";

function drop(count: number, causes: TranscriptReasoningDrop["causes"]): TranscriptReasoningDrop {
  return { sequence: 1, turnId: "turn-1", afterMessageId: "message-1", count, causes };
}

describe("reasoningDropNoticeCopy", () => {
  it("names a prefix edit separately from a provider model change", () => {
    expect(reasoningDropNoticeCopy(drop(1, ["prefix-mismatch"]))).toBe(
      "Earlier reasoning was dropped because the conversation prefix changed.",
    );
    expect(reasoningDropNoticeCopy(drop(2, ["model-mismatch"]))).toBe(
      "Earlier reasoning was dropped because the provider changed the model.",
    );
  });

  it("combines causes once and has an honest fallback", () => {
    expect(reasoningDropNoticeCopy(drop(3, ["prefix-mismatch", "model-mismatch"]))).toBe(
      "Earlier reasoning was dropped because the conversation prefix changed and the provider changed the model.",
    );
    expect(reasoningDropNoticeCopy(drop(1, []))).toBe(
      "Earlier reasoning was dropped because the provider could not reuse it.",
    );
  });
});
