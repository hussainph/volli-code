import { existsSync, promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { checkApp, checkApps, sourceFileNames } from "./check-dist.mjs";

/*
 * Tests for the release gate itself.
 *
 * The gate is the only thing standing between a font binary and a deploy that
 * redistributes it with no license, so "it passed" is worth nothing unless it
 * can be shown to FAIL. Each case below builds a real app directory in a temp
 * dir — manifest, node_modules, dist — and asserts the verdict.
 */

const FONT_PACKAGE = "@fontsource-variable/mona-sans";
const LICENSE_TEXT = "Copyright 2022 The Mona Sans Project Authors\n\nSIL OPEN FONT LICENSE v1.1";
const SHIPPED_FONTS = ["mona-sans-latin-wght-normal.woff2", "mona-sans-latin-wght-italic.woff2"];

let root;

/** A notice that satisfies the gate, so each test can mutate one thing. */
function goodNotice({ version = "5.3.0", licenseText = LICENSE_TEXT } = {}) {
  return `Third-party font notices\n\n${FONT_PACKAGE} ${version}\n\n${licenseText}\n`;
}

async function writeFile(path, contents) {
  await fs.mkdir(join(path, ".."), { recursive: true });
  await fs.writeFile(path, contents);
}

/**
 * Builds an app directory the gate can read: a manifest declaring the font
 * package, that package installed under node_modules with the font files it
 * really ships, and a dist/.
 */
async function makeApp({
  name = "app",
  dependencies = { [FONT_PACKAGE]: "5.3.0" },
  installed = { version: "5.3.0", licenseText: LICENSE_TEXT, files: SHIPPED_FONTS },
  dist = { fonts: ["_astro/mona-sans-latin-wght-normal.Pz49MTQZ.woff2"], notice: goodNotice() },
} = {}) {
  const appDir = join(root, name);
  await writeFile(join(appDir, "package.json"), JSON.stringify({ name, dependencies }));

  if (installed !== null) {
    const packageDir = join(appDir, "node_modules", ...FONT_PACKAGE.split("/"));
    // No `exports` map, so Node resolves every subpath the gate asks for.
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: FONT_PACKAGE, version: installed.version }),
    );
    await writeFile(join(packageDir, "LICENSE"), `${installed.licenseText}\n`);
    for (const file of installed.files) await writeFile(join(packageDir, "files", file), "font");
  }

  if (dist !== null) {
    await fs.mkdir(join(appDir, "dist"), { recursive: true });
    for (const file of dist.fonts) await writeFile(join(appDir, "dist", file), "font");
    if (dist.notice !== null) await writeFile(join(appDir, "dist", "licenses.txt"), dist.notice);
  }

  return appDir;
}

/**
 * Resolves package subpaths inside one app's own node_modules.
 *
 * The gate's real resolver is `createRequire`, but a test runner rewrites that
 * to resolve from the runner's project root — under vitest a "missing" package
 * would silently resolve to the repo's real Mona Sans, and the not-installed
 * case could never be written. This reads the temp app and nothing else.
 */
function resolverFor(appDir) {
  return (specifier) => {
    const segments = specifier.split("/");
    const packageName = segments.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
    const subpath = specifier.slice(packageName.length + 1);
    const path = join(appDir, "node_modules", ...packageName.split("/"), subpath);

    if (!existsSync(path)) throw new Error(`Cannot find module '${specifier}'`);
    return path;
  };
}

