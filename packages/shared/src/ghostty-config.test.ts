import { describe, expect, it } from "vite-plus/test";

import {
  type GhosttyTerminalPrefs,
  mergeGhosttyConfigTexts,
  parseGhosttyTerminalPrefs,
  resolveGhosttyConfigText,
} from "./ghostty-config";

/** The all-unset result, so tests can assert full objects concisely. */
const EMPTY_PREFS: GhosttyTerminalPrefs = {
  fontFamilies: [],
  fontSize: null,
  themeName: null,
  ligatures: null,
  scrollbackLimitBytes: null,
  mouseReporting: null,
  macosOptionAsAlt: null,
};

describe("parseGhosttyTerminalPrefs", () => {
  it("ignores comments and blank lines", () => {
    const text = `
# this is a comment
      # indented comment

font-size = 14
`;
    expect(parseGhosttyTerminalPrefs(text)).toEqual({ ...EMPTY_PREFS, fontSize: 14 });
  });

  it("strips one pair of surrounding double quotes", () => {
    expect(parseGhosttyTerminalPrefs('theme = "Front End Delight"').themeName).toBe(
      "Front End Delight",
    );
  });

  it("leaves unmatched or interior quotes literal", () => {
    expect(parseGhosttyTerminalPrefs('theme = "unterminated').themeName).toBe('"unterminated');
    expect(parseGhosttyTerminalPrefs('theme = weird"quote').themeName).toBe('weird"quote');
  });

  it("is insensitive to spacing around =", () => {
    expect(parseGhosttyTerminalPrefs("font-size=14").fontSize).toBe(14);
    expect(parseGhosttyTerminalPrefs("font-size = 14").fontSize).toBe(14);
    expect(parseGhosttyTerminalPrefs("font-size =14").fontSize).toBe(14);
    expect(parseGhosttyTerminalPrefs("font-size= 14").fontSize).toBe(14);
  });

  it("accumulates repeatable font-family values in order", () => {
    const text = `
font-family = Fira Code
font-family = JetBrains Mono
`;
    expect(parseGhosttyTerminalPrefs(text).fontFamilies).toEqual(["Fira Code", "JetBrains Mono"]);
  });

  it("resets font-family accumulation on an empty value", () => {
    const text = `
font-family = Fira Code
font-family =
font-family = JetBrains Mono
`;
    expect(parseGhosttyTerminalPrefs(text).fontFamilies).toEqual(["JetBrains Mono"]);
  });

  it("ignores styled font-family variants", () => {
    const text = `
font-family = Fira Code
font-family-bold = Fira Code Bold
`;
    expect(parseGhosttyTerminalPrefs(text).fontFamilies).toEqual(["Fira Code"]);
  });

  it("parses font-size as a float", () => {
    expect(parseGhosttyTerminalPrefs("font-size = 13.5").fontSize).toBe(13.5);
  });

  it("treats invalid or non-positive font-size as null", () => {
    expect(parseGhosttyTerminalPrefs("font-size = not-a-number").fontSize).toBeNull();
    expect(parseGhosttyTerminalPrefs("font-size = -5").fontSize).toBeNull();
    expect(parseGhosttyTerminalPrefs("font-size = 0").fontSize).toBeNull();
  });

  it("resets font-size to null on an empty value", () => {
    const text = `
font-size = 14
font-size =
`;
    expect(parseGhosttyTerminalPrefs(text).fontSize).toBeNull();
  });

  it("lets the last theme occurrence win", () => {
    const text = `
theme = Rose Pine
theme = Nord
`;
    expect(parseGhosttyTerminalPrefs(text).themeName).toBe("Nord");
  });

  it("resets theme to null on an empty value", () => {
    const text = `
theme = Nord
theme =
`;
    expect(parseGhosttyTerminalPrefs(text).themeName).toBeNull();
  });

  it("picks the dark variant from a light/dark theme pair", () => {
    expect(parseGhosttyTerminalPrefs("theme = light:Rose Pine Dawn,dark:Rose Pine").themeName).toBe(
      "Rose Pine",
    );
  });

  it("tolerates spaces after commas in a theme pair", () => {
    expect(
      parseGhosttyTerminalPrefs("theme = light:Rose Pine Dawn, dark:Rose Pine").themeName,
    ).toBe("Rose Pine");
  });

  it("falls back to the light variant when only light: is present", () => {
    expect(parseGhosttyTerminalPrefs("theme = light:Rose Pine Dawn").themeName).toBe(
      "Rose Pine Dawn",
    );
  });

  it("uses a plain theme value as-is", () => {
    expect(parseGhosttyTerminalPrefs("theme = Nord").themeName).toBe("Nord");
  });

  it("skips junk lines with no =", () => {
    const text = `
this is not a config line
font-size = 14
another junk line
`;
    expect(parseGhosttyTerminalPrefs(text).fontSize).toBe(14);
  });

  it("keeps a hex color value intact (no trailing-comment stripping)", () => {
    const text = `
# background is not a tracked key, but the parser must not choke on it
background = #123abc
font-size = 14
`;
    const result = parseGhosttyTerminalPrefs(text);
    expect(result.fontSize).toBe(14);
    // Sanity: the parser doesn't treat `#123abc` as a trailing comment that
    // would have truncated the value or broken subsequent line parsing.
    expect(result).toEqual({ ...EMPTY_PREFS, fontSize: 14 });
  });

  it("returns empty defaults for an empty config", () => {
    expect(parseGhosttyTerminalPrefs("")).toEqual(EMPTY_PREFS);
  });

  describe("ligatures (font-feature)", () => {
    it("is null when neither calt nor liga is mentioned", () => {
      expect(parseGhosttyTerminalPrefs("font-feature = ss01").ligatures).toBeNull();
      expect(parseGhosttyTerminalPrefs("").ligatures).toBeNull();
    });

    it("is false when calt is disabled", () => {
      expect(parseGhosttyTerminalPrefs("font-feature = -calt").ligatures).toBe(false);
    });

    it("is false when liga is disabled", () => {
      expect(parseGhosttyTerminalPrefs("font-feature = -liga").ligatures).toBe(false);
    });

    it("handles multiple comma-separated tags in one value", () => {
      expect(parseGhosttyTerminalPrefs("font-feature = -liga, -dlig").ligatures).toBe(false);
    });

    it("tolerates whitespace around comma-separated tags", () => {
      expect(parseGhosttyTerminalPrefs("font-feature =  -calt ,  ss01 ").ligatures).toBe(false);
    });

    it("is true when calt is enabled with a bare tag", () => {
      expect(parseGhosttyTerminalPrefs("font-feature = calt").ligatures).toBe(true);
    });

    it("is true when calt is re-enabled with a + prefix", () => {
      expect(parseGhosttyTerminalPrefs("font-feature = +calt").ligatures).toBe(true);
    });

    it("tracks re-enable across occurrences (last write wins per tag)", () => {
      const text = `
font-feature = -calt
font-feature = +calt
`;
      expect(parseGhosttyTerminalPrefs(text).ligatures).toBe(true);
    });

    it("stays false when one of calt/liga is disabled even if the other is on", () => {
      const text = `
font-feature = liga
font-feature = -calt
`;
      expect(parseGhosttyTerminalPrefs(text).ligatures).toBe(false);
    });

    it("resets all tracked features on an empty value", () => {
      const text = `
font-feature = -calt
font-feature =
`;
      expect(parseGhosttyTerminalPrefs(text).ligatures).toBeNull();
    });
  });

  describe("scrollback-limit", () => {
    it("parses a non-negative integer byte count", () => {
      expect(parseGhosttyTerminalPrefs("scrollback-limit = 10000000").scrollbackLimitBytes).toBe(
        10000000,
      );
      expect(parseGhosttyTerminalPrefs("scrollback-limit = 0").scrollbackLimitBytes).toBe(0);
    });

    it("is null for invalid or negative values", () => {
      expect(parseGhosttyTerminalPrefs("scrollback-limit = -1").scrollbackLimitBytes).toBeNull();
      expect(parseGhosttyTerminalPrefs("scrollback-limit = 1.5").scrollbackLimitBytes).toBeNull();
      expect(parseGhosttyTerminalPrefs("scrollback-limit = huge").scrollbackLimitBytes).toBeNull();
    });

    it("last occurrence wins and empty resets", () => {
      expect(
        parseGhosttyTerminalPrefs("scrollback-limit = 100\nscrollback-limit = 200")
          .scrollbackLimitBytes,
      ).toBe(200);
      expect(
        parseGhosttyTerminalPrefs("scrollback-limit = 100\nscrollback-limit =")
          .scrollbackLimitBytes,
      ).toBeNull();
    });
  });

  describe("mouse-reporting", () => {
    it("parses ghostty booleans only", () => {
      expect(parseGhosttyTerminalPrefs("mouse-reporting = true").mouseReporting).toBe(true);
      expect(parseGhosttyTerminalPrefs("mouse-reporting = false").mouseReporting).toBe(false);
    });

    it("is null for non-boolean values", () => {
      expect(parseGhosttyTerminalPrefs("mouse-reporting = yes").mouseReporting).toBeNull();
      expect(parseGhosttyTerminalPrefs("mouse-reporting = 1").mouseReporting).toBeNull();
    });

    it("last occurrence wins and empty resets", () => {
      expect(
        parseGhosttyTerminalPrefs("mouse-reporting = true\nmouse-reporting = false").mouseReporting,
      ).toBe(false);
      expect(
        parseGhosttyTerminalPrefs("mouse-reporting = true\nmouse-reporting =").mouseReporting,
      ).toBeNull();
    });
  });

  describe("macos-option-as-alt", () => {
    it("parses true/false/left/right", () => {
      expect(parseGhosttyTerminalPrefs("macos-option-as-alt = true").macosOptionAsAlt).toBe(true);
      expect(parseGhosttyTerminalPrefs("macos-option-as-alt = false").macosOptionAsAlt).toBe(false);
      expect(parseGhosttyTerminalPrefs("macos-option-as-alt = left").macosOptionAsAlt).toBe("left");
      expect(parseGhosttyTerminalPrefs("macos-option-as-alt = right").macosOptionAsAlt).toBe(
        "right",
      );
    });

    it("is null for invalid values", () => {
      expect(parseGhosttyTerminalPrefs("macos-option-as-alt = maybe").macosOptionAsAlt).toBeNull();
    });

    it("last occurrence wins and empty resets", () => {
      expect(
        parseGhosttyTerminalPrefs("macos-option-as-alt = left\nmacos-option-as-alt = right")
          .macosOptionAsAlt,
      ).toBe("right");
      expect(
        parseGhosttyTerminalPrefs("macos-option-as-alt = left\nmacos-option-as-alt =")
          .macosOptionAsAlt,
      ).toBeNull();
    });
  });
});

