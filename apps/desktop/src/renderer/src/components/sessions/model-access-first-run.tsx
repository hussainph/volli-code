/**
 * The fresh-profile landing for the Sessions surface (VC-53).
 *
 * A profile with no resolvable global default cannot mint a chat — main
 * refuses the create before anything durable exists — so the surface must not
 * try, and must not toast about a state it can see coming. This is what stands
 * in the empty state instead: the sign-in path, inline.
 *
 * Two shapes of the same block. No available models means no provider is
 * signed in, so the primary act is choosing WHO to sign in to — the menu deep
 * links into Model Access with that provider's flow started. Available models
 * with no default means sign-in already happened and only the choice is
 * missing, so the one act is the pane where it is made.
 */
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import * as React from "react";
import type { ModelAccessProvider } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { useUiStore } from "@renderer/stores/ui";

/**
 * Whether Session creation would resolve a model right now, re-read on every
 * Model Access change (sign-in, default saved). `null` while unanswered —
 * callers treat that as "not ready to auto-open" without drawing the blocked
 * state. A profile without the client (the lab) reads as ready: the create
 * path owns its own refusal there.
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
  const [providers, setProviders] = React.useState<readonly ModelAccessProvider[]>([]);
  const [signedIn, setSignedIn] = React.useState(false);
  const inspect = client?.inspect;

  React.useEffect(() => {
    if (inspect === undefined) return;
    let current = true;
    void inspect({})
      .then((access) => {
        if (!current) return;
        setProviders(access.providers);
        setSignedIn(access.models.some((model) => model.state === "available"));
      })
      .catch(() => {
        // Nothing to list; the Settings button below still opens the pane.
      });
    return () => {
      current = false;
    };
  }, [inspect]);

  const signInOptions = React.useMemo(
    () =>
      providers
        .filter((provider) => provider.signIn.length > 0)
        .toSorted((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    [providers],
  );

  return (
    <>
      <CpuIcon className="size-8 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {signedIn ? "Choose a default model to start." : "Connect a model provider to start."}
      </p>
      <div className="flex items-center gap-2">
        {!signedIn && signInOptions.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>Sign in</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
              {signInOptions.map((provider) => (
                <DropdownMenuItem
                  key={provider.id}
                  onSelect={() => setSettingsOpen(true, "model-access", provider.id)}
                >
                  {provider.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Button
          variant={!signedIn && signInOptions.length > 0 ? "ghost" : "default"}
          onClick={() => setSettingsOpen(true, "model-access")}
        >
          Model Access
        </Button>
      </div>
    </>
  );
}
