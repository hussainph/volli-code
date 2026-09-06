import type { ReasoningDropCause } from "@volli/shared";
import type { TranscriptReasoningDrop } from "./transcript";

const CAUSE_COPY: Record<ReasoningDropCause, string> = {
  "prefix-mismatch": "the conversation prefix changed",
  "model-mismatch": "the provider changed the model",
  unknown: "the provider could not reuse it",
};

/** The client-neutral words for one provider recovery notice. */
export function reasoningDropNoticeCopy(drop: TranscriptReasoningDrop): string {
  const causes = drop.causes.length === 0 ? (["unknown"] as const) : drop.causes;
  const reasons = causes.map((cause) => CAUSE_COPY[cause]);
  const because =
    reasons.length === 1 ? reasons[0] : `${reasons.slice(0, -1).join(", ")} and ${reasons.at(-1)}`;
  return `Earlier reasoning was dropped because ${because}.`;
}