/** Builds a reader over an in-memory file map (absolute path → text). */
const readerFor =
  (files: Record<string, string>) =>
  (absPath: string): string | null =>
    absPath in files ? files[absPath] : null;

describe("resolveGhosttyConfigText", () => {
  it("returns null text and no warnings when the entry file is missing", () => {
    expect(resolveGhosttyConfigText("/home/u/.config/ghostty/config", () => null)).toEqual({
      text: null,
      warnings: [],
    });
  });

  it("returns a lone file's text unchanged when it has no includes", () => {
    const files = { "/cfg/config": "font-size = 14\n" };
    const { text, warnings } = resolveGhosttyConfigText("/cfg/config", readerFor(files));
    expect(text).toBe("font-size = 14\n");
    expect(warnings).toEqual([]);
  });

  it("emits an include's text before the containing file so the parent key wins", () => {
    const files = {
      "/cfg/config": "config-file = theme.conf\ntheme = Parent\n",
      "/cfg/theme.conf": "theme = Child\n",
    };
    const { text, warnings } = resolveGhosttyConfigText("/cfg/config", readerFor(files));
    expect(warnings).toEqual([]);
    // The merged text feeds a last-wins parse; the parent value must survive.
    expect(parseGhosttyTerminalPrefs(text ?? "").themeName).toBe("Parent");
  });

  it("resolves relative include paths against the containing file's directory", () => {
    const files = {
      "/cfg/config": "config-file = sub/extra.conf\n",
      "/cfg/sub/extra.conf": "font-size = 16\n",
    };
    const { text } = resolveGhosttyConfigText("/cfg/config", readerFor(files));
    expect(parseGhosttyTerminalPrefs(text ?? "").fontSize).toBe(16);
  });

  it("skips a missing optional (?) include silently", () => {
    const files = { "/cfg/config": "config-file = ?maybe.conf\nfont-size = 12\n" };
    const { text, warnings } = resolveGhosttyConfigText("/cfg/config", readerFor(files));
    expect(warnings).toEqual([]);
    expect(parseGhosttyTerminalPrefs(text ?? "").fontSize).toBe(12);
  });

  it("warns (without throwing) on a missing non-optional include", () => {
    const files = { "/cfg/config": "config-file = gone.conf\n" };
    const { text, warnings } = resolveGhosttyConfigText("/cfg/config", readerFor(files));
    expect(text).toBe("config-file = gone.conf\n");
    expect(warnings).toEqual(["config-file not found: /cfg/gone.conf"]);
  });

  it("recurses into nested includes under the same no-override rule", () => {
    const files = {
      "/cfg/config": "config-file = a.conf\ntheme = Top\n",
      "/cfg/a.conf": "config-file = b.conf\ntheme = Mid\n",
      "/cfg/b.conf": "theme = Bottom\n",
    };
    const { text, warnings } = resolveGhosttyConfigText("/cfg/config", readerFor(files));
    expect(warnings).toEqual([]);
    // Top wins over Mid wins over Bottom.
    expect(parseGhosttyTerminalPrefs(text ?? "").themeName).toBe("Top");
  });

  it("terminates on an include cycle (A → B → A)", () => {
    const files = {
      "/cfg/a.conf": "config-file = b.conf\nfont-size = 10\n",
      "/cfg/b.conf": "config-file = a.conf\ntheme = Cycle\n",
    };
    const { text, warnings } = resolveGhosttyConfigText("/cfg/a.conf", readerFor(files));
    expect(warnings).toEqual([]);
    const prefs = parseGhosttyTerminalPrefs(text ?? "");
    expect(prefs.fontSize).toBe(10);
    expect(prefs.themeName).toBe("Cycle");
  });

  it("skips a duplicate include the second time it is referenced", () => {
    const files = {
      "/cfg/config": "config-file = shared.conf\nconfig-file = shared.conf\n",
      "/cfg/shared.conf": "font-size = 9\n",
    };
    const { text, warnings } = resolveGhosttyConfigText("/cfg/config", readerFor(files));
    expect(warnings).toEqual([]);
    // The shared file's text appears exactly once in the merged output.
    const occurrences = (text ?? "").split("font-size = 9").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("mergeGhosttyConfigTexts", () => {
  it("joins non-null texts in order with newlines", () => {
    expect(mergeGhosttyConfigTexts(["a = 1", "b = 2"])).toBe("a = 1\nb = 2");
  });

  it("drops null entries", () => {
    expect(mergeGhosttyConfigTexts([null, "a = 1", null, "b = 2"])).toBe("a = 1\nb = 2");
  });

  it("returns null when every entry is null", () => {
    expect(mergeGhosttyConfigTexts([null, null])).toBeNull();
    expect(mergeGhosttyConfigTexts([])).toBeNull();
  });
});
