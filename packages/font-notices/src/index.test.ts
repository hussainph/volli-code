import { describe, expect, it } from "vite-plus/test";

import {
  buildFontNotice,
  renderFontNoticeDocument,
  type FontNotice,
  type FontPackageSource,
} from "./index";

const DOCUMENT_OPTIONS = {
  siteName: "volli.app",
  projectLicenseUrl: "https://github.com/hussainph/volli-code/blob/main/LICENSE",
};

const LICENSE_TEXT = "Copyright 2026 The Acme Font Authors\n\nSIL OPEN FONT LICENSE\n";

function source(overrides: Partial<FontPackageSource> = {}): FontPackageSource {
  return {
    family: "Acme Font",
    packageName: "@acme/font",
    manifest: { version: "1.2.3", license: "OFL-1.1", homepage: "https://example.test/acme-font" },
    licenseText: LICENSE_TEXT,
    ...overrides,
  };
}

function notice(overrides: Partial<FontNotice> = {}): FontNotice {
  return {
    family: "Acme Font",
    packageName: "@acme/font",
    version: "1.2.3",
    license: "OFL-1.1",
    homepage: "https://example.test/acme-font",
    text: "Copyright 2026 The Acme Font Authors",
    ...overrides,
  };
}

describe("buildFontNotice", () => {
  it("takes version, license, homepage and license text from the package", () => {
    // Exact, not toMatchObject: a notice that silently loses a field is the
    // failure this whole module exists to prevent, so every field is pinned.
    expect(buildFontNotice(source())).toEqual({
      family: "Acme Font",
      packageName: "@acme/font",
      version: "1.2.3",
      license: "OFL-1.1",
      homepage: "https://example.test/acme-font",
      // Trimmed: the document supplies its own surrounding blank lines.
      text: "Copyright 2026 The Acme Font Authors\n\nSIL OPEN FONT LICENSE",
    });
  });

  it("reports no homepage rather than inventing one", () => {
    expect(buildFontNotice(source({ manifest: { version: "1.2.3", license: "OFL-1.1" } }))).toEqual(
      {
        family: "Acme Font",
        packageName: "@acme/font",
        version: "1.2.3",
        license: "OFL-1.1",
        homepage: null,
        text: "Copyright 2026 The Acme Font Authors\n\nSIL OPEN FONT LICENSE",
      },
    );
  });

  it.each([
    ["a non-string homepage", 42],
    ["a blank homepage", "   "],
  ])("ignores %s instead of printing it", (_label, homepage) => {
    expect(
      buildFontNotice(source({ manifest: { version: "1.2.3", license: "OFL-1.1", homepage } })),
    ).toMatchObject({ homepage: null });
  });

  it.each([
    ["null", null],
    ["an array", [{ version: "1.2.3", license: "OFL-1.1" }]],
    ["a string", '{"version":"1.2.3"}'],
    ["a number", 7],
  ])("throws when the manifest is %s rather than an object", (_label, manifest) => {
    expect(() => buildFontNotice(source({ manifest }))).toThrow(
      "@acme/font has no readable package.json to attribute.",
    );
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a number", 5],
    ["blank", "   "],
  ])("throws when version is %s, naming version and not license", (_label, version) => {
    expect(() => buildFontNotice(source({ manifest: { version, license: "OFL-1.1" } }))).toThrow(
      "@acme/font declares no version to attribute.",
    );
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a number", 5],
    ["blank", "   "],
  ])("throws when license is %s, naming license and not version", (_label, license) => {
    expect(() => buildFontNotice(source({ manifest: { version: "1.2.3", license } }))).toThrow(
      "@acme/font declares no license to attribute.",
    );
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   \n\t\n"],
  ])("throws on %s LICENSE text rather than publishing an empty notice", (_label, licenseText) => {
    expect(() => buildFontNotice(source({ licenseText }))).toThrow(
      "@acme/font ships an empty LICENSE file.",
    );
  });
});

