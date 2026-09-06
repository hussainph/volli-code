/**
 * ⌘K's list-shape decisions (VC-205), as pure data beside the palette: WHICH
 * sections an `@` scope narrows to, WHERE a section truncates behind its
 * "Show all" row, and the exact match text a row hands cmdk to be judged by.
 *
 * Matching remains cmdk's native `defaultFilter`. The one product-level score
 * rule lives in {@link commandPaletteFilter}: a matching Ticket gets a fixed
 * section-priority point so cmdk cannot reorder Sessions ahead of Tickets.
 * The same wrapper scores the truncated slice and the mounted rows, preventing
 * the two passes from disagreeing.
 */
import { defaultFilter } from "cmdk";

import type {
  CommandPaletteAutomationRunItem,
  CommandPaletteSessionItem,
  CommandPaletteTicketItem,
} from "@renderer/components/command-palette-model";

/* ------------------------------------------------------------------ scopes */

/** The sections a typed `@` token can narrow the palette to. */
export type PaletteScopeId = "tickets" | "sessions" | "automations";

export interface PaletteScope {
  readonly id: PaletteScopeId;
  /** The literal token typed after `@` — also the suggestion row's trailing hint. */
  readonly token: string;
  /** The chip's label; lowercased it is also the section's plural noun. */
  readonly label: string;
}

/**
 * Every scope the palette offers, in suggestion-row order. Editor is
 * deliberately absent: it holds one contextual command, and a filter that
 * narrows to at most one row is a longer way of typing it.
 */
export const PALETTE_SCOPES: readonly PaletteScope[] = [
  { id: "tickets", token: "@tickets", label: "Tickets" },
  { id: "sessions", token: "@sessions", label: "Sessions" },
  { id: "automations", token: "@automations", label: "Automations" },
];

/** The scope definition the chip, placeholder, and empty copy read — or null while browsing everything. */
export function paletteScopeById(scope: PaletteScopeId | null): PaletteScope | null {
  return PALETTE_SCOPES.find((candidate) => candidate.id === scope) ?? null;
}

/**
 * The scope a typed `@word` names: the token itself or its singular form,
 * case-insensitively. Anything else is not a scope — it stays ordinary query
 * text rather than guessing at what a prefix meant.
 */
export function scopeForToken(word: string): PaletteScope | null {
  const normalized = word.toLowerCase();
  return (
    PALETTE_SCOPES.find(
      (candidate) => normalized === candidate.token || `${normalized}s` === candidate.token,
    ) ?? null
  );
}

export interface ParsedPaletteScopeQuery {
  readonly scope: PaletteScope;
  /** Everything after the leading scope token, ready to remain in the input. */
  readonly query: string;
}

/**
 * A recognized leading `@scope` once whitespace seals it, plus any query that
 * follows. This handles both incremental typing (`@sessions `) and one-step
 * paste (`@sessions auth`) without treating an embedded token as syntax.
 */
export function parsePaletteScopeQuery(text: string): ParsedPaletteScopeQuery | null {
  const normalized = text.trimStart();
  const separator = normalized.search(/\s/);
  if (separator < 0) return null;
  const scope = scopeForToken(normalized.slice(0, separator));
  return scope === null ? null : { scope, query: normalized.slice(separator).trimStart() };
}

/**
 * Whether the palette mounts the `@` suggestion rows: no scope chosen yet and
 * the query begins with `@`. From there cmdk's native filter does the rest —
 * `@ti` matches the `@tickets` row and scores 0 against every ordinary row,
 * so the suggestions are all that remains on screen.
 */
export function showScopeSuggestions(query: string, scope: PaletteScopeId | null): boolean {
  return scope === null && query.trimStart().startsWith("@");
}

/** What an empty list says: the generic pair, or the one section a scope narrowed to. */
export function paletteEmptyCopy(scope: PaletteScopeId | null): string {
  const scoped = paletteScopeById(scope);
  return scoped === null
    ? "No matching tickets or sessions."
    : `No matching ${scoped.label.toLowerCase()}.`;
}

/* -------------------------------------------------------------- match text */

/** Every Ticket value starts here, giving the shared filter a typed row marker. */
const TICKET_ROW_PREFIX = "ticket ";

