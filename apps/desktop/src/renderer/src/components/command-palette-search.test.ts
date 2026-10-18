import { PERSON_STARTED } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  buildNavigationCommandItems,
  type CommandPaletteAutomationRunItem,
  type CommandPaletteSessionItem,
  type CommandPaletteTicketItem,
} from "./command-palette-model";
import {
  PALETTE_SCOPES,
  PALETTE_SECTION_LIMIT,
  automationRowMatch,
  browsableNavigationRows,
  commandPaletteFilter,
  navigationLeads,
  navigationRowMatch,
  paletteEmptyCopy,
  paletteScopeById,
  parsePaletteScopeQuery,
  scopeForToken,
  sessionRowContext,
  sessionRowMatch,
  showScopeSuggestions,
  slicePaletteSection,
  ticketRowMatch,
} from "./command-palette-search";

describe("scopeForToken", () => {
  it("resolves each scope's token, its singular form, and mixed case", () => {
    expect(scopeForToken("@tickets")?.id).toBe("tickets");
    expect(scopeForToken("@session")?.id).toBe("sessions");
    expect(scopeForToken("@Automations")?.id).toBe("automations");
  });

  it("resolves nothing for an unknown or bare token", () => {
    expect(scopeForToken("@bogus")).toBeNull();
    expect(scopeForToken("@")).toBeNull();
    expect(scopeForToken("tickets")).toBeNull();
  });
});

describe("parsePaletteScopeQuery", () => {
  it("converts a scope once whitespace seals it", () => {
    expect(parsePaletteScopeQuery("@tickets ")).toEqual({
      scope: PALETTE_SCOPES[0],
      query: "",
    });
    expect(parsePaletteScopeQuery("  @session  ")?.scope.id).toBe("sessions");
  });

  it("preserves the query after a pasted or typed scope", () => {
    expect(parsePaletteScopeQuery("@sessions auth issue")).toEqual({
      scope: PALETTE_SCOPES[1],
      query: "auth issue",
    });
    expect(parsePaletteScopeQuery("@automation  nightly")).toEqual({
      scope: PALETTE_SCOPES[2],
      query: "nightly",
    });
  });

  it("leaves a token still being typed alone", () => {
    expect(parsePaletteScopeQuery("@tickets")).toBeNull();
    expect(parsePaletteScopeQuery("@ti")).toBeNull();
  });

  it("leaves ordinary text, embedded tokens, and unknown scopes alone", () => {
    expect(parsePaletteScopeQuery("auth ")).toBeNull();
    expect(parsePaletteScopeQuery("fix @tickets ")).toBeNull();
    expect(parsePaletteScopeQuery("@bogus query")).toBeNull();
    expect(parsePaletteScopeQuery("   ")).toBeNull();
  });
});

/** One Ticket row's score, by display id. */
function idTicketScore(displayId: string, search: string): number {
  return commandPaletteFilter(`ticket ${displayId} Fix auth Alpha`, search, [
    displayId,
    "Fix auth",
    "Alpha",
  ]);
}

/** One Ticket row's score, by project and title. */
function projectTicketScore(project: string, title: string, search: string): number {
  return commandPaletteFilter(`ticket X-1 ${title} ${project}`, search, ["X-1", title, project]);
}

/** One Board Session row's score, by project and title. */
function projectSessionScore(project: string, title: string, search: string): number {
  return commandPaletteFilter(`session ${title} ${project} · Board Session ${project}`, search, [
    title,
    `${project} · Board Session`,
    project,
  ]);
}

function settingsCommandScore(search: string): number {
  return commandPaletteFilter("navigate Settings App-wide", search, ["Settings", "preferences"]);
}

/** A Ticket that mentions settings, the Settings row's natural rival. */
function settingsTicketScore(search: string): number {
  return commandPaletteFilter("ticket VC-9 Settings search Alpha", search, [
    "VC-9",
    "Settings search",
    "Alpha",
  ]);
}

function skillsPaneScore(search: string): number {
  return commandPaletteFilter("navigate Configure → Skills Alpha", search, ["Configure → Skills"]);
}