describe("renderFontNoticeDocument", () => {
  // The whole document, byte for byte. Substring assertions pass on a document
  // whose license text has been folded into a heading, whose separators have
  // collapsed, or whose sections have run together — exactly the mangling that
  // would leave the published notice non-compliant while every `toContain`
  // still matched.
  it("renders the exact published document", () => {
    const rule = "=".repeat(78);

    expect(renderFontNoticeDocument([notice()], DOCUMENT_OPTIONS)).toBe(
      [
        "Third-party font notices for volli.app",
        "",
        "This site serves the fonts below from its own origin, so each deploy",
        "redistributes their font software. The copyright notice and full license",
        "text for every one of them follow, as their licenses require.",
        "",
        "Nothing here covers the rest of the site: Volli Code itself is licensed",
        "under Apache-2.0 (https://github.com/hussainph/volli-code/blob/main/LICENSE).",
        "",
        "Generated from the installed font packages at build time, never edited by",
        "hand, so it cannot drift from what the build actually ships.",
        "",
        rule,
        "Acme Font (@acme/font 1.2.3)",
        "SPDX-License-Identifier: OFL-1.1",
        "Upstream: https://example.test/acme-font",
        rule,
        "",
        "Copyright 2026 The Acme Font Authors",
        "",
      ].join("\n"),
    );
  });

  it("names the site it was rendered for, and changes nothing else", () => {
    const forDocs = renderFontNoticeDocument([notice()], {
      ...DOCUMENT_OPTIONS,
      siteName: "docs.volli.app",
    });
    const forWebsite = renderFontNoticeDocument([notice()], DOCUMENT_OPTIONS);

    expect(forDocs.split("\n")[0]).toBe("Third-party font notices for docs.volli.app");
    // The site name is a heading, not a substitution applied through the body.
    expect(forDocs.split("\n").slice(1)).toEqual(forWebsite.split("\n").slice(1));
  });

  it("omits the upstream line, and only that line, when no homepage is named", () => {
    const withHomepage = renderFontNoticeDocument([notice()], DOCUMENT_OPTIONS);
    const without = renderFontNoticeDocument([notice({ homepage: null })], DOCUMENT_OPTIONS);

    expect(without).not.toContain("Upstream:");
    expect(without).toBe(withHomepage.replace("Upstream: https://example.test/acme-font\n", ""));
  });

  it("keeps each font in its own fenced section, in the order given", () => {
    const document = renderFontNoticeDocument(
      [
        notice(),
        notice({
          family: "Other Font",
          packageName: "@acme/other",
          version: "2.0.0",
          homepage: null,
          text: "Copyright 2026 The Other Font Authors",
        }),
      ],
      DOCUMENT_OPTIONS,
    );

    const rule = "=".repeat(78);
    // Four rules: an opening and closing fence around each of the two headings.
    expect(document.split(`\n${rule}\n`)).toHaveLength(5);
    expect(document.indexOf("Acme Font (@acme/font 1.2.3)")).toBeLessThan(
      document.indexOf("Other Font (@acme/other 2.0.0)"),
    );
    // Each license body sits after its own heading, not merged into one block.
    expect(document).toContain(
      `${rule}\n\nCopyright 2026 The Acme Font Authors\n\n${rule}\nOther Font`,
    );
    expect(document.endsWith("Copyright 2026 The Other Font Authors\n")).toBe(true);
  });

  it("refuses to publish a notice page with no notices on it", () => {
    expect(() => renderFontNoticeDocument([], DOCUMENT_OPTIONS)).toThrow(
      "No font notices to publish for volli.app.",
    );
  });

  it("cites the package and version the dist gate greps for", () => {
    // The gate in check-dist.mjs looks for the literal `<package> <version>`.
    // It shares no code with this renderer on purpose, so this is the one place
    // the two formats are held to the same shape.
    const document = renderFontNoticeDocument([notice()], DOCUMENT_OPTIONS);

    expect(document).toContain("@acme/font 1.2.3");
  });
});
