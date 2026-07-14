import * as React from "react";
import { FloppyDiskIcon } from "@phosphor-icons/react/dist/csr/FloppyDisk";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { errorMessage, type ArtifactEntry } from "@volli/shared";
import { toast } from "sonner";

import { ArtifactContent } from "@renderer/components/ticket/artifact-content";
import { Button } from "@renderer/components/ui/button";

interface ArtifactViewerProps {
  projectId: string;
  ticketId: string;
  entry: ArtifactEntry;
  /** Bumped by the tab's `onChanged` subscription — triggers a background re-fetch while not mid-edit. */
  refreshSignal: number;
  /** True right after this artifact was just created via "New artifact" — opens straight into edit mode. */
  startInEditMode?: boolean;
  /** Lets the tab refetch the list (mtime/size changed) after a successful save. */
  onSaved?(): void;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "text"; content: string }
  | { status: "image"; dataUrl: string }
  | { status: "other" };

/**
 * The Artifacts tab's content pane for whichever row is selected (decision
 * #17): markdown gets a view/edit toggle (`ArtifactContent` for view, a
 * plain textarea + explicit Save for edit — no autosave here), an image
 * renders inline via a base64 `data:` URI, anything else is a name row +
 * Reveal in Finder. Meant to be mounted with `key={artifactKey(entry)}` at
 * the call site so a selection change remounts it fresh — this component
 * only needs to react to `refreshSignal` while it stays mounted for the same
 * selection.
 */
export function ArtifactViewer({
  projectId,
  ticketId,
  entry,
  refreshSignal,
  startInEditMode = false,
  onSaved,
}: ArtifactViewerProps) {
  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const [editing, setEditing] = React.useState(startInEditMode && entry.kind === "markdown");
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  // Read via a ref (not a `load` dependency) so the background-refresh effect
  // below can skip clobbering an in-progress, unsaved edit without needing
  // `load` itself to change identity (and re-run) every time `editing` toggles.
  const editingRef = React.useRef(editing);
  React.useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  const load = React.useCallback(async () => {
    if (entry.kind === "markdown") {
      const result = await window.api.artifacts.read({
        projectId,
        ticketId,
        tier: entry.tier,
        name: entry.name,
      });
      if (!result.ok) {
        setState({ status: "error", error: result.error });
        return;
      }
      setState({ status: "text", content: result.content });
      setDraft(result.content);
    } else if (entry.kind === "image") {
      const result = await window.api.artifacts.readImage({
        projectId,
        ticketId,
        tier: entry.tier,
        name: entry.name,
      });
      if (!result.ok) {
        setState({ status: "error", error: result.error });
        return;
      }
      setState({ status: "image", dataUrl: result.dataUrl });
    } else {
      setState({ status: "other" });
    }
  }, [projectId, ticketId, entry.tier, entry.name, entry.kind]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Skips the very first run — the effect above already covers the initial
  // load; this one only reacts to LATER `refreshSignal` bumps.
  const skippedInitialRefresh = React.useRef(false);
  React.useEffect(() => {
    if (!skippedInitialRefresh.current) {
      skippedInitialRefresh.current = true;
      return;
    }
    if (editingRef.current) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on refreshSignal alone; `load` is stable per entry.
  }, [refreshSignal]);

  async function handleSave() {
    // Never write until the content has actually loaded: `draft` starts "" and
    // is only seeded once the async read resolves, so a Save fired during the
    // load window would blank the file (worst on a just-created artifact opened
    // straight into edit mode). The Save affordance is gated the same way below.
    if (state.status !== "text") return;
    setSaving(true);
    const result = await window.api.artifacts.write({
      projectId,
      ticketId,
      tier: entry.tier,
      name: entry.name,
      content: draft,
    });
    setSaving(false);
    if (!result.ok) {
      toast.error(`Could not save ${entry.name}: ${result.error}`);
      return;
    }
    setState({ status: "text", content: draft });
    setEditing(false);
    onSaved?.();
  }

  async function handleReveal() {
    try {
      const result = await window.api.artifacts.revealDir({
        projectId,
        ticketId,
        tier: entry.tier,
      });
      if (!result.ok) toast.error(`Could not reveal in Finder: ${result.error}`);
    } catch (error) {
      toast.error(`Could not reveal in Finder: ${errorMessage(error)}`);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-foreground">{entry.name}</span>
        <div className="flex shrink-0 items-center gap-1">
          {entry.kind === "markdown" && !editing && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Edit"
              onClick={() => setEditing(true)}
            >
              <PencilSimpleIcon />
            </Button>
          )}
          {entry.kind === "markdown" && editing && state.status === "text" && (
            <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
              <FloppyDiskIcon />
              Save
            </Button>
          )}
          {entry.kind === "other" && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Reveal in Finder"
              onClick={() => void handleReveal()}
            >
              <FolderOpenIcon />
            </Button>
          )}
        </div>
      </div>

      {state.status === "loading" && <p className="text-xs text-muted-foreground">Loading…</p>}
      {state.status === "error" && <p className="text-xs text-destructive">{state.error}</p>}
      {state.status === "text" &&
        (editing ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-24 flex-1 resize-none rounded-md border border-border bg-transparent p-3 font-mono text-xs text-foreground outline-none focus-visible:border-ring"
          />
        ) : (
          <ArtifactContent content={state.content} />
        ))}
      {state.status === "image" && (
        <img
          src={state.dataUrl}
          alt={entry.name}
          className="max-h-full max-w-full self-start rounded-md border border-border object-contain"
        />
      )}
      {state.status === "other" && (
        <p className="text-xs text-muted-foreground">
          {entry.name} can't be previewed here — use Reveal in Finder.
        </p>
      )}
    </div>
  );
}
