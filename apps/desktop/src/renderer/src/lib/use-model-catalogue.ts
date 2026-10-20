import * as React from "react";
import type { ModelAccessSnapshot } from "@volli/shared";

import { useModelAccessClient } from "@renderer/lib/model-access-client";

export type ModelCatalogue = Pick<ModelAccessSnapshot, "models" | "providers">;

/**
 * Display identities use the whole catalogue, not just today's offerable models:
 * history and pinned Sessions still name models that are hidden or signed out.
 * The client's held read coalesces all callers; only its revision triggers a
 * re-read. A failed refinement keeps the last good names (or honest ID fallbacks).
 */
export function useModelCatalogue(): ModelCatalogue | null {
  const access = useModelAccessClient();
  const inspect = access?.inspect;
  const [catalogue, setCatalogue] = React.useState<ModelCatalogue | null>(null);

  React.useEffect(() => {
    if (inspect === undefined) return;
    let current = true;
    void inspect({})
      .then((snapshot) => {
        if (current) setCatalogue({ models: snapshot.models, providers: snapshot.providers });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [inspect]);

  return catalogue;
}
