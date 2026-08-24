/**
 * What the Session in front has consumed, as three more facts about it.
 *
 * A FRAGMENT OF ROWS, not a block. These mount inside the Home rail's existing
 * Session `<dl>`, directly under Model / Effort / Activity, because cost is a
 * property of the Session rather than a subject of its own. Giving it a heading
 * would put a second "Usage" on a page whose Project block is already about
 * usage, and would break one coherent answer — what is in front — into two.
 *
 * IT RENDERS NOTHING FOR AN UNMETERED SESSION, and the distinction it is
 * protecting is the whole reason `formatUsageCost` returns `null` separately
 * from `"—"`:
 *
 *   • A terminal companion runs models Volli never mediated. It has no usage,
 *     and three rows of dashes on the default rail would be noise dressed as
 *     honesty — the rail stays quiet, exactly as it does for a clean worktree.
 *   • A chat Session before its first metered reply is in the same position as
 *     the context meter, which is absent until something has been measured
 *     rather than showing a zeroed ring.
 *
 * A Session that HAS metered operations but could not price them still renders,
 * at `—` for cost with its token counts intact. That is a real reading: the
 * work happened and its size is known, only the money is unvouchable.
 */
import type * as React from "react";

import type { SessionUsageSummary } from "@volli/shared";

import { formatTokens } from "@volli/session-presentation";
import { formatCachedShare, formatUsageCost, totalUsageTokens } from "@renderer/usage/usage-format";

export function SessionUsageFacts({ summary }: { summary: SessionUsageSummary }) {
  const cost = formatUsageCost(summary);
  if (cost === null) return null;

  const tokens = totalUsageTokens(summary);
  const cached = formatCachedShare(summary);

  return (
    <>
      <UsageFact label="Cost">{cost}</UsageFact>
      {/* Tokens can be absent while cost is known (a provider that priced a
          call without breaking down its classes), so each row is guarded on its
          own rather than on the presence of the block. */}
      {tokens > 0 ? <UsageFact label="Tokens">{formatTokens(tokens)}</UsageFact> : null}
      {cached === null ? null : <UsageFact label="Cached input">{cached}</UsageFact>}
    </>
  );
}

/**
 * The Session block's key/value line.
 *
 * Deliberately identical to `home-rail.tsx`'s own `Fact`, plus `tabular-nums` —
 * every value here is a changing figure, and DESIGN.md's own guidance is that
 * changing metrics take tabular figures so the column does not jitter as digits
 * change width. WIRING NOTE: when this lands in the rail, hoist that `Fact` and
 * let both read one drawing rather than leaving these two to drift.
 */
function UsageFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="shrink-0 text-ui text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-ui tabular-nums text-foreground">{children}</dd>
    </div>
  );
}
