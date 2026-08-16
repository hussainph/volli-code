/**
 * The fresh-Session prompt baseline, measured per section (VC-66).
 *
 * A new Session pays a context cost before the user types a word: the system
 * prompt's layers, every RESOURCE block riding it (the skills index above
 * all), and the delimited Runtime Brief that opens the first message. This
 * module prices that preamble reproducibly — same inputs, same numbers —
 * by measuring the exact strings `composeSystemPrompt` and
 * `composeFirstUserMessage` assemble, through the same section list the
 * composer renders. A section cannot appear in the prompt without appearing
 * here, or here without appearing in the prompt.
 *
 * Token counts are ESTIMATES. There is no tokenizer in this workspace; the
 * only counting primitive anywhere is the renderer's ~4 characters/token
 * heuristic (`context-usage.ts`), and this module deliberately uses the same
 * ratio so the two surfaces tell one story. The honest cross-check is a
 * provider-measured first turn. And the baseline is deliberately not the
 * whole first-turn meter: tool definitions and provider overhead ride on top
 * of everything measured here, are serialized provider-side, and are named as
 * excluded rather than guessed at.
 */
import type { RuntimeBrief } from "@volli/shared";

import { composeBriefBlock, systemPromptSections } from "./prompt";
import type { SystemPromptInput } from "./prompt";

/**
 * The renderer's `CHARS_PER_TOKEN`, spelled again here because the renderer
 * module lives behind a DOM boundary this package must not import across.
 * Close enough for a share, never shown as a count of record.
 */
export const PROMPT_BASELINE_CHARS_PER_TOKEN = 4;

/** One measured slice of the baseline. */
export interface PromptBaselineSection {
  /** The section id `systemPromptSections` names it by, plus `brief` for the Brief block. */
  id: string;
  chars: number;
  /** `ceil(chars / 4)` — an estimate, labeled as one everywhere it renders. */
  tokens: number;
}

export interface PromptBaselineTotal {
  chars: number;
  tokens: number;
}

export interface PromptBaseline {
  /** The estimate's whole model of tokenization. */
  charsPerToken: number;
  /** Every system-prompt layer in delivery order, then the Brief block. */
  sections: readonly PromptBaselineSection[];
  /** The assembled system prompt exactly — section separators included. */
  system: PromptBaselineTotal;
  /** The delimited Brief block that opens the first delivered message. */
  brief: PromptBaselineTotal;
  /**
   * `system + brief`: everything Volli composes into a fresh Session's
   * context. The provider's first-turn meter also carries tool definitions,
   * the user's own text and provider overhead — real costs this breakdown
   * cannot see and does not invent.
   */
  total: PromptBaselineTotal;
}

/** What the baseline is priced from: the prompt's own inputs plus the Brief. */
export interface PromptBaselineInput extends SystemPromptInput {
  brief: RuntimeBrief;
}

function measure(text: string): PromptBaselineTotal {
  return {
    chars: text.length,
    tokens: Math.ceil(text.length / PROMPT_BASELINE_CHARS_PER_TOKEN),
  };
}

/**
 * Price one fresh Session's composed prompt, per section.
 *
 * Per-section tokens each round up, so the section column can sum to slightly
 * more than the rollups; `system` is measured on the joined string (separators
 * and all) and is the number to trust.
 */
export function promptBaseline(input: PromptBaselineInput): PromptBaseline {
  const sections = systemPromptSections(input);
  const system = measure(sections.map((section) => section.text).join("\n\n"));
  const brief = measure(composeBriefBlock(input.role, input.brief));
  return {
    charsPerToken: PROMPT_BASELINE_CHARS_PER_TOKEN,
    sections: [
      ...sections.map((section): PromptBaselineSection => {
        const measured = measure(section.text);
        return { id: section.id, chars: measured.chars, tokens: measured.tokens };
      }),
      { id: "brief", chars: brief.chars, tokens: brief.tokens },
    ],
    system,
    brief,
    total: { chars: system.chars + brief.chars, tokens: system.tokens + brief.tokens },
  };
}
