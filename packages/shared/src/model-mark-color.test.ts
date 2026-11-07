import { describe, expect, it } from "vite-plus/test";

import { MODEL_MARK_TINTS } from "./model-mark-color";
import { deriveCanvasTokens } from "./theme/canvas/derive";
import { DEFAULT_CANVAS } from "./theme/canvas/parse";
import { wcagContrast } from "./theme/color";

describe("MODEL_MARK_TINTS", () => {
  it("is one palette of literal hex, since a vendor's identity is not a theme token", () => {
    for (const [key, tint] of Object.entries(MODEL_MARK_TINTS)) {
      expect(tint, key).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("gives the account and its family one colour, so either name finds the same row", () => {
    expect(MODEL_MARK_TINTS.gemini).toBe(MODEL_MARK_TINTS.google);
  });

  it.each(["light", "dark"] as const)(
    "keeps new decorative marks within the existing contrast band in %s",
    (mode) => {
      // These are decorative logos beside a text label, not control ink. Keep
      // the established tint band's floor on each default surface; this is not
      // a claim of text AA or contrast on every user-authored canvas.
      const tokens = deriveCanvasTokens(DEFAULT_CANVAS, mode);
      const established = [
        MODEL_MARK_TINTS.claude,
        MODEL_MARK_TINTS.openai,
        MODEL_MARK_TINTS.gemini,
        MODEL_MARK_TINTS.deepseek,
        MODEL_MARK_TINTS.mistral,
        MODEL_MARK_TINTS.llama,
        MODEL_MARK_TINTS.qwen,
        MODEL_MARK_TINTS.huggingface,
        MODEL_MARK_TINTS.cloudflare,
        MODEL_MARK_TINTS.openrouter,
        MODEL_MARK_TINTS.monochrome,
      ];
      for (const surface of ["--background", "--card", "--popover", "--sidebar"] as const) {
        const floor = Math.min(...established.map((tint) => wcagContrast(tint, tokens[surface])));
        for (const key of [
          "nvidia",
          "groq",
          "together",
          "cerebras",
          "fireworks",
          "minimax",
          "bedrock",
          "baseten",
          "antgroup",
        ] as const) {
          expect(
            wcagContrast(MODEL_MARK_TINTS[key], tokens[surface]),
            `${key}/${surface}`,
          ).toBeGreaterThanOrEqual(floor);
        }
      }
    },
  );

  it("stays low-chroma, so no mark reads as Volli's own ember accent", () => {
    // The rule `harness-identity.tsx` records, asserted rather than trusted:
    // the widest channel gap is what saturation looks like in hex, and a
    // vendor's own saturated brand colour clears this by a wide margin.
    for (const [key, tint] of Object.entries(MODEL_MARK_TINTS)) {
      const channels = [1, 3, 5].map((at) => Number.parseInt(tint.slice(at, at + 2), 16));
      expect(Math.max(...channels) - Math.min(...channels), key).toBeLessThanOrEqual(0x60);
    }
  });
});
