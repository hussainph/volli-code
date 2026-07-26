import * as React from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { BracketsCurlyIcon } from "@phosphor-icons/react/dist/csr/BracketsCurly";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { SlidersIcon } from "@phosphor-icons/react/dist/csr/Sliders";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { Command } from "cmdk";
import { getBuiltinTheme, listBuiltinThemeNames } from "restty";
import { errorMessage, type ThemeDefinition } from "@volli/shared";

import { SettingsRow, SettingsSection } from "@renderer/components/pages/settings-shell";
import { ThemeEditor } from "@renderer/components/theme/theme-editor";
import { ThemePicker } from "@renderer/components/theme/theme-picker";
import {
  buildTerminalSettingRows,
  type TerminalSettingKey,
  type TerminalSettingRow,
} from "@renderer/components/theme/terminal-settings-model";
import {
  buildEditorThemeDisplay,
  planEditorThemePreview,
  type EditorThemeDisplay,
} from "@renderer/components/theme/editor-settings-model";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { listEditorThemes, type EditorThemeEntry } from "@renderer/editor/editor-theme-catalog";
import { refreshMonacoEditorTheme } from "@renderer/editor/monaco-theme";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import { writeThrough } from "@renderer/stores/mutate";
import { useThemeStore, type ThemeScope } from "@renderer/stores/theme";
import { previewTerminalTheme } from "@renderer/terminal/appearance";
import { DEFAULT_TERMINAL_FONT_SIZE } from "@renderer/terminal/appearance-model";
import { listLocalFontFamilies } from "@renderer/terminal/local-fonts";

/**
 * Settings → Appearance: the app surface's theme picker, and the terminal's.
 *
 * The terminal half is where decision #67 becomes visible. Volli NEVER writes
 * the user's own ghostty config; it writes an overlay file in ghostty's own
 * format, layered on top. So every row here states where its value came from
 * (`Inherited from Ghostty` / `Set by Volli`), reverting means REMOVING a key
 * from Volli's overlay rather than editing the user's file, and both files are
 * one click away — because the file, not this panel, is the full interface
 * (#68: the overlay takes any ghostty key, hand-written, and Volli honors it).
 *
 * Preview here is a real palette swap, not a sample panel: we render the
 * terminal, so highlighting a theme repaints every live session and closing
 * the menu puts it back.
 */
export function AppearanceSettings() {
  const terminal = useThemeStore((state) => state.terminal);
  const hydrated = useThemeStore((state) => state.hydrated);

  // Settings unmounts its inactive category, so entering this pane is the
  // right moment to make sure the authored state is loaded — boot already
  // hydrates, this only covers a boot-time read failure.
  React.useEffect(() => {
    if (!hydrated) void useThemeStore.getState().hydrate();
  }, [hydrated]);

  // Keyed, not indexed: which row goes in which slot is a property of the key,
  // not of the model's array order.
  const rows = React.useMemo(
    () =>
      Object.fromEntries(buildTerminalSettingRows(terminal).map((row) => [row.key, row])) as Record<
        TerminalSettingKey,
        TerminalSettingRow
      >,
    [terminal],
  );

  return (
    <>
      <AppThemeSection />

      <SettingsSection
        title="Editor"
        icon={BracketsCurlyIcon}
        description="Monaco syntax highlighting theme for file and document editors."
      >
        <EditorThemeRow />
      </SettingsSection>

      <SettingsSection
        title="Terminal"
        icon={TerminalWindowIcon}
        description="Layered over your Ghostty config. Volli never edits that file."
      >
        <TerminalThemeRow row={rows.theme} />
        <FontFamilyRow row={rows["font-family"]} />
        <FontSizeRow row={rows["font-size"]} />
        <SettingsRow label="Config files">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void revealPath(terminal?.ghosttyConfigPath ?? null)}
          >
            <FileTextIcon weight="fill" />
            Ghostty config
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void revealPath(terminal?.overlayPaths.global ?? null)}
          >
            <FileTextIcon weight="fill" />
            Volli overlay
          </Button>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}

/** Settings edits the theme every project inherits, so its scope is the global one. */
const GLOBAL_SCOPE: ThemeScope = { kind: "global" };

