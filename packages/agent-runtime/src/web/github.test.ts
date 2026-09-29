/**
 * Which public URL a GitHub page is read from, decided without a socket.
 *
 * The server-backed half — that the rewritten URL is admitted, pinned and
 * reported — lives in `safe-fetch.test.ts`. This file pins the arithmetic.
 */

import { describe, expect, it } from "vite-plus/test";

import { githubDirectoryFor, githubListing, githubRead } from "./github";

describe("githubRead", () => {
  it.each([
    [
      "https://github.com/acme/widgets/blob/main/src/index.ts",
      "https://raw.githubusercontent.com/acme/widgets/main/src/index.ts",
    ],
    [
      "https://www.github.com/acme/widgets/blob/v1.2.0/README.md",
      "https://raw.githubusercontent.com/acme/widgets/v1.2.0/README.md",
    ],
    // A slash in a branch name stays in place: raw.githubusercontent.com
    // resolves `<ref>/<path>` itself.
    [
      "https://github.com/acme/widgets/blob/feature/x/src/a.ts",
      "https://raw.githubusercontent.com/acme/widgets/feature/x/src/a.ts",
    ],
    // Percent-encoding is carried through as it was spelled, and the query
    // (`?plain=1`) and fragment (`#L10`) are about the page, not the file.
    [
      "https://github.com/acme/widgets/blob/main/docs/a%20b.md?plain=1#L10",
      "https://raw.githubusercontent.com/acme/widgets/main/docs/a%20b.md",
    ],
  ])("reads the blob %s as %s", (page, raw) => {
    expect(githubRead(new URL(page))).toEqual({ kind: "raw-file", href: raw });
  });

  it.each([
    [
      "https://github.com/acme/widgets/tree/main",
      "https://api.github.com/repos/acme/widgets/contents?ref=main",
    ],
    [
      "https://github.com/acme/widgets/tree/main/",
      "https://api.github.com/repos/acme/widgets/contents?ref=main",
    ],
    [
      "https://github.com/acme/widgets/tree/v2/packages/core/src/",
      "https://api.github.com/repos/acme/widgets/contents/packages/core/src?ref=v2",
    ],
  ])("lists the tree %s from %s", (page, api) => {
    expect(githubRead(new URL(page))).toEqual({ kind: "directory", href: api });
  });

  it.each([
    "https://github.com/",
    "https://github.com/acme",
    "https://github.com/acme/widgets",
    "https://github.com/acme/widgets/",
    "https://github.com/acme/widgets/issues/12",
    "https://github.com/acme/widgets/pull/7/files",
    // A blob with no path names no file.
    "https://github.com/acme/widgets/blob/main",
    "https://github.com/acme/widgets/blob/main/",
    "https://github.com//widgets/blob/main/a.ts",
    "https://github.com/acme//blob/main/a.ts",
    "https://github.com/acme/widgets/tree//src",
    // Only github.com's own pages, and only over https.
    "http://github.com/acme/widgets/blob/main/a.ts",
    "https://gist.github.com/acme/widgets/blob/main/a.ts",
    "https://raw.githubusercontent.com/acme/widgets/main/a.ts",
    "https://example.com/acme/widgets/blob/main/a.ts",
  ])("leaves %s to be read as the page it is", (page) => {
    expect(githubRead(new URL(page))).toBeUndefined();
  });
});

describe("githubDirectoryFor", () => {
  it.each([
    [
      "https://raw.githubusercontent.com/acme/widgets/main/src/lib/a.ts",
      "https://github.com/acme/widgets/tree/main/src/lib",
    ],
    [
      "https://raw.githubusercontent.com/acme/widgets/main/README.md",
      "https://github.com/acme/widgets/tree/main",
    ],
    [
      "https://github.com/acme/widgets/blob/main/src/a.ts",
      "https://github.com/acme/widgets/tree/main/src",
    ],
    [
      "https://github.com/acme/widgets/tree/main/src/missing",
      "https://github.com/acme/widgets/tree/main/src",
    ],
  ])("points %s at %s", (url, directory) => {
    expect(githubDirectoryFor(new URL(url))).toBe(directory);
  });

  it.each([
    "https://raw.githubusercontent.com/acme/widgets/main",
    "https://raw.githubusercontent.com/acme",
    "https://github.com/acme/widgets/issues/12",
    "https://github.com/acme/widgets/tree/main",
    "https://github.com/acme",
    "https://docs.example.com/a/b/c/d",
  ])("has nothing to point %s at", (url) => {
    expect(githubDirectoryFor(new URL(url))).toBeUndefined();
  });
});

describe("githubListing", () => {
  it("lists directories first, then files, each alphabetically, with sizes", () => {
    const json = JSON.stringify([
      { name: "zeta.ts", type: "file", size: 10 },
      { name: "alpha", type: "dir", size: 0 },
      { name: "beta.ts", type: "file", size: 2048 },
      { name: "link", type: "symlink", size: 12 },
      { name: "vendor", type: "submodule", size: 0 },
      { name: "gamma", type: "dir" },
      { name: "odd", type: "something-new-and-long" },
      { name: "sizeless.ts", type: "file" },
    ]);

    expect(githubListing(json)).toBe(
      [
        "8 entries:",
        "dir        alpha/",
        "dir        gamma/",
        "file       beta.ts  (2048 bytes)",
        "symlink    link",
        "something- odd",
        "file       sizeless.ts",
        "submodule  vendor",
        "file       zeta.ts  (10 bytes)",
      ].join("\n"),
    );
  });

  it("keeps every name on one line, so a filename cannot forge an entry", () => {
    const json = JSON.stringify([{ name: "a\nfile       evil.ts\u0007", type: "file", size: 1 }]);

    expect(githubListing(json)).toBe(
      ["1 entry:", "file       a?file       evil.ts?  (1 bytes)"].join("\n"),
    );
  });

  it("drops entries that are not the shape a listing has", () => {
    const json = JSON.stringify([null, 3, { name: 4, type: "file" }, { name: "a" }, "b"]);

    expect(githubListing(json)).toBe("This directory is empty.");
  });

  it.each([
    ["an object", '{"type":"file","name":"README.md"}'],
    ["not JSON", "<html>rate limited</html>"],
  ])("declines %s, so the caller returns it as it came", (_label, body) => {
    expect(githubListing(body)).toBeUndefined();
  });
});
