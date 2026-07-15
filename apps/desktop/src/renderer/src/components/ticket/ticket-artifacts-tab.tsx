import * as React from "react";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { errorMessage, type ArtifactEntry, type ArtifactTier } from "@volli/shared";
import { toast } from "sonner";

import { artifactKey, groupArtifactsByTier } from "@renderer/components/ticket/artifact-list-utils";
import { ArtifactSection } from "@renderer/components/ticket/artifact-list";
import { ArtifactViewer } from "@renderer/components/ticket/artifact-viewer";
import { NewArtifactDialog } from "@renderer/components/ticket/new-artifact-dialog";
import { Button } from "@renderer/components/ui/button";

/**
 * The Artifacts tab: the `.volli` filesystem-as-truth surface (ticket-detail-mvp
 * decisions #13/#14/#17). Two tiers, both visible from the ticket — the
 * project tier IS the reference surface for now (the two-way relationship
 * decision): "Ticket artifacts" (this ticket's `.volli/tickets/<ID>/artifacts/`)
 * and "Project artifacts" (`.volli/artifacts/`, promote's destination).
 * Subscribes to `api.artifacts.onChanged` for the mount's lifetime so the
 * list (and, loosely, the open viewer) stay live while an agent session
 * writes to either directory.
 */
export function TicketArtifactsTab({
  projectId,
  ticketId,
}: {
  projectId: string;
  ticketId: string;
}) {
  const [entries, setEntries] = React.useState<ArtifactEntry[] | null>(null);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [justCreatedKey, setJustCreatedKey] = React.useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = React.useState(0);
  const [newArtifactOpen, setNewArtifactOpen] = React.useState(false);

  const fetchList = React.useCallback(async () => {
    const result = await window.api.artifacts.list({ projectId, ticketId });
    if (!result.ok) {
      toast.error(`Could not load artifacts: ${result.error}`);
      setEntries([]);
      return;
    }
    setEntries(result.entries);
  }, [projectId, ticketId]);

  React.useEffect(() => {
    void fetchList();
    // Surface a watcher-setup failure instead of silently discarding it: the
    // tab still works (the initial fetch above ran), but the list won't refresh
    // live, so tell the user once, non-blocking.
    void window.api.artifacts.subscribe({ projectId, ticketId }).then((result) => {
      if (!result.ok) {
        toast.error(
          "Live artifact updates unavailable. New artifacts may not appear until you reopen this tab.",
        );
      }
    });
    const unsubscribeListener = window.api.artifacts.onChanged((event) => {
      if (event.projectId !== projectId || event.ticketId !== ticketId) return;
      setRefreshSignal((n) => n + 1);
      void fetchList();
    });
    return () => {
      unsubscribeListener();
      void window.api.artifacts.unsubscribe({ projectId, ticketId });
    };
  }, [projectId, ticketId, fetchList]);

  // A promote/external-delete can make the selected row disappear from its
  // section — drop the stale selection rather than pointing the viewer at
  // nothing.
  React.useEffect(() => {
    if (entries === null || selectedKey === null) return;
    if (!entries.some((entry) => artifactKey(entry) === selectedKey)) setSelectedKey(null);
  }, [entries, selectedKey]);

  const grouped = React.useMemo(() => groupArtifactsByTier(entries ?? []), [entries]);
  const selectedEntry = React.useMemo(
    () => entries?.find((entry) => artifactKey(entry) === selectedKey) ?? null,
    [entries, selectedKey],
  );

  function handleSelect(entry: ArtifactEntry) {
    const key = artifactKey(entry);
    setSelectedKey(key);
    if (key !== justCreatedKey) setJustCreatedKey(null);
  }

  async function handleCreate(
    name: string,
  ): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
    const result = await window.api.artifacts.create({ projectId, ticketId, name });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, name: result.entry.name };
  }

  function handleCreated(name: string) {
    const key = artifactKey({ tier: "ticket", name });
    setJustCreatedKey(key);
    setSelectedKey(key);
    void fetchList();
  }

  async function handlePromote(entry: ArtifactEntry) {
    const result = await window.api.artifacts.promote({ projectId, ticketId, name: entry.name });
    if (!result.ok) {
      toast.error(`Could not promote ${entry.name}: ${result.error}`);
      return;
    }
    await fetchList();
    setSelectedKey(artifactKey(result.entry));
  }

  async function handleRevealDir(tier: ArtifactTier) {
    try {
      const result = await window.api.artifacts.revealDir({ projectId, ticketId, tier });
      if (!result.ok) toast.error(`Could not reveal in Finder: ${result.error}`);
    } catch (error) {
      toast.error(`Could not reveal in Finder: ${errorMessage(error)}`);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 gap-6 px-gutter py-4">
      <div className="flex w-72 shrink-0 flex-col gap-5 overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground">Artifacts</h2>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="New artifact"
            onClick={() => setNewArtifactOpen(true)}
          >
            <PlusIcon />
          </Button>
        </div>
        {entries === null ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            <ArtifactSection
              title="Ticket artifacts"
              entries={grouped.ticket}
              selectedKey={selectedKey}
              emptyLabel="No ticket artifacts yet"
              onSelect={handleSelect}
              onRevealDir={() => void handleRevealDir("ticket")}
              onPromote={(entry) => void handlePromote(entry)}
            />
            <ArtifactSection
              title="Project artifacts"
              entries={grouped.project}
              selectedKey={selectedKey}
              emptyLabel="No project artifacts yet"
              onSelect={handleSelect}
              onRevealDir={() => void handleRevealDir("project")}
            />
          </>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {selectedEntry ? (
          <ArtifactViewer
            key={artifactKey(selectedEntry)}
            projectId={projectId}
            ticketId={ticketId}
            entry={selectedEntry}
            refreshSignal={refreshSignal}
            startInEditMode={artifactKey(selectedEntry) === justCreatedKey}
            onSaved={() => void fetchList()}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
            <FolderIcon weight="fill" className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Select an artifact to view it</p>
          </div>
        )}
      </div>
      <NewArtifactDialog
        open={newArtifactOpen}
        onOpenChange={setNewArtifactOpen}
        onCreate={handleCreate}
        onCreated={handleCreated}
      />
    </div>
  );
}
