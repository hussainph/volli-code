/**
 * The lab's active theme, shared across every scratch and remembered across
 * reloads.
 *
 * A theme picked in the Theming scratch has to follow you to the App shell,
 * the Board and the Chrome band — those are the surfaces where you find out
 * whether it actually works. A theme that reverted the moment you left the
 * picker would only ever be judged against swatches, which is precisely the
 * mistake the Theming scratch exists to avoid.
 *
 * So the choice lives here rather than in a scratch's component state: scratch
 * setup is re-applied on every activation (see scratch.ts), and a value held by
 * the picker would be reset by the next one.
 *
 * On `localStorage`, given CLAUDE.md's "no renderer-side persistence" rule:
 * that rule governs the APP, whose durable state belongs in SQLite behind the
 * main process. The lab has no main process, and this is not domain data —
 * it is a dev-tool preference, namespaced `volli-lab:` so it can never collide
 * with an app key. Nothing here is reachable from shipped code.
 */
import { DEFAULT_THEME, type ThemeDefinition } from "@volli/shared";

import { applyTheme } from "@renderer/theme/apply";
import { useThemeStore } from "@renderer/stores/theme";

const STORAGE_KEY = "volli-lab:theme";

/**
 * Only the authored triple is stored, and the theme is rebuilt from the shipped
 * defaults around it. Every theme the lab can produce — a built-in, or an
 * ad-hoc seed — is exactly `{...DEFAULT_THEME, name, slug, seed}`, so this
 * round-trips them all while making a corrupted or outdated payload impossible
 * to turn into a broken theme.
 */
interface StoredChoice {
  name: string;
  slug: string;
  seed: string;
}

function isStoredChoice(value: unknown): value is StoredChoice {
  if (typeof value !== "object" || value === null) return false;
  const choice = value as Partial<StoredChoice>;
  return (
    typeof choice.name === "string" &&
    typeof choice.slug === "string" &&
    typeof choice.seed === "string"
  );
}

/** The theme the lab is currently set to — the shipped default until one is picked. */
export function labTheme(): ThemeDefinition {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_THEME;
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredChoice(parsed)) return DEFAULT_THEME;
    return { ...DEFAULT_THEME, name: parsed.name, slug: parsed.slug, seed: parsed.seed };
  } catch {
    // A theme preference is not worth failing a page load over: an unreadable
    // or unparseable entry simply means "no choice yet".
    return DEFAULT_THEME;
  }
}

/**
 * Makes `theme` the lab's theme: painted now, and remembered for every scratch
 * that follows.
 *
 * It becomes the store's `global` rather than its `preview`, because that is
 * what it now is — a standing choice, not a hover. `preview` is cleared for the
 * same reason: a live preview would otherwise keep winning in `effectiveTheme`
 * and the choice would not take.
 */
export function setLabTheme(theme: ThemeDefinition): void {
  try {
    const choice: StoredChoice = { name: theme.name, slug: theme.slug, seed: theme.seed };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Storage full or blocked — the theme still applies for this session.
  }
  useThemeStore.setState({ global: theme, preview: null });
  applyTheme(theme);
}

/**
 * Paints the remembered theme onto the document. Called once at lab boot, for
 * the same reason the app hydrates its theme at boot: `globals.css` paints the
 * shipped default with no JS, so without this a reload silently puts every
 * scratch back on Ember while the store says otherwise.
 */
export function applyStoredLabTheme(): void {
  applyTheme(labTheme());
}
