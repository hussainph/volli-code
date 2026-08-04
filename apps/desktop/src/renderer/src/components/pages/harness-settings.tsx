import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import * as React from "react";
import { errorMessage, type HarnessAdapter, type HarnessCommandFailureReason } from "@volli/shared";

import {
  activeHarness,
  harnessCommandFailureLine,
  harnessListings,
  type HarnessListing,
  type HarnessOrigin,
} from "@renderer/components/pages/harness-catalog";
import { RuntimeCatalogSettings } from "@renderer/components/pages/runtime-catalog-settings";
import { SettingsRow, SettingsSection } from "@renderer/components/pages/settings-shell";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";

/**
 * The only harness whose binary Volli will store an override for. Exactly one
 * launch path reads the stored value — `main/index.ts`, which feeds it to
 * `resolveOpenCodeBinary` — so offering the control anywhere else would
 * persist a value no launch ever reads: a setting that appears to work and
 * does nothing.
 */
const OVERRIDABLE_BINARY_HARNESS_ID = "opencode";

/**
 * `window.api` where there is one. The settings surfaces render under
 * `renderToStaticMarkup` in unit tests, where there is no `window` at all and
 * no preload bridge — the built-in half of the list is compiled in, so the pane
 * still renders every first-class harness with nothing to fetch.
 */
function preloadApi(): Window["api"] | undefined {
  return typeof window === "undefined" ? undefined : window.api;
}

/**
 * The Harness Runtimes category: every harness this host can launch, and what
 * there is to configure about the selected one.
 *
 * Master-detail INSIDE the pane, with the selector above the detail rather than
 * beside it. The settings pane is one 608px reading column and the OpenCode
 * detail already spends it on a provider/model master-detail of its own; a
 * second vertical rail in front of that leaves the model rows too narrow to
 * read their own ids. Above, the selector costs one row and the detail keeps
 * the full width.
 *
 * The panes are deliberately spare. Only OpenCode has anything to change today,
 * so the others state the two facts that are true and knowable — the executable
 * a launch resolves and where the harness came from — instead of padding out to
 * a matching size.
 */
