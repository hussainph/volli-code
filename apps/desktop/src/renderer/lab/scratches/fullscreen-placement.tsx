/**
 * Where the terminal-focus control and the right-rail toggle belong.
 *
 * Today the two are split across two surfaces on a rule nobody wrote down:
 * focus-enter sits in the ticket tab strip's full-height right corner
 * (`ticket-tabs.tsx`), focus-exit and the rail toggle sit at the chrome band's
 * right edge (`chrome-bar.tsx`). The band's pairing reads as symmetry — a
 * mirrored sidebar glyph at each end — and the symmetry is what makes the
 * arrangement hard to argue with.
 *
 * Three facts the code makes plain, and this scratch exists to put on screen:
 *
 *  1. The band is WINDOW-scoped and permanent; `RightRailToggle` opens with
 *     `if (!hasOpenTicket) return null`. So the right half of that symmetry is
 *     absent on the board, on Sessions, in Settings, and inside terminal focus
 *     (where `TerminalFocusControls` replaces the whole row). It is a property
 *     of one screen, not of the band.
 *  2. Nothing is balancing against it. The ⌘K pill is absolutely centered on
 *     the WINDOW's midline, not on the flex row (see its comment in
 *     `chrome-bar.tsx`), so emptying the right edge moves nothing.
 *  3. Focus-enter is already in the right place. It is scoped to one session
 *     TAB, and it lives in that tab's own chrome. The owner's swap would move
 *     the correctly-scoped control out to make room for one that has a better
 *     home sitting immediately beside it — hence variant C.
 *
 * The round trip is here too, because enter and exit cannot be judged apart.
 * The tab strip unmounts on entering focus (`ticket-detail.tsx`), which is WHY
 * the exit control had to be rehomed; it is a cause, not a justification. Note
 * while you flip: there is no keyboard chord for focus in either direction
 * (`⌃⌘F` is macOS's own fullscreen and is not wired to this), and the enter
 * button carries a hard-coded `aria-pressed={false}` for a pressed state that
 * lives on a different button in a different component.
 *
 * WHAT IS REAL: the whole window (`AppShell` with a `mainContent` override),
 * the chrome band and its rail toggle, the focus chrome and its exit button,
 * the right rail with its Environment Inspector and Sessions panel, and the
 * `railCollapsed` store every toggle here drives.
 *
 * WHAT IS REBUILT, and only because showing an alternative corner means
 * changing app source: the tab strip's shell and tab chips (container classes
 * copied from `ticket-tabs.tsx`, one code path for all four variants so they
 * differ only where the design differs), the content planes, and variant D's
 * mode strip — the real `TicketRailModeStrip` cannot express "no panel open",
 * which is the state D exists to show.
 *
 * The band's real toggle is driven by the workspace store's `openTicketId`
 * rather than by a prop, because that is the actual switch: variants B–D turn
 * it off, which is exactly what removing the control from the band looks like.
 */
import * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { CornersOutIcon } from "@phosphor-icons/react/dist/csr/CornersOut";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { GitDiffIcon } from "@phosphor-icons/react/dist/csr/GitDiff";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/dist/csr/ChatCircleDots";
import {
  displayTicketId,
  type ChangeSetSnapshot,
  type WorktreeChangeSetResult,
} from "@volli/shared";

import { AppShell } from "@renderer/components/app-shell";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { RailResizeHandle } from "@renderer/components/ticket/rail-resize-handle";
import { TicketRail } from "@renderer/components/ticket/ticket-rail";
import {
  TICKET_RAIL_MODE_LABELS,
  availableRailModes,
  type TicketRailMode,
} from "@renderer/components/ticket/ticket-rail-model";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { useSessionsStore, type SessionContainer } from "@renderer/stores/sessions";
import { useUiStore } from "@renderer/stores/ui";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

import { project, ticketById } from "../fixtures";
import { appApi, seedApp } from "../seed";

export const title = "Focus / rail-toggle placement";
export const note = "Chrome band vs. tab-strip corner — and whether the toggle survives at all";
export const viewport = "window" as const;

const TICKET = ticketById("tkt-14");
const TICKET_LABEL = displayTicketId(project.ticketPrefix, TICKET.ticketNumber);
const SESSION_ID = "ses-14b";

/**
 * A static Change Set so the rail's repository card shows counts rather than
 * its failure row. The lab has no worktree, and a red "couldn't load changes"
 * line sitting in every variant would be the loudest thing on screen in a
 * scratch about a 20px glyph.
 */
