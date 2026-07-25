import { describe, expect, it } from "vite-plus/test";

import {
  applyOverlayEdits,
  resolveGhosttyLayers,
  globalGhosttyOverlayPath,
  isValidOverlayKey,
  isValidOverlayValue,
  OVERLAY_HEADER,
  projectGhosttyOverlayDir,
  projectGhosttyOverlayPath,
  volliGhosttyOverlayDir,
} from "./ghostty-overlay";

const USER_DATA = "/Users/u/Library/Application Support/Volli Code";

describe("overlay paths", () => {
  it("builds the global overlay path under <userData>/volli/ghostty", () => {
    expect(volliGhosttyOverlayDir(USER_DATA)).toBe(`${USER_DATA}/volli/ghostty`);
    expect(globalGhosttyOverlayPath(USER_DATA)).toBe(`${USER_DATA}/volli/ghostty/config`);
  });

  it("builds a per-project overlay path keyed by ticket prefix", () => {
    expect(projectGhosttyOverlayDir(USER_DATA)).toBe(`${USER_DATA}/volli/ghostty/projects`);
    expect(projectGhosttyOverlayPath(USER_DATA, "VC")).toBe(
      `${USER_DATA}/volli/ghostty/projects/VC.config`,
    );
  });

  it("refuses a prefix that is not a valid ticket prefix", () => {
    expect(() => projectGhosttyOverlayPath(USER_DATA, "../../etc")).toThrow(/prefix/i);
    expect(() => projectGhosttyOverlayPath(USER_DATA, "")).toThrow(/prefix/i);
  });

  it("tolerates a trailing slash on the userData dir", () => {
    expect(globalGhosttyOverlayPath(`${USER_DATA}/`)).toBe(`${USER_DATA}/volli/ghostty/config`);
  });
});

describe("applyOverlayEdits — creating an overlay", () => {
  it("writes a Volli header above the first edits when the file does not exist", () => {
    const text = applyOverlayEdits(null, { theme: "Catppuccin Mocha" });
    expect(text.startsWith(OVERLAY_HEADER)).toBe(true);
    expect(text.endsWith("theme = Catppuccin Mocha\n")).toBe(true);
  });

  it("names the file as Volli-owned and safe to hand-edit", () => {
    expect(OVERLAY_HEADER).toMatch(/Volli/);
    for (const line of OVERLAY_HEADER.trimEnd().split("\n")) {
      expect(line.startsWith("#")).toBe(true);
    }
  });
});

// The preservation contract is the thing most likely to silently regress: a
// rewrite that drops a hand-written key turns "the overlay takes any ghostty
// key" (#68) into a lie, and the user only finds out when their cursor stops
// blinking. Asserted hard, line by line.
const HAND_WRITTEN = `# my own overlay notes
theme = Nord

# I like a block cursor
cursor-style = block
font-family = Berkeley Mono
window-padding-x = 8
`;

describe("applyOverlayEdits — preserving a hand-written file", () => {
  it("rewrites only the named key, in place, keeping every other line", () => {
    expect(applyOverlayEdits(HAND_WRITTEN, { theme: "Catppuccin Mocha" })).toBe(
      `# my own overlay notes
theme = Catppuccin Mocha

# I like a block cursor
cursor-style = block
font-family = Berkeley Mono
window-padding-x = 8
`,
    );
  });

  it("appends a key the file does not set yet", () => {
    const text = applyOverlayEdits(HAND_WRITTEN, { "font-size": "14" });
    expect(text).toBe(`${HAND_WRITTEN}font-size = 14\n`);
  });

  it("removes a key on a null value and leaves its neighbors alone", () => {
    expect(applyOverlayEdits(HAND_WRITTEN, { "cursor-style": null })).toBe(
      `# my own overlay notes
theme = Nord

# I like a block cursor
font-family = Berkeley Mono
window-padding-x = 8
`,
    );
  });

  it("is a no-op (beyond newline normalization) for an empty edit set", () => {
    expect(applyOverlayEdits(HAND_WRITTEN, {})).toBe(HAND_WRITTEN);
  });

  it("never touches a key that merely shares a prefix with an edited one", () => {
    const text = applyOverlayEdits("font-size = 12\nfont-size-adjust = 1\n", { "font-size": "16" });
    expect(text).toBe("font-size = 16\nfont-size-adjust = 1\n");
  });

  it("leaves commented-out and malformed lines verbatim", () => {
    const source = "#theme = Dracula\nnot a config line\n   \ntheme = Nord\n";
    expect(applyOverlayEdits(source, { theme: "Ayu" })).toBe(
      "#theme = Dracula\nnot a config line\n   \ntheme = Ayu\n",
    );
  });

  it("keeps the edited key's position and indentation", () => {
    expect(applyOverlayEdits("  theme  =  Nord\nfont-size = 12\n", { theme: "Ayu" })).toBe(
      "  theme = Ayu\nfont-size = 12\n",
    );
  });

  it("collapses duplicate lines for an edited key into the first one", () => {
    const source = "theme = Nord\nfont-size = 12\ntheme = Dracula\n";
    expect(applyOverlayEdits(source, { theme: "Ayu" })).toBe("theme = Ayu\nfont-size = 12\n");
  });

  it("removes every duplicate line for a removed key", () => {
    const source = "theme = Nord\nfont-size = 12\ntheme = Dracula\n";
    expect(applyOverlayEdits(source, { theme: null })).toBe("font-size = 12\n");
  });

  it("writes an empty value through as ghostty's explicit reset, not as a removal", () => {
    expect(applyOverlayEdits("font-family = Berkeley Mono\n", { "font-family": "" })).toBe(
      "font-family = \n",
    );
  });

  it("quotes only a value whose own leading/trailing whitespace is significant", () => {
    expect(applyOverlayEdits(null, { "font-family": "JetBrains Mono" })).toContain(
      "font-family = JetBrains Mono\n",
    );
    expect(applyOverlayEdits(null, { "window-title": " padded " })).toContain(
      'window-title = " padded "\n',
    );
  });

  it("normalizes a missing trailing newline and applies edits idempotently", () => {
    const once = applyOverlayEdits("theme = Nord", { "font-size": "13" });
    expect(once).toBe("theme = Nord\nfont-size = 13\n");
    expect(applyOverlayEdits(once, { "font-size": "13" })).toBe(once);
  });

  it("treats a blank existing file as a fresh overlay", () => {
    expect(applyOverlayEdits("\n\n", { theme: "Nord" })).toBe(`${OVERLAY_HEADER}theme = Nord\n`);
  });
});

