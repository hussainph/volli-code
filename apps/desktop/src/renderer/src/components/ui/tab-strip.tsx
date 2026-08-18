/**
 * The app's one tab strip.
 *
 * Three surfaces drew this object before: Project Files
 * (`files/file-tab-strip.tsx`), the ticket detail (`ticket/ticket-tabs.tsx`)
 * and Home's own strip (`home/home-tab-strip.tsx`). Large stretches of the
 * three were byte-identical — the same transition string, the same
 * hover-revealed close, the same unsaved dot, the same strip container, the
 * same roving-tabindex helper written out three times — and the comments in all
 * three admitted it ("same technique as…", "mirroring the ticket tab strip…").
 * What differed was never a decision: two strips sat at `h-8 text-sm`, which
 * `docs/DESIGN.md` reserves for the rare hero control, and the third at
 * `h-7 text-ui`, which is what a tab actually is. This file is the third one's
 * size, drawn twice.
 *
 * TWO DRAWINGS, one object:
 *
 *  - **folder** — the Chrome-browser tab. Rounded top corners, and the active
 *    tab bleeds 1px past the strip's bottom border (`-mb-px`) so its fill
 *    covers that seam and the tab reads as physically joined to the plane
 *    below. For a strip that IS the top edge of the thing it switches.
 *  - **pill** — the inline tab. A rounded rectangle floating in a centred band,
 *    active by fill rather than by fusing with anything. For a strip that sits
 *    above a surface it does not own.
 *
 * WHAT STAYS WITH THE CALLER: which tabs exist, their order, what a selection
 * means, what a close guards, and every context menu. This file owns the
 * drawing and the focus mechanics — nothing else. `Tab` forwards its rest props
 * to the `role="tab"` element, which is both how a caller attaches its own
 * `data-*` hooks and how Radix's `ContextMenuTrigger asChild` merges its
 * listeners and ref in; a shell that dropped them would be a tab whose
 * right-click opens nothing.
 */
import * as React from "react";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

// Imported rather than accepted as a slot so the two strips that rename cannot
// drift the field's size apart again — which is exactly what they had done
// (`h-5 w-40 text-ui` against `h-5 w-32 text-sm`). The field owns that size now,
// so a strip states only its width.
import { InlineRename } from "@renderer/components/ui/inline-rename";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { cn } from "@renderer/lib/utils";

import { movedTabIndex, successorTabIndex, tabFocusMove, type TabFocusMove } from "./tab-focus";

export type TabVariant = "folder" | "pill";

/**
 * The variant travels by context rather than by prop because a strip's tabs are
 * wrapped — every renamable tab sits inside a `ContextMenu`, so the strip
 * cannot reach its `Tab` children to clone the value in, and a caller repeating
 * `variant` on every tab is one `map` callback away from a strip with two
 * drawings in it.
 */
const TabVariantContext = React.createContext<TabVariant>("folder");

// ---------------------------------------------------------------------------
// Focus, in the DOM

/**
 * A tab's siblings and its own place among them, read live out of the enclosing
 * `role="tablist"`. No ref registry: the tab list is a DOM fact, and a registry
 * would be a second copy of it to keep in sync.
 */
function stripTabs(from: HTMLElement): { tabs: HTMLElement[]; index: number } | null {
  const tablist = from.closest('[role="tablist"]');
  if (tablist === null) return null;
  const tabs = Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]'));
  const index = tabs.indexOf(from);
  return index === -1 ? null : { tabs, index };
}

/** Arrow/Home/End roving focus, from the tab the key landed on. */
function moveTabFocus(from: HTMLElement, move: TabFocusMove): void {
  const found = stripTabs(from);
  if (found === null) return;
  const next = movedTabIndex(found.tabs.length, found.index, move);
  if (next !== null) found.tabs[next]?.focus();
}

/**
 * Hand focus to the tab that will survive this close.
 *
 * Called from inside the × that is about to unmount, BEFORE the close lands, so
 * the successor is picked from the strip as it stands and the next Arrow keeps
 * moving from where the closed tab was.
 *
 * The accepted trade: a close the caller then CANCELS (a dirty-file guard) has
 * already moved focus to the successor. Acceptable — the alternative is
 * deferring focus until every async guard has resolved, by which point the
 * closed tab is gone and there is nothing left to move from.
 */
function focusSuccessorTab(from: HTMLElement): void {
  const tab = from.closest<HTMLElement>('[role="tab"]');
  if (tab === null) return;
  const found = stripTabs(tab);
  if (found === null) return;
  const successor = successorTabIndex(found.tabs.length, found.index);
  if (successor !== null) found.tabs[successor]?.focus();
}

// ---------------------------------------------------------------------------
// The strip

