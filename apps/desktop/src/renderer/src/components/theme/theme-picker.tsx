import * as React from "react";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { StarIcon } from "@phosphor-icons/react/dist/csr/Star";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { Command } from "cmdk";
import { generateThemeTokens, type ThemeDefinition, type ThemeTokens } from "@volli/shared";

import {
  buildThemePickerGroups,
  themeForRowKey,
  type ThemePickerRow,
} from "@renderer/components/theme/theme-picker-model";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { Dialog, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import { cn } from "@renderer/lib/utils";
import { useThemeStore, appliedTheme, type ThemeScope } from "@renderer/stores/theme";
import { BUILTIN_THEMES } from "@renderer/theme/catalog";

/**
 * The one theme picker (decision #73), used identically from global Settings,
 * a project's Configure, and ⌘K. Everything it knows how to decide lives in
 * theme-picker-model.ts; this file is the surface.
 *
 * The behavior worth naming is **preview**. Moving the selection applies the
 * theme to the live DOM and writes NOTHING — Enter commits, Escape (or an
 * unmount, which is what closing the dialog is) restores what was there
 * before. That is only safe because nothing along the preview path persists:
 * see stores/theme.ts, where `startPreview` is memory-only by construction
 * rather than by discipline.
 */

/** Hoisted so the default `scope` is a stable reference across renders. */
const GLOBAL_SCOPE: ThemeScope = { kind: "global" };

/**
 * Row actions (#73). Each is OMITTED from the ⋯ menu until a host supplies its
 * handler, and with none supplied there is no menu at all — a menu of dead
 * items promises an editor that doesn't exist yet.
 */
export interface ThemeRowActions {
  /** Copy a theme into an editable one of your own. */
  onDuplicate?(theme: ThemeDefinition): void;
  onRename?(theme: ThemeDefinition): void;
  onDelete?(theme: ThemeDefinition): void;
  /** Reveal the theme's JSON file — a theme is meant to stay a shareable artifact. */
  onOpenFile?(theme: ThemeDefinition): void;
}

export interface ThemePickerProps extends ThemeRowActions {
  /**
   * Where a commit is written (#69). Defaults to the global scope; the
   * per-project entry point passes its project and the same component handles
   * it, because "override this project's theme" is the same capability as
   * setting the global one, just scoped.
   */
  scope?: ThemeScope;
  /**
   * Themes beyond the shipped catalog — the user's own theme files land here.
   * Merged after {@link BUILTIN_THEMES}, so shipped themes stay on top.
   */
  themes?: readonly ThemeDefinition[];
  /** After a successful commit. The ⌘K host closes itself here. */
  onCommitted?(theme: ThemeDefinition): void;
  /** After an explicit Escape. The pre-preview theme has already been restored. */
  onCancelled?(): void;
  autoFocus?: boolean;
  className?: string;
}

export function ThemePicker({
  scope = GLOBAL_SCOPE,
  themes,
  onCommitted,
  onCancelled,
  autoFocus = true,
  className,
  ...actions
}: ThemePickerProps) {
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState("");
  const favorites = useThemeStore((state) => state.favorites);
  const recents = useThemeStore((state) => state.recents);
  // What this scope has STORED, not what is on screen: while previewing, the
  // effective theme is the row under the cursor, so tagging that one "Current"
  // would drag the tag down the list and hide where Escape goes back to.
  const applied = useThemeStore((state) => appliedTheme(state, scope));

  const catalog = React.useMemo(
    () => (themes === undefined ? BUILTIN_THEMES : [...BUILTIN_THEMES, ...themes]),
    [themes],
  );
  const groups = React.useMemo(
    () => buildThemePickerGroups({ themes: catalog, favorites, recents, query }),
    [catalog, favorites, recents, query],
  );

  // Leaving the picker at all — Escape, closing the dialog, navigating away —
  // puts the previous theme back. An abandoned preview must never survive the
  // surface that started it.
  React.useEffect(() => () => useThemeStore.getState().cancelPreview(), []);

  const previewSelection = (key: string): void => {
    setSelected(key);
    const theme = themeForRowKey(groups, key);
    if (theme !== undefined) useThemeStore.getState().startPreview(theme);
  };

  const commit = (theme: ThemeDefinition): void => {
    useThemeStore.getState().startPreview(theme);
    void useThemeStore
      .getState()
      .commitPreview(scope)
      .then((saved) => {
        if (saved) onCommitted?.(theme);
      });
  };

  const cancel = (): void => {
    useThemeStore.getState().cancelPreview();
    onCancelled?.();
  };

  /**
   * A hover-preview has no natural end. Keyboard previews are bounded — Escape
   * reverts, Enter commits — but the pointer just wanders off, and on a
   * surface that stays mounted (Settings) the abandoned preview would sit
   * there looking exactly like the applied theme. So the pointer leaving IS
   * the "never mind": revert to what is stored.
   *
   * Only `cancelPreview`, never `cancel` — `onCancelled` closes the ⌘K dialog,
   * and moving the mouse off the list must not dismiss the picker.
   *
   * The selection is cleared too. cmdk no-ops on an unchanged value, so a row
   * left highlighted would swallow the re-entry and never preview again; and
   * a highlight with nothing previewed reads as a lie about what is on screen.
   * Clearing is safe: the controlled-value effect assigns the value directly
   * rather than going through `setState`, so this cannot re-enter as a preview.
   */
  const endHoverPreview = (): void => {
    setSelected("");
    useThemeStore.getState().cancelPreview();
  };

  return (
    <Command
      label="Themes"
      loop
      // The model owns filtering (it also searches the derived tag chips), so
      // cmdk must not filter a second time over its own item values.
      shouldFilter={false}
      value={selected}
      onValueChange={previewSelection}
      onPointerLeave={endHoverPreview}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
      className={cn("flex min-h-0 flex-col overflow-hidden", className)}
    >
      <div className="flex h-10 items-center gap-2 border-b border-border px-3">
        <MagnifyingGlassIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <Command.Input
          autoFocus={autoFocus}
          value={query}
          onValueChange={setQuery}
          placeholder="Search themes…"
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <Command.List className="max-h-[min(420px,55vh)] overflow-y-auto p-2 [scrollbar-gutter:stable]">
        <Command.Empty className="py-8 text-center text-sm text-muted-foreground">
          No themes match.
        </Command.Empty>
        {groups.map((group) => (
          <Command.Group
            key={group.key}
            heading={group.label}
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-label [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-muted-foreground"
          >
            {group.rows.map((row) => (
              <ThemeRow
                key={row.key}
                row={row}
                active={row.theme.slug === applied.slug}
                actions={actions}
                onCommit={() => commit(row.theme)}
              />
            ))}
          </Command.Group>
        ))}
      </Command.List>
      <div className="flex h-8 items-center justify-end gap-3 border-t border-border px-3 text-label text-muted-foreground">
        <span>↑↓ preview</span>
        <span>↵ apply</span>
        <span>esc revert</span>
      </div>
    </Command>
  );
}

/**
 * The ⌘K entry point: the same picker in a modal. Closing it (Escape, the
 * overlay, a successful apply) unmounts the picker, which restores whatever was
 * on screen before the preview started.
 */
export function ThemePickerDialog({
  open,
  onOpenChange,
  ...props
}: ThemePickerProps & { open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        // The picker's own footer states the key bindings on screen; a
        // description here would only repeat them into the a11y tree.
        aria-describedby={undefined}
        className="top-[18%] max-w-[min(560px,calc(100vw-32px))] translate-y-0 gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">Change theme</DialogTitle>
        <ThemePicker
          {...props}
          onCommitted={(theme) => {
            props.onCommitted?.(theme);
            onOpenChange(false);
          }}
          onCancelled={() => {
            props.onCancelled?.();
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * One theme row: a generated swatch, the name, its derived chips, the favorite
 * star, and — only when a host actually supplied actions — the ⋯ menu.
 *
 * The ⋯ button opens the row's real context menu by dispatching a synthetic
 * `contextmenu` event at its own position, rather than duplicating the menu in
 * a second primitive. One definition of the menu means right-click and the
 * button can never drift apart — and it keeps every action on the shared
 * context-menu primitive, whose items require a neighboring Phosphor icon.
 *
 * An unsupplied action is OMITTED, never shown disabled: the theme editor is a
 * later PR, and a menu of four permanently-dead items promises a capability
 * that doesn't exist. With none of them supplied there is no menu at all — no
 * ⋯ button, no right-click target — so the affordance appears exactly when it
 * works. {@link ThemeRowActions} is unchanged, so passing handlers lights it up.
 */
function ThemeRow({
  row,
  active,
  actions,
  onCommit,
}: {
  row: ThemePickerRow;
  active: boolean;
  actions: ThemeRowActions;
  onCommit(): void;
}) {
  const triggerRef = React.useRef<HTMLDivElement>(null);
  const { theme } = row;
  const { onDuplicate, onRename, onOpenFile, onDelete } = actions;
  const hasMenu =
    onDuplicate !== undefined ||
    onRename !== undefined ||
    onOpenFile !== undefined ||
    onDelete !== undefined;

  const openMenu = (event: React.MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    triggerRef.current?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: rect.left,
        clientY: rect.bottom,
      }),
    );
  };

  const item = (
    <Command.Item
      value={row.key}
      onSelect={onCommit}
      className="group flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
    >
      <ThemeSwatch theme={theme} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">
          {theme.name}
          {active ? <span className="ml-2 text-label text-muted-foreground">Current</span> : null}
        </span>
        <span className="flex gap-1.5 pt-0.5">
          {row.tags.map((tag) => (
            <span
              key={`${tag.kind}:${tag.label}`}
              className="rounded-full border border-border px-1.5 text-label text-muted-foreground"
            >
              {tag.label}
            </span>
          ))}
        </span>
      </span>
      <button
        type="button"
        aria-label={row.favorite ? `Unfavorite ${theme.name}` : `Favorite ${theme.name}`}
        aria-pressed={row.favorite}
        // cmdk selects on pointerdown; stop it so starring never also
        // applies the theme under the cursor.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          useThemeStore.getState().toggleFavorite(theme.slug);
        }}
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground",
          row.favorite
            ? "text-primary hover:text-primary"
            : "opacity-0 group-hover:opacity-100 focus:opacity-100",
        )}
      >
        <StarIcon weight={row.favorite ? "fill" : "regular"} className="size-3.5" />
      </button>
      {hasMenu ? (
        <button
          type="button"
          aria-label={`More actions for ${theme.name}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={openMenu}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 focus:opacity-100"
        >
          <DotsThreeIcon weight="bold" className="size-4" />
        </button>
      ) : null}
    </Command.Item>
  );

  if (!hasMenu) return item;

  return (
    <ContextMenu>
      <ContextMenuTrigger ref={triggerRef} asChild>
        {item}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        {onDuplicate === undefined ? null : (
          <ContextMenuItem icon={CopyIcon} onSelect={() => onDuplicate(theme)}>
            Duplicate
          </ContextMenuItem>
        )}
        {onRename === undefined ? null : (
          <ContextMenuItem icon={PencilSimpleIcon} onSelect={() => onRename(theme)}>
            Rename
          </ContextMenuItem>
        )}
        {onOpenFile === undefined ? null : (
          <ContextMenuItem icon={FileTextIcon} onSelect={() => onOpenFile(theme)}>
            Open file
          </ContextMenuItem>
        )}
        {onDelete === undefined ? null : (
          <ContextMenuItem icon={TrashIcon} variant="destructive" onSelect={() => onDelete(theme)}>
            Delete
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Generated tokens per theme, cached at module level rather than per mount.
 * Filtering the list drops rows from the tree entirely (the model owns
 * filtering — see `shouldFilter={false}` above), so every row REMOUNTS on every
 * keystroke and a `useMemo` would re-run the OKLCH/APCA generation for each
 * visible theme each time. Keyed weakly on the catalog's own theme objects, so
 * a discarded custom theme takes its entry with it.
 */
const swatchTokens = new WeakMap<ThemeDefinition, ThemeTokens>();

function themeSwatchTokens(theme: ThemeDefinition): ThemeTokens {
  const cached = swatchTokens.get(theme);
  if (cached !== undefined) return cached;
  const tokens = generateThemeTokens(theme);
  swatchTokens.set(theme, tokens);
  return tokens;
}

/** A four-stripe preview of the theme's own generated surfaces and accent. */
function ThemeSwatch({ theme }: { theme: ThemeDefinition }) {
  const tokens = themeSwatchTokens(theme);
  return (
    <span
      aria-hidden
      className="flex size-7 shrink-0 overflow-hidden rounded-md border border-border"
      style={{ backgroundColor: tokens["--background"] }}
    >
      <span className="w-1/3" style={{ backgroundColor: tokens["--card"] }} />
      <span className="w-1/3" style={{ backgroundColor: tokens["--border-strong"] }} />
      <span className="w-1/3" style={{ backgroundColor: tokens["--primary"] }} />
    </span>
  );
}
