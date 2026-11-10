/**
 * The fresh-profile landing for Model Access (VC-53).
 *
 * A profile with no resolvable global default cannot mint a chat — main
 * refuses the create before anything durable exists — so the surface must not
 * try, and must not toast about a state it can see coming. This is what stands
 * in the empty state instead: the sign-in path, inline.
 *
 * It stood in the Sessions page's empty state until VC-54 retired that page.
 * Its home is now the BOARD's empty state (`board/board-empty.tsx`), which is
 * the first thing a fresh profile sees and the only surface guaranteed to be on
 * screen there — see that file for why the app needs one proactive auth surface
 * at all.
 *
 * The empty surface has one recovery: Model Access. Its provider rows retain
 * provider-specific sign-in, and its default picker resolves the other case.
 */
import { EmptyState } from "@renderer/components/ui/empty-state";

import * as React from "react";

import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { useUiStore } from "@renderer/stores/ui";

/**
 * Whether Session creation would resolve a model right now, re-read on every
 * Model Access change (sign-in, default saved). `null` while unanswered —
 * callers draw neither branch then, which is what keeps a one-frame sign-in
 * prompt off a perfectly configured profile. A profile without the client (the
 * lab) reads as ready: the create path owns its own refusal there.
 */
export function useModelAccessReady(active: boolean): boolean | null {
  const client = useModelAccessClient();
  const [ready, setReady] = React.useState<boolean | null>(null);
  const defaults = client?.defaults;
  const revision = client?.revision ?? 0;

  React.useEffect(() => {
    if (!active) return;
    if (defaults === undefined) {
      setReady(true);
      return;
    }
    let current = true;
    void defaults()
      .then((configured) => {
        if (current) setReady(configured.global !== null);
      })
      .catch(() => {
        // An unanswerable read must not brick the surface: the create path
        // will state its own refusal, inline, if the state really is missing.
        if (current) setReady(true);
      });
    return () => {
      current = false;
    };
  }, [active, defaults, revision]);

  return active ? ready : null;
}

export function ModelAccessFirstRun() {
  const client = useModelAccessClient();
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const [signedIn, setSignedIn] = React.useState(false);
  const inspect = client?.inspect;

  React.useEffect(() => {
    if (inspect === undefined) return;
    let current = true;
    void inspect({})
      .then((access) => {
        if (!current) return;
        setSignedIn(access.models.some((model) => model.state === "available"));
      })
      .catch(() => {
        // Nothing to list; the Settings button below still opens the pane.
      });
    return () => {
      current = false;
    };
  }, [inspect]);

  return (
    <EmptyState
      tier="page"
      illustration="mcp"
      status="unavailable"
      title={signedIn ? "No default model" : "No model provider"}
      action={{ label: "Model Access", onAction: () => setSettingsOpen(true, "model-access") }}
    />
  );
}