/** What the editor is open on: which theme, how, and whether the name is the point. */
interface OpenEdit {
  source: ThemeDefinition;
  focusName: boolean;
  mode: "edit" | "duplicate";
}

/**
 * The app-surface library: the picker, and the editor behind it.
 *
 * The two are one surface in two modes rather than two panels side by side.
 * Both drive the SAME live preview — the whole app repaints — so showing them
 * together would mean two controls arguing over what is on screen: moving the
 * picker's cursor would stomp the seed you were dragging, and hovering away
 * would revert it. One at a time makes "what am I looking at" answerable.
 */
function AppThemeSection() {
  const applied = useThemeStore((state) => state.global);
  const [editing, setEditing] = React.useState<OpenEdit | null>(null);
  const [deleting, setDeleting] = React.useState<ThemeDefinition | null>(null);

  // The theme files are hand-editable (#71), so entering this pane re-reads
  // them rather than trusting whatever boot last saw.
  React.useEffect(() => {
    void useThemeStore.getState().loadCustomThemes();
  }, []);

  const edit = (
    source: ThemeDefinition,
    options: { focusName?: boolean; duplicate?: boolean } = {},
  ): void =>
    setEditing({
      source,
      focusName: options.focusName ?? false,
      mode: options.duplicate ? "duplicate" : "edit",
    });

  return (
    <SettingsSection
      title="App theme"
      icon={PaletteIcon}
      action={
        editing === null ? (
          <Button variant="outline" size="sm" onClick={() => edit(applied)}>
            <SlidersIcon weight="fill" />
            Customize
          </Button>
        ) : null
      }
    >
      {editing === null ? (
        <div className="overflow-hidden rounded-lg border border-border bg-background">
          <ThemePicker
            autoFocus={false}
            // Duplicate always opens on a new copy; Rename lands on the name field.
            onDuplicate={(theme) => edit(theme, { duplicate: true })}
            onRename={(theme) => edit(theme, { focusName: true })}
            onDelete={setDeleting}
            onOpenFile={(theme) => void useThemeStore.getState().openCustomThemeFile(theme.slug)}
          />
        </div>
      ) : (
        <ThemeEditor
          key={`${editing.mode}:${editing.source.slug}`}
          source={editing.source}
          focusName={editing.focusName}
          mode={editing.mode}
          scope={GLOBAL_SCOPE}
          onClose={() => setEditing(null)}
        />
      )}
      <DeleteThemeDialog theme={deleting} onOpenChange={() => setDeleting(null)} />
    </SettingsSection>
  );
}

/**
 * Deleting a theme deletes a FILE the user wrote, and the ⋯ menu it is reached
 * from is one mis-aimed click away from Open file — so it confirms, and names
 * the theme it is about to remove.
 */
