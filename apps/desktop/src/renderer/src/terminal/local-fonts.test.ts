import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { listLocalFontFamilies, uniqueFontFamilies } from "./local-fonts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uniqueFontFamilies", () => {
  it("collapses the per-face list the API returns into families, sorted", () => {
    const families = uniqueFontFamilies([
      { family: "SF Mono" },
      { family: "SF Mono" },
      { family: "Menlo" },
    ]);

    expect(families).toEqual(["Menlo", "SF Mono"]);
  });

  it("trims, and drops entries with no family at all", () => {
    expect(uniqueFontFamilies([{ family: "  Menlo " }, { family: "" }, { family: "   " }])).toEqual(
      ["Menlo"],
    );
  });

  it("sorts case-insensitively, so the list reads alphabetically", () => {
    expect(uniqueFontFamilies([{ family: "iosevka" }, { family: "Andale Mono" }])).toEqual([
      "Andale Mono",
      "iosevka",
    ]);
  });
});

describe("listLocalFontFamilies", () => {
  it("enumerates the installed families", async () => {
    vi.stubGlobal("queryLocalFonts", async () => [{ family: "Menlo" }, { family: "Menlo" }]);

    await expect(listLocalFontFamilies()).resolves.toEqual(["Menlo"]);
  });

  it("degrades to an empty list where the API does not exist", async () => {
    vi.stubGlobal("queryLocalFonts", undefined);

    await expect(listLocalFontFamilies()).resolves.toEqual([]);
  });

  it("degrades rather than throwing when the permission is refused", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("queryLocalFonts", () => Promise.reject(new Error("NotAllowedError")));

    // An unavailable font list is a degraded picker, not a failed mutation:
    // logged, never toasted, and the overlay file still takes any value.
    await expect(listLocalFontFamilies()).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
