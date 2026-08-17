/**
 * PROTOTYPE — VC-55. Project-session identity: what a Home chat says about
 * itself, and how loudly.
 *
 * THE QUESTIONS, one per axis in the floating bar. They are independent on
 * purpose: the ticket bundles them as one change, and the first thing worth
 * learning is whether any of them can carry the load alone.
 *
 *  1. IDENTITY — a project session works in the MAIN CHECKOUT; a ticket session
 *     works in a throwaway worktree. "Safe to let it run" vs "it is editing my
 *     working tree." How little decoration makes that land? `none` is today.
 *  2. INFO — where does the durable answer to "which directory is this
 *     touching" live? A rail with ticket parity (⌥⌘B), a always-on venue bar
 *     that costs no toggle, or a rail whose headline is the working tree's
 *     dirty state rather than its path.
 *  3. EMPTY — today's bare mark, scope chips, or chips plus purpose controls.
 *     Note the standing rule this is arguing with: CLAUDE.md's "let controls
 *     talk", and chat-plane.tsx's "a mark, and nothing else".
 *
 * VIEW `both` is the acceptance test for "distinguishable at a glance": the two
 * surfaces side by side, same window, same instant. Judge the identity axis
 * there and nowhere else — anything reads distinct when it is the only thing
 * on screen.
 *
 * Fixtures are frozen strings; nothing here reads git, and the working-tree
 * counts are invented. The lab has no main-process half (CLAUDE.md), so the
 * live-branch problem this prototype exists to raise — a project session's
 * branch is whatever the user has checked out, and it moves under the
 * session — can only be SHOWN here, never demonstrated.
 */
import * as React from "react";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";
import { CompassIcon } from "@phosphor-icons/react/dist/csr/Compass";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { GitPullRequestIcon } from "@phosphor-icons/react/dist/csr/GitPullRequest";
import { KanbanIcon } from "@phosphor-icons/react/dist/csr/Kanban";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { PathIcon } from "@phosphor-icons/react/dist/csr/Path";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { StackIcon } from "@phosphor-icons/react/dist/csr/Stack";
import { TicketIcon } from "@phosphor-icons/react/dist/csr/Ticket";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { Button } from "@renderer/components/ui/button";
import { EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import { StatusDot } from "@renderer/components/ui/status-dot";
import { Tab, TabStrip, tabStopIndex } from "@renderer/components/ui/tab-strip";
import { cn } from "@renderer/lib/utils";

export const title = "Project session · identity, info, empty chat";
export const note = "Three independent axes over a Home chat and a ticket chat — VC-55";
export const viewport = "window" as const;

// ---------------------------------------------------------------------------
// Fixtures

const PROJECT = {
  name: "volli-code",
  /** The main checkout. A project session runs HERE — the user's working tree. */
  path: "~/Desktop/code/volli-code",
  /** Live, and it moves: whatever the user has checked out right now. */
  branch: "main",
  dirtyFiles: 3,
  model: "Claude Opus 4.6",
  effort: "High",
} as const;

const TICKET = {
  id: "VC-81",
  title: "Auto-title v2: model-generated titles",
  branch: "volli/VC-81-auto-title-model-generated-titles",
  worktree: "~/.volli/worktrees/volli-code-f3732f45/VC-81-auto-title…",
  dirtyFiles: 7,
} as const;

/** "Cheap context" per the ticket — tickets this session already touched. */
const RECENT = [
  { id: "VC-54", title: "Home taxonomy: board becomes a tabbed Home", state: "Todo" },
  { id: "VC-75", title: "Active-session discoverability", state: "Backlog" },
  { id: "VC-81", title: "Auto-title v2", state: "Doing" },
] as const;

// ---------------------------------------------------------------------------
// Axes

type Identity = "none" | "glyph" | "tint" | "material";
type Info = "none" | "rail" | "venue-bar" | "worktree-rail";
type Empty = "mark" | "chips" | "purpose";
type View = "home" | "ticket" | "both";

const IDENTITY_LABELS: Record<Identity, string> = {
  none: "None (today)",
  glyph: "Glyph",
  tint: "Glyph + tint",
  material: "Glyph + material",
};

const INFO_LABELS: Record<Info, string> = {
  none: "None (today)",
  rail: "Rail (⌥⌘B parity)",
  "venue-bar": "Venue bar",
  "worktree-rail": "Working-tree rail",
};

const EMPTY_LABELS: Record<Empty, string> = {
  mark: "Mark (today)",
  chips: "Scope chips",
  purpose: "Chips + purpose",
};

const VIEW_LABELS: Record<View, string> = {
  home: "Home",
  ticket: "Ticket",
  both: "Both (at-a-glance test)",
};

// ---------------------------------------------------------------------------
// Small shared parts

/** A scope chip. One fact, one glyph, no sentence. */
function Chip({
  icon: Icon,
  children,
  tone = "quiet",
  title: hover,
}: {
  icon?: React.ComponentType<{ className?: string; weight?: "bold" }>;
  children: React.ReactNode;
  tone?: "quiet" | "accent" | "warn";
  title?: string;
}) {
  return (
    <span
      title={hover}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2 text-ui",
        tone === "quiet" && "border-border bg-card text-muted-foreground",
        tone === "accent" && "border-primary/30 bg-primary/10 text-primary-text",
        tone === "warn" && "border-attention/30 bg-attention/10 text-attention-foreground",
      )}
    >
      {Icon ? <Icon weight="bold" className="size-3" /> : null}
      {children}
    </span>
  );
}