function DeleteThemeDialog({
  theme,
  onOpenChange,
}: {
  theme: ThemeDefinition | null;
  onOpenChange(open: boolean): void;
}) {
  const [pending, setPending] = React.useState(false);

  return (
    <AlertDialog
      open={theme !== null}
      onOpenChange={(open) => {
        if (!open) setPending(false);
        onOpenChange(open);
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {theme?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its file is removed from your themes folder. Anything already wearing this theme keeps
            the colors it has.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(event) => {
              // Kept open across the write, so a failed delete leaves the
              // confirm (and its toast) rather than closing as if it worked.
              event.preventDefault();
              if (theme === null) return;
              setPending(true);
              void useThemeStore
                .getState()
                .deleteCustomTheme(theme.slug)
                .then((deleted) => {
                  setPending(false);
                  if (deleted) onOpenChange(false);
                });
            }}
          >
            Delete theme
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Provenance chip for the Editor theme row, plus reset when explicitly pinned. */
function EditorThemeOriginBadge({ display }: { display: EditorThemeDisplay }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={cn(
          "rounded-full border px-2 py-0.5 text-label",
          display.source === "automatic"
            ? "border-border text-muted-foreground"
            : "border-primary/40 text-primary-text",
        )}
      >
        {display.sourceLabel}
      </span>
      {display.resettable ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Reset editor theme to match app theme"
          title="Reset to match app theme"
          onClick={() => void useThemeStore.getState().setEditorTheme(null)}
        >
          <ArrowCounterClockwiseIcon />
        </Button>
      ) : null}
    </span>
  );
}

/**
 * Monaco/shiki theme picker over the shipped catalog.
 *
 * Apply-then-revert preview (same contract as TerminalThemeRow): highlighting
 * a row paints Monaco via {@link refreshMonacoEditorTheme} and writes nothing;
 * picking one persists through {@link useThemeStore.setEditorTheme}; closing
 * the menu any other way restores the resolved theme.
 */
function EditorThemeRow() {
  const editorThemeId = useThemeStore((state) => state.editorThemeId);
  const appThemeSlug = useThemeStore((state) => state.global.slug);
  const [open, setOpen] = React.useState(false);
  // cmdk only calls `onValueChange` when the root is CONTROLLED — uncontrolled
  // it just updates its own store and returns, so an uncontrolled picker here
  // would silently never preview anything.
  const [selected, setSelected] = React.useState("");
  const themes = React.useMemo(() => listEditorThemes(), []);

  const display = React.useMemo(
    () => buildEditorThemeDisplay({ editorThemeId, appThemeSlug, themes }),
    [editorThemeId, appThemeSlug, themes],
  );

  const paintPreview = React.useCallback(
    (selection: string): void => {
      const plan = planEditorThemePreview({
        selection,
        resolvedId: display.resolvedId,
      });
      refreshMonacoEditorTheme(plan.themeId);
    },
    [display.resolvedId],
  );

  const endPreview = React.useCallback((): void => {
    paintPreview("");
  }, [paintPreview]);

  // Leaving the surface with a preview running would strand Monaco on a theme
  // that is not stored anywhere.
  React.useEffect(() => endPreview, [endPreview]);

  return (
    <SettingsRow label="Theme">
      <EditorThemeOriginBadge display={display} />
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) endPreview();
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            aria-label="Editor theme"
            className="w-52 justify-between"
          >
            <span className="truncate">{display.label}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-0">
          <Command
            loop
            value={selected}
            onValueChange={(id) => {
              setSelected(id);
              paintPreview(id);
            }}
            // The pointer wandering off the list ends the preview, same as the
            // terminal picker: a hover has no Escape.
            onPointerLeave={() => {
              setSelected("");
              endPreview();
            }}
            className="flex flex-col overflow-hidden rounded-md"
          >
            <Command.Input
              autoFocus
              aria-label="Search editor themes"
              placeholder="Search themes…"
              className="h-9 border-b border-border bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <Command.List className="max-h-64 overflow-y-auto p-1">
              <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
                No matching theme.
              </Command.Empty>
              {themes.map((theme: EditorThemeEntry) => (
                <Command.Item
                  key={theme.id}
                  value={theme.id}
                  keywords={[theme.label, theme.family ?? ""]}
                  onSelect={() => {
                    // Commit first, then drop the preview: setEditorTheme
                    // refreshes Monaco to the same id, so there is no flash.
                    void useThemeStore
                      .getState()
                      .setEditorTheme(theme.id)
                      .then((saved) => {
                        if (saved) setOpen(false);
                        endPreview();
                      });
                  }}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                >
                  <span className="truncate">{theme.label}</span>
                  {theme.id === display.resolvedId ? (
                    <CheckIcon weight="bold" className="size-3.5" />
                  ) : null}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </PopoverContent>
      </Popover>
    </SettingsRow>
  );
}

/** Reveal a config file in Finder; a missing path or a failed reveal toasts. */
async function revealPath(path: string | null): Promise<void> {
  if (path === null) {
    toastError("Terminal config hasn't loaded yet.");
    return;
  }
  try {
    const result = await window.api.fs.revealInFinder(path);
    if (!result.ok) toastError(`Couldn't reveal ${path}: ${result.error}`);
  } catch (error) {
    toastError(`Couldn't reveal ${path}: ${errorMessage(error)}`);
  }
}

/**
 * Writes overlay keys and adopts the freshly-resolved appearance main hands
 * back, so the provenance labels update without a second round trip. Live
 * terminals repaint from main's own file-watch broadcast.
 */
async function writeOverlay(edits: Record<string, string | null>): Promise<boolean> {
  const result = await writeThrough("update the terminal settings", () =>
    window.api.theme.writeGlobalOverlay(edits),
  );
  if (result === null) return false;
  useThemeStore.getState().acceptTerminal(result.terminal);
  return true;
}

/** The origin label plus, when something set the key, its one-click revert. */
function OriginBadge({ row }: { row: TerminalSettingRow }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={cn(
          "rounded-full border px-2 py-0.5 text-label",
          row.source === "default"
            ? "border-border text-muted-foreground"
            : row.source === "ghostty"
              ? "border-border text-muted-foreground"
              : // The label is 11px, so it needs the text token even more than
                // body copy does; the border stays on --primary, which is a fill.
                "border-primary/40 text-primary-text",
        )}
      >
        {row.sourceLabel}
      </span>
      {row.revertible ? <RevertButton settingKey={row.key} /> : null}
    </span>
  );
}

/**
 * Revert = remove the key from Volli's overlay. That is the whole mechanism:
 * whatever the user's own config says then wins again, without Volli having
 * touched it.
 */
function RevertButton({ settingKey }: { settingKey: TerminalSettingKey }) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={`Revert ${settingKey}`}
      title="Revert to Ghostty"
      onClick={() => void writeOverlay({ [settingKey]: null })}
    >
      <ArrowCounterClockwiseIcon />
    </Button>
  );
}

/**
 * Repaints every live terminal in `name`'s palette, writing nothing. A name the
 * catalog doesn't have (cmdk hands back `""` when the selection empties) ends
 * the preview rather than painting nothing.
 */
const preview = (name: string): void => previewTerminalTheme(getBuiltinTheme(name));

/** Puts the resolved palette back, ending a preview. */
const endPreview = (): void => previewTerminalTheme(null);

/**
 * Terminal theme picker over restty's bundled catalog — which IS ghostty's
 * full theme collection, already in the app bundle.
 *
 * Apply-then-revert preview: highlighting a name repaints every live terminal
 * and writes nothing; picking one writes `theme = <name>` to the overlay;
 * closing the menu any other way puts the resolved palette back.
 */
function TerminalThemeRow({ row }: { row: TerminalSettingRow }) {
  const [open, setOpen] = React.useState(false);
  // cmdk only calls `onValueChange` when the root is CONTROLLED — uncontrolled
  // it just updates its own store and returns (see its `setState`), so an
  // uncontrolled picker here would silently never preview anything.
  const [selected, setSelected] = React.useState("");
  const names = React.useMemo(() => listBuiltinThemeNames(), []);

  // Leaving the surface with a preview running would strand every terminal on
  // a palette that is not stored anywhere.
  React.useEffect(() => endPreview, []);

  return (
    <SettingsRow label={row.label}>
      <OriginBadge row={row} />
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) endPreview();
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            aria-label="Terminal theme"
            className="w-52 justify-between"
          >
            <span className="truncate">{row.value ?? "Volli Dark"}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-0">
          <Command
            loop
            value={selected}
            onValueChange={(name) => {
              setSelected(name);
              preview(name);
            }}
            // The pointer wandering off the list ends the preview, same as in
            // the app-theme picker: a hover has no Escape. Clearing the
            // selection keeps cmdk from swallowing the re-entry onto the row
            // it left highlighted.
            onPointerLeave={() => {
              setSelected("");
              endPreview();
            }}
            className="flex flex-col overflow-hidden rounded-md"
          >
            <Command.Input
              autoFocus
              aria-label="Search terminal themes"
              placeholder="Search themes…"
              className="h-9 border-b border-border bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <Command.List className="max-h-64 overflow-y-auto p-1">
              <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
                No matching theme.
              </Command.Empty>
              {names.map((name) => (
                <Command.Item
                  key={name}
                  value={name}
                  onSelect={() => {
                    // Commit first, then drop the preview: the overlay write
                    // resolves into the same palette, so there is no flash.
                    void writeOverlay({ theme: name }).then((saved) => {
                      if (saved) setOpen(false);
                      endPreview();
                    });
                  }}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                >
                  <span className="truncate">{name}</span>
                  {name === row.value ? <CheckIcon weight="bold" className="size-3.5" /> : null}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </PopoverContent>
      </Popover>
    </SettingsRow>
  );
}

/**
 * Font family, from the Local Font Access list restty already resolves
 * families against — so the list can only contain faces the terminal will
 * actually be able to load.
 */
function FontFamilyRow({ row }: { row: TerminalSettingRow }) {
  const [open, setOpen] = React.useState(false);
  const [families, setFamilies] = React.useState<readonly string[] | null>(null);

  React.useEffect(() => {
    if (!open || families !== null) return;
    let cancelled = false;
    void listLocalFontFamilies().then((found) => {
      if (!cancelled) setFamilies(found);
    });
    return () => {
      cancelled = true;
    };
  }, [open, families]);

  return (
    <SettingsRow label={row.label}>
      <OriginBadge row={row} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="w-52 justify-between">
            <span className="truncate">{row.value ?? "Ghostty default"}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-0">
          <Command loop className="flex flex-col overflow-hidden rounded-md">
            <Command.Input
              autoFocus
              placeholder="Search fonts…"
              className="h-9 border-b border-border bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <Command.List className="max-h-64 overflow-y-auto p-1">
              <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
                {families === null
                  ? "Loading fonts…"
                  : families.length === 0
                    ? "No fonts found. Set font-family in the overlay file."
                    : "No matching font."}
              </Command.Empty>
              {(families ?? []).map((family) => (
                <Command.Item
                  key={family}
                  value={family}
                  onSelect={() => {
                    void writeOverlay({ "font-family": family }).then((saved) => {
                      if (saved) setOpen(false);
                    });
                  }}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                >
                  <span className="truncate">{family}</span>
                  {family === row.value ? <CheckIcon weight="bold" className="size-3.5" /> : null}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </PopoverContent>
      </Popover>
    </SettingsRow>
  );
}

/** Font size bounds. Below 6pt the grid stops being legible; above 32 a pane holds almost nothing. */
const FONT_SIZE_RANGE = { min: 6, max: 32 } as const;

/**
 * A stepper rather than a free number field: every step lands on a valid size.
 *
 * Clicks arrive far faster than the overlay round-trip, so a step counts from
 * its own pending target rather than from the last resolved value — reading the
 * store would make the second of two fast clicks recompute the same number and
 * silently drop it. The pending target also drives the display, so the stepper
 * responds to the click rather than to the file write, and it is handed back to
 * the store once the last write in a burst settles (including a failed one:
 * `writeOverlay` has toasted, and the number must go back to what is stored).
 *
 * The writes are CHAINED, never concurrent: each is a read-modify-write of one
 * config file, and two in flight at once can interleave into a file that says
 * neither.
 */
function FontSizeRow({ row }: { row: TerminalSettingRow }) {
  const current = useThemeStore((state) => state.terminal?.prefs.fontSize ?? null);
  const [pending, setPending] = React.useState<number | null>(null);
  // The same target as `pending`, readable synchronously — two clicks in one
  // tick share a render, and so would share a stale `pending`.
  const target = React.useRef<number | null>(null);
  const queue = React.useRef<Promise<void>>(Promise.resolve());
  const size = pending ?? current ?? DEFAULT_TERMINAL_FONT_SIZE;

  const step = (delta: 1 | -1): void => {
    const from = target.current ?? current ?? DEFAULT_TERMINAL_FONT_SIZE;
    const next = Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, from + delta));
    if (next === from) return;
    target.current = next;
    setPending(next);
    const settle = (): void => {
      // Only the last click of a burst gives the display back — an earlier one
      // would flash the size the file had two clicks ago.
      if (target.current !== next) return;
      target.current = null;
      setPending(null);
    };
    // Settled on BOTH paths: `writeOverlay` toasts and resolves rather than
    // rejecting, but one rejected link would be inherited by every later click
    // — the chain would stop running and the stepper would freeze on a pending
    // number forever. `.then(settle, settle)` also heals it.
    queue.current = queue.current
      .then(() => writeOverlay({ "font-size": String(next) }))
      .then(settle, settle);
  };

  return (
    <SettingsRow label={row.label}>
      <OriginBadge row={row} />
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Decrease terminal font size"
          disabled={size <= FONT_SIZE_RANGE.min}
          onClick={() => step(-1)}
        >
          <MinusIcon />
        </Button>
        <span className="w-12 text-center text-ui tabular-nums">{size} pt</span>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Increase terminal font size"
          disabled={size >= FONT_SIZE_RANGE.max}
          onClick={() => step(1)}
        >
          <PlusIcon />
        </Button>
      </div>
    </SettingsRow>
  );
}
