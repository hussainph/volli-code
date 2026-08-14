/**
 * PROTOTYPE — the selected Calm Stack with compact inline properties and a
 * balanced repository action row.
 *
 * The question: does Compare give Publish an honest, visually balanced GitHub
 * companion without turning the summary into a repository toolbar?
 */
import * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/dist/csr/ChatCircleDots";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { FileCodeIcon } from "@phosphor-icons/react/dist/csr/FileCode";
import { FlagIcon } from "@phosphor-icons/react/dist/csr/Flag";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { GitCommitIcon } from "@phosphor-icons/react/dist/csr/GitCommit";
import { GitDiffIcon } from "@phosphor-icons/react/dist/csr/GitDiff";
import { GitPullRequestIcon } from "@phosphor-icons/react/dist/csr/GitPullRequest";
import { GithubLogoIcon } from "@phosphor-icons/react/dist/csr/GithubLogo";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { MoonIcon } from "@phosphor-icons/react/dist/csr/Moon";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { SunIcon } from "@phosphor-icons/react/dist/csr/Sun";
import { TagIcon } from "@phosphor-icons/react/dist/csr/Tag";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { Button } from "@renderer/components/ui/button";
import { ButtonGroup } from "@renderer/components/ui/button-group";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";

export const title = "Ticket · Right sidebar redesign";
export const note = "Selected Calm Stack with inline Details and balanced repository actions";
export const viewport = "window" as const;

type RailMode = "now" | "changes" | "files";
type Variant = "calm" | "toolbar" | "linear";
type Scenario = "dirty" | "clean" | "loading" | "paused" | "no-worktree";
type RailWidth = 240 | 300 | 420;
type Appearance = "dark" | "light";

const MODES: ReadonlyArray<{ key: RailMode; label: string; icon: PhosphorIcon }> = [
  { key: "now", label: "Now", icon: ChatCircleDotsIcon },
  { key: "changes", label: "Diffs", icon: GitDiffIcon },
  { key: "files", label: "Files", icon: FoldersIcon },
];

interface ChangeRow {
  path: string;
  status: "Modified" | "Added" | "Renamed";
  additions: number;
  deletions: number;
}

const CHANGES: readonly ChangeRow[] = [
  {
    path: "apps/desktop/src/renderer/src/components/ticket/ticket-rail.tsx",
    status: "Modified",
    additions: 86,
    deletions: 31,
  },
  {
    path: "apps/desktop/src/renderer/src/components/ticket/ticket-properties.tsx",
    status: "Modified",
    additions: 42,
    deletions: 118,
  },
  {
    path: "apps/desktop/src/renderer/src/components/ui/tabs-subtle.tsx",
    status: "Added",
    additions: 124,
    deletions: 0,
  },
  {
    path: "apps/desktop/src/renderer/src/components/ticket/ticket-environment-summary.tsx",
    status: "Renamed",
    additions: 29,
    deletions: 17,
  },
];

const CHANGE_STATUS: Record<ChangeRow["status"], { icon: PhosphorIcon; ink: string }> = {
  Modified: { icon: GitDiffIcon, ink: "text-attention" },
  Added: { icon: PlusIcon, ink: "text-positive" },
  Renamed: { icon: ArrowRightIcon, ink: "text-info" },
};

const FILES = [
  { path: "apps/desktop/src/renderer/src/components/ticket", kind: "directory" as const },
  {
    path: "apps/desktop/src/renderer/src/components/ticket/ticket-rail.tsx",
    kind: "file" as const,
  },
  {
    path: "apps/desktop/src/renderer/src/components/ticket/ticket-properties.tsx",
    kind: "file" as const,
  },
  { path: "docs/DESIGN.md", kind: "reference" as const },
  { path: "CONTEXT.md", kind: "reference" as const },
] as const;

function splitPath(path: string): { filename: string; parent: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1
    ? { filename: path, parent: "" }
    : { filename: path.slice(slash + 1), parent: path.slice(0, slash) };
}