/** A rail block: uppercase label, then rows. Mirrors the ticket rail's grammar. */
function RailBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 px-4 py-4">
      <h3 className="text-label uppercase text-muted-foreground">{label}</h3>
      {children}
    </section>
  );
}

/** One `label → value` line inside a rail block. */
function RailRow({
  icon: Icon,
  label,
  value,
  mono,
  title: hover,
}: {
  icon?: React.ComponentType<{ className?: string; weight?: "bold" }>;
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2" title={hover}>
      <span className="flex shrink-0 items-center gap-1 text-ui text-muted-foreground">
        {Icon ? <Icon weight="bold" className="size-3" /> : null}
        {label}
      </span>
      <span className={cn("min-w-0 truncate text-ui text-foreground", mono && "font-mono")}>
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Identity — what the tab and the surface wear

/**
 * The identity treatment, resolved once and read by the tab, the surface and
 * the empty state, so the three can never disagree about how loud this is.
 */
function identityStyle(identity: Identity, project: boolean) {
  if (!project || identity === "none") {
    return { glyph: ChatCircleIcon, tab: "", surface: "", accent: false };
  }
  return {
    glyph: CompassIcon,
    tab:
      identity === "tint" ? "text-primary-text" : identity === "material" ? "text-foreground" : "",
    surface:
      identity === "tint"
        ? // A hairline of accent along the plane's top edge — the whole
          // decoration, and it never touches the transcript's own ink.
          "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-primary/30"
        : identity === "material"
          ? // A material shift instead of a color: the plane sits on the rail's
            // own darker canvas rather than the card's background.
            "bg-gradient-to-b from-accent/30 to-transparent to-[120px]"
          : "",
    accent: identity === "tint",
  };
}

// ---------------------------------------------------------------------------
// Empty chat

function EmptyChat({
  variant,
  project,
  identity,
}: {
  variant: Empty;
  project: boolean;
  identity: Identity;
}) {
  const style = identityStyle(identity, project);
  const Glyph = style.glyph;

  if (variant === "mark") {
    // Today, verbatim from chat-plane.tsx — the control arm.
    return (
      <div className={cn(EMPTY_PAGE, "min-h-80")}>
        <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-card shadow-raised">
          <CodeIcon className="size-5 text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className={cn(EMPTY_PAGE, "min-h-80 gap-4")}>
      <div
        className={cn(
          "flex size-10 items-center justify-center rounded-xl border bg-card shadow-raised",
          style.accent ? "border-primary/30" : "border-border",
        )}
      >
        <Glyph
          className={cn("size-5", style.accent ? "text-primary-text" : "text-muted-foreground")}
        />
      </div>

      {/* The chips ARE the sentence. Scope reads left to right the way a path
          does: what repo, what branch, what directory. */}
      <div className="flex flex-wrap items-center justify-center gap-1">
        <Chip icon={StackIcon}>{PROJECT.name}</Chip>
        <Chip icon={GitBranchIcon}>{project ? PROJECT.branch : TICKET.branch}</Chip>
        {project ? (
          <Chip icon={FolderOpenIcon} tone="accent" title={PROJECT.path}>
            Main checkout
          </Chip>
        ) : (
          <Chip icon={FolderOpenIcon} title={TICKET.worktree}>
            Worktree
          </Chip>
        )}
      </div>

      {variant === "purpose" ? (
        // Controls, not prose: each is a real affordance that would prefill the
        // composer. The one line of text below them is the whole copy budget.
        <div className="flex flex-col items-center gap-2">
          <div className="flex flex-wrap items-center justify-center gap-1">
            {project ? (
              <>
                <Button variant="outline" size="sm">
                  <PathIcon className="size-3.5" />
                  Shape an idea
                </Button>
                <Button variant="outline" size="sm">
                  <PlusIcon className="size-3.5" />
                  File tickets
                </Button>
                <Button variant="outline" size="sm">
                  <ListChecksIcon className="size-3.5" />
                  Drive a ticket
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm">
                  <CodeIcon className="size-3.5" />
                  Implement
                </Button>
                <Button variant="outline" size="sm">
                  <GitPullRequestIcon className="size-3.5" />
                  Open a PR
                </Button>
              </>
            )}
          </div>
          <p className="max-w-80 text-ui text-muted-foreground">
            {project
              ? "Orchestrates from the main checkout. It does not write code here."
              : "Runs isolated in this ticket's worktree."}
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Info surfaces

/** The always-on strip. No toggle, no page, no parity — one line under the tabs. */
function VenueBar({ project }: { project: boolean }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-4 py-2">
      {project ? (
        <>
          <Chip icon={FolderOpenIcon} tone="accent" title={PROJECT.path}>
            Main checkout
          </Chip>
          <Chip icon={GitBranchIcon}>{PROJECT.branch}</Chip>
          {PROJECT.dirtyFiles > 0 ? (
            <Chip icon={WarningIcon} tone="warn">
              {PROJECT.dirtyFiles} uncommitted
            </Chip>
          ) : null}
        </>
      ) : (
        <>
          <Chip icon={FolderOpenIcon} title={TICKET.worktree}>
            Worktree
          </Chip>
          <Chip icon={GitBranchIcon}>{TICKET.branch}</Chip>
        </>
      )}
      <span className="ml-auto flex items-center gap-1 text-ui text-muted-foreground">
        {PROJECT.model} · {PROJECT.effort}
      </span>
    </div>
  );
}

/** The rail. `emphasis` decides which question its first block answers. */
function InfoRail({ emphasis, project }: { emphasis: "venue" | "worktree"; project: boolean }) {
  const dirty = project ? PROJECT.dirtyFiles : TICKET.dirtyFiles;

  const venueBlock = (
    <RailBlock label="Venue">
      <div className="flex flex-col gap-2 rounded-row border border-border bg-card p-4">
        <RailRow
          icon={FolderOpenIcon}
          label={project ? "Main checkout" : "Worktree"}
          value={project ? PROJECT.path : TICKET.worktree}
          mono
          title={project ? PROJECT.path : TICKET.worktree}
        />
        <RailRow
          icon={GitBranchIcon}
          label="Branch"
          value={project ? PROJECT.branch : TICKET.branch}
          mono
          title={
            project
              ? "Live: whatever the main checkout has checked out right now."
              : "Pinned to this ticket."
          }
        />
        {project ? (
          // The stake, spelled where it is decided rather than in a doc: this
          // is the user's own tree, and a session running here is not isolated.
          <p className="text-ui text-attention-foreground">Your working tree — not isolated.</p>
        ) : null}
      </div>
    </RailBlock>
  );

  const worktreeBlock = (
    <RailBlock label={project ? "Working tree" : "Changes"}>
      <div className="flex flex-col gap-2 rounded-row border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "flex items-center gap-1 text-ui",
              dirty > 0 ? "text-attention-foreground" : "text-muted-foreground",
            )}
          >
            {dirty > 0 ? <WarningIcon weight="bold" className="size-3" /> : null}
            {dirty > 0 ? `${dirty} uncommitted files` : "Clean"}
          </span>
          <Button variant="ghost" size="xs">
            Review
            <ArrowRightIcon className="size-3" />
          </Button>
        </div>
        <RailRow
          icon={FolderOpenIcon}
          label={project ? "Main checkout" : "Worktree"}
          value={project ? PROJECT.path : TICKET.worktree}
          mono
        />
        <RailRow
          icon={GitBranchIcon}
          label="Branch"
          value={project ? PROJECT.branch : TICKET.branch}
          mono
        />
      </div>
    </RailBlock>
  );

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border bg-sidebar">
      {emphasis === "worktree" ? (
        <>
          {worktreeBlock}
          <RailBlock label="Session">
            <div className="flex flex-col gap-2">
              <RailRow icon={CompassIcon} label="Kind" value={project ? "Project" : "Ticket"} />
              <RailRow label="Model" value={PROJECT.model} />
              <RailRow label="Effort" value={PROJECT.effort} />
              <div className="flex items-center justify-between gap-2">
                <span className="text-ui text-muted-foreground">Activity</span>
                <span className="flex items-center gap-1 text-ui text-foreground">
                  <StatusDot state="ready" />
                  Ready
                </span>
              </div>
            </div>
          </RailBlock>
        </>
      ) : (
        <>
          {venueBlock}
          <RailBlock label="Session">
            <div className="flex flex-col gap-2">
              <RailRow icon={CompassIcon} label="Kind" value={project ? "Project" : "Ticket"} />
              <RailRow label="Model" value={PROJECT.model} />
              <RailRow label="Effort" value={PROJECT.effort} />
              <div className="flex items-center justify-between gap-2">
                <span className="text-ui text-muted-foreground">Activity</span>
                <span className="flex items-center gap-1 text-ui text-foreground">
                  <StatusDot state="ready" />
                  Ready
                </span>
              </div>
            </div>
          </RailBlock>
        </>
      )}

      {/* "Cheap context where already known" — tickets this session has touched.
          Nothing is fetched for it; if the session never mentioned one, the
          block is absent rather than empty. */}
      <RailBlock label="Touched">
        <div className="flex flex-col gap-1">
          {RECENT.map((row) => (
            <button
              key={row.id}
              type="button"
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent"
            >
              <TicketIcon weight="bold" className="size-3 shrink-0 text-muted-foreground" />
              <span className="shrink-0 font-mono text-ui text-muted-foreground">{row.id}</span>
              <span className="min-w-0 truncate text-ui text-foreground">{row.title}</span>
            </button>
          ))}
        </div>
      </RailBlock>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// A surface: tab strip + plane (+ optional info)

function Surface({
  project,
  identity,
  info,
  empty,
}: {
  project: boolean;
  identity: Identity;
  info: Info;
  empty: Empty;
}) {
  const style = identityStyle(identity, project);
  const Glyph = style.glyph;
  // Home's permanent Board tab (VC-54) vs a ticket's permanent Body tab.
  const tabs = project
    ? [
        { id: "board", label: "Board", permanent: true },
        { id: "chat", label: "Shape the 0.1.0 train", permanent: false },
      ]
    : [
        { id: "body", label: "Ticket", permanent: true },
        { id: "chat", label: "Auto-title v2 implementation", permanent: false },
      ];
  const activeIndex = 1;
  const stop = tabStopIndex(tabs.length, activeIndex);
  const railOn = info === "rail" || info === "worktree-rail";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
      <TabStrip
        variant="pill"
        label={project ? "Home tabs" : "Ticket tabs"}
        className="shrink-0"
        actions={
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" aria-label="New session">
              <PlusIcon className="size-3.5" />
            </Button>
            {railOn ? (
              <Button variant="ghost" size="icon-sm" aria-label="Hide details rail (⌥⌘B)">
                <SidebarSimpleIcon className="size-3.5" />
              </Button>
            ) : null}
          </div>
        }
      >
        {tabs.map((tab, index) => (
          <Tab
            key={tab.id}
            label={tab.label}
            active={index === activeIndex}
            tabStop={index === stop}
            closable={!tab.permanent}
            status={index === activeIndex ? "ready" : undefined}
            labelClassName={index === activeIndex ? style.tab : undefined}
            leading={
              tab.permanent ? (
                (project ? KanbanIcon : TicketIcon)({
                  weight: "bold",
                  className: "size-3 shrink-0 text-muted-foreground",
                })
              ) : (
                <Glyph
                  weight="bold"
                  className={cn(
                    "size-3 shrink-0",
                    style.accent ? "text-primary-text" : "text-muted-foreground",
                  )}
                />
              )
            }
            onActivate={() => {}}
          />
        ))}
      </TabStrip>

      {info === "venue-bar" ? <VenueBar project={project} /> : null}

      <div className="flex min-h-0 flex-1">
        <div className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", style.surface)}>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
            <EmptyChat variant={empty} project={project} identity={identity} />
          </div>
          {/* A stand-in composer: the empty state is only honest with the thing
              it is sitting above. Not interactive — the composer is not what
              this prototype is asking about. */}
          <div className="shrink-0 px-4 pb-4">
            <div className="mx-auto flex max-w-content flex-col gap-2 rounded-container border border-border bg-card p-4 shadow-raised">
              <span className="text-sm text-muted-foreground">Message…</span>
              <div className="flex items-center gap-2 text-ui text-muted-foreground">
                <span>{PROJECT.model}</span>
                <span>·</span>
                <span>{PROJECT.effort}</span>
              </div>
            </div>
          </div>
        </div>

        {railOn ? (
          <InfoRail emphasis={info === "worktree-rail" ? "worktree" : "venue"} project={project} />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The bar

function AxisPicker<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Record<T, string>;
  onChange(next: T): void;
}) {
  return (
    <label className="flex items-center gap-1">
      <span className="text-label uppercase text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="h-7 rounded-full border border-border bg-card px-2 text-ui text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
      >
        {(Object.keys(options) as T[]).map((key) => (
          <option key={key} value={key}>
            {options[key]}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function ProjectSessionIdentityScratch() {
  const [identity, setIdentity] = React.useState<Identity>("tint");
  const [info, setInfo] = React.useState<Info>("rail");
  const [empty, setEmpty] = React.useState<Empty>("chips");
  const [view, setView] = React.useState<View>("both");

  return (
    <div className="flex h-svh w-full flex-col bg-rail">
      <div className="flex min-h-0 flex-1 gap-2 p-2 pb-16">
        {view !== "ticket" ? (
          <Surface project identity={identity} info={info} empty={empty} />
        ) : null}
        {view !== "home" ? (
          <Surface project={false} identity={identity} info={info} empty={empty} />
        ) : null}
      </div>

      {/* Bottom-LEFT: the shell parks its own "← Lab" control bottom-right. */}
      <div className="fixed bottom-3 left-3 z-[9998] flex max-w-[calc(100vw-12rem)] flex-wrap items-center gap-4 rounded-full border border-border bg-background/90 px-4 py-2 shadow-overlay backdrop-blur">
        <AxisPicker
          label="Identity"
          value={identity}
          options={IDENTITY_LABELS}
          onChange={setIdentity}
        />
        <AxisPicker label="Info" value={info} options={INFO_LABELS} onChange={setInfo} />
        <AxisPicker label="Empty" value={empty} options={EMPTY_LABELS} onChange={setEmpty} />
        <AxisPicker label="View" value={view} options={VIEW_LABELS} onChange={setView} />
        {/* Rule 5: surface the state, so a screenshot carries its own caption. */}
        <code className="font-mono text-label text-muted-foreground">
          {identity} / {info} / {empty}
        </code>
      </div>
    </div>
  );
}
