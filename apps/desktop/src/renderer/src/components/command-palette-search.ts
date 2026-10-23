/**
 * ⌘K's list-shape decisions (VC-205), as pure data beside the palette: WHICH
 * sections an `@` scope narrows to, WHERE a section truncates behind its
 * "Show all" row, and the exact match text a row hands cmdk to be judged by.
 *
 * Matching remains cmdk's native `defaultFilter`. The product-level score
 * rules live in {@link commandPaletteFilter}: a matching Ticket gets a fixed
 * section-priority bonus so no score says a Session outranks a Ticket, and
 * three typed intents win (VC-303) — an exact Ticket display id, a query that
 * starts with a project's name, and a page command's own name. Section ORDER
 * is the palette's to decide, not cmdk's: see {@link navigationLeads}.
 * The same wrapper scores the truncated slice and the mounted rows, preventing
 * the two passes from disagreeing.
 */
import { defaultFilter } from "cmdk";

import type {
  CommandPaletteAutomationRunItem,
  CommandPaletteNavigationItem,
  CommandPaletteSessionItem,
  CommandPaletteTicketItem,
} from "@renderer/components/command-palette-model";

/* ------------------------------------------------------------------ scopes */

/** The sections a typed `@` token can narrow the palette to. */
export type PaletteScopeId = "tickets" | "sessions" | "automations";

/**
 * Every section that truncates behind a "Show all" row: the scopes, plus the
 * Go to section, which no `@` token narrows to (it is a handful of pages, and
 * its rows answer to their names — see {@link commandPaletteFilter}).
 */
export type PaletteSectionId = PaletteScopeId | "navigation";

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
    ? "No matching tickets, sessions, or commands."
    : `No matching ${scoped.label.toLowerCase()}.`;
}

/* -------------------------------------------------------------- match text */

/**
 * Typed row markers: every Ticket, Session and Go to value starts with one, so
 * the shared filter knows which rules a row is under. The Go to marker is not
 * "go to " because the editor's Go to Line row already starts with that.
 */
const TICKET_ROW_PREFIX = "ticket ";
const SESSION_ROW_PREFIX = "session ";
const NAVIGATION_ROW_PREFIX = "navigate ";

/**
 * cmdk's native score is at most 1, so each bonus below is a band no native
 * difference can cross. A Ticket's bonus is constant within its section, so
 * native relevance still orders its rows while every matching Ticket outranks
 * every Session; the project-qualified bonus lifts a row within its own
 * section only; the outright bonus clears everything.
 */
const TICKET_SECTION_BONUS = 10;
const PROJECT_QUALIFIED_BONUS = 1;
const OUTRIGHT_BONUS = 100;

/** Lowercased words only: "Configure → Skills" and "configure skills" read alike. */
function commandWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Whether `query` names this command: its title in whole leading words —
 * "settings", "board", "configure", "configure skills" — but not "sett". A
 * half-typed word is still a search, and lifting a command above every
 * Ticket that shares three letters with it would be guessing.
 */
function namesCommand(title: string, query: string): boolean {
  const name = commandWords(title);
  const typed = commandWords(query);
  if (typed === "" || !name.startsWith(typed)) return false;
  return name.length === typed.length || name.charAt(typed.length) === " ";
}

/**
 * A Ticket or Session row's score under a project-qualified query: one that
 * is the row's project name, or starts with it and a space ("alpha auth").
 * The rest of the query is then matched alone, so the qualifier never has to
 * survive cmdk's subsequence match against a title. 0 when the query does not
 * name this row's project.
 *
 * The project name is the LAST keyword of both row kinds — see
 * {@link ticketRowMatch} and {@link sessionRowMatch}, which keep it there.
 */
function projectQualifiedScore(value: string, query: string, keywords: readonly string[]): number {
  const project = keywords.at(-1)?.trim().toLowerCase();
  if (project === undefined || project === "") return 0;
  if (query === project) return 1;
  if (!query.startsWith(`${project} `)) return 0;
  return defaultFilter(value, query.slice(project.length).trimStart(), [...keywords]);
}

/**
 * cmdk's matcher plus the palette's ranking rules:
 *
 * - **Section priority** (VC-205): every matching Ticket outranks every other
 *   row, so cmdk cannot reorder Sessions ahead of Tickets.
 * - **Exact display id** (VC-303): "ALP-1" puts ALP-1 first. Natively it ties
 *   with ALP-10, ALP-12 and every other id it is a prefix of.
 * - **Project-qualified** (VC-303): "alpha auth" puts Alpha's matching
 *   Tickets and Sessions ahead of every other project's in their sections.
 * - **Command names** (VC-303): "Settings" puts the Settings row first, ahead
 *   of any Ticket that happens to mention settings.
 *
 * Ties keep the model's order — recency, current project first — because
 * every sort over these scores is stable. Leading whitespace is ignored
 * consistently for typed suggestions and rows.
 */
