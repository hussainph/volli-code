import * as React from "react";
import { errorMessage, type HarnessCommandFailureReason } from "@volli/shared";

import {
  activeHarness,
  harnessCommandFailureLine,
  isHarnessCommandFailureReason,
  type HarnessListing,
} from "@renderer/components/pages/harness-catalog";
import {
  HarnessIdentitySection,
  HarnessSelector,
  preloadApi,
  useHarnessListings,
} from "@renderer/components/pages/harness-picker";
import { SettingsRow } from "@renderer/components/pages/settings-shell";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";

/**
 * The only harness whose binary Volli will store an override for.
 *
 * The structured OpenCode runtime that read this value is gone, so today the
 * stored override reaches no launch — the terminal companion's wrapper walks
 * the login-shell PATH instead. Kept to one harness rather than widened while
 * that is true: a control offered everywhere would be a setting that appears
 * to work and does nothing, in as many places as there are harnesses.
 */
const OVERRIDABLE_BINARY_HARNESS_ID = "opencode";

/**
 * The Harness Runtimes category: every harness this host can launch, and what
 * there is to configure about the selected one, app-wide.
 *
 * Master-detail INSIDE the pane — see {@link HarnessSelector} for why the
 * selector sits above the detail rather than beside it. Configure's Runtime
 * category is the same shape at project scope, minus the binary row below,
 * which stays global: exactly one launch path reads the stored value.
 */
export function HarnessSettings() {
  const listings = useHarnessListings();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const active = activeHarness(listings, selectedId);

  return (
    <div className="flex flex-col gap-3">
      <HarnessSelector listings={listings} activeId={active?.id ?? null} onSelect={setSelectedId} />
      {active ? <HarnessDetail listing={active} /> : null}
    </div>
  );
}

/** The selected harness's pane: its identity card, plus whatever it alone can configure. */
function HarnessDetail({ listing }: { listing: HarnessListing }) {
  return (
    <div className="flex flex-col gap-6">
      <HarnessIdentitySection listing={listing}>
        {listing.id === OVERRIDABLE_BINARY_HARNESS_ID ? <BinaryRow harnessId={listing.id} /> : null}
      </HarnessIdentitySection>
    </div>
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
 * A refusal that carries a typed reason is a verdict about the candidate, so it
 * is answered inline with the one thing to do about it. Anything else — a
 * throw, or an `ok: false` the IPC envelope composed without a reason in it —
 * is not a verdict, so it toasts the message main sent instead of inventing an
 * inline line for it.
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
        setResolvedPath(null);
        // A verdict about the candidate is answered inline, where the candidate
        // still is. Everything else — a guard miss, a throw inside the handler,
        // a degraded-database boot — reaches here as `ok: false` with no
        // `reason` at all, however required the type says it is, so it is
        // toasted with the `error` main sent rather than narrowed to a line
        // that does not exist. Reading `reason` on trust here is precisely what
        // draws the empty red line and swallows the only readable half.
        if (isHarnessCommandFailureReason(result.reason)) {
          setFailure(result.reason);
          return;
        }
        setFailure(null);
        toastError(`Couldn't save the harness binary: ${result.error}`);
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
