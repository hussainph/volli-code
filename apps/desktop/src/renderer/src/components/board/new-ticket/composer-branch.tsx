import { Spinner } from "@renderer/components/ui/spinner";
import { LoadingLabel } from "@renderer/components/ui/loading-label";
import {
  ChevronDownIcon,
  CheckIcon,
  CloudDownloadIcon,
  BranchIcon,
} from "@renderer/components/ui/icon";

import * as React from "react";
import { errorMessage } from "@volli/shared";

import {
  baseChipLabel,
  type BranchGroup,
  type BranchListingState,
  groupBranchOptions,
} from "@renderer/components/board/new-ticket/branch-picker";
import { composerChipClass } from "@renderer/components/board/new-ticket/composer-chip";
import { Button } from "@renderer/components/ui/button";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@renderer/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { cn } from "@renderer/lib/utils";
import { notAvailableOn, remoteHostNow } from "@renderer/stores/remote-project";

/**
 * The base branch a new ticket's worktree starts from, picked in the
 * composer's Options panel.
 *
 * The chip carries its VALUE in its accessible name ("Base branch: main"), not
 * just its subject. The value is the whole point of a chip — a name of "Base
 * branch" would tell a screen-reader user what the control is for and withhold
 * the one thing it is showing.
 *
 * A checkout ticket has no branch to create, so Options hides the chip and the
 * base is never persisted for it (see `submit.ts`'s `baseBranchFor`).
 */

/**
 * Reads a project's refs, re-reading on every composer open and on retarget.
 * Loading and failure are distinct states rather than one absent listing: see
 * {@link BranchListingState}.
 */
export function useBranchListing(projectId: string): BranchListingState {
  const [state, setState] = React.useState<BranchListingState>({ status: "loading" });
  const guard = useLatestAsync();

  React.useEffect(() => {
    const token = guard.claim();
    // A remote project's refs are on its host (VC-711): this Mac lists none.
    const host = remoteHostNow(projectId);
    if (host !== null) {
      setState({ status: "failed", error: notAvailableOn(host) });
      return;
    }
    setState({ status: "loading" });
    void (async () => {
      try {
        const result = await window.api.worktree.branches(projectId);
        if (!guard.isCurrent(token)) return;
        setState(
          result.ok
            ? { status: "loaded", listing: result }
            : { status: "failed", error: result.error },
        );
      } catch (caught) {
        if (guard.isCurrent(token)) setState({ status: "failed", error: errorMessage(caught) });
      }
    })();
    return () => guard.invalidate();
  }, [projectId, guard]);

  return state;
}

/**
 * The pickable refs, as a real listbox: arrow keys move through it, the active
 * row carries `aria-selected`, and typing filters without leaving the field.
 * They were plain buttons, which meant Tab through every branch a repo has and
 * nothing telling an assistive reader which one is current — a list this long
 * has to be navigable the way its neighbouring menu is.
 */
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
        <CommandGroup key={group.key} heading={group.heading}>
          {group.options.map((option) => (
            <CommandItem
              key={option.name}
              value={option.name}
              // The closure, never cmdk's callback argument: it hands back the
              // item's value LOWERCASED, and a branch name is case-sensitive.
              onSelect={() => onPick(option.name)}
            >
              <BranchIcon
                className={cn(
                  "size-3.5 shrink-0",
                  option.remote ? "text-muted-foreground" : "text-foreground",
                )}
              />
              <span className="truncate font-mono text-ui text-foreground">{option.name}</span>
              {option.name === value ? (
                <CheckIcon
                  strokeWidth={2.25}
                  className="ml-auto size-3.5 shrink-0 text-foreground"
                />
              ) : null}
            </CommandItem>
          ))}
        </CommandGroup>
      ))}
    </>
  );
}

/** The picker's body — one of four answers, never two of them blurred together. */
function BranchListBody({
  state,
  groups,
  query,
  value,
  onPick,
}: {
  state: BranchListingState;
  groups: BranchGroup[];
  query: string;
  value: string | null;
  onPick: (name: string) => void;
}) {
  if (state.status === "failed") {
    // A repo we cannot read is the one case worth a sentence: the chip alone
    // cannot say why it has nothing to offer.
    return (
      <div className="flex items-start gap-2 px-2 py-2 text-ui text-muted-foreground">
        <CloudDownloadIcon className="mt-px size-3.5 shrink-0" />
        {state.error}
      </div>
    );
  }
  // Loading takes the empty geometry too: it holds the same slot a moment
  // earlier, and a different one would make the list jump as the read lands.
  if (state.status === "loading") {
    return (
      <div className={EMPTY_INLINE}>
        <LoadingLabel>Reading branches</LoadingLabel>
      </div>
    );
  }
  if (groups.length === 0) {
    return (
      <div className="sr-only">{query.trim() === "" ? "No branches" : "No matching branches"}</div>
    );
  }
  return <BranchRows groups={groups} value={value} onPick={onPick} />;
}

export function BaseBranchChip({
  state,
  value,
  onChange,
}: {
  state: BranchListingState;
  value: string | null;
  onChange: (branch: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  // The remote heading dates a SNAPSHOT, so the clock is read when the picker
  // opens. Reading it once per mount would leave a composer left open all
  // afternoon still claiming "fetched 2h ago".
  const [openedAt, setOpenedAt] = React.useState(() => Date.now());

  const handleOpenChange = React.useCallback((next: boolean) => {
    setOpen(next);
    if (!next) return;
    setQuery("");
    setOpenedAt(Date.now());
  }, []);

  const groups = React.useMemo(
    () => groupBranchOptions(state, query, openedAt),
    [state, query, openedAt],
  );
  const label = baseChipLabel(value, state);

  // Options has a fixed width; the base gives up space to the destination,
  // while the full ref stays in the accessible name.
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {/* Never disabled by an unreadable repo: the chip still has to say
            what it will branch from, and "unknown" is the honest answer. */}
        <Button
          aria-label={`Base branch: ${label.spoken}`}
          variant="inspector"
          className={cn(composerChipClass(), "min-w-0 flex-1 justify-start")}
        >
          {state.status === "loading" && value === null ? (
            <Spinner aria-hidden role="presentation" />
          ) : (
            <BranchIcon />
          )}
          <span className="min-w-0 truncate" title={label.text}>
            {label.text}
          </span>
          <ChevronDownIcon strokeWidth={2.25} className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        {/* Our own filter, in the project's recency order — cmdk's would rank by
            match score and flatten the local/remote split the groups exist for. */}
        <Command shouldFilter={false} className="bg-transparent">
          <CommandInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search branches…"
          />
          <CommandList className="max-h-64">
            <BranchListBody
              state={state}
              groups={groups}
              query={query}
              value={value}
              onPick={(name) => {
                onChange(name);
                setOpen(false);
              }}
            />
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The Options panel's branch fields, passed as one object. */
export interface ComposerBranchRowProps {
  state: BranchListingState;
  baseBranch: string | null;
  onBaseBranchChange: (branch: string) => void;
  usesWorktree: boolean;
  onUsesWorktreeChange: (usesWorktree: boolean) => void;
}
