import * as React from "react";
import { GlobeIcon } from "@phosphor-icons/react";
import { errorMessage } from "@volli/shared";
import type {
  WebAccessProvider,
  WebAccessSettingsView,
  WebAccessResult,
} from "../../../../../ipc/contract";
import { AsyncSection, Cell, DataTable, Health } from "../kit";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Notice } from "@renderer/components/ui/notice";
import { LoadingLabel } from "@renderer/components/ui/loading-label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@renderer/components/ui/dialog";
import { toastError } from "@renderer/lib/toast";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";

const PROVIDERS = [
  { id: "brave", name: "Brave" },
  { id: "exa", name: "Exa" },
  { id: "searxng", name: "SearXNG" },
] as const;
type Provider = (typeof PROVIDERS)[number];
export function WebSearchPane() {
  const [view, setView] = React.useState<WebAccessSettingsView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<Provider | null>(null);
  const [draft, setDraft] = React.useState("");
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const reads = useLatestAsync();
  const locked = React.useRef(false);
  const load = React.useCallback(async () => {
    const token = reads.claim();
    try {
      const result = await window.api.webAccess.get();
      if (!reads.isCurrent(token)) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setView(result.settings);
      setError(null);
    } catch (cause) {
      if (reads.isCurrent(token)) setError(errorMessage(cause));
    }
  }, [reads]);
  React.useEffect(() => {
    void load();
    return () => reads.invalidate();
  }, [load, reads]);
  const write = async (run: () => Promise<WebAccessResult>, close = false) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setFieldError(null);
    const token = reads.claim();
    try {
      const result = await run();
      if (!result.ok) {
        if (reads.isCurrent(token)) setFieldError(result.error);
        else toastError(result.error);
        return;
      }
      if (!reads.isCurrent(token)) return;
      setView(result.settings);
      setError(null);
      if (close) {
        setDraft("");
        setEditing(null);
      }
    } catch (cause) {
      if (reads.isCurrent(token)) setFieldError(errorMessage(cause));
      else toastError(errorMessage(cause));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const choose = (provider: WebAccessProvider) =>
    void write(() => window.api.webAccess.setProvider(provider, view?.searxngUrl ?? null));
  const ready = (id: Provider["id"]) =>
    id === "searxng" ? view?.searxngUrl !== null : view?.keys[id] === "present";
  return (
    <>
      <AsyncSection
        title="Search providers"
        icon={GlobeIcon}
        state={
          view
            ? { status: "ready", data: view }
            : error
              ? { status: "error", message: error, onRetry: () => void load() }
              : { status: "loading" }
        }
      >
        {(saved) => (
          <>
            <DataTable
              label="Web search providers"
              items={PROVIDERS}
              keyOf={(p) => p.id}
              rows={4}
              empty="No search providers"
              columns={[
                {
                  key: "provider",
                  header: "Provider",
                  cell: (p) => (
                    <Cell strong>
                      <span className="flex items-center gap-2">
                        <GlobeIcon aria-hidden className="size-4" />
                        {p.name}
                      </span>
                    </Cell>
                  ),
                },
                {
                  key: "status",
                  header: "Status",
                  width: "9rem",
                  cell: (p) => (
                    <Health state={ready(p.id) ? "ready" : "idle"}>
                      {ready(p.id)
                        ? "Configured"
                        : p.id === "searxng"
                          ? "Needs instance"
                          : "Needs key"}
                    </Health>
                  ),
                },
                {
                  key: "key",
                  header: "Credential",
                  width: "8rem",
                  cell: (p) => (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Edit ${p.name} ${p.id === "searxng" ? "instance" : "key"}`}
                      disabled={busy}
                      onClick={() => {
                        setDraft(p.id === "searxng" ? (saved.searxngUrl ?? "") : "");
                        setFieldError(null);
                        setEditing(p);
                      }}
                    >
                      {p.id === "searxng"
                        ? "Edit instance"
                        : ready(p.id)
                          ? "Replace key"
                          : "Add key"}
                    </Button>
                  ),
                },
                {
                  key: "default",
                  header: "Default",
                  width: "5rem",
                  cell: (p) => (
                    <input
                      type="radio"
                      name="web-search-default"
                      aria-label={`Use ${p.name} by default`}
                      checked={saved.provider === p.id}
                      disabled={busy || !ready(p.id)}
                      onChange={() => choose(p.id)}
                      className="accent-primary"
                    />
                  ),
                },
              ]}
            />
            <div className="flex flex-wrap items-center justify-between gap-4 p-4">
              <Health state={saved.provider === "off" ? "idle" : "ready"}>
                {saved.provider === "off"
                  ? "Web search off"
                  : `Web search: ${PROVIDERS.find((p) => p.id === saved.provider)?.name}`}
              </Health>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || saved.provider === "off"}
                onClick={() => choose("off")}
              >
                Turn off
              </Button>
            </div>
          </>
        )}
      </AsyncSection>
      {error && view && (
        <Notice
          tone="error"
          title="Couldn't refresh search settings"
          detail={error}
          actions={
            <Button size="sm" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      )}
      {fieldError && !editing && <Notice announce tone="error" title={fieldError} />}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setEditing(null);
            setDraft("");
            setFieldError(null);
          }
        }}
      >
        <DialogContent showCloseButton={!busy} aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>
              {editing?.name} {editing?.id === "searxng" ? "instance" : "API key"}
            </DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            aria-label={editing?.id === "searxng" ? "Instance address" : "API key"}
            type={editing?.id === "searxng" ? "text" : "password"}
            value={draft}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
          />
          {fieldError && <Notice announce tone="error" title={fieldError} />}
          <DialogFooter>
            {editing && editing.id !== "searxng" && ready(editing.id) && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  const id = editing.id;
                  void write(() => window.api.webAccess.clearKey(id), true);
                }}
              >
                Remove key
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setDraft("");
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={busy || !draft.trim()}
              onClick={() => {
                if (!editing) return;
                const id = editing.id;
                void write(
                  () =>
                    id === "searxng"
                      ? window.api.webAccess.setProvider(id, draft)
                      : window.api.webAccess.setKey(id, draft),
                  true,
                );
              }}
            >
              {busy ? <LoadingLabel>Saving</LoadingLabel> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