/**
 * cmdk's matcher plus VC-205's section priority. The added point is constant
 * within the Ticket section, so native relevance still orders its rows while
 * every matching Ticket group score remains above every other group's score.
 * Leading whitespace is ignored consistently for typed suggestions and rows.
 */
export function commandPaletteFilter(value: string, search: string, keywords?: string[]): number {
  const score = defaultFilter(value, search.trimStart(), keywords);
  return score > 0 && value.startsWith(TICKET_ROW_PREFIX) ? score + 1 : score;
}

/**
 * The exact strings a palette row hands cmdk: the item `value` plus the
 * `keywords` cmdk appends to it before scoring. Built here — once — because
 * {@link slicePaletteSection} scores the same pair; a view-side copy that
 * drifted would truncate rows cmdk ranks into view.
 */
export interface PaletteRowMatch {
  value: string;
  keywords: string[];
}

export function ticketRowMatch(item: CommandPaletteTicketItem): PaletteRowMatch {
  return {
    value: `${TICKET_ROW_PREFIX}${item.displayId} ${item.title} ${item.projectName}`,
    keywords: [item.displayId, item.title, item.projectName],
  };
}

/** The one context line a session row shows AND matches on — built once so the two cannot drift. */
export function sessionRowContext(item: CommandPaletteSessionItem): string {
  return item.ticketDisplayId === null
    ? `${item.projectName} · Project Session`
    : `${item.ticketDisplayId} · ${item.ticketTitle}`;
}

export function sessionRowMatch(item: CommandPaletteSessionItem): PaletteRowMatch {
  const context = sessionRowContext(item);
  return {
    value: `session ${item.title} ${context} ${item.projectName}`,
    keywords: [item.title, context, item.projectName],
  };
}

export function automationRowMatch(item: CommandPaletteAutomationRunItem): PaletteRowMatch {
  return {
    value: `run automation ${item.name} ${item.ticketDisplayId}`,
    keywords: [item.name, item.ticketDisplayId, "run", "automation"],
  };
}

/* -------------------------------------------------------------- truncation */

/** How many rows a section shows before its "Show all" row (VC-205 asks for 10–12). */
export const PALETTE_SECTION_LIMIT = 10;

export interface PaletteSectionSlice<T> {
  /** The rows to mount, best match first, paired with the match text their `Command.Item` takes. */
  readonly visible: readonly { readonly row: T; readonly match: PaletteRowMatch }[];
  /** Matching rows held behind "Show all" — 0 once the section is expanded or fits. */
  readonly hiddenCount: number;
}

/**
 * The slice of one section the palette mounts: every row cmdk would keep,
 * best score first, truncated at {@link PALETTE_SECTION_LIMIT} until expanded.
 *
 * Scored with {@link commandPaletteFilter} over the same value/keywords the
 * mounted rows then carry, so cmdk's native pass over the mounted subset
 * reproduces exactly this ranking — truncation can never cut a row cmdk would
 * have shown above the cut. An empty search mirrors cmdk's own short-circuit:
 * everything matches, in the model's order (recency for tickets).
 *
 * A one-row overflow is not truncated: the "Show all" row would occupy the
 * very slot the hidden row vacated, hiding one thing to show one thing.
 */
export function slicePaletteSection<T>(
  rows: readonly T[],
  match: (row: T) => PaletteRowMatch,
  search: string,
  expanded: boolean,
): PaletteSectionSlice<T> {
  const entries = rows.map((row) => ({ row, match: match(row) }));
  const matched =
    search === ""
      ? entries
      : entries
          .map((entry) => ({
            entry,
            score: commandPaletteFilter(entry.match.value, search, entry.match.keywords),
          }))
          .filter((scored) => scored.score > 0)
          // Stable, so equal scores keep the model's own order.
          .toSorted((a, b) => b.score - a.score)
          .map((scored) => scored.entry);
  const limit =
    expanded || matched.length <= PALETTE_SECTION_LIMIT + 1
      ? matched.length
      : PALETTE_SECTION_LIMIT;
  return { visible: matched.slice(0, limit), hiddenCount: matched.length - limit };
}
