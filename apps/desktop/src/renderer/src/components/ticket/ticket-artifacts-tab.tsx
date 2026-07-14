import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";

/**
 * The Artifacts tab: empty-state placeholder. Step 5 wires up the real
 * `.volli` fs plumbing (project- and ticket-level artifact listing,
 * promote/reference, typeset render + click-to-edit for `.md`, inline images,
 * reveal-in-Finder for everything else — decisions #13/#14/#17).
 */
export function TicketArtifactsTab() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
      <FolderIcon weight="fill" className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">No artifacts yet</p>
    </div>
  );
}
