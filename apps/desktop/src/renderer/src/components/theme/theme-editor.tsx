import * as React from "react";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";

import {
  beginThemeDuplicate,
  beginThemeEdit,
  CANVAS_KINDS,
  canvasOf,
  GRAIN_RANGE,
  swatchColor,
  withAccent,
  withAccentUnlocked,
  withCanvas,
  withGrain,
  withName,
  withSeed,
  type CanvasKind,
  type ThemeDraft,
} from "@renderer/components/theme/theme-editor-model";
import { SettingsRow } from "@renderer/components/pages/settings-shell";
import { ThemeComboBox } from "@renderer/components/theme/theme-combo-box";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Switch } from "@renderer/components/ui/switch";
import { cn } from "@renderer/lib/utils";
import { useThemeStore, type ThemeScope } from "@renderer/stores/theme";
import { BUILTIN_THEMES, mergeThemeCatalog } from "@renderer/theme/catalog";
import { canvasBackground } from "@renderer/theme/canvas-layer";
import { isBuiltinThemeSlug, type ThemeCanvas, type ThemeDefinition } from "@volli/shared";

/**
 * The theme editor (#71/#75): a seed, an unlockable accent, grain, a name.
 *
 * Everything here edits a {@link ThemeDraft} and previews it — the whole app
 * repaints as you drag, and NOTHING is written until Save. That is why the
 * controls are so plain: the preview is the app itself, so a sample panel would
 * only be a worse copy of what is already on screen behind this one.
 *
 * ── MOTION ────────────────────────────────────────────────────────────────
 * Two things animate, both entrances, both `--ease-swift` under 300ms, both
 * opacity+transform only, both reduced to a plain fade under
 * `prefers-reduced-motion`:
 *
 *   the panel        opening the editor        fade + 4px rise
 *   the accent pair  unlocking the accent      fade + 4px rise
 *
 * Deliberately NOT animated, and the reason in each case:
 *
 *   the seed and grain scrubs — dragging repaints every token in the app on
 *     every pointer move; a transition on that is a queue of stale frames
 *     chasing the cursor, and the animated repaint that DOES belong to a theme
 *     change is the project-switch cross-fade (PR 4), not this
 *   the ⌘K picker — a hundreds-of-times-a-day surface (Raycast's model)
 *   the Save/Cancel buttons — the button primitive already owns their press
 *     feedback, and re-stating it here would fight it
 * ──────────────────────────────────────────────────────────────────────────
 */

/** Entrance timing. Under 300ms, per the motion rules in docs/DESIGN.md's spirit. */
const ENTER_MS = 180;

/**
 * Tailwind's `starting:` = `@starting-style`: an entrance with no keyframes and
 * no mounted flag. Under `prefers-reduced-motion` the MOVEMENT drops and the
 * fade stays — reduced motion means gentler, not none, and the fade is what
 * keeps the panel from appearing out of nowhere.
 */
const ENTER = cn(
  "transition-[opacity,transform] ease-swift starting:-translate-y-1 starting:opacity-0",
  "motion-reduce:starting:translate-y-0",
);

export interface ThemeEditorProps {
  /** The theme the editor opened on. A built-in is duplicated on the way in. */
  source: ThemeDefinition;
  /** Where Save writes the applied theme (#69). */
  scope: ThemeScope;
  /** Rename opens the editor with the name field selected. */
  focusName?: boolean;
  /** Duplicate always opens on a new copy; edit may reuse an owned theme's slug. */
  mode?: "edit" | "duplicate";
  /** Save (after a successful write) and Cancel both land here. */
  onClose(): void;
}

