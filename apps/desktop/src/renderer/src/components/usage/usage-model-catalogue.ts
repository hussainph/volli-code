/**
 * The model catalogue the usage rows are named against, read at the boundary.
 *
 * WHY IT IS A FILE OF ITS OWN. `usage-rail.tsx` is where the rails' store reads
 * live, and the drawings beside it are props-in so the UI lab can mount them
 * (see that file's own comment). This is the third kind of read those rows need
 * — not the ledger and not a preference, but the catalogue that turns
 * `anthropic/claude-opus-4-1` into "Claude Opus 4.1" — and it is a hook with one
 * question, so it sits where a test can mount it against a client instead of
 * against five stores.
 *
 * NOTHING HERE POLLS, for the reason the rollups do not: a model's name changes
 * when the catalogue does, and the shared client already bumps its revision when
 * a sign-in, a sign-out or an explicit Refresh moves it. `inspect({})` is that
 * client's HELD read (`lib/model-access-client.tsx`), so a rail arriving after a
 * composer has asked pays nothing for the answer, and the handle is re-minted
 * per revision — which is what makes depending on it the same as depending on
 * the revision.
 */
import * as React from "react";

import { useModelAccessClient } from "@renderer/lib/model-access-client";
import type { UsageModelCatalogue } from "@renderer/components/usage/usage-rail-model";

/**
 * The catalogue, or `null` until a read has landed.
 *
 * A FAILED READ KEEPS THE LAST GOOD ONE, and a first failure answers `null`,
 * which the rows draw as the ids the ledger holds (`modelName`). No toast: this
 * is a refinement nobody asked for — the figure the reader came for is already
 * on screen, and a name is not an act they are waiting on.
 */
export function useUsageModelCatalogue(): UsageModelCatalogue | null {
  const access = useModelAccessClient();
  const inspect = access?.inspect;
  const [catalogue, setCatalogue] = React.useState<UsageModelCatalogue | null>(null);

  React.useEffect(() => {
    if (inspect === undefined) return;
    let current = true;
    void inspect({})
      .then((snapshot) => {
        if (!current) return;
        setCatalogue({ models: snapshot.models, providers: snapshot.providers });
      })
      // The answer to a read that was overtaken, or one that failed, is the one
      // already held — never an empty catalogue, which would rename every row
      // on screen back to an id.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [inspect]);

  return catalogue;
}
