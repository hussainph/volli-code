import * as React from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { resolveAppearance } from "@volli/shared";
import { getBuiltinTheme } from "restty";

import { SettingsRow, SettingsSection } from "@renderer/components/pages/settings-shell";
import {
  fallbackTerminalThemeLabel,
  revealPath,
  terminalThemeItems,
} from "@renderer/components/theme/appearance-catalog";
import { AppearanceModeChoice, CanvasEditor } from "@renderer/components/theme/canvas-editor";
import { ThemeComboBox, ThemeOriginPill } from "@renderer/components/theme/theme-combo-box";
import {
  buildTerminalSettingRows,
  type TerminalSettingKey,
  type TerminalSettingRow,
} from "@renderer/components/theme/terminal-settings-model";
import { Button } from "@renderer/components/ui/button";
import { writeThrough } from "@renderer/stores/mutate";
import { effectiveAppearance, useThemeStore, type ThemeScope } from "@renderer/stores/theme";
import { previewTerminalTheme } from "@renderer/terminal/appearance";
import { DEFAULT_TERMINAL_FONT_SIZE } from "@renderer/terminal/appearance-model";
import { listLocalFontFamilies } from "@renderer/terminal/local-fonts";

/**
 * Settings → Appearance: the canvas editor, the light/dark choice, and the
 * terminal's theme.
 *
 * There is no Editor row. The editor wears one light theme or one dark one,
 * decided by the light/dark choice above it (VC-123) — so the control that
 * would have gone here already exists, one section up.
 *
 * Handoff: UI slop pass stripped tutorial descriptions/tooltips from this pane
 * (Terminal keeps one Ghostty trust line). Don't add helper text back —
 * AGENTS.md / CLAUDE.md ("UI copy: let controls talk").
 *
 * Four sections, and the first two are separate on purpose. The canvas is a
 * gradient; the appearance is light, dark or follow-the-system; the per-mode
 * dials in the engine exist precisely so ONE canvas renders correctly in BOTH
 * modes. They are also scoped independently — a project can override either
 * alone — so a single "App theme" section owning both would be the one shape
 * that cannot express what is stored.
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
 *
 * The editor has no row and no preview of its own (VC-123). It wears one light
 * theme or one dark one, decided by Mode above — so the App theme section
 * previews Monaco too, through the same repaint.
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
        title="Terminal"
        icon={TerminalWindowIcon}
        description="Volli never edits your Ghostty config."
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
            <FileTextIcon />
            Ghostty config
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void revealPath(terminal?.overlayPaths.global ?? null)}
          >
            <FileTextIcon />
            Volli overlay
          </Button>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}

/**
 * The scope every control on this page writes to. Module-level so its identity
 * is stable — the editor holds it in `useCallback` dependencies, and a fresh
 * object each render would rebuild every handler on every paint of a surface
 * whose whole point is that it repaints continuously while you drag.
 */
const GLOBAL_SCOPE: ThemeScope = { kind: "global" };

/**
 * The app-wide canvas, and the mode it is seen in.
 *
 * Reads `globalCanvas` rather than whatever is on screen, and that distinction
 * is the page's one subtlety: a project can override the canvas, so the window
 * you are looking at while you edit may not be the one this section owns. The
 * note below says so instead of letting an edit look like it failed.
 *
 * The mode it renders the pad and the contrast alert at is the GLOBAL scope's
 * own resolution too — the same reason. A project pinned to light must not
 * make this section describe a light canvas the app-wide setting never asked for.
 *
 * LIGHT/DARK SITS HERE, above the canvas, because to anyone changing how the app
 * looks they are one subject; two sections read as bureaucracy. What has not
 * changed is the thing that split was protecting: THE CANVAS DOES NOT NAME A
 * MODE. The per-mode dials exist precisely so one authored gradient renders
 * correctly in both, and a project may override the mode or the canvas alone.
 * So this control is a SIBLING of `CanvasEditor`, never a child of it — inside
 * the editor it would claim the canvas is per-mode, and it would ride the editor
 * onto the per-project page, where a global-only setting has no business being.
 */
function AppThemeSection() {
  const canvas = useThemeStore((state) => state.globalCanvas);
  const appearance = useThemeStore((state) => state.globalAppearance);
  const systemPrefersDark = useThemeStore((state) => state.systemPrefersDark);
  const shadowed = useThemeStore((state) => (state.projectOverride?.canvas ?? null) !== null);
  const resolved = resolveAppearance(appearance, systemPrefersDark);

  return (
    <SettingsSection title="App theme" icon={PaletteIcon}>
      <SettingsRow label="Mode">
        <AppearanceModeChoice
          value={appearance}
          testId="appearance-mode"
          onChange={(next) => void useThemeStore.getState().setGlobalAppearance(next)}
        />
      </SettingsRow>
      <CanvasEditor scope={GLOBAL_SCOPE} canvas={canvas} resolved={resolved} />
      {shadowed ? <CanvasShadowedNote /> : null}
    </SettingsSection>
  );
}

/**
 * The note {@link AppThemeSection} shows while a project's canvas shadows the
 * global one. Exported for its copy: "Project" is CONTEXT.md's one user-facing
 * word for a rail entry (the VC-57 ruling), this pill is where "Workspace"
 * kept sneaking back in, and the suite cannot install an override to make the
 * conditional render it (`renderToStaticMarkup` reads a store's INITIAL
 * state), so the note itself is the testable surface.
 */
export function CanvasShadowedNote() {
  return (
    <p data-testid="appearance-canvas-shadowed" className="pt-2">
      <ThemeOriginPill emphasized={false}>Project override</ThemeOriginPill>
    </p>
  );
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
    <span className="flex items-center gap-1">
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
  // A string, so it is safe as a selector result (see `activeTheme`'s note), and
  // it is what makes the fallback label follow a mode flip live.
  const resolved = useThemeStore(effectiveAppearance);

  return (
    <SettingsRow label={row.label}>
      <OriginBadge row={row} />
      <ThemeComboBox
        ariaLabel="Terminal theme"
        searchLabel="Search terminal themes"
        buttonLabel={row.value ?? fallbackTerminalThemeLabel(resolved)}
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