export interface TabStripProps extends React.ComponentProps<"div"> {
  variant?: TabVariant;
  /**
   * The tablist's accessible name. Not optional: a ticket screen draws a second
   * tablist (the details rail's page switcher) on the same frame, so an
   * unnamed strip leaves both AT and every `getByRole("tablist")` query with no
   * way to say which one it means.
   */
  label: string;
  /**
   * The trailing cluster, past a divider — session-start controls, a rail
   * toggle. Tabs are places; everything here acts on them, and the rule plus
   * the vertical alignment is what keeps a ghost button from reading as one
   * more tab.
   */
  actions?: React.ReactNode;
}

export function TabStrip({
  variant = "folder",
  label,
  actions,
  className,
  children,
  ...props
}: TabStripProps) {
  const folder = variant === "folder";
  return (
    <div
      data-slot="tab-strip"
      data-variant={variant}
      className={cn(
        "flex shrink-0 border-b border-border bg-rail",
        // A folder strip is only as tall as its tabs plus the 4px above them,
        // because the tabs ARE its bottom edge. A pill strip centres its tabs
        // in a band of its own.
        folder ? "items-end pt-1" : "h-9 items-center gap-1 px-2",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          folder ? "items-end px-2" : "items-center",
        )}
      >
        <div
          role="tablist"
          aria-label={label}
          aria-orientation="horizontal"
          className={cn("flex gap-1", folder ? "items-end" : "items-center")}
        >
          <TabVariantContext.Provider value={variant}>{children}</TabVariantContext.Provider>
        </div>
      </div>
      {actions !== undefined ? (
        // The divider is half the separation; vertical alignment is the rest.
        // Tabs sit on the strip's bottom edge because they fuse with the plane
        // below, so a control spanning the band's full height cannot be
        // mistaken for one however it is styled. `-mt-1` cancels the strip's
        // own top pad so the column reaches the true top edge.
        <div
          className={cn(
            "flex shrink-0 border-l border-border/70",
            folder ? "-mt-1 items-stretch self-stretch pr-1 pl-2" : "items-center pl-2",
          )}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The tab

/** An inline rename in progress, in place of the label. */
export interface TabRenaming {
  value: string;
  onCommit(next: string): void;
  onCancel(): void;
}

export interface TabProps extends React.ComponentPropsWithRef<"div"> {
  /**
   * The tab's name — its label AND its accessible name, spelled explicitly.
   * Without the explicit name AT computes one from the whole subtree, absorbs
   * the close button's "Close <label>", and reads the tab doubled.
   */
  label: string;
  /**
   * A quieter line after the label, IN the tab — the Project Files strip's
   * parent-directory disambiguator for two tabs that share a basename. Not a
   * tooltip: `title` (a plain div prop) is the tooltip.
   */
  hint?: string;
  active: boolean;
  /**
   * This tab holds the strip's single entry point in the document's tab order.
   * Computed by the caller with {@link tabStopIndex}, which is where the "and
   * the first tab when nothing is active" rule lives.
   */
  tabStop: boolean;
  /** A Session's liveness, leading. The one status map (`ui/status-dot.tsx`). */
  status?: StatusDotState;
  /** Anything else leading: a kind glyph, a park badge. */
  leading?: React.ReactNode;
  /** A quiet mark between the leading slot and the label (Files' worktree dot). */
  badge?: React.ReactNode;
  /** Whether this tab shows a close affordance at all. */
  closable?: boolean;
  /**
   * Unsaved work. The close control becomes the dot — always visible, because
   * a draft has to be findable from across the strip — and turns back into an ×
   * on hover so the tab still closes in one click.
   */
  dirty?: boolean;
  /** Treatments on the label itself: italic for a preview, struck for an exit. */
  labelClassName?: string;
  /** Non-null while this tab is being renamed in place. */
  renaming?: TabRenaming | null;
  /** Not `onSelect`, which a div already owns as a DOM event. */
  onActivate(): void;
  onClose?(): void;
}

export function Tab({
  label,
  hint,
  active,
  tabStop,
  status,
  leading,
  badge,
  closable = true,
  dirty = false,
  labelClassName,
  renaming = null,
  onActivate,
  onClose,
  className,
  ...props
}: TabProps) {
  const variant = React.useContext(TabVariantContext);
  const folder = variant === "folder";
  const renamingNow = renaming !== null && renaming !== undefined;
  // The close is hidden mid-rename on purpose: the only two exits from an
  // inline edit are commit and cancel, and an × that blurs (committing) and
  // then closes is a destructive answer to a control reached for to dismiss.
  const showClose = closable && onClose !== undefined && !renamingNow;

  return (
    <div
      {...props}
      data-slot="tab"
      role="tab"
      aria-label={label}
      aria-selected={active}
      tabIndex={tabStop ? 0 : -1}
      onClick={onActivate}
      onKeyDown={(event) => {
        const move = tabFocusMove(event.key);
        if (move !== null) {
          event.preventDefault();
          moveTabFocus(event.currentTarget, move);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          // Activation only when the tab ITSELF has the key: the close × is a
          // real button inside this div, and swallowing its Enter here would
          // select the tab the user was trying to close. Arrows stay unguarded
          // above — roving out of the × is exactly what they are for.
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          onActivate();
        }
      }}
      className={cn(
        // `scale` is in the transition list and `scale-100!` is the
        // reduced-motion cancel — see the press note in `ui/button.tsx`.
        "group relative flex h-7 shrink-0 items-center gap-1 text-ui font-medium outline-none transition-[color,background-color,box-shadow,transform,scale] duration-150 ease-out active:scale-[0.97] motion-reduce:scale-100! focus-visible:ring-2 focus-visible:ring-ring/45",
        folder ? "rounded-t-lg" : "rounded-md",
        // A closable tab pays its right inset in the × instead of in padding.
        folder ? (closable ? "pr-1 pl-3" : "px-3") : closable ? "pr-1 pl-2" : "px-2.5",
        active
          ? folder
            ? // -mb-px pulls the active tab 1px past the strip's bottom border
              // so its content-coloured fill covers that seam. `shadow-raised`
              // is the halo that says "active" — carried here rather than by
              // the `[role="tab"][aria-selected="true"]` rule globals.css used
              // to hold, because a shadow you cannot see in the component is a
              // shadow nobody can tell is live.
              "-mb-px bg-background text-foreground shadow-raised"
            : "bg-accent text-foreground shadow-raised"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        className,
      )}
    >
      {/* 8px, not the 6px default: `ui/status-dot.tsx` sizes the dot by where it
          sits, and a tab is the larger of its two homes. */}
      {status !== undefined ? <StatusDot state={status} size="md" /> : null}
      {leading}
      {badge}
      {renamingNow ? (
        <InlineRename
          value={renaming.value}
          ariaLabel={`Rename ${label}`}
          className="w-40"
          onCommit={renaming.onCommit}
          onCancel={renaming.onCancel}
        />
      ) : (
        // A plain span, not a button: the tab div above is the `role="tab"`
        // that click, Enter and Space activate, so there is no nested
        // interactive control inside it.
        <span className={cn("max-w-40 truncate", labelClassName)}>{label}</span>
      )}
      {hint !== undefined && !renamingNow ? (
        // Dimmer than the tab's own muted ink so it stays subordinate on an
        // ACTIVE tab too, where the label is at full strength. It used to be a
        // step smaller instead; at one type size for the whole tab, weight of
        // colour is what is left to say it with.
        <span
          data-testid="tab-hint"
          className="max-w-28 shrink-0 truncate text-muted-foreground/70"
        >
          {hint}
        </span>
      ) : null}
      {showClose ? <TabClose label={label} dirty={dirty} onClose={onClose} /> : null}
    </div>
  );
}

/**
 * The hover-revealed close, and the unsaved dot it becomes.
 *
 * Not exported: every one of the three strips put it in the same place, at the
 * same size, with the same stop-propagation and the same successor-focus walk,
 * so there was never a call site that wanted to position it itself. `onClose`
 * on {@link Tab} is the whole surface area.
 */
function TabClose({ label, dirty, onClose }: { label: string; dirty: boolean; onClose(): void }) {
  return (
    <button
      type="button"
      data-slot="tab-close"
      data-testid="tab-close"
      aria-label={`Close ${label}`}
      // Stop the click from reaching the tab's own select handler, and pass the
      // keyboard on to a tab that will still be here afterwards.
      onClick={(event) => {
        event.stopPropagation();
        focusSuccessorTab(event.currentTarget);
        onClose();
      }}
      className={cn(
        // The house hover-reveal contract in full (`ticket/rail-panel-parts.tsx`
        // is the reference): the duration and the reduced-motion escape are
        // part of it, and every tab copy had dropped both.
        "group/close flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none transition-opacity duration-100 hover:bg-border hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/45 motion-reduce:transition-none",
        dirty ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
      )}
    >
      {dirty ? (
        <span
          data-testid="tab-dirty"
          title="Unsaved changes"
          aria-label="Unsaved changes"
          className="size-2 rounded-full bg-primary group-hover/close:hidden"
        />
      ) : null}
      {/* `bold` is the ≤12px tier (CLAUDE.md): at 12px regular draws lighter
          than the label beside it, and coverage is scale-invariant. */}
      <XIcon weight="bold" className={cn("size-3", dirty && "hidden group-hover/close:block")} />
    </button>
  );
}

export { tabStopIndex } from "./tab-focus";