export function HarnessSettings() {
  const [registered, setRegistered] = React.useState<readonly HarnessAdapter[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const api = preloadApi();
    if (api === undefined) return;
    let cancelled = false;
    api.harness
      .registered()
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          toastError(`Couldn't load registered harnesses: ${result.error}`);
          return;
        }
        setRegistered(result.harnesses);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        toastError(`Couldn't load registered harnesses: ${errorMessage(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const listings = React.useMemo(() => harnessListings(registered), [registered]);
  const active = activeHarness(listings, selectedId);

  return (
    <div className="flex flex-col gap-3">
      <div
        role="group"
        aria-label="Harnesses"
        className="flex w-fit flex-wrap gap-1 rounded-lg border border-border bg-card/50 p-1"
      >
        {listings.map((listing) => {
          const isActive = listing.id === active?.id;
          return (
            <button
              key={listing.id}
              type="button"
              aria-current={isActive ? true : undefined}
              onClick={() => setSelectedId(listing.id)}
              className={cn(
                "h-7 rounded-md px-3 text-ui transition-colors",
                isActive
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {listing.label}
            </button>
          );
        })}
      </div>

      {active ? <HarnessDetail listing={active} /> : null}
    </div>
  );
}

/** The selected harness's pane: its identity card, plus whatever it alone can configure. */
function HarnessDetail({ listing }: { listing: HarnessListing }) {
  const overridable = listing.id === OVERRIDABLE_BINARY_HARNESS_ID;
  return (
    <div className="flex flex-col gap-6">
      <SettingsSection
        title={listing.label}
        icon={CpuIcon}
        action={<OriginChip origin={listing.origin} />}
      >
        <SettingsRow label="Command">
          <code className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-xs text-foreground">
            {listing.command}
          </code>
        </SettingsRow>
        {overridable ? <BinaryRow harnessId={listing.id} /> : null}
      </SettingsSection>
      {overridable ? <RuntimeCatalogSettings /> : null}
    </div>
  );
}

/** Built-in or registered, stated where the harness's other identity facts are. */
function OriginChip({ origin }: { origin: HarnessOrigin }) {
  return (
    <span className="rounded-full border border-border px-2 py-0.5 text-label uppercase text-muted-foreground">
      {origin === "built-in" ? "Built-in" : "Registered"}
    </span>
  );
}

/**
 * The per-harness binary override: where this harness's executable actually is,
 * when the login-shell PATH is not the answer.
 *
 * Empty means automatic — the stored value is cleared and resolution goes back
 * to walking PATH for the command above. What is stored is what was typed, so
 * the status line shows the canonical realpath the validation resolved to
 * rather than folding it back into the field: a later PATH or filesystem change
 * is honored on the next attach, and freezing the realpath into the input would
 * quietly turn that into a fixed path nobody chose.
 *
 * A refusal is typed, so it is answered inline with the one thing to do about
 * it. Anything that throws is a transport failure rather than a verdict about
 * the candidate, and toasts.
 */
function BinaryRow({ harnessId }: { harnessId: string }) {
  const [draft, setDraft] = React.useState("");
  const [stored, setStored] = React.useState<string | null>(null);
  const [resolvedPath, setResolvedPath] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<HarnessCommandFailureReason | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [unreadable, setUnreadable] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  // A failed read leaves the field DISABLED rather than empty and editable.
  // Empty means automatic on this surface, so showing it when the stored value
  // is simply unknown would state the opposite of what may be persisted, and
  // saving over it would overwrite an override nobody was shown. The
  // "Automatic" placeholder is withheld for exactly the same reason — it is
  // the same claim in lighter type — and Retry stands in for Save so the
  // state is recoverable without leaving the pane.
  React.useEffect(() => {
    const api = preloadApi();
    if (api === undefined) return;
    let cancelled = false;
    api.harness
      .commandGet({ harnessId })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setUnreadable(true);
          toastError(`Couldn't read the harness binary: ${result.error}`);
          return;
        }
        setStored(result.command);
        setDraft(result.command ?? "");
        setUnreadable(false);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setUnreadable(true);
        toastError(`Couldn't read the harness binary: ${errorMessage(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [harnessId, attempt]);

  const candidate = draft.trim();
  const dirty = candidate !== (stored ?? "");

  async function save(): Promise<void> {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      const command = candidate === "" ? null : candidate;
      const result = await window.api.harness.commandSet({ harnessId, command });
      if (!result.ok) {
        setFailure(result.reason);
        setResolvedPath(null);
        return;
      }
      setFailure(null);
      setStored(command);
      setDraft(candidate);
      setResolvedPath(result.resolvedPath);
    } catch (error) {
      toastError(`Couldn't save the harness binary: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsRow label="Binary" htmlFor="harness-binary" align="start">
      {/* Wide enough that a real binary path is legible without scrolling the
          field: this is the one control on the surface whose value is a path. */}
      <div className="flex w-96 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Input
            id="harness-binary"
            value={draft}
            placeholder={loaded ? "Automatic" : ""}
            spellCheck={false}
            autoComplete="off"
            disabled={!loaded || saving}
            aria-invalid={failure !== null}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setFailure(null);
              // The realpath belongs to the value that was SAVED. Left up under
              // edited text it asserts a resolution for a path that is not in
              // the field and was never stored.
              setResolvedPath(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
            // Mono only once there is a path in it: "Automatic" is a word, and
            // typesetting it as code claims it is a value someone could type.
            // `md:text-xs` because the base `Input` carries `md:text-sm`, which
            // an unprefixed `text-xs` does not merge with and never outranks.
            className={cn("h-8 flex-1 text-xs md:text-xs", draft !== "" && "font-mono")}
          />
          {unreadable ? (
            <Button onClick={() => setAttempt((count) => count + 1)}>Retry</Button>
          ) : (
            <Button disabled={!loaded || saving || !dirty} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          )}
        </div>
        {unreadable ? (
          <p className="text-xs text-destructive">Couldn&apos;t read the stored binary.</p>
        ) : failure !== null ? (
          <p className="text-xs text-destructive">{harnessCommandFailureLine(failure)}</p>
        ) : resolvedPath !== null ? (
          <p className="truncate font-mono text-xs text-muted-foreground" title={resolvedPath}>
            {resolvedPath}
          </p>
        ) : null}
      </div>
    </SettingsRow>
  );
}
