import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CloudArrowDownIcon } from "@phosphor-icons/react/dist/csr/CloudArrowDown";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import * as React from "react";
import { errorMessage, type WorktreeBranchListing } from "@volli/shared";

import {
  type BranchGroup,
  groupBranchOptions,
} from "@renderer/components/board/new-ticket/branch-picker";
import { composerChipClass } from "@renderer/components/board/new-ticket/composer-chip";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Input } from "@renderer/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { cn } from "@renderer/lib/utils";

/**
 * The chip row's branch relationship: `base ▾ → destination ▾`.
 *
 * It reads as a sentence because it is one — this ticket's work starts from
 * that ref and lands in that place. The two chips are independently clickable
 * and sit closer to each other (gap-1) than to the metadata chips (gap-1.5),
 * so the arrow binds them into one statement rather than three loose controls.
 *
 * When the destination is the project checkout there is no branch to create,
 * so the base chip and the arrow are not shown — a base ref would be a control
 * with nothing to act on. That is also why the base is never persisted for a
 * checkout ticket (see `submit.ts`'s `baseBranchFor`).
 */

/** Reads a project's refs, re-reading on every composer open and on retarget. */
export function useBranchListing(projectId: string): {
  listing: WorktreeBranchListing | null;
  error: string | null;
} {
  const [listing, setListing] = React.useState<WorktreeBranchListing | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const guard = useLatestAsync();

  React.useEffect(() => {
    const token = guard.claim();
    setListing(null);
    setError(null);
    void (async () => {
      try {
        const result = await window.api.worktree.branches(projectId);
        if (!guard.isCurrent(token)) return;
        if (result.ok) setListing(result);
        else setError(result.error);
      } catch (caught) {
        if (guard.isCurrent(token)) setError(errorMessage(caught));
      }
    })();
    return () => guard.invalidate();
  }, [projectId, guard]);

  return { listing, error };
}

function BranchRows({
  groups,
  value,
  onPick,
}: {
  groups: BranchGroup[];
  value: string | null;
  onPick: (name: string) => void;
}) {
  return (
    <>
      {groups.map((group) => (
        <div key={group.key}>
          <div className="px-2 pt-2 pb-1 text-label uppercase text-muted-foreground">
            {group.heading}
          </div>
          {group.options.map((option) => (
            <button
              key={option.name}
              type="button"
              onClick={() => onPick(option.name)}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent"
            >
              <GitBranchIcon
                className={cn("size-3.5 shrink-0", option.remote && "text-muted-foreground")}
              />
              <span className="truncate font-mono text-xs text-foreground">{option.name}</span>
              {option.name === value ? (
                <CheckIcon weight="bold" className="ml-auto size-3.5 shrink-0" />
              ) : null}
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

function BaseBranchChip({
  listing,
  error,
  value,
  onChange,
}: {
  listing: WorktreeBranchListing | null;
  error: string | null;
  value: string | null;
  onChange: (branch: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  React.useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const groups = React.useMemo(() => groupBranchOptions(listing, query), [listing, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* Never disabled by an unreadable repo: the chip still has to say
            what it will branch from, and "unknown" is the honest answer. */}
        <Button aria-label="Base branch" variant="ghost" size="sm" className={composerChipClass()}>
          <GitBranchIcon />
          {value ?? (error === null ? "…" : "unknown")}
          <CaretDownIcon weight="bold" className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1">
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search branches…"
          className="mb-1 h-8 text-sm"
        />
        <div className="max-h-64 overflow-y-auto">
          {error !== null ? (
            // A repo we cannot read is the one case worth a sentence: the chip
            // alone cannot say why it has nothing to offer.
            <div className="flex items-start gap-2 px-2 py-2 text-xs text-muted-foreground">
              <CloudArrowDownIcon className="mt-px size-3.5 shrink-0" />
              {error}
            </div>
          ) : groups.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {listing === null ? "Reading branches…" : "No matching branches"}
            </div>
          ) : (
            <BranchRows
              groups={groups}
              value={value}
              onPick={(name) => {
                onChange(name);
                setOpen(false);
              }}
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Where the ticket's work happens. The two options are the two the app can
 * actually honor: its own worktree off the chosen base, or the project's
 * existing checkout — which is `usesWorktree`, the same durable field the
 * footer's switch used to bind, now named by what it produces.
 */
function DestinationChip({
  usesWorktree,
  onChange,
}: {
  usesWorktree: boolean;
  onChange: (usesWorktree: boolean) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Working destination"
          variant="ghost"
          size="sm"
          className={composerChipClass()}
        >
          {usesWorktree ? null : <FolderOpenIcon />}
          {usesWorktree ? "new worktree" : "project checkout"}
          <CaretDownIcon weight="bold" className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={usesWorktree ? "worktree" : "checkout"}
          onValueChange={(next) => onChange(next === "worktree")}
        >
          <DropdownMenuRadioItem value="worktree">New worktree</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="checkout">Project checkout</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ComposerBranchRow({
  listing,
  error,
  baseBranch,
  onBaseBranchChange,
  usesWorktree,
  onUsesWorktreeChange,
}: {
  listing: WorktreeBranchListing | null;
  error: string | null;
  baseBranch: string | null;
  onBaseBranchChange: (branch: string) => void;
  usesWorktree: boolean;
  onUsesWorktreeChange: (usesWorktree: boolean) => void;
}) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      {usesWorktree ? (
        <>
          <BaseBranchChip
            listing={listing}
            error={error}
            value={baseBranch}
            onChange={onBaseBranchChange}
          />
          <ArrowRightIcon
            aria-hidden
            weight="bold"
            className="size-3 shrink-0 text-muted-foreground/60"
          />
        </>
      ) : null}
      <DestinationChip usesWorktree={usesWorktree} onChange={onUsesWorktreeChange} />
    </div>
  );
}