export function commandPaletteFilter(
  value: string,
  search: string,
  keywords: string[] = [],
): number {
  const typed = search.trimStart();
  const score = defaultFilter(value, typed, keywords);
  const query = typed.trimEnd().toLowerCase();
  if (value.startsWith(NAVIGATION_ROW_PREFIX)) {
    return keywords[0] !== undefined && namesCommand(keywords[0], query)
      ? OUTRIGHT_BONUS + score
      : score;
  }
  const ticket = value.startsWith(TICKET_ROW_PREFIX);
  if (!ticket && !value.startsWith(SESSION_ROW_PREFIX)) return score;
  const qualified = projectQualifiedScore(value, query, keywords);
  const ranked = qualified > 0 ? qualified + PROJECT_QUALIFIED_BONUS : score;
  if (ranked <= 0) return 0;
  if (!ticket) return ranked;
  const exactId = keywords[0]?.trim().toLowerCase() === query;
  return ranked + TICKET_SECTION_BONUS + (exactId ? OUTRIGHT_BONUS : 0);
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

/** Display id FIRST and project name LAST: {@link commandPaletteFilter} reads both by position. */
export function ticketRowMatch(item: CommandPaletteTicketItem): PaletteRowMatch {
  return {
    value: `${TICKET_ROW_PREFIX}${item.displayId} ${item.title} ${item.projectName}`,
    keywords: [item.displayId, item.title, item.projectName],
  };
}

/** The one context line a session row shows AND matches on — built once so the two cannot drift. */
export function sessionRowContext(item: CommandPaletteSessionItem): string {
  if (item.ticketDisplayId !== null) return `${item.ticketDisplayId} · ${item.ticketTitle}`;
  return item.scope.kind === "unavailable"
    ? `${item.projectName} · Ticket unavailable`
    : `${item.projectName} · Board Session`;
}

/** Project name LAST: {@link commandPaletteFilter} reads it by position. */
export function sessionRowMatch(item: CommandPaletteSessionItem): PaletteRowMatch {
  const context = sessionRowContext(item);
  return {
    value: `${SESSION_ROW_PREFIX}${item.title} ${context} ${item.projectName}`,
    keywords: [item.title, context, item.projectName],
  };
}

export function automationRowMatch(item: CommandPaletteAutomationRunItem): PaletteRowMatch {
  return {
    value: `run automation ${item.name} ${item.ticketDisplayId}`,
    keywords: [item.name, item.ticketDisplayId, "run", "automation"],
  };
}

/** Title FIRST: {@link commandPaletteFilter} reads it by position to know a command's name. */
export function navigationRowMatch(item: CommandPaletteNavigationItem): PaletteRowMatch {
  return {
    value: `${NAVIGATION_ROW_PREFIX}${item.title} ${item.hint}`,
    keywords: [item.title, ...item.keywords],
  };
}

/**
 * Whether the Go to section leads the list: the query names one of its
 * commands ("Settings", "board") outright.
 *
 * The palette has to decide this itself. cmdk 1.1.1 sorts rows WITHIN a group
 * by score, but its group reorder looks each group up as
 * `[data-value="<encoded group id>"]` while the attribute holds the group's
 * value, so it never finds one and groups keep their DOM order. Tickets lead
 * by being rendered first; a named command leads by being rendered before
 * them. No other section needs to move: an exact display id is a Ticket, and
 * a project-qualified Session never outranks a matching Ticket.
 */
export function navigationLeads(
  slice: PaletteSectionSlice<CommandPaletteNavigationItem>,
  search: string,
): boolean {
  const top = slice.visible[0];
  return (
    top !== undefined &&
    commandPaletteFilter(top.match.value, search, top.match.keywords) >= OUTRIGHT_BONUS
  );
}

/**
 * The Go to rows a palette mounts. Browsing (no query) shows the pages and
 * leaves Configure's individual panes out — they are reached by name, and
 * listing all seven under an empty query would make the one bounded-by-design
 * section the longest thing on screen.
 */
export function browsableNavigationRows(
  rows: readonly CommandPaletteNavigationItem[],
  search: string,
): readonly CommandPaletteNavigationItem[] {
  return search === "" ? rows.filter((row) => row.id !== "configure-pane") : rows;
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
