/**
 * The passive side: which mapper reads one response, by the provider that
 * answered it.
 *
 * Keyed on `model.provider` because that is the one identity the stream
 * instrument has at `onResponse` time, and because the Pi provider id is also
 * the key the holder and the probe use — so a header seen here folds into the
 * same entry the probe settles.
 */

import type { UsageLimitsUpdate } from "@volli/shared";

import { anthropicHeadersToUpdate } from "./anthropic";
import { codexHeadersToUpdate } from "./codex";
import type { HeaderMap } from "./windows";

type HeaderMapper = (headers: HeaderMap, observedAt: number) => UsageLimitsUpdate | null;

const MAPPERS: Readonly<Record<string, HeaderMapper>> = {
  anthropic: anthropicHeadersToUpdate,
  "openai-codex": codexHeadersToUpdate,
};

/**
 * The windows one provider response states, or null — for a provider with no
 * mapper, or a response that carried no usage headers (a Codex WebSocket turn,
 * an Anthropic API-key turn).
 */
export function headerUsageUpdate(
  providerId: string,
  headers: HeaderMap,
  observedAt: number,
): UsageLimitsUpdate | null {
  const mapper = MAPPERS[providerId];
  return mapper === undefined ? null : mapper(headers, observedAt);
}