function Hint({
  label,
  children,
  side = "bottom",
}: {
  label: string;
  children: React.ReactElement;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function ActiveLabelTabs({
  mode,
  onMode,
  modes,
  variant,
  reducedMotion,
  homeLabel,
  narrow,
}: {
  mode: RailMode;
  onMode(mode: RailMode): void;
  modes: ReadonlyArray<{ key: RailMode; label: string; icon: PhosphorIcon }>;
  variant: Variant;
  reducedMotion: boolean;
  homeLabel: "Now" | "Sessions";
  narrow: boolean;
}) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const [animateSelection, setAnimateSelection] = React.useState(true);

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? modes.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + modes.length) % modes.length;
    const nextMode = modes[next];
    if (nextMode === undefined) return;
    setAnimateSelection(false);
    onMode(nextMode.key);
    refs.current[next]?.focus();
  }

  return (
    <div
      className={cn(
        "sticky top-0 z-20 shrink-0 pt-3 pb-3 backdrop-blur-xl",
        narrow ? "px-3" : "px-4",
        variant === "toolbar" ? "bg-sidebar/95" : "bg-sidebar/80",
      )}
    >
      <div
        role="tablist"
        aria-label="Ticket sidebar pages"
        className={cn(
          "flex h-10 items-center gap-0.5 p-1",
          variant === "calm" &&
            cn(
              "mx-auto rounded-full border border-sidebar-border bg-background/75 shadow-sm",
              modes.length === 3 ? "w-40" : "w-[194px]",
            ),
          variant === "toolbar" && "w-full justify-between rounded-lg bg-sidebar-accent/70",
          variant === "linear" &&
            cn("mx-auto rounded-full bg-background/35", modes.length === 3 ? "w-40" : "w-[194px]"),
        )}
      >
        {modes.map((item, index) => {
          const active = mode === item.key;
          const Icon = item.icon;
          const label = item.key === "now" ? homeLabel : item.label;
          const button = (
            <motion.button
              layout={animateSelection && !reducedMotion}
              transition={
                animateSelection && !reducedMotion
                  ? { type: "spring", duration: 0.32, bounce: 0.1 }
                  : { duration: 0 }
              }
              key={item.key}
              ref={(node) => {
                refs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`rail-tab-${item.key}`}
              aria-controls={`rail-panel-${item.key}`}
              aria-selected={active}
              aria-label={label}
              tabIndex={active ? 0 : -1}
              onClick={() => {
                setAnimateSelection(true);
                onMode(item.key);
              }}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "relative flex h-8 items-center justify-center gap-1.5 overflow-hidden rounded-full text-ui outline-none",
                variant === "toolbar" ? "min-w-8 flex-1 px-2" : active ? "w-[84px]" : "w-8",
                "focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 active:scale-[0.97]",
                !reducedMotion &&
                  "transition-[color,background-color,box-shadow,transform] duration-150 [transition-timing-function:cubic-bezier(0.23,1,0.32,1)]",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-xs"
                  : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
              )}
            >
              <motion.span layout="position" className="flex shrink-0 items-center">
                <Icon className="size-3.5" weight="regular" />
              </motion.span>
              <AnimatePresence initial={false} mode="popLayout">
                {active ? (
                  <motion.span
                    key={`${item.key}-label`}
                    initial={
                      animateSelection && !reducedMotion
                        ? { opacity: 0, transform: "translateX(-4px)" }
                        : false
                    }
                    animate={{ opacity: 1, transform: "translateX(0)" }}
                    exit={
                      animateSelection && !reducedMotion
                        ? { opacity: 0, transform: "translateX(3px)" }
                        : { opacity: 0 }
                    }
                    transition={{
                      duration: reducedMotion ? 0 : 0.14,
                      ease: [0.23, 1, 0.32, 1],
                    }}
                    className="whitespace-nowrap"
                  >
                    {label}
                  </motion.span>
                ) : null}
              </AnimatePresence>
            </motion.button>
          );
          return (
            <Tooltip key={item.key} open={active ? false : undefined}>
              <TooltipTrigger asChild>{button}</TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

function DiffTotals({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 font-mono font-medium tabular-nums",
        compact ? "text-xs" : "text-ui",
      )}
    >
      <span className="text-positive">+281</span>
      <span className="text-destructive">−166</span>
    </span>
  );
}

function RepositoryPopover({
  children,
  noWorktree,
}: {
  children: React.ReactNode;
  noWorktree: boolean;
}) {
  const currentBranch = noWorktree ? "main" : "ui/right-sidebar-fixes";
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <div className="flex flex-col gap-1">
          <div className="px-2 pt-1 pb-2">
            <p className="mb-1.5 text-label font-medium uppercase text-muted-foreground">Branch</p>
            <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
              {noWorktree ? null : (
                <>
                  <span className="shrink-0 text-muted-foreground">main</span>
                  <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground" />
                </>
              )}
              <span className="min-w-0 truncate font-medium text-foreground">{currentBranch}</span>
            </div>
          </div>
          <div className="mx-2 h-px bg-border" />
          <button
            type="button"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui hover:bg-accent"
          >
            <FolderIcon weight="fill" />
            Reveal worktree in Finder
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CommitDialog({ onComplete }: { onComplete(message: string): void }) {
  const [message, setMessage] = React.useState("");
  const [includeUnstaged, setIncludeUnstaged] = React.useState(true);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="min-w-0 border-sidebar-border bg-background/35 px-2.5 text-xs shadow-xs"
        >
          <GitCommitIcon />
          <span>Publish</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md gap-5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranchIcon />
            ui/right-sidebar-fixes
          </DialogTitle>
        </DialogHeader>
        <Input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Commit message (leave blank to generate)…"
          className="h-10"
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeUnstaged}
            onChange={(event) => setIncludeUnstaged(event.target.checked)}
            className="accent-primary"
          />
          Include unstaged changes
          <DiffTotals compact />
        </label>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <DialogClose asChild>
            <Button onClick={() => onComplete(message.trim() || "Generated commit message")}>
              Commit &amp; push
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PublishControl({
  onComplete,
  onCompare,
  narrow,
}: {
  onComplete(message: string): void;
  onCompare(): void;
  narrow: boolean;
}) {
  return (
    <div className="flex w-full items-center justify-between gap-2">
      <ButtonGroup aria-label="Publish repository changes">
        <CommitDialog onComplete={onComplete} />
        <Popover>
          <Hint label="More repository actions" side="top">
            <PopoverTrigger asChild>
              <Button
                size="icon-sm"
                variant="outline"
                className="border-sidebar-border bg-background/35 shadow-xs"
                aria-label="More repository actions"
              >
                <DotsThreeIcon weight="bold" />
              </Button>
            </PopoverTrigger>
          </Hint>
          <PopoverContent align="end" className="w-48 p-1">
            {[
              [GitCommitIcon, "Commit"],
              [GitPullRequestIcon, "Push"],
              [ArrowSquareOutIcon, "Open pull request"],
            ].map(([Icon, label]) => (
              <button
                key={label as string}
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui hover:bg-accent"
              >
                <Icon weight="fill" />
                {label as string}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      </ButtonGroup>
      <Hint label="Compare ui/right-sidebar-fixes with main on GitHub" side="top">
        <Button
          size="sm"
          variant="outline"
          aria-label="Compare branch with main on GitHub"
          className="border-sidebar-border bg-background/35 px-2.5 text-xs shadow-xs"
          onClick={onCompare}
        >
          {narrow ? null : <GithubLogoIcon weight="fill" />}
          Compare
        </Button>
      </Hint>
    </div>
  );
}

function ScenarioState({
  scenario,
  kind,
}: {
  scenario: Scenario;
  kind: "now" | "changes" | "files";
}) {
  if (scenario === "loading") {
    return (
      <div className="flex flex-col gap-2 p-3" aria-label={`Loading ${kind}`}>
        {["w-4/5", "w-3/5", "w-full"].map((width) => (
          <div
            key={width}
            className={cn("h-8 animate-pulse rounded-md bg-sidebar-accent/70", width)}
          />
        ))}
      </div>
    );
  }
  return null;
}

function PausedBanner({ narrow = false }: { narrow?: boolean }) {
  return (
    <div
      className={cn(
        "mb-2 flex items-center gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-2.5 py-2 text-xs text-destructive",
        narrow ? "mx-3" : "mx-4",
      )}
    >
      <WarningIcon weight="fill" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">Updates paused</span>
      <button type="button" className="flex items-center gap-1 font-medium hover:underline">
        <ArrowClockwiseIcon />
        Retry
      </button>
    </div>
  );
}

function EnvironmentSummary({
  variant,
  scenario,
  onComplete,
  onCompare,
  onShowChanges,
  narrow,
}: {
  variant: Variant;
  scenario: Scenario;
  onComplete(message: string): void;
  onCompare(): void;
  onShowChanges(): void;
  narrow: boolean;
}) {
  const clean = scenario === "clean";
  const noWorktree = scenario === "no-worktree";
  const currentBranch = noWorktree
    ? "main"
    : narrow
      ? "right-sidebar-fixes"
      : "ui/right-sidebar-fixes";
  const content = (
    <>
      <button
        type="button"
        onClick={onShowChanges}
        aria-label={clean ? "No changes, show Diffs" : "4 changes, show Diffs"}
        className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-[14px] pt-3 pb-2.5 text-left hover:bg-sidebar-accent/45"
      >
        <span className="flex min-w-0 items-center gap-2">
          <GitDiffIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-ui font-medium">{clean ? "No changes" : "4 changes"}</span>
        </span>
        {clean ? <CheckCircleIcon className="text-positive" /> : <DiffTotals compact />}
      </button>
      <RepositoryPopover noWorktree={noWorktree}>
        <button
          type="button"
          aria-label={
            noWorktree ? "Project branch main" : "Branch from main to ui/right-sidebar-fixes"
          }
          className="flex min-h-8 w-full items-center gap-2 border-t border-sidebar-border/70 px-[14px] py-2.5 text-left hover:bg-sidebar-accent/45"
        >
          <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
          {noWorktree ? null : (
            <>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">main</span>
              <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground" />
            </>
          )}
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-mono text-xs",
              noWorktree ? "text-foreground" : "text-sidebar-foreground",
            )}
          >
            {currentBranch}
          </span>
          <CaretDownIcon className="size-3 text-muted-foreground" />
        </button>
      </RepositoryPopover>
      {!clean && !noWorktree ? (
        <div className="border-t border-sidebar-border/70 px-[14px] py-2.5">
          <PublishControl onComplete={onComplete} onCompare={onCompare} narrow={narrow} />
        </div>
      ) : null}
    </>
  );

  if (variant === "calm") {
    return (
      // The lift is `var(--shadow-raised)`, the generated tier-1 shadow. This
      // read `hsl(var(--foreground)/0.06)` when it was reviewed, and
      // `--foreground` is a hex — so the whole `box-shadow` was invalid and the
      // browser dropped it, which is why the card that shipped from this scratch
      // is flat (`ticket-repository-summary.tsx` says so at its own return).
      // Copy the token, never the hsl() form: no color token in this app is
      // channel-triplet shaped.
      <section
        className={cn(
          "overflow-hidden rounded-xl border border-sidebar-border/70 bg-background/55 shadow-[var(--shadow-raised)] dark:bg-sidebar-accent/45 dark:shadow-none",
          narrow ? "mx-3" : "mx-4",
        )}
      >
        {content}
      </section>
    );
  }
  if (variant === "toolbar") {
    return <section className="border-y border-sidebar-border px-2 py-1.5">{content}</section>;
  }
  return <section className="px-3">{content}</section>;
}

function SessionRows({ variant, narrow }: { variant: Variant; narrow: boolean }) {
  const rows = [
    { title: "Right sidebar redesign", detail: "Waiting for you", tone: "bg-attention" },
    { title: "Architecture audit", detail: "Working", tone: "bg-positive" },
    { title: "Previous implementation", detail: "18m ago", tone: "bg-muted-foreground/30" },
  ];
  return (
    <section
      className={cn(
        "flex flex-col pb-8",
        variant === "calm" ? cn("gap-1 pt-5", narrow ? "px-3" : "px-4") : "px-2 pt-4",
      )}
    >
      <div className="flex items-center justify-between px-2 pb-1.5">
        <h2 className="text-label font-medium uppercase text-muted-foreground">Sessions</h2>
        <Hint label="New session" side="left">
          <Button size="icon-xs" variant="ghost" aria-label="New session">
            <PlusIcon weight="bold" />
          </Button>
        </Hint>
      </div>
      {rows.map((row, index) => (
        <button
          key={row.title}
          type="button"
          className={cn(
            "flex w-full items-center gap-2 px-2 py-2 text-left hover:bg-sidebar-accent/60",
            variant === "calm" &&
              "rounded-lg border border-transparent hover:border-sidebar-border",
            variant === "linear" && index > 0 && "border-t border-sidebar-border/70",
          )}
        >
          <ChatCircleDotsIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-ui">{row.title}</span>
          <span className="flex shrink-0 items-center gap-1.5 text-label text-muted-foreground">
            <span className={cn("size-1.5 rounded-full", row.tone)} />
            {row.detail}
          </span>
        </button>
      ))}
    </section>
  );
}

function NowPanel({
  variant,
  scenario,
  onComplete,
  onCompare,
  onShowChanges,
  narrow,
}: {
  variant: Variant;
  scenario: Scenario;
  onComplete(message: string): void;
  onCompare(): void;
  onShowChanges(): void;
  narrow: boolean;
}) {
  if (scenario === "loading") {
    return <ScenarioState scenario={scenario} kind="now" />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [scroll-padding-bottom:2rem]">
      {variant === "toolbar" ? (
        <div className="flex items-center justify-between px-4 pb-2">
          <div>
            <p className="text-ui font-medium">Current session</p>
            <p className="text-xs text-muted-foreground">Local · ui/right-sidebar-fixes</p>
          </div>
          <DiffTotals compact />
        </div>
      ) : null}
      {scenario === "paused" ? <PausedBanner narrow={narrow} /> : null}
      <EnvironmentSummary
        variant={variant}
        scenario={scenario}
        onComplete={onComplete}
        onCompare={onCompare}
        onShowChanges={onShowChanges}
        narrow={narrow}
      />
      <PropertiesSection narrow={narrow} />
      <SessionRows variant={variant} narrow={narrow} />
    </div>
  );
}

function RowActions({
  path,
  onOpen,
  className,
}: {
  path: string;
  onOpen(path: string): void;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100",
        className,
      )}
    >
      <Hint label={copied ? "Path copied" : "Copy path"} side="top">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Copy ${path}`}
          onClick={(event) => {
            event.stopPropagation();
            void navigator.clipboard?.writeText(path);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 900);
          }}
        >
          {copied ? <CheckCircleIcon /> : <CopyIcon />}
        </Button>
      </Hint>
      <Hint label="Open in tab" side="top">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Open ${path} in tab`}
          onClick={(event) => {
            event.stopPropagation();
            onOpen(path);
          }}
        >
          <ArrowSquareOutIcon />
        </Button>
      </Hint>
    </span>
  );
}

function ChangesPanel({
  variant,
  scenario,
  onOpen,
  narrow,
}: {
  variant: Variant;
  scenario: Scenario;
  onOpen(path: string): void;
  narrow: boolean;
}) {
  const [query, setQuery] = React.useState("");
  const [searching, setSearching] = React.useState(false);
  const [selected, setSelected] = React.useState(CHANGES[0]?.path ?? null);
  if (scenario === "loading") {
    return <ScenarioState scenario={scenario} kind="changes" />;
  }
  if (scenario === "clean") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <header
          className={cn("flex min-h-7 items-center gap-1 pt-1 pb-3", narrow ? "px-3" : "px-4")}
        >
          <p className="text-ui font-medium">Diffs</p>
          <span className="rounded-full bg-sidebar-accent px-1.5 font-mono text-label text-muted-foreground">
            0
          </span>
        </header>
        <div
          className={cn(
            "flex items-start gap-2.5 rounded-lg border border-sidebar-border/70 bg-background/35 p-3",
            narrow ? "mx-3" : "mx-4",
          )}
        >
          <CheckCircleIcon className="mt-0.5 size-4 shrink-0 text-positive" weight="fill" />
          <div>
            <p className="text-ui font-medium">No changes vs main</p>
            <p className="mt-0.5 text-xs text-muted-foreground">The branch is up to date.</p>
          </div>
        </div>
      </div>
    );
  }
  const rows = CHANGES.filter((row) => row.path.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className={cn("flex shrink-0 flex-col gap-2 pt-1 pb-3", narrow ? "px-3" : "px-4")}>
        <div className="flex min-h-7 items-center gap-1">
          <p className="text-ui font-medium">Diffs</p>
          <span className="rounded-full bg-sidebar-accent px-1.5 font-mono text-label text-muted-foreground">
            4
          </span>
          <Hint label="Refresh changes">
            <Button size="icon-sm" variant="ghost" aria-label="Refresh changes">
              <ArrowClockwiseIcon />
            </Button>
          </Hint>
          <Hint label="Filter changed files">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Filter changed files"
              aria-pressed={searching}
              onClick={() => setSearching((value) => !value)}
            >
              <MagnifyingGlassIcon />
            </Button>
          </Hint>
          <span className="min-w-1 flex-1" />
          <DiffTotals compact />
        </div>
        {searching ? (
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter changed files…"
            className="h-7 text-ui"
          />
        ) : null}
      </header>
      {scenario === "paused" ? <PausedBanner narrow={narrow} /> : null}
      <ul
        className={cn(
          "min-h-0 flex-1 overflow-y-auto pb-8 [scroll-padding-bottom:2rem]",
          variant === "calm" ? "px-2" : "border-t border-sidebar-border",
        )}
      >
        {rows.map((row) => {
          const { filename, parent } = splitPath(row.path);
          const active = selected === row.path;
          const status = CHANGE_STATUS[row.status];
          const StatusIcon = status.icon;
          return (
            <li key={row.path}>
              <div
                className={cn(
                  "group relative w-full text-left",
                  variant === "calm" ? "rounded-lg" : "border-b border-sidebar-border/70",
                  active ? "bg-sidebar-accent/80" : "hover:bg-sidebar-accent/55",
                )}
              >
                <button
                  type="button"
                  aria-label={`${row.status}: ${row.path}`}
                  onClick={() => {
                    setSelected(row.path);
                    onOpen(row.path);
                  }}
                  className="grid min-h-[52px] w-full grid-cols-[16px_minmax(0,1fr)_72px] items-center gap-x-2 px-2.5 py-[7px] text-left outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50"
                >
                  <StatusIcon className={cn("size-4 shrink-0", status.ink)} weight="bold" />
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-ui font-medium">{filename}</span>
                      <span
                        className={cn(
                          "shrink-0 text-label font-medium transition-opacity duration-100 group-hover:opacity-0 group-focus-within:opacity-0",
                          status.ink,
                          narrow && "sr-only",
                        )}
                      >
                        {row.status}
                      </span>
                    </span>
                    <span className="block truncate text-xs text-muted-foreground/75">
                      {parent}
                    </span>
                  </span>
                  <span className="flex w-[72px] shrink-0 justify-end gap-1 font-mono text-xs tabular-nums">
                    <span className="font-medium text-positive">+{row.additions}</span>
                    <span className="font-medium text-destructive">−{row.deletions}</span>
                  </span>
                </button>
                <RowActions
                  path={row.path}
                  onOpen={onOpen}
                  className="absolute top-[5px] right-20 z-10 rounded-md bg-sidebar-accent/95 px-0.5 shadow-xs"
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FilesPanel({
  variant,
  scenario,
  onPreview,
  onOpen,
  narrow,
}: {
  variant: Variant;
  scenario: Scenario;
  onPreview(path: string): void;
  onOpen(path: string): void;
  narrow: boolean;
}) {
  if (scenario === "loading") {
    return <ScenarioState scenario={scenario} kind="files" />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 px-4 pt-1 pb-3">
        <div className="min-w-0 flex-1">
          <p className="text-ui font-medium">Ticket files</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {scenario === "no-worktree" ? "main" : "ui/right-sidebar-fixes"}
          </p>
        </div>
        <Hint label="Filter files">
          <Button size="icon-sm" variant="ghost" aria-label="Filter files">
            <MagnifyingGlassIcon />
          </Button>
        </Hint>
      </header>
      {scenario === "paused" ? <PausedBanner narrow={narrow} /> : null}
      <ul
        className={cn(
          "min-h-0 flex-1 overflow-y-auto pb-8 [scroll-padding-bottom:2rem]",
          variant === "calm" ? "px-2" : "border-t border-sidebar-border",
        )}
      >
        {FILES.map((row) => {
          const { filename, parent } = splitPath(row.path);
          const Icon =
            row.kind === "directory"
              ? FolderIcon
              : row.kind === "reference"
                ? TagIcon
                : FileCodeIcon;
          return (
            <li key={row.path}>
              <div
                className={cn(
                  "group flex w-full items-center gap-2 px-2 py-2 text-left hover:bg-sidebar-accent/55",
                  variant === "calm" ? "rounded-lg" : "border-b border-sidebar-border/70",
                )}
              >
                <button
                  type="button"
                  onClick={() => onPreview(row.path)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" weight="fill" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui font-medium">
                      {filename}
                      {row.kind === "directory" ? "/" : ""}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground/75">
                      {row.kind === "reference" ? `Referenced · ${parent}` : parent}
                    </span>
                  </span>
                </button>
                {row.kind === "file" || row.kind === "reference" ? (
                  <RowActions path={row.path} onOpen={onOpen} />
                ) : (
                  <CaretDownIcon className="-rotate-90 text-muted-foreground" />
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ChoicePopover({
  icon: Icon,
  label,
  value,
  options,
  onValue,
}: {
  icon: PhosphorIcon;
  label: string;
  value: string;
  options: readonly string[];
  onValue(value: string): void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${value}`}
          className="flex h-6 items-center gap-2 rounded-full border border-sidebar-border bg-background/40 px-2 text-xs hover:bg-sidebar-accent/60"
        >
          <Icon className="size-4 text-muted-foreground" />
          <span>{value}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-1">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onValue(option)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui hover:bg-accent"
          >
            <span className="flex-1">{option}</span>
            {option === value ? <CheckCircleIcon weight="fill" className="text-primary" /> : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function PropertiesSection({ narrow = false }: { narrow?: boolean }) {
  const [status, setStatus] = React.useState("Doing");
  const [priority, setPriority] = React.useState("High");
  const [labels, setLabels] = React.useState(["Feature", "UI"]);

  const propertyPills = (
    <>
      <ChoicePopover
        icon={CircleIcon}
        label="Status"
        value={status}
        options={["Backlog", "Todo", "Doing", "Needs Review", "Done"]}
        onValue={setStatus}
      />
      <ChoicePopover
        icon={FlagIcon}
        label="Priority"
        value={priority}
        options={["No priority", "Low", "Medium", "High", "Urgent"]}
        onValue={setPriority}
      />
    </>
  );

  const labelPills = (
    <>
      {labels.map((label) => (
        <button
          key={label}
          type="button"
          onClick={() => setLabels((current) => current.filter((item) => item !== label))}
          className="flex h-6 items-center gap-2 rounded-full border border-sidebar-border bg-background/40 px-2 text-xs hover:bg-sidebar-accent/60"
        >
          <span
            className={cn(
              "size-2 rounded-full",
              label === "Feature" ? "bg-violet-400" : "bg-cyan-400",
            )}
          />
          <span>{label}</span>
        </button>
      ))}
      <Hint label="Add label">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Add label"
          onClick={() =>
            setLabels((current) => (current.includes("Design") ? current : [...current, "Design"]))
          }
        >
          <PlusIcon />
        </Button>
      </Hint>
    </>
  );

  return (
    <section
      aria-label="Properties"
      className={cn("flex flex-col gap-1.5 pt-5", narrow ? "px-3" : "px-4")}
    >
      <div aria-label="Status and priority" className="flex min-h-6 flex-wrap items-center gap-1.5">
        {propertyPills}
      </div>
      <div aria-label="Labels" className="flex min-h-6 flex-wrap items-center gap-1.5">
        {labelPills}
      </div>
    </section>
  );
}

function SidebarPanel({
  variant,
  scenario,
  mode,
  onMode,
  reducedMotion,
  homeLabel,
  onOpen,
  onPreview,
  onComplete,
  onCompare,
  narrow,
}: {
  variant: Variant;
  scenario: Scenario;
  mode: RailMode;
  onMode(mode: RailMode): void;
  reducedMotion: boolean;
  homeLabel: "Now" | "Sessions";
  onOpen(path: string): void;
  onPreview(path: string): void;
  onComplete(message: string): void;
  onCompare(): void;
  narrow: boolean;
}) {
  return (
    <>
      <ActiveLabelTabs
        mode={mode}
        onMode={onMode}
        modes={MODES}
        variant={variant}
        reducedMotion={reducedMotion}
        homeLabel={homeLabel}
        narrow={narrow}
      />
      <section
        id={`rail-panel-${mode}`}
        role="tabpanel"
        aria-labelledby={`rail-tab-${mode}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {mode === "now" ? (
          <NowPanel
            variant={variant}
            scenario={scenario}
            onComplete={onComplete}
            onCompare={onCompare}
            onShowChanges={() => onMode("changes")}
            narrow={narrow}
          />
        ) : null}
        {mode === "changes" ? (
          <ChangesPanel variant={variant} scenario={scenario} onOpen={onOpen} narrow={narrow} />
        ) : null}
        {mode === "files" ? (
          <FilesPanel
            variant={variant}
            scenario={scenario}
            onPreview={onPreview}
            onOpen={onOpen}
            narrow={narrow}
          />
        ) : null}
      </section>
    </>
  );
}

function WorkbenchMock({ activeSurface }: { activeSurface: string }) {
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-end gap-1 border-b border-border px-3">
        <div className="flex h-8 items-center gap-2 rounded-t-lg bg-accent px-3 text-ui font-medium">
          <span className="size-2 rounded-full bg-primary" />
          Ticket
        </div>
        {activeSurface !== "Ticket" ? (
          <div className="flex h-8 max-w-72 items-center gap-2 rounded-t-lg border-x border-t border-border px-3 text-ui">
            <FileCodeIcon className="text-muted-foreground" />
            <span className="truncate">{activeSurface}</span>
          </div>
        ) : null}
        <Button size="icon-sm" variant="ghost" aria-label="New ticket tab" className="mb-1">
          <PlusIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto flex h-full max-w-content flex-col px-gutter pt-8">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded-full border border-border px-2 py-0.5">VC-214</span>
            <span>Doing</span>
          </div>
          <h1 className="mt-3 text-title font-semibold">Redesign the ticket right sidebar</h1>
          <p className="mt-6 max-w-2xl text-sm leading-6 text-muted-foreground">
            Turn the rail into a calm access surface. Sidebar pages reveal what exists; deliberate
            rows open or focus the full file, diff, or Session in the ticket workbench.
          </p>
          <div className="mt-8 rounded-xl border border-border bg-card/50 p-4">
            <div className="flex items-center gap-2 text-ui font-medium">
              <GitBranchIcon />
              {activeSurface === "Ticket" ? "Current design question" : activeSurface}
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              The main workbench tab strip stays authoritative. The sidebar tab bar changes only the
              sidebar page.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

function ControlDeck({
  scenario,
  onScenario,
  width,
  onWidth,
  appearance,
  onAppearance,
  reducedMotion,
  onReducedMotion,
  homeLabel,
  onHomeLabel,
}: {
  scenario: Scenario;
  onScenario(value: Scenario): void;
  width: RailWidth;
  onWidth(value: RailWidth): void;
  appearance: Appearance;
  onAppearance(value: Appearance): void;
  reducedMotion: boolean;
  onReducedMotion(value: boolean): void;
  homeLabel: "Now" | "Sessions";
  onHomeLabel(value: "Now" | "Sessions"): void;
}) {
  return (
    <div className="fixed bottom-14 left-3 z-[100] flex max-w-[calc(100vw-24px)] flex-wrap items-center gap-2 rounded-xl border border-border bg-background/95 p-2 text-xs shadow-lg backdrop-blur-xl">
      <select
        aria-label="Prototype scenario"
        value={scenario}
        onChange={(event) => onScenario(event.target.value as Scenario)}
        className="h-7 rounded-full border border-border bg-background px-2 text-xs outline-none"
      >
        <option value="dirty">Dirty worktree</option>
        <option value="clean">Clean worktree</option>
        <option value="loading">Loading</option>
        <option value="paused">Updates paused</option>
        <option value="no-worktree">No worktree</option>
      </select>
      <span className="h-4 w-px bg-border" />
      {([240, 300, 420] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={width === value}
          onClick={() => onWidth(value)}
          className="rounded-full px-2 py-1 text-muted-foreground hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
        >
          {value}px
        </button>
      ))}
      <span className="h-4 w-px bg-border" />
      <button
        type="button"
        onClick={() => onAppearance(appearance === "dark" ? "light" : "dark")}
        className="flex items-center gap-1 rounded-full px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {appearance === "dark" ? <MoonIcon /> : <SunIcon />}
        {appearance}
      </button>
      <button
        type="button"
        aria-pressed={reducedMotion}
        onClick={() => onReducedMotion(!reducedMotion)}
        className="rounded-full px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
      >
        Reduced motion
      </button>
      <button
        type="button"
        onClick={() => onHomeLabel(homeLabel === "Now" ? "Sessions" : "Now")}
        className="rounded-full px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        Label: {homeLabel}
      </button>
    </div>
  );
}

export default function TicketRightSidebarScratch() {
  const variant: Variant = "calm";
  const [mode, setMode] = React.useState<RailMode>("now");
  const [scenario, setScenario] = React.useState<Scenario>("dirty");
  const [width, setWidth] = React.useState<RailWidth>(300);
  const [appearance, setAppearance] = React.useState<Appearance>("dark");
  const [reducedMotion, setReducedMotion] = React.useState(false);
  const [homeLabel, setHomeLabel] = React.useState<"Now" | "Sessions">("Now");
  const [activeSurface, setActiveSurface] = React.useState("Ticket");
  const [activity, setActivity] = React.useState<string | null>(null);

  React.useEffect(() => {
    const root = document.documentElement;
    const previousDark = root.classList.contains("dark");
    const previousLight = root.classList.contains("light");
    root.classList.toggle("dark", appearance === "dark");
    root.classList.toggle("light", appearance === "light");
    return () => {
      root.classList.toggle("dark", previousDark);
      root.classList.toggle("light", previousLight);
    };
  }, [appearance]);

  const openSurface = React.useCallback((path: string) => {
    setActiveSurface(`Diff · ${splitPath(path).filename}`);
  }, []);
  const previewSurface = React.useCallback((path: string) => {
    setActiveSurface(`Preview · ${splitPath(path).filename}`);
  }, []);

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
      <div className="h-svh w-full overflow-hidden bg-rail p-2 text-foreground">
        <div className="flex h-full overflow-hidden rounded-xl border border-border bg-background shadow-xl">
          <WorkbenchMock activeSurface={activeSurface} />
          <aside
            className="relative flex shrink-0 flex-col border-l border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out"
            style={{ width }}
          >
            <SidebarPanel
              variant={variant}
              scenario={scenario}
              mode={mode}
              onMode={setMode}
              reducedMotion={reducedMotion}
              homeLabel={homeLabel}
              narrow={width === 240}
              onOpen={openSurface}
              onPreview={previewSurface}
              onCompare={() => setActivity("Opening branch comparison on GitHub…")}
              onComplete={(message) => {
                setActivity(message);
                setScenario("clean");
              }}
            />
            {activity !== null ? (
              <div className="absolute right-3 bottom-3 left-3 flex items-center gap-2 rounded-lg border border-sidebar-border bg-background/95 px-3 py-2 text-xs shadow-lg">
                <CheckCircleIcon className="text-positive" weight="fill" />
                <span className="min-w-0 flex-1 truncate">{activity}</span>
                <button type="button" onClick={() => setActivity(null)} aria-label="Dismiss">
                  ×
                </button>
              </div>
            ) : null}
          </aside>
        </div>
        <ControlDeck
          scenario={scenario}
          onScenario={setScenario}
          width={width}
          onWidth={setWidth}
          appearance={appearance}
          onAppearance={setAppearance}
          reducedMotion={reducedMotion}
          onReducedMotion={setReducedMotion}
          homeLabel={homeLabel}
          onHomeLabel={setHomeLabel}
        />
      </div>
    </TooltipProvider>
  );
}
