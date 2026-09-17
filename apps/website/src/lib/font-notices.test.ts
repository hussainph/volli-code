import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  REDISTRIBUTED_FONT_PACKAGES,
  collectFontNotices,
  readFontNotice,
  renderFontNoticeDocument,
  type FontNotice,
  type PackageFileReader,
} from "./font-notices";

const DOCUMENT_OPTIONS = {
  siteName: "volli.app",
  projectLicenseUrl: "https://github.com/hussainph/volli-code/blob/main/LICENSE",
};

/** A stand-in package: a manifest and a LICENSE, addressed the way Node would. */
function fakeReader(files: Record<string, string>): PackageFileReader {
  return (specifier) => {
    const contents = files[specifier];
    if (contents === undefined) throw new Error(`unexpected read: ${specifier}`);
    return contents;
  };
}

function fakePackage(overrides: Record<string, unknown> = {}): Record<string, string> {
  return {
    "@acme/font/package.json": JSON.stringify({
      version: "1.2.3",
      license: "OFL-1.1",
      homepage: "https://example.test/acme-font",
      ...overrides,
    }),
    "@acme/font/LICENSE": "Copyright 2026 The Acme Font Authors\n\nSIL OPEN FONT LICENSE\n",
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

describe("readFontNotice", () => {
  it("takes version, license, homepage and license text from the package", () => {
    const result = readFontNotice(
      { family: "Acme Font", packageName: "@acme/font" },
      fakeReader(fakePackage()),
    );

    expect(result).toEqual({
      family: "Acme Font",
      packageName: "@acme/font",
      version: "1.2.3",
      license: "OFL-1.1",
      homepage: "https://example.test/acme-font",
      // Trimmed: the notice supplies its own surrounding blank lines.
      text: "Copyright 2026 The Acme Font Authors\n\nSIL OPEN FONT LICENSE",
    });
  });

  it("reports no homepage rather than inventing one", () => {
    const files = fakePackage();
    files["@acme/font/package.json"] = JSON.stringify({ version: "1.2.3", license: "OFL-1.1" });

    expect(
      readFontNotice({ family: "Acme Font", packageName: "@acme/font" }, fakeReader(files)),
    ).toMatchObject({ homepage: null });
  });

  it("throws when the package declares no version or license", () => {
    for (const manifest of [{ version: "1.2.3" }, { license: "OFL-1.1" }]) {
      const files = fakePackage();
      files["@acme/font/package.json"] = JSON.stringify(manifest);

      expect(() =>
        readFontNotice({ family: "Acme Font", packageName: "@acme/font" }, fakeReader(files)),
      ).toThrow(/no version and license/);
    }
  });

  it("throws on an empty LICENSE rather than publishing an empty notice", () => {
    const files = fakePackage();
    files["@acme/font/LICENSE"] = "   \n";

    expect(() =>
      readFontNotice({ family: "Acme Font", packageName: "@acme/font" }, fakeReader(files)),
    ).toThrow(/empty LICENSE/);
  });
});

describe("collectFontNotices", () => {
  it("reads the real installed Mona Sans package by default", () => {
    // Not a fixture: this is the evidence that the published notice carries the
    // OFL text and copyright line of the font the build actually emits.
    const notices = collectFontNotices();

    expect(notices).toHaveLength(REDISTRIBUTED_FONT_PACKAGES.length);
    const [monaSans] = notices;
    expect(monaSans.family).toBe("Mona Sans");
    expect(monaSans.packageName).toBe("@fontsource-variable/mona-sans");
    expect(monaSans.license).toBe("OFL-1.1");
    expect(monaSans.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(monaSans.text).toContain("Copyright 2022 The Mona Sans Project Authors");
    expect(monaSans.text).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(monaSans.text).toContain("PERMISSION & CONDITIONS");
  });

  it("reads each package it is given", () => {
    const notices = collectFontNotices(
      [{ family: "Acme Font", packageName: "@acme/font" }],
      fakeReader(fakePackage()),
    );

    expect(notices.map((entry) => entry.packageName)).toEqual(["@acme/font"]);
  });
});

describe("renderFontNoticeDocument", () => {
  it("states the site, the project license, and every font's full notice", () => {
    const document = renderFontNoticeDocument([notice()], DOCUMENT_OPTIONS);

    expect(document).toContain("Third-party font notices for volli.app");
    expect(document).toContain(DOCUMENT_OPTIONS.projectLicenseUrl);
    expect(document).toContain("Acme Font — @acme/font 1.2.3");
    expect(document).toContain("SPDX-License-Identifier: OFL-1.1");
    expect(document).toContain("Upstream: https://example.test/acme-font");
    expect(document).toContain("Copyright 2026 The Acme Font Authors");
    expect(document.endsWith("\n")).toBe(true);
  });

  it("omits the upstream line when the package names no homepage", () => {
    const document = renderFontNoticeDocument([notice({ homepage: null })], DOCUMENT_OPTIONS);

    expect(document).not.toContain("Upstream:");
    expect(document).toContain("Acme Font — @acme/font 1.2.3");
  });

  it("keeps each font's notice separate", () => {
    const document = renderFontNoticeDocument(
      [
        notice(),
        notice({
          family: "Other Font",
          packageName: "@acme/other",
          version: "2.0.0",
          text: "Copyright 2026 The Other Font Authors",
        }),
      ],
      DOCUMENT_OPTIONS,
    );

    expect(document).toContain("Acme Font — @acme/font 1.2.3");
    expect(document).toContain("Other Font — @acme/other 2.0.0");
    expect(document).toContain("Copyright 2026 The Other Font Authors");
  });
});

/** Drops comment-only and blank lines, leaving just the code. */
function code(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !/^(\/\/|\/\*|\*)/.test(trimmed);
    })
    .join("\n");
}

/**
 * The docs site carries a copy of this module's code, because the two Astro
 * projects share no build and neither would otherwise depend on a workspace
 * package. Duplication is the deliberate choice; silent DRIFT is the thing that
 * would make it a bad one — the docs copy has no test runner of its own, so a
 * fix landed here and forgotten there would go unnoticed until a deploy
 * published a wrong notice.
 *
 * Comment lines are excluded from the comparison: each copy names its own site
 * and its own entry point, which is prose that should differ. Everything that
 * executes must not.
 */
describe("the docs copy of this module", () => {
  const DOCS_MODULE = new URL("../../../docs/src/lib/font-notices.ts", import.meta.url);

  it("exists, and its code is identical to this one", () => {
    const docs = readFileSync(DOCS_MODULE, "utf8");
    const website = readFileSync(new URL("./font-notices.ts", import.meta.url), "utf8");

    expect(code(docs)).toBe(code(website));
  });

  it("attributes the same font packages", () => {
    const docs = readFileSync(DOCS_MODULE, "utf8");

    for (const font of REDISTRIBUTED_FONT_PACKAGES) {
      expect(docs).toContain(`packageName: "${font.packageName}"`);
    }
  });
});
