import { CanvasInstrument } from "../kit/canvas-instrument";
import { LoadingLabel } from "@renderer/components/ui/loading-label";
import * as React from "react";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { resolveAppearance, type Project } from "@volli/shared";

import { fallbackTerminalThemeLabel, revealPath } from "@renderer/components/theme/appearance-rows";
import { OverrideControl, PrefRow, PrefSection } from "@renderer/components/settings/kit";
import { AppearanceModeChoice } from "@renderer/components/theme/canvas-editor";
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
import { resolveThemeSurface } from "@renderer/theme/apply";

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
            <LoadingLabel>Loading this project&rsquo;s appearance</LoadingLabel>
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
      <ProjectAppThemeSection key={`app:${project.id}`} project={project} />
      <ProjectTerminalThemeSection key={`terminal:${project.id}`} projectId={project.id} />
    </>
  );
}

function projectScope(project: Project) {
  return {
    projectId: project.id,
    canvas: project.themeCanvas ?? null,
    appearance: project.themeAppearance ?? null,
  };
}

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
  const mode = resolveThemeSurface(appearance, globalAppearance).value;
  const resolved = resolveAppearance(mode, systemPrefersDark);
  const inherited = describeAppearance(
    globalAppearance,
    resolveAppearance(globalAppearance, systemPrefersDark),
  );

  const writeMode = (next: typeof globalAppearance | null): void => {
    void useThemeStore.getState().setProjectAppearance(project.id, next);
  };

  return (
    <PrefSection title="Theme" icon={PaletteIcon}>
      <PrefRow
        label="Mode"
        description={appearance === null ? "Global default" : "Project override"}
      >
        <OverrideControl
          label="Mode"
          inheritedValue={inherited}
          overridden={appearance !== null}
          onRevert={() => writeMode(null)}
        >
          <AppearanceModeChoice
            iconOnly
            value={mode}
            testId="project-appearance-mode"
            onChange={writeMode}
          />
        </OverrideControl>
      </PrefRow>
      <CanvasInstrument
        scope={scope}
        canvas={resolveThemeSurface(own, globalCanvas).value}
        resolved={resolved}
      />

      {
        <PrefRow
          label="Canvas"
          description={own === null ? "Global default" : "Project override"}
          testId="project-appearance-canvas-row"
        >
          <OverrideControl
            label="Canvas"
            inheritedValue="the global canvas"
            overridden={own !== null}
            onRevert={() => {
              void useThemeStore.getState().setProjectCanvas(project.id, null);
            }}
          >
            <span className="text-ui text-muted-foreground">
              {own === null ? "Global default" : "Project override"}
            </span>
          </OverrideControl>
        </PrefRow>
      }
    </PrefSection>
  );
}

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
      <PrefRow
        label={rows.theme.label}
        description={rows.theme.sourceLabel}
        testId="project-appearance-terminal-row"
      >
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
