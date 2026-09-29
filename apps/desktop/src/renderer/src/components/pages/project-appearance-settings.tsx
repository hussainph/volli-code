import * as React from "react";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { resolveAppearance, type Project } from "@volli/shared";

import { fallbackTerminalThemeLabel, revealPath } from "@renderer/components/theme/appearance-rows";
import { OverrideControl, PrefRow, PrefSection } from "@renderer/components/settings/kit";
import { AppearanceModeChoice, CanvasEditor } from "@renderer/components/theme/canvas-editor";
import { describeAppearance } from "@renderer/components/theme/canvas-editor-model";
import {
  projectTerminalChoice,
  projectTerminalOverlayEdits,
} from "@renderer/components/theme/project-appearance-model";
import {
  buildTerminalSettingRows,
  type TerminalSettingKey,
  type TerminalSettingRow,
} from "@renderer/components/theme/terminal-settings-model";
import { Button } from "@renderer/components/ui/button";
import { writeThrough } from "@renderer/stores/mutate";
import { effectiveAppearance, useThemeStore, type ThemeScope } from "@renderer/stores/theme";

/**
 * Configure → Appearance: one project's per-surface theming (#69).
 *
 * Handoff: same UI slop pass as appearance-settings.tsx — see AGENTS.md.
 *
 * Every surface starts on **Inherit** (#72: per-project theming is off by
 * default), which is the ABSENCE of a stored value rather than a stored
 * "inherit" marker, so a project that has been reset reads exactly like one that
 * was never touched.
 *
 * The terminal surface has no **Custom** any more (VC-413). Entering Custom used
 * to open a picker over a theme catalog vendored out of Ghostty.app; with no
 * catalog there is nothing for a project to pick, and Volli will not write a
 * theme name into a file the user owns just to have something to show. What the
 * row does instead is report the resolved theme and, when this project's own
 * overlay is what set it — by hand, in the file below — offer the revert that
 * removes the key.
 *
 * The app surface is TWO tri-states rather than one, because a project's
 * gradient and its light/dark choice are two independent columns on its row
 * (migration 014) and either can be overridden alone. Both are authored by the
 * same canvas editor the global page mounts, scoped here.
 *
 * The terminal is the one surface with no store setter, by design: its source
 * of truth is the project's ghostty overlay FILE, so this writes the overlay
 * and adopts the appearance main resolves back (#67 — and Inherit REMOVES the
 * key rather than writing a default over the user's own config).
 */
export function ProjectAppearanceSettings({ project }: { project: Project }) {
  const inScope = useThemeStore((state) => state.projectId === project.id);

  // Selection already announces the scope (stores/projects.ts), so this is the
  // narrow case where Configure is reached before that read has landed — or
  // after one failed. Reading the store imperatively keeps the effect keyed on
  // the project alone, so a failed hydrate can't spin.
  React.useEffect(() => {
    if (useThemeStore.getState().projectId !== project.id) {
      void useThemeStore.getState().hydrate(projectScope(project));
    }
  }, [project]);

  if (!inScope) {
    // The effect fires once per project, and the store toasts a failed read
    // rather than retrying — so without this button a read that lost (bridge
    // hiccup, a locked database) would leave the pane on "Loading…" for as
    // long as it stays open, with nothing to press.
    return (
      <PrefSection title={project.name}>
        {/* A note and a button are not a row, so nothing else spaces them. */}
        <div className="flex flex-col items-start gap-2">
          <p className="text-ui leading-5 text-muted-foreground">
            Loading this project&rsquo;s appearance…
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void useThemeStore.getState().hydrate(projectScope(project))}
          >
            Retry
          </Button>
        </div>
      </PrefSection>
    );
  }

  // Keyed on the project so switching projects while this pane is open remounts
  // the sections: the canvas editor's in-flight preview state describes ONE
  // project's session with this pane, and carrying it across would show project
  // B a gesture that was aimed at project A.
  return (
    <>
      <ProjectAppThemeSection key={project.id} project={project} />
      <ProjectTerminalThemeSection key={project.id} projectId={project.id} />
    </>
  );
}

/**
 * The project's own theming columns (migration 014), as the theme store's
 * scope descriptor. Read off the project ROW rather than fetched: the row
 * already arrived in the bootstrap payload, and a second read path would be a
 * second answer to "what is this project's canvas?".
 */
function projectScope(project: Project) {
  return {
    projectId: project.id,
    canvas: project.themeCanvas ?? null,
    appearance: project.themeAppearance ?? null,
  };
}

/**
 * This project's mode and its own gradient — the SAME PICKER the global page
 * mounts, wearing this project's scope.
 *
 * ONE SECTION, TWO SCOPES, and that is the whole subtlety. The two settings
 * stay genuinely independent: a project may pin dark while inheriting the
 * gradient, or take its own gradient and still follow the app-wide mode.
 *
 * TOUCHING THE PICKER IS THE OVERRIDE — there is no "Give this project its
 * own" gate to press first (that was exactly the enter-a-mode step
 * `kit/override.tsx` retired everywhere else). The editor mounts on the
 * project's EFFECTIVE canvas (its own, else the app-wide one); the first edit
 * previews from there and the commit writes the project row, which is what
 * creates the override (`commitPreview` → `setProjectCanvas`). Divergence is
 * then said once per scope, in the override grammar: the mode's revert rides
 * the pad chip beside the control it reverts, and the canvas gets one quiet
 * row below the editor that EXISTS only while a project canvas does.
 *
 * The editor's own preview mechanism is scope-aware, so a drag here paints
 * this window and commits to this project's `projects` row — the global
 * canvas is never touched by it.
 */
