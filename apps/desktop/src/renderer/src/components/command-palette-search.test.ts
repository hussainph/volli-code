import { PERSON_STARTED } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import type {
  CommandPaletteAutomationRunItem,
  CommandPaletteSessionItem,
  CommandPaletteTicketItem,
} from "./command-palette-model";
import {
  PALETTE_SCOPES,
  PALETTE_SECTION_LIMIT,
  automationRowMatch,
  commandPaletteFilter,
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
      "session Session Alpha · Project Session Alpha",
      "session",
      ["Session", "Alpha · Project Session", "Alpha"],
    );
    expect(ticketScore).toBeGreaterThan(sessionScore);
    expect(commandPaletteFilter("ticket VC-1 Auth Alpha", "session", [])).toBe(0);
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
    expect(paletteEmptyCopy(null)).toBe("No matching tickets or sessions.");
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
    provenance: PERSON_STARTED,
    ...overrides,
  };
}

describe("row match text", () => {
  it("builds a ticket row's value and keywords", () => {
    expect(ticketRowMatch(ticketItem())).toEqual({
      value: "ticket ALP-1 Fix auth Alpha",
      keywords: ["ALP-1", "Fix auth", "Alpha"],
    });
  });

  it("gives a ticket session its ticket context and a project session its project", () => {
    expect(sessionRowContext(sessionItem())).toBe("Alpha · Project Session");
    expect(
      sessionRowContext(sessionItem({ ticketDisplayId: "ALP-1", ticketTitle: "Fix auth" })),
    ).toBe("ALP-1 · Fix auth");
  });

  it("builds a session row's value and keywords from the same context line", () => {
    expect(sessionRowMatch(sessionItem())).toEqual({
      value: "session Plan the migration Alpha · Project Session Alpha",
      keywords: ["Plan the migration", "Alpha · Project Session", "Alpha"],
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
