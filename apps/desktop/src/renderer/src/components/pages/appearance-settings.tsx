import * as React from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { Command } from "cmdk";
import { getBuiltinTheme, listBuiltinThemeNames } from "restty";
import { errorMessage } from "@volli/shared";

import { SettingsRow, SettingsSection } from "@renderer/components/pages/settings-shell";
import { ThemePicker } from "@renderer/components/theme/theme-picker";
import {
  buildTerminalSettingRows,
  type TerminalSettingKey,
  type TerminalSettingRow,
} from "@renderer/components/theme/terminal-settings-model";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import { writeThrough } from "@renderer/stores/mutate";
import { useThemeStore } from "@renderer/stores/theme";
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

  const rows = React.useMemo(() => buildTerminalSettingRows(terminal), [terminal]);

  return (
    <>
      <SettingsSection
        title="App theme"
        icon={PaletteIcon}
        description="One color drives the whole surface — the neutral ladder, the accent, and every border is derived from it, so no theme can be unreadable. Move through the list to preview; Enter applies."
      >
        <div className="overflow-hidden rounded-lg border border-border bg-background">
          <ThemePicker autoFocus={false} />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Terminal"
        icon={TerminalWindowIcon}
        description="Volli layers its own settings on top of your Ghostty config and never edits that file. Anything set here wins; reverting hands the key back to Ghostty."
      >
        <TerminalThemeRow row={rows[0]!} />
        <FontFamilyRow row={rows[1]!} />
        <FontSizeRow row={rows[2]!} />
        <SettingsRow
          label="Configuration files"
          description="The overlay accepts any Ghostty key by hand — Volli preserves your lines and comments when it rewrites the keys it manages."
        >
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

/** Reveal a config file in Finder; a missing path or a failed reveal toasts. */
async function revealPath(path: string | null): Promise<void> {
  if (path === null) {
    toastError("Volli hasn't resolved the terminal configuration yet.");
    return;
  }
  try {
    const result = await window.api.fs.revealInFinder(path);
    if (!result.ok) toastError(`Could not reveal ${path}: ${result.error}`);
  } catch (error) {
    toastError(`Could not reveal ${path}: ${errorMessage(error)}`);
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
              : "border-primary/40 text-primary",
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
      title="Remove Volli's setting and inherit from Ghostty"
      onClick={() => void writeOverlay({ [settingKey]: null })}
    >
      <ArrowCounterClockwiseIcon />
    </Button>
  );
}

/** Repaints every live terminal in `name`'s palette, writing nothing. */
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
  const names = React.useMemo(() => listBuiltinThemeNames(), []);

  // Leaving the surface with a preview running would strand every terminal on
  // a palette that is not stored anywhere.
  React.useEffect(() => endPreview, []);

  return (
    <SettingsRow label={row.label} description="Ghostty's full theme catalog, bundled with Volli.">
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
            onValueChange={preview}
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
    <SettingsRow
      label={row.label}
      description="Installed fonts, resolved the same way Ghostty resolves them."
    >
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
                  ? "Reading installed fonts…"
                  : families.length === 0
                    ? "No installed fonts available — set font-family in the overlay file."
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

/** A stepper rather than a free number field: every step lands on a valid size. */
function FontSizeRow({ row }: { row: TerminalSettingRow }) {
  const current = useThemeStore((state) => state.terminal?.prefs.fontSize ?? null);
  const size = current ?? DEFAULT_TERMINAL_FONT_SIZE;

  const step = (delta: 1 | -1): void => {
    const next = Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, size + delta));
    if (next === size) return;
    void writeOverlay({ "font-size": String(next) });
  };

  return (
    <SettingsRow label={row.label} description="Points, as Ghostty measures them.">
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