export function ThemeEditor({
  source,
  scope,
  focusName = false,
  mode = "edit",
  onClose,
}: ThemeEditorProps) {
  const owned = useThemeStore((state) => state.customThemes);
  const catalog = React.useMemo(() => mergeThemeCatalog(BUILTIN_THEMES, owned), [owned]);
  // The catalog is read ONCE, when the edit opens: a duplicate's name is chosen
  // against the library as it stood, and a save landing mid-edit must not
  // rename the draft under the user.
  const [draft, setDraft] = React.useState<ThemeDraft>(() =>
    mode === "duplicate"
      ? beginThemeDuplicate({ source, catalog })
      : beginThemeEdit({ source, owned, catalog }),
  );
  // The hex fields hold TEXT, not color: `#00aa` is a legal thing to be typing
  // and an illegal thing to paint, so the draft only moves once it parses.
  const [seedText, setSeedText] = React.useState(draft.theme.seed);
  const [accentText, setAccentText] = React.useState(draft.theme.accent ?? draft.theme.seed);
  const [saving, setSaving] = React.useState(false);
  const nameRef = React.useRef<HTMLInputElement>(null);

  // Paint the draft immediately — for a duplicated built-in this is a visual
  // no-op (same seed), which is the point: the copy is not a different look.
  // Leaving with an unsaved edit puts the stored theme back; a saved edit has
  // already cleared the preview, so the cleanup is a no-op on that path.
  const opened = React.useRef(draft.theme).current;
  React.useEffect(() => {
    useThemeStore.getState().startPreview(opened);
    return () => useThemeStore.getState().cancelPreview();
  }, [opened]);

  React.useEffect(() => {
    if (focusName) nameRef.current?.select();
  }, [focusName]);

  /**
   * The look a hover-preview must put back — the draft as it stands.
   *
   * A ref, moved SYNCHRONOUSLY wherever the draft moves rather than in an
   * effect: `ThemeComboBox` restores in a `finally`, which can run before React
   * has committed the pick, so a restore reading render-time state would put
   * back the value the user just replaced.
   */
  const painted = React.useRef(draft.theme);

  /** Adopt a draft change and repaint from it. `null` = not a color yet; keep the text, keep the paint. */
  const edit = (next: ThemeDraft | null): void => {
    if (next === null) return;
    painted.current = next.theme;
    setDraft(next);
    useThemeStore.getState().startPreview(next.theme);
  };

  /**
   * A change with nothing to paint — the name. Repainting on it would be worse
   * than wasteful: every apply drops the terminals' token-derived palette
   * (theme/apply.ts), so typing a name would re-theme every live session
   * per keystroke. Save sends the final draft either way.
   */
  const editUnpainted = (next: ThemeDraft): void => {
    painted.current = next.theme;
    setDraft(next);
  };

  const save = (): void => {
    setSaving(true);
    void useThemeStore
      .getState()
      .saveCustomTheme(draft.theme, scope)
      .then((saved) => {
        // A failed save has already toasted; staying open keeps the user's
        // work, and keeps the preview showing what they were saving.
        if (saved) onClose();
        else setSaving(false);
      });
  };

  const unlocked = draft.theme.accent !== null;

  return (
    <div
      style={{ transitionDuration: `${ENTER_MS}ms` }}
      className={cn("flex flex-col rounded-lg border border-border bg-background p-4", ENTER)}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Escape belongs to the innermost thing that can be dismissed: the
        // edit, not the Settings surface hosting it.
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <SettingsRow label="Name" htmlFor="theme-name">
        <Input
          id="theme-name"
          ref={nameRef}
          autoFocus
          value={draft.theme.name}
          onChange={(event) => editUnpainted(withName(draft, event.target.value))}
          className="w-56"
        />
      </SettingsRow>

      <SettingsRow
        label="Color"
        htmlFor="theme-seed-hex"
        description="One color tints the whole app — the chrome takes its hue, the accent takes its punch."
      >
        <ColorField
          id="theme-seed"
          label="Theme color"
          value={draft.theme.seed}
          text={seedText}
          onText={(text) => {
            setSeedText(text);
            edit(withSeed(draft, text));
          }}
        />
      </SettingsRow>

      <SettingsRow
        label="Custom accent"
        description="Off, the accent follows the color above. On, pick it separately."
      >
        <Switch
          aria-label="Custom accent"
          checked={unlocked}
          onCheckedChange={(next) => {
            const edited = withAccentUnlocked(draft, next);
            setAccentText(edited.theme.accent ?? edited.theme.seed);
            edit(edited);
          }}
        />
      </SettingsRow>

      {unlocked ? (
        <div style={{ transitionDuration: `${ENTER_MS}ms` }} className={ENTER}>
          <SettingsRow label="Accent" htmlFor="theme-accent-hex">
            <ColorField
              id="theme-accent"
              label="Accent color"
              value={draft.theme.accent ?? draft.theme.seed}
              text={accentText}
              onText={(text) => {
                setAccentText(text);
                edit(withAccent(draft, text));
              }}
            />
          </SettingsRow>
        </div>
      ) : null}

      {/* Above Grain, below the accent disclosure: the canvas is the layer
          grain would sit over, and it is the larger of the two decisions, so
          it reads first. */}
      <SettingsRow
        label="Background"
        description="The layer behind the app's content. Its colors come from the color above."
      >
        <ThemeComboBox
          ariaLabel="Background"
          buttonLabel={CANVAS_LABEL[draft.theme.canvas.kind]}
          buttonPreview={<CanvasSample canvas={draft.theme.canvas} />}
          searchLabel="Search backgrounds"
          // Three rows do not get a search field.
          searchable={false}
          empty="No backgrounds match."
          activeValue={draft.theme.canvas.kind}
          items={CANVAS_KINDS.map((kind) => ({
            value: kind,
            label: CANVAS_LABEL[kind],
            preview: <CanvasSample canvas={canvasOf(kind, draft.theme.seed)} />,
          }))}
          onPreview={(kind) =>
            useThemeStore.getState().startPreview(withCanvas(draft, kind as CanvasKind).theme)
          }
          // Back to the DRAFT, which is what this editor is showing — read
          // through a ref because the combo box restores in a `finally` that
          // can run before React has committed the pick.
          onEndPreview={() => useThemeStore.getState().startPreview(painted.current)}
          onSelect={(kind) => {
            edit(withCanvas(draft, kind));
            return Promise.resolve(true);
          }}
        />
      </SettingsRow>

      <SettingsRow
        label="Grain"
        htmlFor="theme-grain"
        description="Texture over the app's surfaces."
      >
        <input
          id="theme-grain"
          type="range"
          min={GRAIN_RANGE.min}
          max={GRAIN_RANGE.max}
          step={GRAIN_RANGE.step}
          value={draft.theme.grain}
          onChange={(event) => edit(withGrain(draft, event.target.valueAsNumber))}
          className="w-40 cursor-pointer accent-primary"
        />
        <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
          {Math.round(draft.theme.grain * 100)}%
        </span>
      </SettingsRow>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-border/60 pt-4">
        <p className="min-w-0 text-xs text-muted-foreground">
          {isBuiltinThemeSlug(draft.source.slug) && draft.duplicated
            ? `${draft.source.name} ships with Volli, so this is a copy you own.`
            : draft.duplicated
              ? "This is a new copy — save to add it to your themes folder."
              : "Saved to your themes folder."}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={saving} onClick={save}>
            <CheckIcon weight="fill" />
            Save theme
          </Button>
        </div>
      </div>
    </div>
  );
}

