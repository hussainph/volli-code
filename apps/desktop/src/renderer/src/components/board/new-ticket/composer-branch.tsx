import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CloudArrowDownIcon } from "@phosphor-icons/react/dist/csr/CloudArrowDown";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
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
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@renderer/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
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
 * Both chips carry their VALUE in their accessible name ("Base branch: main"),
 * not just their subject. The value is the whole point of a chip — a name of
 * "Base branch" would tell a screen-reader user what the control is for and
 * withhold the one thing it is showing.
 *
 * When the destination is the project checkout there is no branch to create,
 * so the base chip and the arrow are not shown — a base ref would be a control
 * with nothing to act on. That is also why the base is never persisted for a
 * checkout ticket (see `submit.ts`'s `baseBranchFor`).
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
        <CommandGroup
          key={group.key}
          heading={group.heading}
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-label [&_[cmdk-group-heading]]:uppercase"
        >
          {group.options.map((option) => (
            <CommandItem
              key={option.name}
              value={option.name}
              // The closure, never cmdk's callback argument: it hands back the
              // item's value LOWERCASED, and a branch name is case-sensitive.
              onSelect={() => onPick(option.name)}
            >
              <GitBranchIcon
                className={cn(
                  "size-3.5 shrink-0",
                  option.remote ? "text-muted-foreground" : "text-foreground",
                )}
              />
              <span className="truncate font-mono text-xs text-foreground">{option.name}</span>
              {option.name === value ? (
                <CheckIcon weight="bold" className="ml-auto size-3.5 shrink-0 text-foreground" />
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
      <div className="flex items-start gap-2 px-2 py-2 text-xs text-muted-foreground">
        <CloudArrowDownIcon className="mt-px size-3.5 shrink-0" />
        {state.error}
      </div>
    );
  }
  if (state.status === "loading") {
    return <div className="px-2 py-2 text-xs text-muted-foreground">Reading branches…</div>;
  }
  if (groups.length === 0) {
    return (
      <div className="px-2 py-2 text-xs text-muted-foreground">
        {query.trim() === "" ? "No branches" : "No matching branches"}
      </div>
    );
  }
  return <BranchRows groups={groups} value={value} onPick={onPick} />;
}

function BaseBranchChip({
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

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {/* Never disabled by an unreadable repo: the chip still has to say
            what it will branch from, and "unknown" is the honest answer. */}
        <Button
          aria-label={`Base branch: ${label.spoken}`}
          variant="ghost"
          size="sm"
          className={composerChipClass()}
        >
          <GitBranchIcon />
          {label.text}
          <CaretDownIcon weight="bold" className="size-3" />
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
  const label = usesWorktree ? "new worktree" : "project checkout";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`Working destination: ${label}`}
          variant="ghost"
          size="sm"
          className={composerChipClass()}
        >
          {usesWorktree ? null : <FolderOpenIcon />}
          {label}
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

/** The `base → destination` pair. One prop object: it is one statement. */
export interface ComposerBranchRowProps {
  state: BranchListingState;
  baseBranch: string | null;
  onBaseBranchChange: (branch: string) => void;
  usesWorktree: boolean;
  onUsesWorktreeChange: (usesWorktree: boolean) => void;
}

export function ComposerBranchRow({
  state,
  baseBranch,
  onBaseBranchChange,
  usesWorktree,
  onUsesWorktreeChange,
}: ComposerBranchRowProps) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      {usesWorktree ? (
        <>
          <BaseBranchChip state={state} value={baseBranch} onChange={onBaseBranchChange} />
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