describe("commandPaletteFilter", () => {
  it("keeps cmdk matching while ignoring leading query whitespace", () => {
    expect(commandPaletteFilter("@tickets", "  @ti", ["Tickets"])).toBeGreaterThan(0);
    expect(commandPaletteFilter("session Deploy", "auth", [])).toBe(0);
  });

  it("keeps every matching Ticket above a more relevant Session", () => {
    const ticketScore = commandPaletteFilter("ticket VC-1 Session cleanup Alpha", "session", [
      "VC-1",
      "Session cleanup",
      "Alpha",
    ]);
    const sessionScore = commandPaletteFilter(
      "session Session Alpha · Board Session Alpha",
      "session",
      ["Session", "Alpha · Board Session", "Alpha"],
    );
    expect(ticketScore).toBeGreaterThan(sessionScore);
    expect(commandPaletteFilter("ticket VC-1 Auth Alpha", "session", [])).toBe(0);
  });

  it("puts an exact display id above every id it is a prefix of (VC-303)", () => {
    // Natively these tie: "ALP-1" is a prefix of both values.
    expect(idTicketScore("ALP-1", "ALP-1")).toBeGreaterThan(idTicketScore("ALP-10", "ALP-1"));
    // Case and surrounding whitespace are not part of an id.
    expect(idTicketScore("ALP-1", "  alp-1 ")).toBeGreaterThan(idTicketScore("ALP-10", "  alp-1 "));
  });

  it("lifts the named project's rows within their section, and only there", () => {
    const ticket = projectTicketScore;
    const session = projectSessionScore;
    // "beta auth": Beta's Session beats Alpha's identical one…
    expect(session("Beta", "Fix auth", "beta auth")).toBeGreaterThan(
      session("Alpha", "Fix auth", "beta auth"),
    );
    // …multi-word project names qualify too…
    expect(session("Volli Code", "Fix auth", "volli code auth")).toBeGreaterThan(
      session("Alpha", "Fix auth", "volli code auth"),
    );
    // …the bare name lifts every row of that project…
    expect(session("Beta", "Anything", "beta")).toBeGreaterThan(
      session("Alpha", "Beta notes", "beta"),
    );
    // …yet a qualified Session never climbs over a matching Ticket.
    expect(ticket("Alpha", "Beta auth", "beta auth")).toBeGreaterThan(
      session("Beta", "Fix auth", "beta auth"),
    );
    // A project row whose remainder does not match falls back to plain scoring.
    expect(session("Beta", "Deploy", "beta zzz")).toBe(
      commandPaletteFilter("session Deploy Beta · Board Session Beta", "beta zzz", [
        "Deploy",
        "Beta · Board Session",
        "Beta",
      ]),
    );
    // A row with no project keyword is scored natively.
    expect(commandPaletteFilter("session Deploy", "deploy", [])).toBeGreaterThan(0);
    expect(commandPaletteFilter("session Deploy", "deploy", ["Deploy", ""])).toBeGreaterThan(0);
  });

  it("puts a command above every Ticket once its name is typed, not before", () => {
    const settings = settingsCommandScore;
    const ticket = settingsTicketScore;
    expect(settings("Settings")).toBeGreaterThan(ticket("Settings"));
    expect(settings(" settings ")).toBeGreaterThan(ticket(" settings "));
    // Half a word is still a search: the Ticket section keeps its lead.
    expect(settings("sett")).toBeGreaterThan(0);
    expect(settings("sett")).toBeLessThan(ticket("sett"));

    const pane = skillsPaneScore;
    // A whole leading word names it; part of the next word does not.
    expect(pane("configure")).toBeGreaterThan(ticket("configure") + 1);
    expect(pane("configure → sk")).toBeLessThanOrEqual(1);
    expect(pane("configure → skills")).toBeGreaterThan(100);
    // A command row with no name keyword is scored natively.
    expect(commandPaletteFilter("navigate Home", "home", [])).toBeLessThanOrEqual(1);
  });
});

describe("showScopeSuggestions", () => {
  it("offers the rows exactly while an unscoped query starts with @", () => {
    expect(showScopeSuggestions("@", null)).toBe(true);
    expect(showScopeSuggestions("  @ti", null)).toBe(true);
    expect(showScopeSuggestions("", null)).toBe(false);
    expect(showScopeSuggestions("auth", null)).toBe(false);
    expect(showScopeSuggestions("@", "tickets")).toBe(false);
  });
});

describe("paletteScopeById / paletteEmptyCopy", () => {
  it("resolves every listed scope and null", () => {
    for (const scope of PALETTE_SCOPES) {
      expect(paletteScopeById(scope.id)).toBe(scope);
    }
    expect(paletteScopeById(null)).toBeNull();
  });

  it("names the narrowed section in the empty copy", () => {
    expect(paletteEmptyCopy(null)).toBe("No matching tickets, sessions, or commands.");
    expect(paletteEmptyCopy("sessions")).toBe("No matching sessions.");
  });
});

