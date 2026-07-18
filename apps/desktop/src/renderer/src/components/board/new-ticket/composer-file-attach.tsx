import * as React from "react";
import { PaperclipIcon } from "@phosphor-icons/react/dist/csr/Paperclip";
import {
  baseNameOf,
  dirNameOf,
  type IndexedFile,
  isExpressibleRefPath,
  scoreFileMatch,
} from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import type { FileIndexHandle } from "@renderer/hooks/use-file-index";

const MAX_RESULTS = 50;

/**
 * The footer paperclip: a repo file picker that ranks the project file index
 * with `scoreFileMatch` (the same ranking the `@` autocomplete uses) and, on
 * pick, inserts `@relative/path` at the description's caret via `onInsert`.
 * Opening the popover kicks a (cache-gated) index refresh so the list is fresh.
 */
export function ComposerFileAttach({
  fileIndex,
  onInsert,
}: {
  fileIndex: FileIndexHandle;
  onInsert: (relPath: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const { refresh } = fileIndex;

  React.useEffect(() => {
    if (open) {
      setQuery("");
      refresh();
    }
  }, [open, refresh]);

  const results = React.useMemo(() => {
    return fileIndex
      .getIndex()
      .filter((file) => isExpressibleRefPath(file.relPath))
      .map((file) => ({ file, score: scoreFileMatch(query, file.relPath) }))
      .filter((entry): entry is { file: IndexedFile; score: number } => entry.score !== null)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS);
    // fileIndex.version changes identity when the cached index updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, fileIndex.version, fileIndex.getIndex]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Attach file reference"
          className="text-muted-foreground hover:text-foreground"
        >
          <PaperclipIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1">
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search files…"
          className="mb-1 h-8 text-sm"
        />
        <div className="max-h-64 overflow-y-auto">
          {results.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">No matching files</div>
          ) : (
            results.map(({ file }) => (
              <button
                key={file.relPath}
                type="button"
                onClick={() => {
                  onInsert(file.relPath);
                  setOpen(false);
                }}
                className="flex w-full items-baseline gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
              >
                <span className="truncate text-foreground">{baseNameOf(file.relPath)}</span>
                <span className="ml-auto truncate text-xs text-muted-foreground">
                  {dirNameOf(file.relPath)}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
