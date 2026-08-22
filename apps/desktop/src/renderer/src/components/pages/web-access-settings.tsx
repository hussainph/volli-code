/**
 * Settings → Web (VC-31): the bring-your-own search provider.
 *
 * View glue only. The fold from a saved setting to what this pane shows lives
 * in `web-access-model.ts`, which is coverage-enrolled; this file draws it and
 * does the I/O.
 *
 * **The key field is write-only, and that is the pane's whole shape.** Main
 * answers every call with a settings view in which a stored key is the word
 * "present" — there is no channel that reads one back, not even masked, because
 * a page that can render the last four characters is a page that was sent them.
 * So the field is empty on load whether or not a key is stored, what it says
 * beside it is whether one exists, and Remove is how you get rid of it. The
 * local `key` state is cleared the moment a save succeeds so the plaintext does
 * not sit in a React tree for the life of the window.
 *
 * A refused endpoint arrives here as the endpoint policy's own sentence, and is
 * shown in the row rather than toasted away: it is a correction to what the
 * person just typed, and it belongs beside the field they typed it into.
 */
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@volli/shared";

import type {
  KeyedWebAccessProvider,
  WebAccessProvider,
  WebAccessSettingsView,
} from "../../../../ipc/contract";
import { webAccessPanel } from "@renderer/components/pages/web-access-model";
import { PrefRow, PrefSection } from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { Input } from "@renderer/components/ui/input";
import { Notice } from "@renderer/components/ui/notice";
import { Segmented } from "@renderer/components/ui/segmented";
import { StatusDot } from "@renderer/components/ui/status-dot";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { toastError } from "@renderer/lib/toast";

const PROVIDERS: readonly { key: WebAccessProvider; label: string }[] = [
  { key: "off", label: "Off" },
  { key: "brave", label: "Brave" },
  { key: "exa", label: "Exa" },
  { key: "searxng", label: "SearXNG" },
];

/** The provider names shown in the key field's placeholder. */
const PROVIDER_LABEL: Readonly<Record<KeyedWebAccessProvider, string>> = {
  brave: "Brave",
  exa: "Exa",
};

const KEY_STATE_LABEL = {
  absent: "Not set",
  present: "Stored in your keychain",
  unreadable: "Stored, but unreadable here",
} as const;

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; view: WebAccessSettingsView }
  | { status: "error"; message: string };

