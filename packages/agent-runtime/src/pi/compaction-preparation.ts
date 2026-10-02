/**
 * Inject model-aware token counting into the owned Pi 0.99.2 cut/partition and
 * file-op rules. The former core patch is folded into the estimator seam;
 * callers without one retain upstream behavior. Retained reasoning is stripped
 * by context reconstruction, so it spends no keep-recent budget here either.
 */
import { getOrThrow, prepareCompaction, type CompactionSettings } from "./harness-compaction";
import { type Entry } from "./harness-session";
import type { Api, Model } from "@earendil-works/pi-ai";
import { withoutReasoning } from "./reasoning";
import { estimateMessageTokens } from "./token-counting";

export function prepareModelCompaction(
  path: readonly Entry[],
  settings: CompactionSettings,
  model: Model<Api>,
) {
  return getOrThrow(
    prepareCompaction([...path], settings, (message) =>
      estimateMessageTokens(withoutReasoning(message), model),
    ),
  );
}
