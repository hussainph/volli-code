import { FileIcon } from "@phosphor-icons/react/dist/csr/File";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { UploadSimpleIcon } from "@phosphor-icons/react/dist/csr/UploadSimple";
import type { ArtifactEntry, ArtifactKind } from "@volli/shared";

import { artifactKey } from "@renderer/components/ticket/artifact-list-utils";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { relativeTime } from "@renderer/lib/relative-time";

const KIND_ICONS: Record<ArtifactKind, typeof FileTextIcon> = {
  markdown: FileTextIcon,
  image: ImageIcon,
  other: FileIcon,
};

function ArtifactRow({
  entry,
  selected,
  onSelect,
  onPromote,
}: {
  entry: ArtifactEntry;
  selected: boolean;
  onSelect(): void;
  onPromote?(): void;
}) {
  const KindIcon = KIND_ICONS[entry.kind];
  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-150 ease-out",
        selected ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-accent/60",
      )}
    >
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2">
        <KindIcon weight="fill" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(entry.mtime)}</span>
      </button>
      {onPromote && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Promote to project"
          className="opacity-0 group-hover:opacity-100"
          onClick={onPromote}
        >
          <UploadSimpleIcon />
        </Button>
      )}
    </div>
  );
}

interface ArtifactSectionProps {
  title: string;
  entries: readonly ArtifactEntry[];
  selectedKey: string | null;
  emptyLabel: string;
  onSelect(entry: ArtifactEntry): void;
  onRevealDir(): void;
  /** Present only for the ticket-tier section — project-tier rows have nowhere further to promote to. */
  onPromote?(entry: ArtifactEntry): void;
}

/** One tier's section in the Artifacts tab: header (title + Reveal in Finder) + rows, or an empty state. */
export function ArtifactSection({
  title,
  entries,
  selectedKey,
  emptyLabel,
  onSelect,
  onRevealDir,
  onPromote,
}: ArtifactSectionProps) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Reveal ${title} in Finder`}
          onClick={onRevealDir}
        >
          <FolderOpenIcon />
        </Button>
      </div>
      {entries.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 rounded-md border border-dashed border-border py-6 text-center">
          <p className="text-xs text-muted-foreground">{emptyLabel}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {entries.map((entry) => (
            <ArtifactRow
              key={artifactKey(entry)}
              entry={entry}
              selected={artifactKey(entry) === selectedKey}
              onSelect={() => onSelect(entry)}
              onPromote={onPromote ? () => onPromote(entry) : undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}