const CHANGE_SET: ChangeSetSnapshot = {
  baseRevision: "9f2c1ab",
  headRevision: "4d7e0b3",
  revision: "4d7e0b3-dirty",
  files: [
    {
      path: "src/editor/gutter-decorations.ts",
      status: "modified",
      insertions: 48,
      deletions: 12,
      binary: false,
    },
    {
      path: "src/editor/scroll-debounce.ts",
      status: "modified",
      insertions: 9,
      deletions: 4,
      binary: false,
    },
    {
      path: "src/editor/gutter-decorations.test.ts",
      status: "added",
      insertions: 96,
      deletions: 0,
      binary: false,
    },
  ],
  insertions: 153,
  deletions: 16,
  truncated: false,
  totalCount: 3,
};

/**
 * The focus chrome names its Session by reading the sessions store, so the
 * breadcrumb says "Session 2" rather than falling back to "Terminal".
 *
 * seed.ts warns that a seeded container makes the next scratch try to mount a
 * PTY that never existed — it cannot here, because `mainContent` is overridden
 * and `MainContent` returns before `SessionsLayer` on that path, and `seedApp`
 * puts the store back for whatever scratch comes next.
 */
const SESSION_CONTAINER: SessionContainer = {
  tabs: [
    {
      sessionId: SESSION_ID,
      title: "Session 2",
      scope: { kind: "ticket", projectId: project.id, ticketId: TICKET.id },
      layout: { kind: "pane", sessionId: SESSION_ID, exitCode: null },
      activePaneId: SESSION_ID,
    },
  ],
  activeSessionId: SESSION_ID,
};

export const api = {
  ...appApi,
  worktree: {
    changeSet: (): Promise<WorktreeChangeSetResult> =>
      Promise.resolve({ ok: true, changeSet: CHANGE_SET }),
  },
};

export function seed(): void {
  seedApp();
  useSessionsStore.setState({ byOwner: { [TICKET.id]: SESSION_CONTAINER } });
  setBandTicketOpen(true);
}

/** The one switch that decides whether the band renders its own rail toggle. */
function setBandTicketOpen(open: boolean): void {
  useWorkspaceStore.setState({
    byProject: {
      [project.id]: {
        ...DEFAULT_WORKSPACE_UI,
        nav: "board",
        openTicketId: open ? TICKET.id : null,
      },
    },
  });
}

type VariantKey = "a" | "b" | "c" | "d";

const VARIANTS: readonly { key: VariantKey; label: string; caption: string }[] = [
  { key: "a", label: "A · Today", caption: "Focus in the corner, rail toggle in the band." },
  {
    key: "b",
    label: "B · Swap",
    caption: "Rail toggle takes the corner; focus moves onto the plane.",
  },
  {
    key: "c",
    label: "C · Cluster",
    caption: "The corner holds both; the band's right edge goes empty.",
  },
  {
    key: "d",
    label: "D · Summoned",
    caption: "Panels open from their own icon — no toggle exists.",
  },
];

type TabKind = "body" | "file" | "session" | "chat";

interface StripTab {
  id: string;
  label: string;
  kind: TabKind;
}

const TABS: readonly StripTab[] = [
  { id: "doc", label: TICKET_LABEL, kind: "body" },
  { id: "file:gutter", label: "gutter-decorations.ts", kind: "file" },
  { id: SESSION_ID, label: "Session 2", kind: "session" },
  { id: "chat:chat-14a", label: "Trace the dropped decorations", kind: "chat" },
];

function tabById(id: string): StripTab {
  return TABS.find((tab) => tab.id === id) ?? TABS[0]!;
}

/**
 * The strip's shell, copied from `ticket-tabs.tsx` down to the corner's
 * `-mt-1.5 … self-stretch` cancellation, with the corner handed in. Tabs are
 * flattened to plain chips: close ×, rename, preview italics and the roving
 * tabindex are all real in the app and none of them move a control, so
 * carrying them here would only be a second copy to keep honest.
 */
