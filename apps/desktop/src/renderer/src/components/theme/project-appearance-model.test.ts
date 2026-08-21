import { describe, expect, it } from "vite-plus/test";
import type { GhosttyAppearancePayload } from "@volli/shared";

import * as model from "./project-appearance-model";
import {
  projectTerminalChoice,
  projectTerminalOverlayEdits,
  terminalCustomSeed,
} from "./project-appearance-model";

describe("the retired editor surface", () => {
  it("offers no editor choice — a project overrides its appearance instead", () => {
    // VC-123. The editor reads one light theme or one dark one off the resolved
    // appearance, and a project's appearance is a migration-014 column, so
    // there is nothing per-project left for this module to own.
    expect(model).not.toHaveProperty("projectEditorChoice");
    expect(model).not.toHaveProperty("withProjectEditorChoice");
  });
});

describe("projectTerminalOverlayEdits", () => {
  it("writes the ghostty theme key for a named terminal theme", () => {
    expect(projectTerminalOverlayEdits({ kind: "theme", name: "Nord" })).toEqual({ theme: "Nord" });
  });

  it("REMOVES the key on Inherit, rather than writing a default over the user's config", () => {
    // The project overlay is the last layer in the chain (#67): leaving a key
    // behind would pin the terminal to whatever Volli last wrote.
    expect(projectTerminalOverlayEdits({ kind: "inherit" })).toEqual({ theme: null });
  });
});

/** A resolved ghostty chain: what the terminal is painted with, and which layer won each key. */
function appearance(
  over: {
    prefs?: Partial<GhosttyAppearancePayload["prefs"]>;
    provenance?: GhosttyAppearancePayload["provenance"];
  } = {},
): GhosttyAppearancePayload {
  return {
    prefs: {
      themeName: null,
      fontFamilies: [],
      fontSize: null,
      ligatures: null,
      mouseReporting: null,
      macosOptionAsAlt: null,
      scrollbackLimitBytes: null,
      ...over.prefs,
    },
    configText: null,
    themeSource: null,
    provenance: over.provenance ?? {},
    overlayPaths: { global: "/data/volli/ghostty/config", project: "/data/volli/ghostty/vlt" },
    ghosttyConfigPath: "/home/u/.config/ghostty/config",
  };
}

describe("projectTerminalChoice", () => {
  it("reads a missing payload as Inherit", () => {
    expect(projectTerminalChoice(null)).toEqual({ kind: "inherit" });
  });

  it("reads a chain that names no theme as Inherit", () => {
    expect(projectTerminalChoice(appearance())).toEqual({ kind: "inherit" });
  });

  it("reads a theme the user's own ghostty config won as Inherit", () => {
    // The project overrides nothing here — it is simply downstream of a config
    // that already sets a theme, which is what Inherit means.
    expect(
      projectTerminalChoice(
        appearance({ prefs: { themeName: "Nord" }, provenance: { theme: "ghostty" } }),
      ),
    ).toEqual({ kind: "inherit" });
  });

  it("reads a theme the GLOBAL Volli overlay won as Inherit", () => {
    expect(
      projectTerminalChoice(
        appearance({ prefs: { themeName: "Nord" }, provenance: { theme: "volli-global" } }),
      ),
    ).toEqual({ kind: "inherit" });
  });

  it("reads a theme the project's own overlay won as that theme", () => {
    expect(
      projectTerminalChoice(
        appearance({ prefs: { themeName: "Nord" }, provenance: { theme: "volli-project" } }),
      ),
    ).toEqual({ kind: "theme", name: "Nord" });
  });

  it("reads Inherit when the project layer won some OTHER key", () => {
    // A project that only sets font-size has not overridden its palette.
    expect(
      projectTerminalChoice(
        appearance({
          prefs: { themeName: "Nord" },
          provenance: { theme: "ghostty", "font-size": "volli-project" },
        }),
      ),
    ).toEqual({ kind: "inherit" });
  });
});

describe("terminalCustomSeed", () => {
  it("has nothing to pin when no layer names a theme", () => {
    // The terminal is wearing the token-derived fallback, which has no catalog
    // name — Volli must not invent one to write into the user's overlay file.
    expect(terminalCustomSeed(appearance())).toBeNull();
    expect(terminalCustomSeed(null)).toBeNull();
  });

  it("pins whatever the project is already showing, whichever layer supplied it", () => {
    expect(
      terminalCustomSeed(
        appearance({ prefs: { themeName: "Nord" }, provenance: { theme: "ghostty" } }),
      ),
    ).toBe("Nord");
  });
});