function ProjectAppThemeSection({ project }: { project: Project }) {
  const own = useThemeStore((state) => state.projectOverride?.canvas ?? null);
  const globalCanvas = useThemeStore((state) => state.globalCanvas);
  const appearance = useThemeStore((state) => state.projectOverride?.appearance ?? null);
  const globalAppearance = useThemeStore((state) => state.globalAppearance);
  const systemPrefersDark = useThemeStore((state) => state.systemPrefersDark);

  // The scope descriptor is memoised for the same reason the global page's is a
  // module constant: the editor holds it in `useCallback` dependencies.
  const scope = React.useMemo<ThemeScope>(
    () => ({ kind: "project", projectId: project.id }),
    [project.id],
  );
  // Resolved for THIS project — its own appearance override when it has one.
  const resolved = resolveAppearance(appearance ?? globalAppearance, systemPrefersDark);
  const inherited = describeAppearance(
    globalAppearance,
    resolveAppearance(globalAppearance, systemPrefersDark),
  );

  const writeMode = (next: typeof globalAppearance | null): void => {
    void useThemeStore.getState().setProjectAppearance(project.id, next);
  };

  return (
    <PrefSection title="App theme" icon={PaletteIcon}>
      <CanvasEditor
        scope={scope}
        canvas={own ?? globalCanvas}
        resolved={resolved}
        mode={
          <OverrideControl
            label="Mode"
            inheritedValue={inherited}
            overridden={appearance !== null}
            onRevert={() => writeMode(null)}
          >
            <AppearanceModeChoice
              iconOnly
              value={appearance ?? globalAppearance}
              testId="project-appearance-mode"
              onChange={writeMode}
            />
          </OverrideControl>
        }
      />

      {own === null ? null : (
        <PrefRow label="Canvas" align="center" testId="project-appearance-canvas-row">
          <OverrideControl
            label="Canvas"
            inheritedValue="the app-wide canvas"
            overridden
            onRevert={() => {
              void useThemeStore.getState().setProjectCanvas(project.id, null);
            }}
          >
            <span className="text-ui text-muted-foreground">This project&rsquo;s own</span>
          </OverrideControl>
        </PrefRow>
      )}
    </PrefSection>
  );
}

/**
 * Terminal surface: this project's ghostty overlay.
 *
 * There is no store setter here on purpose — the value lives in a FILE, one
 * layer below Volli's global overlay and the user's own config, and main hands
 * back the freshly-resolved chain so the provenance chip updates without a
 * second round trip (#67). Inherit REMOVES the key: the project overlay is the
 * last layer, so leaving a key behind would pin the terminal to whatever Volli
 * last wrote instead of letting the config chain win again.
 *
 * WHAT THIS SECTION CAN STILL DO, after the catalog left (VC-413): report, and
 * revert. "Is this project overriding its terminal theme?" is still answered
 * honestly — from the resolved chain's PROVENANCE, so a key the user hand-wrote
 * into this project's overlay counts exactly like one Volli wrote, which is what
 * #68 promised. The revert is still a key REMOVAL. What is gone is the only
 * thing that needed a catalog: choosing a name from a list.
 */
function ProjectTerminalThemeSection({ projectId }: { projectId: string }) {
  const terminal = useThemeStore((state) => state.terminal);
  // The fallback palette carries a name per mode, so the label has to follow the
  // resolved appearance — see `fallbackTerminalThemeLabel`.
  const resolved = useThemeStore(effectiveAppearance);
  const rows = React.useMemo(
    () =>
      Object.fromEntries(buildTerminalSettingRows(terminal).map((row) => [row.key, row])) as Record<
        TerminalSettingKey,
        TerminalSettingRow
      >,
    [terminal],
  );

  const choice = projectTerminalChoice(terminal);
  const overridden = choice.kind === "theme";
  const shown = rows.theme.value ?? fallbackTerminalThemeLabel(resolved);

  const revert = (): void => {
    void writeThrough("update this project's terminal theme", () =>
      window.api.theme.writeProjectOverlay(
        projectId,
        projectTerminalOverlayEdits({ kind: "inherit" }),
      ),
    ).then((result) => {
      if (result !== null) useThemeStore.getState().acceptTerminal(result.terminal);
    });
  };

  return (
    <PrefSection
      title="Terminal"
      icon={TerminalWindowIcon}
      hint={<>Volli writes an overlay file. It never edits your Ghostty config.</>}
    >
      <PrefRow label={rows.theme.label} testId="project-appearance-terminal-row">
        <OverrideControl
          label="Terminal theme"
          inheritedValue={shown}
          overridden={overridden}
          onRevert={revert}
        >
          <span className="text-ui text-muted-foreground">{shown}</span>
        </OverrideControl>
      </PrefRow>
      <PrefRow label="Config file">
        <Button
          variant="outline"
          size="sm"
          disabled={(terminal?.overlayPaths.project ?? null) === null}
          onClick={() => void revealPath(terminal?.overlayPaths.project ?? null)}
        >
          <FileTextIcon />
          This project&rsquo;s overlay
        </Button>
      </PrefRow>
    </PrefSection>
  );
}
