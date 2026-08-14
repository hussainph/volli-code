import { describe, expect, it } from "vite-plus/test";
import type { IndexedFile, PromptTemplate } from "@volli/shared";

import {
  activePickerRow,
  applyPickerRow,
  commandTokenAt,
  composerPicker,
  movePickerActive,
  rankCommandCompletions,
  type ComposerPickerRow,
  type ComposerPickerState,
} from "./composer-picker";

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return { name: "review", description: "Review a file", content: "Review $1.", ...overrides };
}

function indexed(relPath: string, artifact = false): IndexedFile {
  return { relPath, kind: artifact ? "markdown" : "other", artifact };
}

const TEMPLATES: readonly PromptTemplate[] = [
  template({ name: "review", description: "Review a file", content: "Review $1." }),
  template({ name: "ship", description: "Open a pull request", content: "Ship it." }),
  template({ name: "preview", description: "Render the docs", content: "Preview." }),
];

const FILES: readonly IndexedFile[] = [
  indexed("src/app.ts"),
  indexed("src/lib/app.test.ts"),
  indexed(".volli/artifacts/notes.md", true),
];

function pick(text: string, caret = text.length): ComposerPickerState | null {
  return composerPicker({ text, caret, templates: TEMPLATES, files: FILES });
}

describe("commandTokenAt", () => {
  it("opens on a bare slash at the very start", () => {
    expect(commandTokenAt({ text: "/", offset: 1 })).toEqual({ from: 0, to: 1, query: "" });
  });

  it("carries the name typed so far", () => {
    expect(commandTokenAt({ text: "/rev", offset: 4 })).toEqual({ from: 0, to: 4, query: "rev" });
  });

  it("stays open with the caret inside the name", () => {
    expect(commandTokenAt({ text: "/review", offset: 3 })).toEqual({
      from: 0,
      to: 3,
      query: "re",
    });
  });

  it("closes once the caret passes the name into the arguments", () => {
    expect(commandTokenAt({ text: "/review src/a.ts", offset: 12 })).toBeNull();
  });

  it("closes at the space itself — the name is chosen by then", () => {
    expect(commandTokenAt({ text: "/review ", offset: 8 })).toBeNull();
  });

  it("never opens away from the start of the message", () => {
    expect(commandTokenAt({ text: "and/or", offset: 6 })).toBeNull();
    expect(commandTokenAt({ text: " /review", offset: 8 })).toBeNull();
  });

  it("does not open with the caret before the slash", () => {
    expect(commandTokenAt({ text: "/review", offset: 0 })).toBeNull();
  });

  it("clamps a caret past the end of the text", () => {
    expect(commandTokenAt({ text: "/rev", offset: 99 })).toEqual({ from: 0, to: 4, query: "rev" });
  });
});

describe("rankCommandCompletions", () => {
  it("offers every template for an empty query, name-sorted", () => {
    const rows = rankCommandCompletions({ query: "", templates: TEMPLATES });

    expect(rows.map((row) => row.value)).toEqual(["preview", "review", "ship"]);
  });

  it("labels a row with its slash and its description", () => {
    const [row] = rankCommandCompletions({ query: "ship", templates: TEMPLATES });

    expect(row?.label).toBe("/ship");
    expect(row?.detail).toBe("Open a pull request");
  });

  it("puts a prefix match above one the name merely contains", () => {
    const rows = rankCommandCompletions({ query: "rev", templates: TEMPLATES });

    expect(rows.map((row) => row.value)).toEqual(["review", "preview"]);
  });

  it("still finds a template only its description explains", () => {
    const rows = rankCommandCompletions({ query: "pull request", templates: TEMPLATES });

    expect(rows.map((row) => row.value)).toEqual(["ship"]);
  });

  it("is case-insensitive", () => {
    expect(rankCommandCompletions({ query: "SHIP", templates: TEMPLATES })).toHaveLength(1);
  });

  it("is empty when nothing matches", () => {
    expect(rankCommandCompletions({ query: "zzz", templates: TEMPLATES })).toEqual([]);
  });

  it("caps a very long list", () => {
    const many = Array.from({ length: 80 }, (_, index) =>
      template({ name: `cmd${String(index).padStart(2, "0")}` }),
    );

    expect(rankCommandCompletions({ query: "", templates: many })).toHaveLength(50);
  });
});

describe("composerPicker", () => {
  it("opens the command picker on a leading slash", () => {
    const state = pick("/rev");

    expect(state?.mode).toBe("command");
    expect(state?.query).toBe("rev");
    expect(state?.rows.map((row) => row.value)).toEqual(["review", "preview"]);
  });

  it("opens the file picker at an @ boundary", () => {
    const state = pick("look at @src/app");

    expect(state?.mode).toBe("file");
    expect(state?.from).toBe(8);
    expect(state?.rows.map((row) => row.value)).toContain("src/app.ts");
  });

  it("marks an artifact row so the list can draw it as the different thing it is", () => {
    const state = pick("@notes");
    const row = state?.rows.find((entry) => entry.value === ".volli/artifacts/notes.md");

    expect(row?.kind).toBe("file");
    expect(row?.kind === "file" && row.artifact).toBe(true);
  });

  it("does not offer to create an artifact — the composer cannot open the result", () => {
    const state = pick("@brand-new-name");

    expect(state?.rows.every((row) => row.kind === "file")).toBe(true);
  });

  it("is closed for ordinary prose", () => {
    expect(pick("just a message")).toBeNull();
  });

  it("is closed for an @ that is not at a ref boundary", () => {
    expect(pick("mail me@example")).toBeNull();
  });

  it("lets a leading slash win outright — the two can never both be live", () => {
    // `@` cannot start at offset 0 when a `/` is there, so this is a statement
    // about ordering, not about a real ambiguity.
    const state = pick("/review");

    expect(state?.mode).toBe("command");
  });
});