// One edit must produce at most one ghostty directive. A value runs to
// end-of-line and cannot escape a line break, so `\n` in one is not a
// formatting bug: ghostty's `command` key sets the program the terminal runs.
// Today's callers only pass theme names, font families and integers — these
// assert the guard holds anyway, since the overlay's whole stance (#67/#68) is
// "unrepresentable", not "unlikely".
describe("applyOverlayEdits — refusing an injected directive", () => {
  it("refuses a value that would append a second directive", () => {
    expect(() =>
      applyOverlayEdits(null, { theme: "Nord\ncommand = /bin/sh -c 'echo pwned'" }),
    ).toThrow(/value for key "theme"/);
    expect(() => applyOverlayEdits(null, { theme: "Nord\rcommand = /bin/sh" })).toThrow(
      /line break/,
    );
  });

  it("refuses a key that would write junk lines into a file it promised to preserve", () => {
    expect(() => applyOverlayEdits("# hi\ntheme = Nord\n", { "a\nb": "x" })).toThrow(/key "a\\nb"/);
    expect(() => applyOverlayEdits(null, { "a\rb": "x" })).toThrow(/line break/);
  });

  it("refuses a key containing `=` (ambiguous) or `#` (would comment the line out)", () => {
    expect(() => applyOverlayEdits(null, { "theme = Nord\nfont-size": "12" })).toThrow(/key/);
    expect(() => applyOverlayEdits(null, { "theme=x": "Nord" })).toThrow(/key "theme=x"/);
    expect(() => applyOverlayEdits(null, { "#theme": "Nord" })).toThrow(/key "#theme"/);
  });

  it("refuses before writing anything, so no partial edit is applied", () => {
    // The valid key is ordered first on purpose: a check done per line as it
    // is emitted would have already written it.
    expect(() => applyOverlayEdits("theme = Nord\n", { "font-size": "12", "a\nb": "x" })).toThrow();
  });

  it("still writes a value whose leading/trailing spaces are significant", () => {
    expect(applyOverlayEdits(null, { "font-family": " Berkeley Mono " })).toContain(
      'font-family = " Berkeley Mono "\n',
    );
    // `#` and `=` inside a VALUE are literal to ghostty and stay unrejected.
    expect(applyOverlayEdits(null, { "window-title": "a = b # c" })).toContain(
      "window-title = a = b # c\n",
    );
  });

  it("applies the key rule to a removal too, and reports it directly", () => {
    expect(() => applyOverlayEdits("theme = Nord\n", { "a\nb": null })).toThrow(/key/);
    expect(isValidOverlayKey("font-family")).toBe(true);
    expect(isValidOverlayKey("a\nb")).toBe(false);
    expect(isValidOverlayValue("Berkeley Mono")).toBe(true);
    expect(isValidOverlayValue("Nord\ncommand = x")).toBe(false);
  });
});

describe("resolveGhosttyLayers", () => {
  it("merges the layers last-wins and reports where each key came from", () => {
    const resolved = resolveGhosttyLayers([
      { origin: "ghostty", text: "theme = Nord\nfont-size = 12\ncursor-style = block" },
      { origin: "volli-global", text: "theme = Catppuccin Mocha" },
      { origin: "volli-project", text: "font-size = 15" },
    ]);
    expect(resolved.text).toBe(
      "theme = Nord\nfont-size = 12\ncursor-style = block\ntheme = Catppuccin Mocha\nfont-size = 15",
    );
    expect(resolved.provenance).toEqual({
      theme: "volli-global",
      "font-size": "volli-project",
      "cursor-style": "ghostty",
    });
  });

  it("skips absent layers entirely", () => {
    const resolved = resolveGhosttyLayers([
      { origin: "ghostty", text: null },
      { origin: "volli-global", text: "theme = Ayu" },
      { origin: "volli-project", text: null },
    ]);
    expect(resolved.text).toBe("theme = Ayu");
    expect(resolved.provenance).toEqual({ theme: "volli-global" });
  });

  it("reports no text and no provenance when nothing is configured", () => {
    const resolved = resolveGhosttyLayers([{ origin: "ghostty", text: null }]);
    expect(resolved.text).toBeNull();
    expect(resolved.provenance).toEqual({});
  });

  it("ignores comments and malformed lines when attributing keys", () => {
    const resolved = resolveGhosttyLayers([
      { origin: "ghostty", text: "# theme = Nord\ngibberish\ntheme = Dracula" },
    ]);
    expect(resolved.provenance).toEqual({ theme: "ghostty" });
  });
});

describe("applyOverlayEdits — malformed lines", () => {
  it("preserves a line whose key is empty rather than treating it as a key", () => {
    // `= value` sets nothing in ghostty; it must survive verbatim, not be
    // mistaken for a key the edits could target or collapse.
    const text = "= orphaned\ntheme = Nord\n";
    expect(applyOverlayEdits(text, { theme: "Dracula" })).toBe("= orphaned\ntheme = Dracula\n");
  });
});