function VariantTabStrip({
  activeTabId,
  onSelect,
  corner,
}: {
  activeTabId: string;
  onSelect(tabId: string): void;
  corner: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-end border-b border-border bg-rail pt-1.5">
      <div className="flex min-w-0 flex-1 items-end overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div role="tablist" aria-orientation="horizontal" className="flex items-end gap-0.5">
          {TABS.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSelect(tab.id)}
                className={cn(
                  "relative flex h-8 shrink-0 items-center rounded-t-lg px-3.5 text-sm outline-none transition-[color,background-color] duration-150 ease-out focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  active
                    ? "-mb-px bg-background text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {tab.kind === "session" || tab.kind === "chat" ? (
                  <span aria-hidden className="mr-1.5 size-2 shrink-0 rounded-full bg-primary" />
                ) : null}
                <span className="max-w-40 truncate font-medium">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      {corner}
    </div>
  );
}

/** The strip's full-height right corner. One region; how many cells is the question. */
function StripCorner({ children }: { children: React.ReactNode }) {
  return (
    <div className="-mt-1.5 flex shrink-0 items-stretch self-stretch border-l border-border/70 px-1.5">
      {children}
    </div>
  );
}

/**
 * Focus-enter as it ships: present on every tab, dimmed on the three that
 * cannot be focused — which is most of the time, since the Doc tab is where a
 * ticket opens. The `title` doing the explaining is the tell.
 */
function FocusCornerButtonToday({ canFocus, onEnter }: { canFocus: boolean; onEnter(): void }) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      className="h-full rounded-none"
      disabled={!canFocus}
      onClick={onEnter}
      aria-label="Enter terminal focus"
      aria-pressed={false}
      title={canFocus ? "Enter terminal focus" : "Select a terminal tab to enter terminal focus"}
    >
      <CornersOutIcon className="size-3.5" />
    </Button>
  );
}

/**
 * The same control with the two things the shipped one gets wrong fixed: no
 * `aria-pressed` (it is an action whose pressed state lives on another button),
 * and a reserved slot that fades instead of a permanently-dimmed glyph — so the
 * strip's right edge never shifts as you move between tab kinds.
 */
