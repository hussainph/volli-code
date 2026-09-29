/**
 * The runtime's half of a quota reset: which facts it hands the pure reader.
 *
 * `quotaResetInstant` in `@volli/shared` owns every rule about what a failure
 * sentence means. This file only knows what the runtime alone can supply at
 * the moment a run fails — which provider answered, when, and the usage
 * windows the passive meter and the Model Access probe have folded into the
 * holder for that provider — so the reset is read once, where those facts are
 * live, and travels on the Attention from then on.
 */
import { quotaResetInstant, type RuntimeFailure } from "@volli/shared";

import type { UsageLimitsHolder } from "./usage-limits/holder";

/** When the allowance this failure spent comes back, or `null`. */
export function failureResetsAt(input: {
  failure: RuntimeFailure;
  providerId: string;
  observedAt: number;
  holder: UsageLimitsHolder | undefined;
}): number | null {
  const windows = input.holder?.get(input.providerId)?.windows;
  return quotaResetInstant({
    providerId: input.providerId,
    message: input.failure.message,
    observedAt: input.observedAt,
    ...(windows === undefined ? {} : { windows }),
  });
}
