/**
 * Inject model-aware token counting into the owned Pi 0.99.2 cut/partition and
 * file-op rules. The former core patch is folded into the estimator seam;
 * callers without one retain upstream behavior. Retained reasoning is stripped
 * by context reconstruction, so it spends no keep-recent budget here either.
 */
import { getOrThrow, prepareCompaction, type CompactionSettings } from "./harness-compaction";
import { type Entry } from "./harness-session";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { withoutReasoning } from "./reasoning";
import { estimateMessageTokens, tokenizerFamily, type TokenizerFamily } from "./token-counting";

/**
 * Stripped estimates by ORIGINAL message and tokenizer family. A turn with
 * reasoning strips to a fresh object every time, so nothing keyed by the
 * stripped copy could ever hit; the cut search, `tokensBefore` and a second
 * preparation each count the same settled messages again. Settled messages
 * are never mutated in place (see `createContextTokenProjector`).
 */
const strippedEstimates = new WeakMap<object, Map<TokenizerFamily, number>>();

function strippedMessageTokens(message: AgentMessage, model: Model<Api>): number {
  const family = tokenizerFamily(model);
  let byFamily = strippedEstimates.get(message);
  const known = byFamily?.get(family);
  if (known !== undefined) return known;
  const estimated = estimateMessageTokens(withoutReasoning(message), model);
  if (byFamily === undefined) strippedEstimates.set(message, (byFamily = new Map()));
  byFamily.set(family, estimated);
  return estimated;
}

export function prepareModelCompaction(
  path: readonly Entry[],
  settings: CompactionSettings,
  model: Model<Api>,
) {
  return getOrThrow(
    prepareCompaction([...path], settings, (message) => strippedMessageTokens(message, model)),
  );
}
