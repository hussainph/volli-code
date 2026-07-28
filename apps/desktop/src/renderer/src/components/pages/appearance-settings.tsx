import * as React from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { BracketsCurlyIcon } from "@phosphor-icons/react/dist/csr/BracketsCurly";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { getBuiltinTheme } from "restty";

import { SettingsRow, SettingsSection } from "@renderer/components/pages/settings-shell";
import {
  editorThemeItems,
  FALLBACK_TERMINAL_THEME_LABEL,
  revealPath,
  terminalThemeItems,
} from "@renderer/components/theme/appearance-catalog";
import { ThemeComboBox, ThemeOriginPill } from "@renderer/components/theme/theme-combo-box";
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
import { Button } from "@renderer/components/ui/button";
import { listEditorThemes } from "@renderer/editor/editor-theme-catalog";
import { writeThrough } from "@renderer/stores/mutate";
import { useThemeStore } from "@renderer/stores/theme";
import { previewTerminalTheme } from "@renderer/terminal/appearance";
import { DEFAULT_TERMINAL_FONT_SIZE } from "@renderer/terminal/appearance-model";
import { listLocalFontFamilies } from "@renderer/terminal/local-fonts";

/**
 * Settings → Appearance: the app surface's theme picker, the Monaco editor
 * theme, and the terminal's.
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
 * the menu puts it back. The Editor picker does the same for Monaco through
 * the theme store ({@link useThemeStore.startEditorPreview} /
 * {@link useThemeStore.endEditorPreview}) so `paintedEditor` stays coherent
 * with App-theme preview.
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

/**
 * Placeholder for the canvas editor.
 *
 * The seed-based picker and its theme-file editor stood here and are gone with
 * the system behind them; the stop editor that replaces them is the next change
 * on this branch, and it lands in exactly this slot. A panel that says so is the
 * honest interim — an empty section would read as a broken pane, and half a
 * control would be a surface arguing with the window it cannot yet change.
 */
function AppThemeSection() {
  return (
    <SettingsSection
      title="App theme"
      icon={PaletteIcon}
      description="The gradient this window is painted with, and whether it renders light or dark."
    >
      <div
        data-testid="appearance-canvas-placeholder"
        className="rounded-lg border border-border bg-background px-4 py-6 text-center"
      >
        <p className="text-sm text-foreground">The canvas editor lands next.</p>
        <p className="mt-1 text-ui text-muted-foreground">
          Volli is painted from a canvas you author — a gradient, its saturation and its texture —
          which renders correctly in both light and dark. The controls for it arrive in the next
          change; until then the window wears the shipped default.
        </p>
      </div>
    </SettingsSection>
  );
}

/** Provenance chip for the Editor theme row, plus reset when explicitly pinned. */
function EditorThemeOriginBadge({ display }: { display: EditorThemeDisplay }) {
  return (
    <span className="flex items-center gap-1.5">
      <ThemeOriginPill emphasized={display.source !== "automatic"}>
        {display.sourceLabel}
      </ThemeOriginPill>
      {display.resettable ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Reset editor theme to the default"
          title="Reset to the default"
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
 * a row paints Monaco via {@link useThemeStore.startEditorPreview} and writes
 * nothing; picking one persists through {@link useThemeStore.setEditorTheme};
 * closing the menu any other way restores through
 * {@link useThemeStore.endEditorPreview} — never a stale closure over the
 * pre-commit resolved id, and never a direct Monaco call that would desync
 * `paintedEditor`.
 */
function EditorThemeRow() {
  const editorThemeId = useThemeStore((state) => state.editorThemeId);
  const themes = React.useMemo(() => listEditorThemes(), []);
  const items = React.useMemo(() => editorThemeItems(), []);

  const display = React.useMemo(
    () => buildEditorThemeDisplay({ editorThemeId, themes }),
    [editorThemeId, themes],
  );

  return (
    <SettingsRow label="Theme">
      <EditorThemeOriginBadge display={display} />
      <ThemeComboBox
        ariaLabel="Editor theme"
        searchLabel="Search editor themes"
        buttonLabel={display.label}
        empty="No matching theme."
        items={items}
        activeValue={display.resolvedId}
        onPreview={(selection) => {
          const plan = planEditorThemePreview({ selection, resolvedId: display.resolvedId });
          if (plan.kind === "restore") endEditorPreview();
          else useThemeStore.getState().startEditorPreview(plan.themeId);
        }}
        onEndPreview={endEditorPreview}
        onSelect={(id) => useThemeStore.getState().setEditorTheme(id)}
      />
    </SettingsRow>
  );
}

/**
 * Puts Monaco back on the theme implied by the **current** theme store — the
 * committed editorThemeId, or the shipped default. Module-level
 * so the unmount-only effect stays exhaustive-deps clean (mirrors
 * TerminalThemeRow's `endPreview`).
 */
const endEditorPreview = (): void => {
  useThemeStore.getState().endEditorPreview();
};

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
      <ThemeOriginPill emphasized={row.source === "volli-global" || row.source === "volli-project"}>
        {row.sourceLabel}
      </ThemeOriginPill>
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
  const items = React.useMemo(() => terminalThemeItems(), []);

  return (
    <SettingsRow label={row.label}>
      <OriginBadge row={row} />
      <ThemeComboBox
        ariaLabel="Terminal theme"
        searchLabel="Search terminal themes"
        buttonLabel={row.value ?? FALLBACK_TERMINAL_THEME_LABEL}
        empty="No matching theme."
        items={items}
        activeValue={row.value}
        onPreview={preview}
        onEndPreview={endPreview}
        onSelect={(name) => writeOverlay({ theme: name })}
      />
    </SettingsRow>
  );
}

/**
 * Font family, from the Local Font Access list restty already resolves
 * families against — so the list can only contain faces the terminal will
 * actually be able to load.
 */
function FontFamilyRow({ row }: { row: TerminalSettingRow }) {
  const [opened, setOpened] = React.useState(false);
  const [families, setFamilies] = React.useState<readonly string[] | null>(null);
  const items = React.useMemo(
    () => (families ?? []).map((family) => ({ value: family, label: family })),
    [families],
  );

  React.useEffect(() => {
    if (!opened || families !== null) return;
    let cancelled = false;
    void listLocalFontFamilies().then((found) => {
      if (!cancelled) setFamilies(found);
    });
    return () => {
      cancelled = true;
    };
  }, [opened, families]);

  return (
    <SettingsRow label={row.label}>
      <OriginBadge row={row} />
      <ThemeComboBox
        ariaLabel="Terminal font family"
        searchLabel="Search fonts"
        searchPlaceholder="Search fonts…"
        buttonLabel={row.value ?? "Ghostty default"}
        empty={
          families === null
            ? "Loading fonts…"
            : families.length === 0
              ? "No fonts found. Set font-family in the overlay file."
              : "No matching font."
        }
        items={items}
        activeValue={row.value}
        // Enumerating the local font list is a permissioned round trip, so it
        // waits for the menu to actually open rather than running on mount.
        onOpenChange={(next) => {
          if (next) setOpened(true);
        }}
        onSelect={(family) => writeOverlay({ "font-family": family })}
      />
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