/** What each Background reads as. The noun alone — the preview is the app. */
const CANVAS_LABEL: Record<CanvasKind, string> = {
  solid: "Solid",
  gradient: "Gradient",
  mesh: "Mesh",
};

/**
 * A Background row's painted sample: the derived stops themselves, as one small
 * bar, in **the same CSS the canvas paints**.
 *
 * A single flat swatch would be the wrong thing to show — the choice here is
 * between two-or-three derived colors and a geometry, and one color states
 * neither. Painting the real thing at 16×24 makes the ramp legible, and going
 * through `canvasBackground` means a sample can never drift from the window.
 *
 * `aria-hidden`: the row's accessible name is the option word alone.
 */
function CanvasSample({ canvas }: { canvas: ThemeCanvas }) {
  return (
    <span
      aria-hidden
      className="h-6 w-4 shrink-0 rounded-sm border border-border/60"
      style={{ background: canvasBackground(canvas) }}
    />
  );
}

/**
 * A color swatch and its hex, editable from either side.
 *
 * The swatch IS the native color input — it opens the system picker, and
 * dragging in it fires continuously, so the app previews under the cursor. The
 * hex field is for the other half of how people choose colors: pasting one.
 */
function ColorField({
  id,
  label,
  value,
  text,
  onText,
}: {
  id: string;
  label: string;
  /** The last color that parsed — what the swatch shows. */
  value: string;
  /** What is in the hex field, which may not be a color yet. */
  text: string;
  onText(text: string): void;
}) {
  return (
    <span className="flex items-center gap-2">
      <input
        id={id}
        type="color"
        aria-label={label}
        value={swatchColor(value)}
        onChange={(event) => onText(event.target.value)}
        className="size-9 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-1"
      />
      <Input
        id={`${id}-hex`}
        aria-label={`${label} hex`}
        spellCheck={false}
        value={text}
        onChange={(event) => onText(event.target.value)}
        className="w-28 font-mono"
      />
    </span>
  );
}