function FocusCornerCell({ canFocus, onEnter }: { canFocus: boolean; onEnter(): void }) {
  return (
    <div
      aria-hidden={!canFocus}
      className={cn(
        "flex items-stretch transition-opacity duration-150 ease-out motion-reduce:transition-none",
        canFocus ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <Button
        size="icon-xs"
        variant="ghost"
        className="h-full rounded-none"
        tabIndex={canFocus ? undefined : -1}
        onClick={onEnter}
        aria-label="Enter terminal focus"
        title="Enter terminal focus"
      >
        <CornersOutIcon className="size-3.5" />
      </Button>
    </div>
  );
}

/** `RightRailToggle`'s glyph and behavior, rehomed into the corner. */
function RailCornerCell() {
  const railCollapsed = useUiStore((state) => state.railCollapsed);
  const toggleRailCollapsed = useUiStore((state) => state.toggleRailCollapsed);

  return (
    <Button
      size="icon-xs"
      variant="ghost"
      className="h-full rounded-none"
      aria-pressed={railCollapsed}
      onClick={() => toggleRailCollapsed()}
      aria-label={railCollapsed ? "Show details rail" : "Hide details rail"}
      title={`${railCollapsed ? "Show" : "Hide"} details (⌥⌘B)`}
    >
      <SidebarSimpleIcon weight="fill" className="size-3.5 scale-x-[-1]" />
    </Button>
  );
}

/**
 * Variant B's home for focus-enter: the plane's own top-right, revealed on
 * hover, the way a video player does it — which is also the only placement
 * where enter and exit land at the same point on screen, since the plane grows
 * to fill the window. Its cost is real and is the reason B is not the
 * recommendation: this chip sits over a live PTY, and a TUI running mouse
 * reporting loses that corner.
 */
function PlaneFocusChip({ onEnter }: { onEnter(): void }) {
  return (
    <div className="pointer-events-none absolute top-3 right-3 z-10 opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none">
      <Button
        size="icon-sm"
        variant="ghost"
        className="pointer-events-auto border border-border/60 bg-background/70 backdrop-blur-md"
        onClick={onEnter}
        aria-label="Enter terminal focus"
        title="Enter terminal focus"
      >
        <CornersOutIcon />
      </Button>
    </div>
  );
}

const MODE_ICONS: Record<TicketRailMode, PhosphorIcon> = {
  now: ChatCircleDotsIcon,
  changes: GitDiffIcon,
  files: FoldersIcon,
};

/**
 * Variant D's strip. `TicketRailModeStrip` takes a non-null mode and always
 * rings one icon, which cannot express the state D turns on: nothing open, and
 * therefore nothing to toggle. Same glyphs, same labels, same pill sizes.
 */
function SummonModeStrip({
  openMode,
  onToggleMode,
}: {
  openMode: TicketRailMode | null;
  onToggleMode(mode: TicketRailMode): void;
}) {
  return (
    <nav
      aria-label="Ticket panels"
      className="flex shrink-0 flex-col items-center gap-0.5 border-l border-sidebar-border bg-sidebar px-1.5 py-2"
    >
      {availableRailModes().map((key) => {
        const Icon = MODE_ICONS[key];
        const label = TICKET_RAIL_MODE_LABELS[key];
        const open = openMode === key;
        return (
          <Button
            key={key}
            size="icon-sm"
            variant="ghost"
            aria-pressed={open}
            aria-label={label}
            title={label}
            onClick={() => onToggleMode(key)}
            className={cn(
              "rounded-md text-muted-foreground",
              open &&
                "bg-primary/15 text-primary ring-1 ring-inset ring-primary/40 hover:bg-primary/20 hover:text-primary",
            )}
          >
            <Icon weight="fill" className="size-3.5" />
          </Button>
        );
      })}
    </nav>
  );
}

/**
 * The Codex-shaped card: the rail's pinned summary, floated over the content
 * and anchored to the icon that summoned it, on a translucent material rather
 * than a permanent 300px column. The other three modes are placeholders on
 * purpose — Files and Changes are navigators you keep open while clicking
 * through rows, and a card that dismisses is the wrong container for them.
 * That gap is the argument, not an omission.
 */
function SummonedCard({ mode, onClose }: { mode: TicketRailMode; onClose(): void }) {
  return (
    <div className="absolute top-3 right-3 z-20 w-80 overflow-hidden rounded-xl border border-border bg-popover/90 shadow-lg backdrop-blur-xl">
      <div className="flex items-center justify-between border-b border-sidebar-border px-4 py-2">
        <span className="text-label font-medium text-muted-foreground uppercase">
          {TICKET_RAIL_MODE_LABELS[mode]}
        </span>
        <Button size="icon-xs" variant="ghost" onClick={onClose} aria-label="Close panel">
          <SidebarSimpleIcon weight="fill" className="size-3 scale-x-[-1]" />
        </Button>
      </div>
      <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
        <p className="text-ui font-medium text-muted-foreground">{TICKET_RAIL_MODE_LABELS[mode]}</p>
        <p className="text-xs text-muted-foreground/80">Nothing here yet</p>
      </div>
    </div>
  );
}

/** A terminal-shaped stand-in — the lab has no PTY, and none is needed to place a corner. */
function TerminalPlane() {
  return (
    <div className="min-h-0 flex-1 overflow-hidden bg-background px-4 py-3 font-mono text-xs leading-5 text-muted-foreground">
      <p className="text-foreground">$ pnpm vitest run src/editor</p>
      <p>✓ src/editor/gutter-decorations.test.ts (14)</p>
      <p>✓ src/editor/scroll-debounce.test.ts (6)</p>
      <p className="text-foreground">Test Files 2 passed (2)</p>
      <p className="text-foreground">
        $ <span className="inline-block h-3 w-1.5 translate-y-px bg-foreground/70" />
      </p>
    </div>
  );
}

function DocPlane() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background pt-8">
      <ContentColumn>
        <h1 className="text-title font-semibold text-foreground">{TICKET.title}</h1>
        <p className="mt-6 text-sm leading-6 text-muted-foreground">{TICKET.body}</p>
      </ContentColumn>
    </div>
  );
}

function Plane({ kind }: { kind: TabKind }) {
  return kind === "body" ? <DocPlane /> : <TerminalPlane />;
}

/**
 * The ticket surface, standing in for `ticket-detail.tsx`'s composition — the
 * strip above one row of plane + rail, with the strip and rail both gone under
 * terminal focus exactly as the real view drops them.
 */
