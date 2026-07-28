import * as React from "react";
import { BracketsCurlyIcon } from "@phosphor-icons/react/dist/csr/BracketsCurly";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { isShippedEditorThemeId, type Project, type ShippedEditorThemeId } from "@volli/shared";

import {
  editorThemeItems,
  FALLBACK_TERMINAL_THEME_LABEL,
  revealPath,
  terminalThemeItems,
} from "@renderer/components/theme/appearance-catalog";
import { SettingsRow, SettingsSection } from "@renderer/components/pages/settings-shell";
import { ThemeComboBox, ThemeOriginPill } from "@renderer/components/theme/theme-combo-box";
import {
  projectEditorChoice,
  projectTerminalChoice,
  projectTerminalOverlayEdits,
  terminalCustomSeed,
  type ProjectTerminalChoice,
} from "@renderer/components/theme/project-appearance-model";
import {
  buildTerminalSettingRows,
  type TerminalSettingKey,
  type TerminalSettingRow,
} from "@renderer/components/theme/terminal-settings-model";
import { planEditorThemePreview } from "@renderer/components/theme/editor-settings-model";
import { Button } from "@renderer/components/ui/button";
import {
  DEFAULT_EDITOR_THEME_ID,
  resolveEditorThemeId,
} from "@renderer/editor/editor-theme-catalog";
import { writeThrough } from "@renderer/stores/mutate";
import { useThemeStore } from "@renderer/stores/theme";
import { previewTerminalTheme } from "@renderer/terminal/appearance";
import { getBuiltinTheme } from "restty";

/**
 * Configure → Appearance: one project's per-surface theming (#69).
 *
 * The vocabulary is a tri-state PER SURFACE, and the section — not the picker —
 * owns it. Every surface starts on **Inherit** (#72: per-project theming is off
 * by default), which is the ABSENCE of a stored value rather than a stored
 * "inherit" marker, so a project that has been reset reads exactly like one
 * that was never touched. **Custom** opens on whatever the surface is already
 * showing, so switching modes pins the look rather than changing it: for the
 * editor that is the catalog id currently resolved, for the terminal it is the
 * theme name the ghostty chain resolves (and nothing, when the chain names none
 * — Volli will not invent a name to write into a file the user owns).
 *
 * The app surface is a placeholder for now: its per-workspace control is the
 * canvas editor, scoped, and that editor is the next change on this branch.
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
      <SettingsSection title={project.name}>
        <InheritNote>Loading this project&rsquo;s appearance…</InheritNote>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void useThemeStore.getState().hydrate(projectScope(project))}
        >
          Retry
        </Button>
      </SettingsSection>
    );
  }

  // Keyed on the project so switching projects while this pane is open remounts
  // the sections: the local "opening the library" / "Custom, nothing written
  // yet" states describe ONE project's session with this pane, and carrying
  // them across would show project B a picker project A had opened.
  return (
    <>
      <ProjectAppThemeSection key={project.id} project={project} />
      <ProjectEditorThemeSection key={project.id} projectId={project.id} />
      <ProjectTerminalThemeSection key={project.id} projectId={project.id} />
    </>
  );
}

/**
 * The workspace's own theming columns (migration 014), as the theme store's
 * scope descriptor. Read off the project ROW rather than fetched: the row
 * already arrived in the bootstrap payload, and a second read path would be a
 * second answer to "what is this workspace's canvas?".
 */
function projectScope(project: Project) {
  return {
    projectId: project.id,
    canvas: project.themeCanvas ?? null,
    appearance: project.themeAppearance ?? null,
  };
}

/** The quiet one-liner an inheriting surface shows instead of a control it isn't using. */
function InheritNote({ children }: { children: React.ReactNode }) {
  return <p className="text-xs leading-5 text-muted-foreground">{children}</p>;
}

/**
 * The app's segmented-control idiom (ui/button.tsx's pill scale, same shape as
 * the board's view toggle and the diff presentation toggle), driven by a data
 * array rather than repeated blocks so a third segment is a row, not a branch.
 *
 * Re-selecting the active segment is a NO-OP: "Custom" means a different stored
 * value per surface, so clicking it while already Custom would re-run that
 * surface's entry write and could silently replace what the user had chosen.
 */