export function WebAccessSettings() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [endpoint, setEndpoint] = useState("");
  const [key, setKey] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const settingsFetch = useLatestAsync();
  const load = useCallback(async () => {
    const token = settingsFetch.claim();
    try {
      const result = await window.api.webAccess.get();
      if (!settingsFetch.isCurrent(token)) return;
      if (!result.ok) {
        setState({ status: "error", message: result.error });
        return;
      }
      setState({ status: "loaded", view: result.settings });
      setEndpoint(result.settings.searxngUrl ?? "");
    } catch (error) {
      if (settingsFetch.isCurrent(token)) {
        setState({ status: "error", message: errorMessage(error) });
      }
    }
  }, [settingsFetch]);

  useEffect(() => {
    void load();
    return () => settingsFetch.invalidate();
  }, [load, settingsFetch]);

  /**
   * One shape for every write: run it, take the view it answers with, and put a
   * refusal beside the field rather than in a toast. `onSaved` runs only when
   * the write actually landed — which is what clears a typed key.
   */
  async function write(
    run: () => Promise<
      { ok: true; settings: WebAccessSettingsView } | { ok: false; error: string }
    >,
    onSaved?: () => void,
  ): Promise<void> {
    if (busy) return;
    setBusy(true);
    setFieldError(null);
    try {
      const result = await run();
      if (!result.ok) {
        setFieldError(result.error);
        return;
      }
      setState({ status: "loaded", view: result.settings });
      setEndpoint(result.settings.searxngUrl ?? "");
      onSaved?.();
    } catch (error) {
      toastError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (state.status === "loading") {
    return (
      <PrefSection title="Web search" icon={GlobeIcon}>
        <p className={EMPTY_INLINE}>Loading…</p>
      </PrefSection>
    );
  }
  if (state.status === "error") {
    return (
      <PrefSection title="Web search" icon={GlobeIcon}>
        <Notice
          announce
          tone="error"
          icon={WarningIcon}
          title="Couldn't read your web search settings"
          detail={state.message}
          actions={
            <Button size="xs" variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      </PrefSection>
    );
  }

  const panel = webAccessPanel(state.view);
  // The key panel renders only for a provider that has one, so the narrowing
  // is done once here rather than at each of the five places below that would
  // otherwise have to re-derive which provider's key they are talking about.
  const keyedProvider: KeyedWebAccessProvider = state.view.provider === "exa" ? "exa" : "brave";
  const keyState = state.view.keys[keyedProvider];
  const chooseProvider = (provider: WebAccessProvider): void => {
    void write(() =>
      window.api.webAccess.setProvider(
        provider,
        // The saved instance is carried forward when switching TO SearXNG, so
        // returning to it does not ask for a URL that is already stored.
        provider === "searxng" ? (endpoint.trim() === "" ? null : endpoint) : null,
      ),
    );
  };

  return (
    <PrefSection title="Web search" icon={GlobeIcon}>
      <PrefRow label="Provider">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 text-ui text-muted-foreground">
            <StatusDot state={panel.active ? "ready" : "idle"} />
            {panel.active ? "On" : "Off"}
          </span>
          <Segmented
            ariaLabel="Web search provider"
            testId="web-access-provider"
            value={panel.provider}
            options={PROVIDERS}
            disabled={busy}
            onChange={chooseProvider}
          />
        </div>
      </PrefRow>

      {panel.showsEndpoint ? (
        <PrefRow label="Instance" htmlFor="web-access-endpoint" align="start">
          <div className="flex w-80 flex-col items-end gap-2">
            <Input
              id="web-access-endpoint"
              value={endpoint}
              placeholder="http://localhost:8888"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setEndpoint(event.target.value)}
            />
            <Button
              size="xs"
              variant="outline"
              disabled={busy || endpoint.trim() === ""}
              onClick={() =>
                void write(() => window.api.webAccess.setProvider("searxng", endpoint))
              }
            >
              Save instance
            </Button>
          </div>
        </PrefRow>
      ) : null}

      {panel.showsKey ? (
        <PrefRow label="API key" htmlFor="web-access-key" align="start">
          <div className="flex w-80 flex-col items-end gap-2">
            <Input
              id="web-access-key"
              type="password"
              value={key}
              placeholder={
                keyState === "absent"
                  ? `Paste your ${PROVIDER_LABEL[keyedProvider]} key`
                  : "Replace stored key"
              }
              spellCheck={false}
              autoComplete="off"
              disabled={busy || panel.keyEntryDisabled}
              onChange={(event) => setKey(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <span className="text-ui text-muted-foreground">{KEY_STATE_LABEL[keyState]}</span>
              {keyState === "absent" ? null : (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void write(
                      () => window.api.webAccess.clearKey(keyedProvider),
                      () => setKey(""),
                    )
                  }
                >
                  Remove
                </Button>
              )}
              <Button
                size="xs"
                variant="outline"
                disabled={busy || panel.keyEntryDisabled || key.trim() === ""}
                onClick={() =>
                  // Cleared on success: a plaintext key has no reason to sit in
                  // a React tree once main has encrypted it.
                  void write(
                    () => window.api.webAccess.setKey(keyedProvider, key),
                    () => setKey(""),
                  )
                }
              >
                Save key
              </Button>
            </div>
          </div>
        </PrefRow>
      ) : null}

      {fieldError === null ? null : (
        <Notice announce tone="error" icon={WarningIcon} title={fieldError} />
      )}
      {panel.notice === null || fieldError !== null ? null : (
        <Notice tone={panel.notice.tone} title={panel.notice.message} />
      )}
    </PrefSection>
  );
}