function TicketSurface({ variant }: { variant: VariantKey }) {
  const railCollapsed = useUiStore((state) => state.railCollapsed);
  const railWidth = useUiStore((state) => state.railWidth);
  const focused = useUiStore((state) => state.terminalFocusTarget !== null);
  const [activeTabId, setActiveTabId] = React.useState<string>(SESSION_ID);
  const [openMode, setOpenMode] = React.useState<TicketRailMode | null>("changes");

  const activeTab = tabById(activeTabId);
  const canFocus = activeTab.kind === "session";

  const enterFocus = React.useCallback(() => {
    setActiveTabId(SESSION_ID);
    useUiStore.getState().setTerminalFocusTarget({
      projectId: project.id,
      ticketId: TICKET.id,
      sessionId: SESSION_ID,
    });
  }, []);

  if (focused) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <TerminalPlane />
      </div>
    );
  }

  const corner =
    variant === "a" ? (
      <StripCorner>
        <FocusCornerButtonToday canFocus={canFocus} onEnter={enterFocus} />
      </StripCorner>
    ) : variant === "b" ? (
      <StripCorner>
        <RailCornerCell />
      </StripCorner>
    ) : variant === "c" ? (
      <StripCorner>
        <FocusCornerCell canFocus={canFocus} onEnter={enterFocus} />
        <RailCornerCell />
      </StripCorner>
    ) : (
      <StripCorner>
        <FocusCornerCell canFocus={canFocus} onEnter={enterFocus} />
      </StripCorner>
    );

  const railVisible = variant !== "d" && !railCollapsed;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <VariantTabStrip activeTabId={activeTabId} onSelect={setActiveTabId} corner={corner} />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="group relative flex min-h-0 flex-1 flex-col">
          <Plane kind={activeTab.kind} />
          {variant === "b" && canFocus ? <PlaneFocusChip onEnter={enterFocus} /> : null}
        </div>
        {variant === "d" && openMode !== null ? (
          <SummonedCard mode={openMode} onClose={() => setOpenMode(null)} />
        ) : null}
        {variant === "d" ? (
          <SummonModeStrip
            openMode={openMode}
            onToggleMode={(mode) => setOpenMode((current) => (current === mode ? null : mode))}
          />
        ) : null}
        {railVisible ? (
          <aside
            className="relative flex shrink-0 flex-col border-l border-sidebar-border bg-sidebar"
            style={{ width: railWidth }}
          >
            <RailResizeHandle />
            <TicketRail
              projectId={project.id}
              ticket={TICKET}
              creating={false}
              onNewSession={() => {}}
              onNewChat={() => {}}
              onActivateSession={setActiveTabId}
              onActivateChat={() => setActiveTabId("chat:chat-14a")}
              activeTabId={activeTabId}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Lab chrome, deliberately floating clear of both the shell's own bottom-right
 * pill and the app's pinned bottom-left Settings row — a lab control resting on
 * a real affordance is one you will eventually mistake for one.
 */
function VariantPicker({
  variant,
  onVariant,
  focused,
  onFocused,
}: {
  variant: VariantKey;
  onVariant(next: VariantKey): void;
  focused: boolean;
  onFocused(next: boolean): void;
}) {
  const caption = VARIANTS.find((entry) => entry.key === variant)?.caption ?? "";

  return (
    <div className="pointer-events-none fixed bottom-3 left-1/2 z-[9998] flex -translate-x-1/2 flex-col items-center gap-1.5">
      <p className="rounded-full bg-background/80 px-3 py-0.5 text-label text-muted-foreground backdrop-blur">
        {caption}
      </p>
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-background/90 p-1 shadow-lg backdrop-blur">
        {VARIANTS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => onVariant(entry.key)}
            aria-pressed={entry.key === variant}
            className="rounded-full px-3 py-1 text-label text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
          >
            {entry.label}
          </button>
        ))}
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <button
          type="button"
          onClick={() => onFocused(!focused)}
          aria-pressed={focused}
          className="rounded-full px-3 py-1 text-label text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
        >
          Focused
        </button>
      </div>
    </div>
  );
}

export default function FullscreenPlacementScratch() {
  const [variant, setVariant] = React.useState<VariantKey>("a");
  const focused = useUiStore((state) => state.terminalFocusTarget !== null);

  // Variant A is the only one where the band still owns a rail toggle, so the
  // workspace's open ticket — the band's real gate — follows the variant.
  React.useEffect(() => {
    setBandTicketOpen(variant === "a");
  }, [variant]);

  return (
    <>
      <AppShell mainContent={<TicketSurface variant={variant} />} />
      <VariantPicker
        variant={variant}
        onVariant={setVariant}
        focused={focused}
        onFocused={(next) =>
          useUiStore.getState().setTerminalFocusTarget(
            next
              ? {
                  projectId: project.id,
                  ticketId: TICKET.id,
                  sessionId: SESSION_ID,
                }
              : null,
          )
        }
      />
    </>
  );
}
