import { describe, expect, it } from "vite-plus/test";
import type { Label, Ticket } from "@volli/shared";

import {
  labelPickerOptions,
  labelVocabulary,
  newLabelFromQuery,
  withLabelToggled,
} from "./label-picker-model";

function label(name: string, color: string | null = null): Label {
  return { id: `label-${name}`, projectId: "project-1", name, color };
}

function ticket(labels: string[], ticketNumber = 1): Ticket {
  return {
    id: `ticket-${ticketNumber}`,
    projectId: "project-1",
    ticketNumber,
    title: "T",
    body: "",
    status: "todo",
    priority: "medium",
    labels,
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order: 0,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("labelVocabulary", () => {
  it("is the project's label rows, sorted ascending", () => {
    expect(labelVocabulary([label("urgent"), label("bug")], [])).toEqual(["bug", "urgent"]);
  });

  it("includes a name in use on a ticket that has no row yet", () => {
    // `labelsByProject` is seeded once at boot while main mints a row for any
    // unknown name — so a label typed this session exists only on the ticket,
    // and leaving it out of the picker is what breeds the second spelling.
    expect(labelVocabulary([], [ticket(["chore"])])).toEqual(["chore"]);
  });

  it("counts a name carried by both a row and a ticket once", () => {
    expect(labelVocabulary([label("bug")], [ticket(["bug"]), ticket(["bug", "docs"], 2)])).toEqual([
      "bug",
      "docs",
    ]);
  });
});

describe("labelPickerOptions", () => {
  it("marks the ticket's own labels as selected", () => {
    expect(labelPickerOptions(["bug", "docs"], ["docs"], "")).toEqual([
      { name: "bug", selected: false },
      { name: "docs", selected: true },
    ]);
  });

  it("keeps a selected name the vocabulary does not know", () => {
    // The composer edits a ticket that does not exist yet: a name created in
    // its popover belongs to no row and no ticket until submit.
    expect(labelPickerOptions([], ["fresh"], "")).toEqual([{ name: "fresh", selected: true }]);
  });

  it("filters by case-insensitive substring, ignoring the query's whitespace", () => {
    expect(labelPickerOptions(["bug", "debug", "docs"], [], "  BU ")).toEqual([
      { name: "bug", selected: false },
      { name: "debug", selected: false },
    ]);
  });

  it("offers nothing when the query matches nothing", () => {
    expect(labelPickerOptions(["bug"], [], "zzz")).toEqual([]);
  });
});

describe("newLabelFromQuery", () => {
  it("is the trimmed query when the project has no such label", () => {
    expect(newLabelFromQuery(["bug"], [], "  chore ")).toBe("chore");
  });

  it("is null for an empty or whitespace-only query", () => {
    expect(newLabelFromQuery(["bug"], [], "")).toBeNull();
    expect(newLabelFromQuery(["bug"], [], "   ")).toBeNull();
  });

  it("refuses a name that differs from an existing one only in case", () => {
    // The reason the picker exists: `Bug` beside `bug` is one label typed
    // twice, and the board's Label facet would then list both.
    expect(newLabelFromQuery(["bug"], [], "Bug")).toBeNull();
  });

  it("refuses a name already selected on this ticket", () => {
    expect(newLabelFromQuery([], ["fresh"], "fresh")).toBeNull();
  });
});

describe("withLabelToggled", () => {
  it("appends a label that is not carried, preserving chip order", () => {
    expect(withLabelToggled(["bug"], "docs")).toEqual(["bug", "docs"]);
  });

  it("removes a label that is carried", () => {
    expect(withLabelToggled(["bug", "docs"], "bug")).toEqual(["docs"]);
  });
});