const check = (appDir) => checkApp(appDir, { cwd: root, resolverFor });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "font-notices-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("checkApp", () => {
  it("passes a site whose notice cites the font it ships", async () => {
    const result = await check(await makeApp());

    expect(result.failures).toEqual([]);
    expect(result.note).toContain("1 font file(s), 1 package(s) attributed");
  });

  it("reports against the workspace package name, not the path it was invoked with", async () => {
    // Each site runs this as `check-font-notices .`; a CI log saying "." does
    // not say which site is out of compliance.
    const result = await checkApp(".", { cwd: await makeApp({ name: "site" }), resolverFor });

    expect(result.label).toBe("site");
    expect(result.note).toMatch(/^site:/);
  });

  it("fails when the site was never built", async () => {
    const result = await check(await makeApp({ dist: null }));

    expect(result.failures).toEqual([expect.stringContaining("no dist/ to check")]);
    expect(result.note).toBeNull();
  });

  it("fails when the app directory has no manifest", async () => {
    const result = await check(join(root, "nowhere"));

    expect(result.failures).toEqual([expect.stringContaining("no readable package.json")]);
  });

  it("says nothing is owed when dist/ ships no fonts", async () => {
    const result = await check(await makeApp({ dist: { fonts: [], notice: null } }));

    expect(result.failures).toEqual([]);
    expect(result.note).toContain("no font binaries in dist/");
  });

  it("fails when fonts shipped with no notice at all", async () => {
    const result = await check(
      await makeApp({
        dist: { fonts: ["_astro/mona-sans-latin-wght-normal.Pz49MTQZ.woff2"], notice: null },
      }),
    );

    expect(result.failures).toEqual([
      expect.stringContaining("ships 1 font file(s) but no licenses.txt"),
    ]);
  });

  it("treats a blank notice as no notice", async () => {
    const result = await check(
      await makeApp({
        dist: { fonts: ["_astro/mona-sans-latin-wght-normal.Pz49MTQZ.woff2"], notice: "  \n\n" },
      }),
    );

    expect(result.failures).toEqual([expect.stringContaining("but no licenses.txt")]);
  });

  it("fails when the notice cites a stale version of the font package", async () => {
    // The realistic drift: the dependency was bumped and the published notice
    // was not rebuilt, so it attributes software the site no longer ships.
    const result = await check(
      await makeApp({ dist: { fonts: SHIPPED_FONTS, notice: goodNotice({ version: "5.2.9" }) } }),
    );

    // The installed version is what must be cited, not whatever the notice says.
    expect(result.failures).toEqual([
      expect.stringContaining(`licenses.txt does not cite ${FONT_PACKAGE} 5.3.0.`),
    ]);
  });

  it("fails when the notice cites the package but drops the license text", async () => {
    const result = await check(
      await makeApp({
        dist: {
          fonts: SHIPPED_FONTS,
          notice: `${FONT_PACKAGE} 5.3.0\n\nsee the upstream repository for terms\n`,
        },
      }),
    );

    expect(result.failures).toEqual([
      expect.stringContaining("does not carry the full LICENSE text"),
    ]);
  });

  it("fails when a truncated license text is passed off as the whole license", async () => {
    const result = await check(
      await makeApp({
        dist: {
          fonts: SHIPPED_FONTS,
          notice: goodNotice({ licenseText: LICENSE_TEXT.slice(0, 40) }),
        },
      }),
    );

    expect(result.failures).toEqual([
      expect.stringContaining("does not carry the full LICENSE text"),
    ]);
  });

  it("fails when the declared font package is not installed", async () => {
    const result = await check(await makeApp({ installed: null }));

    // One fault, named once: with the package unreadable the gate cannot know
    // which files it owns, so it does not also cry "unattributed font".
    expect(result.failures).toEqual([
      expect.stringContaining(`cannot read ${FONT_PACKAGE}'s package.json and LICENSE`),
    ]);
  });

  it("accepts the content hash Astro inserts before the extension", async () => {
    const result = await check(
      await makeApp({
        dist: {
          fonts: [
            "_astro/mona-sans-latin-wght-normal.Pz49MTQZ.woff2",
            "_astro/mona-sans-latin-wght-italic.DsUdksa4.woff2",
          ],
          notice: goodNotice(),
        },
      }),
    );

    expect(result.failures).toEqual([]);
  });

  it("accepts an unhashed font file", async () => {
    const result = await check(
      await makeApp({
        dist: { fonts: ["fonts/mona-sans-latin-wght-normal.woff2"], notice: goodNotice() },
      }),
    );

    expect(result.failures).toEqual([]);
  });

  it("fails an unattributed family whose name merely starts with an attributed one", async () => {
    // The regression this gate was rewritten for. A prefix test would read
    // `mona-sans-expanded-…` as covered by `@fontsource-variable/mona-sans`
    // and let a second, differently licensed family deploy unattributed.
    const result = await check(
      await makeApp({
        dist: {
          fonts: [
            "_astro/mona-sans-latin-wght-normal.Pz49MTQZ.woff2",
            "_astro/mona-sans-expanded-latin-wght-normal.AbC12345.woff2",
          ],
          notice: goodNotice(),
        },
      }),
    );

    expect(result.failures).toEqual([
      expect.stringContaining("1 font file(s) in dist/ are not covered"),
    ]);
    expect(result.failures[0]).toContain("mona-sans-expanded-latin-wght-normal");
  });

  it("fails a font that came from outside the declared packages entirely", async () => {
    const result = await check(
      await makeApp({
        dist: { fonts: ["fonts/ProprietaryFace-Bold.woff2"], notice: goodNotice() },
      }),
    );

    expect(result.failures).toEqual([expect.stringContaining("are not covered by licenses.txt")]);
  });

  it("ignores non-font files in dist/", async () => {
    const appDir = await makeApp();
    await writeFile(join(appDir, "dist", "index.html"), "<html></html>");
    await writeFile(join(appDir, "dist", "_astro", "index.css"), "body{}");

    expect((await check(appDir)).failures).toEqual([]);
  });

  it("ignores non-font dependencies when deciding what must be attributed", async () => {
    const result = await check(
      await makeApp({ dependencies: { astro: "7.2.8", [FONT_PACKAGE]: "5.3.0" } }),
    );

    expect(result.failures).toEqual([]);
    expect(result.note).toContain("1 package(s) attributed");
  });
});

describe("checkApps", () => {
  it("reports every app rather than stopping at the first failure", async () => {
    await makeApp({ name: "good" });
    await makeApp({ name: "bad", dist: { fonts: SHIPPED_FONTS, notice: null } });

    const { failures, notes } = await checkApps(["good", "bad"], { cwd: root, resolverFor });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^bad:/);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^good:/);
  });
});

describe("sourceFileNames", () => {
  it.each([
    ["mona-sans-latin-wght-normal.woff2", ["mona-sans-latin-wght-normal.woff2"]],
    [
      "mona-sans-latin-wght-normal.Pz49MTQZ.woff2",
      ["mona-sans-latin-wght-normal.Pz49MTQZ.woff2", "mona-sans-latin-wght-normal.woff2"],
    ],
    ["face.v2.HASH1234.woff2", ["face.v2.HASH1234.woff2", "face.v2.woff2"]],
  ])("maps %s back to its source name", (distName, expected) => {
    expect(sourceFileNames(distName)).toEqual(expected);
  });
});