describe("the gates that keep a picker shut", () => {
  const base = { text: "/rev", caret: 4, templates: TEMPLATES, files: FILES };

  it("opens by default", () => {
    expect(composerPicker(base)).not.toBeNull();
  });

  it("stays shut while the composer cannot take a message", () => {
    expect(composerPicker({ ...base, ready: false })).toBeNull();
  });

  it("stays shut while an interaction card holds the slot", () => {
    expect(composerPicker({ ...base, interactionOpen: true })).toBeNull();
  });

  it("stays shut on the token Escape dismissed", () => {
    expect(composerPicker({ ...base, dismissed: { mode: "command", from: 0 } })).toBeNull();
  });

  it("keeps a dismissal shut however much more is typed into the same token", () => {
    const dismissed = { mode: "command", from: 0 } as const;

    expect(composerPicker({ ...base, text: "/revie", caret: 6, dismissed })).toBeNull();
  });

  it("opens a different token even while one is dismissed", () => {
    const state = composerPicker({
      text: "look at @src/ap",
      caret: 15,
      templates: TEMPLATES,
      files: FILES,
      dismissed: { mode: "file", from: 0 },
    });

    expect(state?.mode).toBe("file");
    expect(state?.from).toBe(8);
  });

  it("does not confuse a dismissed command with a file token at the same offset", () => {
    const state = composerPicker({
      text: "@src/ap",
      caret: 7,
      templates: TEMPLATES,
      files: FILES,
      dismissed: { mode: "command", from: 0 },
    });

    expect(state?.mode).toBe("file");
  });

  it("treats an explicit null dismissal as no dismissal", () => {
    expect(composerPicker({ ...base, dismissed: null })).not.toBeNull();
  });
});

describe("applyPickerRow", () => {
  function commandRow(name: string): ComposerPickerRow {
    const found = TEMPLATES.find((entry) => entry.name === name);
    if (!found) throw new Error(`no fixture template ${name}`);
    return {
      kind: "command",
      value: found.name,
      label: `/${found.name}`,
      detail: found.description,
      template: found,
    };
  }

  it("stages `/name ` for a template that reads arguments", () => {
    const state = pick("/rev");
    if (state === null) throw new Error("expected an open picker");

    expect(applyPickerRow({ text: "/rev", state, row: commandRow("review") })).toEqual({
      text: "/review ",
      caret: 8,
    });
  });

  it("expands a template that reads nothing the moment it is picked", () => {
    const state = pick("/sh");
    if (state === null) throw new Error("expected an open picker");

    expect(applyPickerRow({ text: "/sh", state, row: commandRow("ship") })).toEqual({
      text: "Ship it. ",
      caret: 9,
    });
  });

  it("writes a file ref over the @ token and leaves a trailing space", () => {
    const text = "look at @src/ap";
    const state = pick(text);
    if (state === null) throw new Error("expected an open picker");
    const row = state.rows.find((entry) => entry.value === "src/app.ts");
    if (row === undefined) throw new Error("expected src/app.ts");

    expect(applyPickerRow({ text, state, row })).toEqual({
      text: "look at @src/app.ts ",
      caret: 20,
    });
  });

  it("never consumes the text to the right of the caret", () => {
    const text = "@src/ap and then some";
    const state = composerPicker({ text, caret: 7, templates: TEMPLATES, files: FILES });
    if (state === null) throw new Error("expected an open picker");
    const row = state.rows.find((entry) => entry.value === "src/app.ts");
    if (row === undefined) throw new Error("expected src/app.ts");

    expect(applyPickerRow({ text, state, row }).text).toBe("@src/app.ts and then some");
  });

  it("skips its own space when the text to the right already starts with one", () => {
    const text = "/rev args";
    const state = composerPicker({ text, caret: 4, templates: TEMPLATES, files: FILES });
    if (state === null) throw new Error("expected an open picker");

    expect(applyPickerRow({ text, state, row: commandRow("review") })).toEqual({
      text: "/review args",
      caret: 7,
    });
  });
});

describe("movePickerActive", () => {
  const rows = rankCommandCompletions({ query: "", templates: TEMPLATES });

  it("steps down the list", () => {
    expect(movePickerActive(rows, "preview", 1)).toBe("review");
  });

  it("wraps past the end", () => {
    expect(movePickerActive(rows, "ship", 1)).toBe("preview");
  });

  it("wraps past the start", () => {
    expect(movePickerActive(rows, "preview", -1)).toBe("ship");
  });

  it("starts from the top when the active row is no longer in the list", () => {
    expect(movePickerActive(rows, "gone", 1)).toBe("preview");
  });

  it("keeps the value when there is nothing to move through", () => {
    expect(movePickerActive([], "anything", 1)).toBe("anything");
  });
});

describe("activePickerRow", () => {
  const rows = rankCommandCompletions({ query: "", templates: TEMPLATES });

  it("finds the named row", () => {
    expect(activePickerRow(rows, "ship")?.value).toBe("ship");
  });

  it("falls back to the first row, so ⏎ always has a target", () => {
    expect(activePickerRow(rows, "gone")?.value).toBe("preview");
  });

  it("is null when there are no rows at all", () => {
    expect(activePickerRow([], "anything")).toBeNull();
  });
});
