import { StyleChoice } from "../kit/style-choice";
import { Switch } from "@renderer/components/ui/switch";
import { useStyleStore } from "@renderer/stores/style";
import { OverrideLinks } from "../settings-navigation";
import { useProjectsStore } from "@renderer/stores/projects";
import { CanvasInstrument } from "../kit/canvas-instrument";
import { LoadingLabel } from "@renderer/components/ui/loading-label";
import * as React from "react";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { resolveAppearance } from "@volli/shared";

import { OverrideControl, PrefRow, PrefSection } from "@renderer/components/settings/kit";
import { fallbackTerminalThemeLabel, revealPath } from "@renderer/components/theme/appearance-rows";
import { AppearanceModeChoice } from "@renderer/components/theme/canvas-editor";
import { FontPicker } from "../kit/font-picker";
import {
  buildTerminalSettingRows,
  type TerminalSettingKey,
  type TerminalSettingRow,
} from "@renderer/components/theme/terminal-settings-model";
import { Button } from "@renderer/components/ui/button";
import { writeThrough } from "@renderer/stores/mutate";
import { effectiveAppearance, useThemeStore, type ThemeScope } from "@renderer/stores/theme";
import { DEFAULT_TERMINAL_FONT_SIZE } from "@renderer/terminal/appearance-model";
import { listLocalFontFamilies } from "@renderer/terminal/local-fonts";

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

      <PrefSection
        title="Terminal"
        icon={TerminalWindowIcon}
        // The one-line trust boundary: whose file Volli writes.
        hint={<>Volli writes an overlay file and never edits your Ghostty config.</>}
      >
        <TerminalThemeRow row={rows.theme} />
        <FontFamilyRow row={rows["font-family"]} />
        <FontSizeRow row={rows["font-size"]} />
        <PrefRow label="Config files">
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
        </PrefRow>
      </PrefSection>
    </>
  );
}

const GLOBAL_SCOPE: ThemeScope = { kind: "global" };

function AppThemeSection() {
  const motion = useStyleStore((state) => state.motion);
  const setMotion = useStyleStore((state) => state.setMotion);
  const projects = useProjectsStore((state) => state.projects);
  const canvas = useThemeStore((state) => state.globalCanvas);
  const appearance = useThemeStore((state) => state.globalAppearance);
  const systemPrefersDark = useThemeStore((state) => state.systemPrefersDark);
  const resolved = resolveAppearance(appearance, systemPrefersDark);

  // No "Project override" pill when a project's canvas shadows this one — it
  // would be a status nothing here could act on. The section names each project
  // that overrides it as a link, and that project's own Configure page carries
  // the divergence and its revert.
  return (
    <PrefSection
      title="Theme"
      icon={PaletteIcon}
      action={
        <OverrideLinks
          projects={projects.filter((p) => p.themeCanvas != null || p.themeAppearance != null)}
          page="appearance"
        />
      }
    >
      <StyleChoice />
      <PrefRow label="Motion" htmlFor="appearance-motion">
        <Switch id="appearance-motion" checked={motion} onCheckedChange={setMotion} />
      </PrefRow>
      <CanvasInstrument
        scope={GLOBAL_SCOPE}
        canvas={canvas}
        resolved={resolved}
        mode={
          <AppearanceModeChoice
            iconOnly
            value={appearance}
            testId="appearance-mode"
            onChange={(next) => void useThemeStore.getState().setGlobalAppearance(next)}
          />
        }
      />
    </PrefSection>
  );
}

async function writeOverlay(edits: Record<string, string | null>): Promise<boolean> {
  const result = await writeThrough("update the terminal settings", () =>
    window.api.theme.writeGlobalOverlay(edits),
  );
  if (result === null) return false;
  useThemeStore.getState().acceptTerminal(result.terminal);
  return true;
}

function OriginBadge({ row }: { row: TerminalSettingRow }) {
  return (
    <OverrideControl
      label={row.label}
      inheritedValue="Ghostty"
      overridden={row.source === "volli-global"}
      onRevert={() => void writeOverlay({ [row.key]: null })}
    >
      <span className="sr-only">{row.sourceLabel}</span>
    </OverrideControl>
  );
}

function TerminalThemeRow({ row }: { row: TerminalSettingRow }) {
  // A string, so it is safe as a selector result (see `activeTheme`'s note), and
  // it is what makes the fallback label follow a mode flip live.
  const resolved = useThemeStore(effectiveAppearance);

  return (
    <PrefRow label={row.label} description={row.sourceLabel}>
      <OriginBadge row={row} />
      <span className="text-ui text-muted-foreground">
        {row.value ?? fallbackTerminalThemeLabel(resolved)}
      </span>
    </PrefRow>
  );
}

function FontFamilyRow({ row }: { row: TerminalSettingRow }) {
  const [opened, setOpened] = React.useState(false);
  const [families, setFamilies] = React.useState<readonly string[] | null>(null);

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
    <PrefRow label={row.label} description={row.sourceLabel}>
      <OriginBadge row={row} />
      <FontPicker
        ariaLabel="Terminal font family"
        searchLabel="Search fonts"
        searchPlaceholder="Search fonts…"
        buttonLabel={row.value ?? "Ghostty default"}
        empty={
          families === null ? (
            <LoadingLabel>Loading fonts</LoadingLabel>
          ) : families.length === 0 ? (
            "No fonts found"
          ) : (
            "No matching font"
          )
        }
        families={families ?? []}
        activeValue={row.value}
        // Enumerating the local font list is a permissioned round trip, so it
        // waits for the menu to actually open rather than running on mount.
        onOpenChange={(next) => {
          if (next) setOpened(true);
        }}
        onSelect={(family) => writeOverlay({ "font-family": family })}
      />
    </PrefRow>
  );
}

const FONT_SIZE_RANGE = { min: 6, max: 32 } as const;

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
    <PrefRow label={row.label} description={row.sourceLabel}>
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
    </PrefRow>
  );
}