function ticketItem(overrides: Partial<CommandPaletteTicketItem> = {}): CommandPaletteTicketItem {
  return {
    kind: "ticket",
    projectId: "p1",
    projectName: "Alpha",
    ticketId: "t1",
    displayId: "ALP-1",
    title: "Fix auth",
    updatedAt: 0,
    ...overrides,
  };
}

function sessionItem(
  overrides: Partial<CommandPaletteSessionItem> = {},
): CommandPaletteSessionItem {
  return {
    kind: "session",
    projectId: "p1",
    projectName: "Alpha",
    sessionId: "s1",
    sessionKind: "chat",
    title: "Plan the migration",
    scope: { kind: "project", projectId: "p1" },
    ticketDisplayId: null,
    ticketTitle: null,
    lastActivityAt: 0,
    provenance: PERSON_STARTED,
    destination: "tab",
    ...overrides,
  } as CommandPaletteSessionItem;
}

describe("row match text", () => {
  it("builds a ticket row's value and keywords", () => {
    expect(ticketRowMatch(ticketItem())).toEqual({
      value: "ticket ALP-1 Fix auth Alpha",
      keywords: ["ALP-1", "Fix auth", "Alpha"],
    });
  });

  it("gives ticket, Board, and unavailable-ticket Sessions truthful context", () => {
    expect(sessionRowContext(sessionItem())).toBe("Alpha · Board Session");
    expect(
      sessionRowContext(sessionItem({ ticketDisplayId: "ALP-1", ticketTitle: "Fix auth" })),
    ).toBe("ALP-1 · Fix auth");
    expect(
      sessionRowContext(sessionItem({ destination: "detail", scope: { kind: "unavailable" } })),
    ).toBe("Alpha · Ticket unavailable");
  });

  it("builds a session row's value and keywords from the same context line", () => {
    expect(sessionRowMatch(sessionItem())).toEqual({
      value: "session Plan the migration Alpha · Board Session Alpha",
      keywords: ["Plan the migration", "Alpha · Board Session", "Alpha"],
    });
  });

  it("builds a navigation row's value and keywords, title first", () => {
    const [home] = buildNavigationCommandItems({ name: "Alpha" });
    expect(navigationRowMatch(home!)).toEqual({
      value: "navigate Home Alpha",
      keywords: ["Home", "home", "tabs"],
    });
  });

  it("builds an automation run row's value and keywords", () => {
    const run: CommandPaletteAutomationRunItem = {
      kind: "automation-run",
      automationId: "a1",
      name: "Review",
      ownership: "project",
      ticketId: "t1",
      ticketDisplayId: "ALP-1",
    };
    expect(automationRowMatch(run)).toEqual({
      value: "run automation Review ALP-1",
      keywords: ["Review", "ALP-1", "run", "automation"],
    });
  });
});

const matchTitle = (row: { title: string }) => ({ value: row.title, keywords: [] });
const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ title: `Row number ${index}` }));

describe("slicePaletteSection", () => {
  it("keeps the model's own order and truncates an empty search at the limit", () => {
    const slice = slicePaletteSection(rows(14), matchTitle, "", false);
    expect(slice.visible.map((entry) => entry.row.title)[0]).toBe("Row number 0");
    expect(slice.visible).toHaveLength(PALETTE_SECTION_LIMIT);
    expect(slice.hiddenCount).toBe(4);
  });

  it("does not hide a single overflow row behind a row of its own size", () => {
    const slice = slicePaletteSection(rows(PALETTE_SECTION_LIMIT + 1), matchTitle, "", false);
    expect(slice.visible).toHaveLength(PALETTE_SECTION_LIMIT + 1);
    expect(slice.hiddenCount).toBe(0);
  });

  it("shows everything once expanded", () => {
    const slice = slicePaletteSection(rows(14), matchTitle, "", true);
    expect(slice.visible).toHaveLength(14);
    expect(slice.hiddenCount).toBe(0);
  });

  it("drops rows cmdk would drop and ranks the better match first", () => {
    const slice = slicePaletteSection(
      [{ title: "beta alpha" }, { title: "alpha beta" }, { title: "deploy" }],
      matchTitle,
      "alpha",
      false,
    );
    // The start-anchored match outscores the word-boundary one under cmdk's
    // own filter; "deploy" does not survive at all.
    expect(slice.visible.map((entry) => entry.row.title)).toEqual(["alpha beta", "beta alpha"]);
    expect(slice.hiddenCount).toBe(0);
  });

  it("matches through keywords, exactly as cmdk appends them", () => {
    const slice = slicePaletteSection(
      [{ title: "session Untitled", keyword: "Fix auth" }],
      (row) => ({ value: row.title, keywords: [row.keyword] }),
      "fix",
      false,
    );
    expect(slice.visible).toHaveLength(1);
  });

  it("truncates a searched section too, counting only the survivors", () => {
    const searched = slicePaletteSection(
      [...rows(13), { title: "unrelated" }],
      matchTitle,
      "row",
      false,
    );
    expect(searched.visible).toHaveLength(PALETTE_SECTION_LIMIT);
    expect(searched.hiddenCount).toBe(3);
  });
});

