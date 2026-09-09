/**
 * Inject model-aware token counting into Pi's own cut/partition and file-op
 * rules. The small pi-agent-core patch adds only an optional estimator seam;
 * callers without one retain upstream behavior. Retained reasoning is stripped
 * by context reconstruction, so it spends no keep-recent budget here either.
 */
import {
  getOrThrow,
  prepareCompaction,
  type Entry,
  type CompactionSettings,
} from "@earendil-works/pi-agent-core";
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