function SegmentedChoice<Key extends string>({
  ariaLabel,
  testId,
  value,
  options,
  onChange,
}: {
  ariaLabel: string;
  testId: string;
  value: Key;
  options: readonly { key: Key; label: string }[];
  onChange(key: Key): void;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
      className="flex items-center gap-1"
    >
      {options.map((option) => (
        <Button
          key={option.key}
          size="sm"
          variant={option.key === value ? "secondary" : "ghost"}
          aria-pressed={option.key === value}
          data-choice={option.key}
          onClick={() => {
            if (option.key !== value) onChange(option.key);
          }}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

/** Every surface's top-level tri-state, in the section header where it reads as the section's own mode. */
const SURFACE_MODES = [
  { key: "inherit", label: "Inherit" },
  { key: "custom", label: "Custom" },
] as const;

type SurfaceMode = (typeof SURFACE_MODES)[number]["key"];

/**
 * Placeholder for the workspace-scoped canvas editor.
 *
 * A workspace's own gradient and its own light/dark choice are two independent
 * migration-014 columns on its row, and both are already read, resolved and
 * painted — what is missing is the control that authors them, which is the
 * canvas editor and the next change on this branch. Saying so is the honest
 * interim: a stub control here would write a canvas nobody authored.
 */
function ProjectAppThemeSection({ project }: { project: Project }) {
  const overridden = useThemeStore(
    (state) => state.projectOverride?.canvas != null || state.projectOverride?.appearance != null,
  );

  return (
    <SettingsSection
      title="App theme"
      icon={PaletteIcon}
      description="What this project's window wears. Every other project is unaffected."
    >
      <div data-testid="project-appearance-canvas-placeholder">
        <InheritNote>
          {overridden ? (
            <>
              <span className="text-foreground">{project.name}</span> has its own canvas. The editor
              for it lands next; until then this workspace keeps what it was given.
            </>
          ) : (
            <>Following the app-wide canvas. The per-workspace canvas editor lands next.</>
          )}
        </InheritNote>
      </div>
    </SettingsSection>
  );
}

/**
 * Editor surface: the shipped Monaco/shiki catalog, scoped to this project.
 *
 * Mirrors the global row exactly — same catalog, same apply-then-revert preview
 * through the theme store (never a direct Monaco call, or `paintedEditor`
 * desyncs) — with the inherited id resolved exactly as the global row resolves
 * it, so "Inherit" says what Monaco will actually wear here.
 */
function ProjectEditorThemeSection({ projectId }: { projectId: string }) {
  const override = useThemeStore((state) => state.projectOverride);
  const globalEditorThemeId = useThemeStore((state) => state.editorThemeId);
  const items = React.useMemo(() => editorThemeItems(), []);

  const choice = projectEditorChoice(override);
  const inherited = resolveEditorThemeId({ editorThemeId: globalEditorThemeId });
  const resolvedId = choice.kind === "theme" ? choice.themeId : inherited;
  const label = items.find((item) => item.value === resolvedId)?.label ?? resolvedId;

  const write = (themeId: ShippedEditorThemeId | null): Promise<boolean> =>
    useThemeStore.getState().setProjectEditorTheme(projectId, themeId);

  return (
    <SettingsSection
      title="Editor"
      icon={BracketsCurlyIcon}
      description="Monaco syntax highlighting for files and documents opened in this project."
      action={
        <SegmentedChoice
          ariaLabel="Editor theme scope"
          testId="project-appearance-editor-mode"
          value={choice.kind === "inherit" ? "inherit" : "custom"}
          options={SURFACE_MODES}
          onChange={(mode: SurfaceMode) => {
            // Custom pins the id currently resolved, so the switch changes what
            // the choice MEANS without changing what is on screen.
            void write(mode === "inherit" ? null : pinnableEditorThemeId(inherited));
          }}
        />
      }
    >
      {choice.kind === "inherit" ? (
        <InheritNote>
          Following the app-wide editor theme — <span className="text-foreground">{label}</span>.
        </InheritNote>
      ) : (
        <SettingsRow label="Theme">
          <ThemeOriginPill emphasized>Set by this project</ThemeOriginPill>
          <ThemeComboBox
            ariaLabel="Project editor theme"
            searchLabel="Search editor themes"
            buttonLabel={label}
            empty="No matching theme."
            items={items}
            activeValue={resolvedId}
            onPreview={(selection) => {
              const plan = planEditorThemePreview({ selection, resolvedId });
              if (plan.kind === "restore") endEditorPreview();
              else useThemeStore.getState().startEditorPreview(plan.themeId);
            }}
            onEndPreview={endEditorPreview}
            onSelect={(themeId) => write(themeId)}
          />
        </SettingsRow>
      )}
    </SettingsSection>
  );
}

/**
 * `resolveEditorThemeId` answers with a catalog id, but types it as a plain
 * string — narrow it back rather than casting, because main's IPC guard rejects
 * anything outside the shipped union and a silent rejection would read as
 * "Custom didn't stick".
 */
function pinnableEditorThemeId(resolved: string): ShippedEditorThemeId {
  return isShippedEditorThemeId(resolved) ? resolved : DEFAULT_EDITOR_THEME_ID;
}

/** Puts Monaco back on whatever the CURRENT store state resolves to, ending a preview. */
const endEditorPreview = (): void => {
  useThemeStore.getState().endEditorPreview();
};

/** Repaints every live terminal in `name`'s palette, writing nothing. */
const previewTerminal = (name: string): void => previewTerminalTheme(getBuiltinTheme(name));

/** Puts the resolved palette back, ending a preview. */
const endTerminalPreview = (): void => previewTerminalTheme(null);

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
 * `pending` covers the one case Custom cannot pre-select: a chain that names no
 * theme at all. The terminal is then wearing the token-derived fallback, which
 * has no catalog name — so Custom opens the picker with nothing written, and
 * the first pick is the first write.
 */
function ProjectTerminalThemeSection({ projectId }: { projectId: string }) {
  const terminal = useThemeStore((state) => state.terminal);
  const items = React.useMemo(() => terminalThemeItems(), []);
  const rows = React.useMemo(
    () =>
      Object.fromEntries(buildTerminalSettingRows(terminal).map((row) => [row.key, row])) as Record<
        TerminalSettingKey,
        TerminalSettingRow
      >,
    [terminal],
  );

  const choice = projectTerminalChoice(terminal);
  const [pending, setPending] = React.useState(false);
  const custom = choice.kind === "theme" || pending;

  const write = async (next: ProjectTerminalChoice): Promise<boolean> => {
    const result = await writeThrough("update this project's terminal theme", () =>
      window.api.theme.writeProjectOverlay(projectId, projectTerminalOverlayEdits(next)),
    );
    if (result === null) return false;
    useThemeStore.getState().acceptTerminal(result.terminal);
    return true;
  };

  const setMode = (mode: SurfaceMode): void => {
    if (mode === "inherit") {
      setPending(false);
      // Nothing of this project's is in the file yet, so there is no key to
      // remove — don't touch the user's overlay to say nothing.
      if (choice.kind === "theme") void write({ kind: "inherit" });
      return;
    }
    const seed = terminalCustomSeed(terminal);
    setPending(true);
    if (seed !== null) {
      // A write that didn't land stored nothing, so Inherit is still the truth
      // — roll the section back rather than leave it claiming Custom over an
      // overlay that has no key in it.
      void write({ kind: "theme", name: seed }).then((saved) => {
        if (!saved) setPending(false);
      });
    }
  };

  return (
    <SettingsSection
      title="Terminal"
      icon={TerminalWindowIcon}
      description="Layered over your Ghostty config and Volli's global overlay. Volli never edits your config."
      action={
        <SegmentedChoice
          ariaLabel="Terminal theme scope"
          testId="project-appearance-terminal-mode"
          value={custom ? "custom" : "inherit"}
          options={SURFACE_MODES}
          onChange={setMode}
        />
      }
    >
      {custom ? (
        <SettingsRow label={rows.theme.label}>
          <ThemeOriginPill emphasized={rows.theme.source === "volli-project"}>
            {rows.theme.sourceLabel}
          </ThemeOriginPill>
          <ThemeComboBox
            ariaLabel="Project terminal theme"
            searchLabel="Search terminal themes"
            buttonLabel={rows.theme.value ?? FALLBACK_TERMINAL_THEME_LABEL}
            empty="No matching theme."
            items={items}
            activeValue={choice.kind === "theme" ? choice.name : null}
            onPreview={previewTerminal}
            onEndPreview={endTerminalPreview}
            onSelect={(name) => write({ kind: "theme", name })}
          />
        </SettingsRow>
      ) : (
        <InheritNote>
          Following Ghostty and Volli&rsquo;s global overlay —{" "}
          <span className="text-foreground">
            {rows.theme.value ?? FALLBACK_TERMINAL_THEME_LABEL}
          </span>
          .
        </InheritNote>
      )}
      <SettingsRow label="Config file" description="Takes any Ghostty key, hand-written.">
        <Button
          variant="outline"
          size="sm"
          disabled={(terminal?.overlayPaths.project ?? null) === null}
          onClick={() => void revealPath(terminal?.overlayPaths.project ?? null)}
        >
          <FileTextIcon weight="fill" />
          This project&rsquo;s overlay
        </Button>
      </SettingsRow>
    </SettingsSection>
  );
}