describe("navigationLeads", () => {
  const pages = buildNavigationCommandItems({ name: "Alpha" }, [
    { key: "skills", label: "Skills" },
  ]);
  const leads = (search: string) =>
    navigationLeads(
      slicePaletteSection(
        browsableNavigationRows(pages, search),
        navigationRowMatch,
        search,
        false,
      ),
      search,
    );

  it("puts Go to first once the query names one of its commands", () => {
    expect(leads("Settings")).toBe(true);
    expect(leads("board")).toBe(true);
    expect(leads("configure skills")).toBe(true);
  });

  it("leaves it last while browsing, half-typed, or matching nothing", () => {
    expect(leads("")).toBe(false);
    expect(leads("sett")).toBe(false);
    expect(leads("zzzz")).toBe(false);
  });
});

describe("browsableNavigationRows", () => {
  it("leaves Configure's panes out while browsing and in once searching", () => {
    const pages = buildNavigationCommandItems({ name: "Alpha" }, [
      { key: "skills", label: "Skills" },
    ]);
    expect(browsableNavigationRows(pages, "").map((row) => row.title)).not.toContain(
      "Configure → Skills",
    );
    expect(browsableNavigationRows(pages, "skills")).toBe(pages);
  });
});

/**
 * VC-303's acceptance, end to end over the real match text and the same
 * slices the palette mounts: each kind of query has a predictable top row.
 * Session recency is the model's to decide and is proven there
 * (`command-palette-model.test.ts`); these rows arrive already in its order.
 */
describe("the palette's top results", () => {
  const tickets = [
    ticketItem({ ticketId: "t10", displayId: "ALP-10", title: "Settings search", updatedAt: 9 }),
    ticketItem({ ticketId: "t1", displayId: "ALP-1", title: "Fix auth", updatedAt: 1 }),
    ticketItem({
      ticketId: "b1",
      projectId: "p2",
      projectName: "Beta",
      displayId: "BET-1",
      title: "Fix auth",
      updatedAt: 5,
    }),
  ];
  const sessions = [
    sessionItem({ sessionId: "alpha", title: "Fix auth", lastActivityAt: 900 }),
    sessionItem({
      sessionId: "beta",
      projectId: "p2",
      projectName: "Beta",
      title: "Fix auth",
      scope: { kind: "project", projectId: "p2" },
      lastActivityAt: 950,
    }),
  ];
  const navigation = buildNavigationCommandItems({ name: "Alpha" }, [
    { key: "skills", label: "Skills" },
  ]);

  /**
   * Each non-empty section's top row, in the order the palette MOUNTS the
   * sections — which is the order the list shows them, because cmdk keeps
   * groups in DOM order: Tickets, Sessions, then Go to, unless
   * `navigationLeads` moves Go to first.
   */
  function top(search: string): string[] {
    const ticketTop = slicePaletteSection(tickets, ticketRowMatch, search, false).visible[0];
    const sessionTop = slicePaletteSection(sessions, sessionRowMatch, search, false).visible[0];
    const navigationSlice = slicePaletteSection(
      browsableNavigationRows(navigation, search),
      navigationRowMatch,
      search,
      false,
    );
    const navigationTop = navigationSlice.visible[0]?.row.title;
    const sections = [ticketTop?.row.displayId, sessionTop?.row.sessionId];
    const ordered = navigationLeads(navigationSlice, search)
      ? [navigationTop, ...sections]
      : [...sections, navigationTop];
    return ordered.filter((label): label is string => label !== undefined);
  }

  it("puts an exact display id first", () => {
    expect(top("ALP-1")[0]).toBe("ALP-1");
    expect(top("alp-10")[0]).toBe("ALP-10");
  });

  it("puts the qualifying project's rows first in their sections", () => {
    expect(top("beta fix auth")).toEqual(["BET-1", "beta"]);
    expect(top("alpha fix auth")).toEqual(["ALP-1", "alpha"]);
  });

  it('puts the Settings command first for "Settings", and Tickets first for half of it', () => {
    expect(top("Settings")[0]).toBe("Settings");
    expect(top("configure skills")[0]).toBe("Configure → Skills");
    expect(top("sett")[0]).toBe("ALP-10");
  });
});
