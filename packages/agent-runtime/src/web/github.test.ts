/**
 * Which public URL a GitHub page is read from, decided without a socket.
 *
 * The server-backed half — that the rewritten URL is admitted, pinned and
 * reported — lives in `safe-fetch.test.ts`. This file pins the arithmetic.
 */

import { describe, expect, it } from "vite-plus/test";

import { githubDirectoryFor, githubHostFor, githubListing, githubRead } from "./github";

const PAGE = "https://github.com/acme/widgets/tree/main/src";

/** The trees API's answer for a directory holding these entries. */
function tree(entries: readonly unknown[], truncated = false): string {
  return JSON.stringify({ sha: "abc", url: "https://api.github.com/x", tree: entries, truncated });
}

/** A listing with room to spare, the way a whole read is bounded. */
function listed(json: string, after?: string, budget = 25_000) {
  return githubListing(json, { page: PAGE, after, budget });
}

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
      "https://api.github.com/repos/acme/widgets/git/trees/main",
      "https://github.com/acme/widgets/tree/main",
      undefined,
    ],
    [
      "https://github.com/acme/widgets/tree/main/",
      "https://api.github.com/repos/acme/widgets/git/trees/main",
      "https://github.com/acme/widgets/tree/main",
      undefined,
    ],
    [
      "https://github.com/acme/widgets/tree/v2/packages/core/src/?after=index.ts",
      "https://api.github.com/repos/acme/widgets/git/trees/v2:packages/core/src",
      "https://github.com/acme/widgets/tree/v2/packages/core/src",
      "index.ts",
    ],
  ])("lists the tree %s from %s", (treeUrl, api, page, after) => {
    expect(githubRead(new URL(treeUrl))).toEqual({ kind: "directory", href: api, page, after });
  });

  it("expects each rewrite's answer from the host it names", () => {
    const blob = githubRead(new URL("https://github.com/acme/widgets/blob/main/a.ts"));
    const directory = githubRead(new URL("https://github.com/acme/widgets/tree/main"));
    expect(blob && githubHostFor(blob)).toBe("raw.githubusercontent.com");
    expect(directory && githubHostFor(directory)).toBe("api.github.com");
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
  it("lists directories first, then files, each alphabetically, in git's words", () => {
    const json = tree([
      { path: "zeta.ts", mode: "100644", type: "blob", size: 10 },
      { path: "alpha", mode: "040000", type: "tree" },
      { path: "beta.ts", mode: "100755", type: "blob", size: 2048 },
      { path: "link", mode: "120000", type: "blob", size: 12 },
      { path: "vendor", mode: "160000", type: "commit" },
      { path: "gamma", mode: "040000", type: "tree" },
      { path: "odd", mode: "100644", type: "something-new-and-long" },
      { path: "sizeless.ts", mode: "100644", type: "blob" },
    ]);

    expect(listed(json)).toEqual({
      text: [
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
      cut: false,
    });
  });

  it("keeps every name on one line, so a filename cannot forge an entry", () => {
    const json = tree([{ path: "a\nfile       evil.ts\u0007", type: "blob", size: 1 }]);

    expect(listed(json)?.text).toBe(
      ["1 entry:", "file       a?file       evil.ts?  (1 bytes)"].join("\n"),
    );
  });

  it("drops entries that are not the shape a tree entry has", () => {
    const json = tree([null, 3, { path: 4, type: "blob" }, { path: "a" }, "b"]);

    expect(listed(json)).toEqual({ text: "This directory is empty.", cut: false });
  });

  it("says when GitHub's API sent only part of the tree", () => {
    expect(listed(tree([{ path: "a.ts", type: "blob", size: 1 }], true))).toEqual({
      text: [
        "1 entry:",
        "file       a.ts  (1 bytes)",
        "GitHub's API returned only part of this directory, because the whole tree is larger than it will send; entries past the last one here are missing.",
      ].join("\n"),
      cut: true,
    });
    expect(listed(tree([], true))?.cut).toBe(true);
  });

  describe("a directory too long for one read", () => {
    const entries = Array.from({ length: 3_000 }, (_, index) => ({
      path: `test-${String(index).padStart(4, "0")}.js`,
      type: "blob",
      size: index,
    }));

    it("stops on an entry boundary inside the bound and names the URL that continues it", () => {
      const first = listed(tree(entries));

      expect(first?.cut).toBe(true);
      expect(first?.text.length).toBeLessThanOrEqual(25_000);
      const lines = first?.text.split("\n") ?? [];
      const closing = lines.at(-1) ?? "";
      const lastShown = lines.at(-2) ?? "";
      expect(lines[0]).toBe("3000 entries:");
      expect(lastShown).toMatch(/^file {7}test-\d{4}\.js {2}\(\d+ bytes\)$/);
      const name = /test-\d{4}\.js/.exec(lastShown)?.[0] ?? "";
      expect(closing).toBe(
        `Listed ${lines.length - 2} of the 3000 entries from here; Volli's character bound cut the rest. Continue with ${PAGE}?after=${name}`,
      );
    });

    it("continues past the named entry until every entry has been listed once", () => {
      const seen: string[] = [];
      let after: string | undefined;
      for (let reads = 0; reads < 20; reads += 1) {
        const read = listed(tree(entries), after);
        const lines = read?.text.split("\n") ?? [];
        if (after !== undefined) {
          expect(lines[0]).toBe(`3000 entries; continuing after ${after}:`);
        }
        const names = lines
          .filter((line) => line.startsWith("file"))
          .map((line) => line.slice(11, 24));
        seen.push(...names);
        if (read?.cut !== true) break;
        after = decodeURIComponent(/\?after=(.+)$/.exec(lines.at(-1) ?? "")?.[1] ?? "");
      }

      expect(seen).toHaveLength(3_000);
      expect(new Set(seen).size).toBe(3_000);
    });
  });

  it("lists from the start, and says so, when the entry to continue after is not there", () => {
    const read = listed(tree([{ path: "a.ts", type: "blob", size: 1 }]), "gone.ts");

    expect(read?.text.split("\n")[0]).toBe(
      "1 entry; none is named gone.ts, so this lists from the start:",
    );
  });

  it("encodes the name it continues after, so the URL stays one URL", () => {
    const entries = [
      { path: "a b#c?.ts", type: "blob", size: 1 },
      { path: "z.ts", type: "blob", size: 1 },
    ];
    // Room for the heading and one line past the closing reserve, no more.
    const read = listed(tree(entries), undefined, 1_024 + 45);

    expect(read?.text.split("\n").at(-1)).toBe(
      `Listed 1 of the 2 entries from here; Volli's character bound cut the rest. Continue with ${PAGE}?after=a%20b%23c%3F.ts`,
    );
  });

  it("still names a way on when not even one entry fits", () => {
    const entries = [{ path: "a.ts", type: "blob", size: 1 }];

    expect(listed(tree(entries), undefined, 10)?.text.split("\n").at(-1)).toBe(
      `Listed 0 of the 1 entries from here; Volli's character bound cut the rest. Continue with ${PAGE}`,
    );
    expect(listed(tree(entries), "a.ts", 10)?.text.split("\n")[0]).toBe(
      "1 entry; continuing after a.ts:",
    );
    const two = [...entries, { path: "b.ts", type: "blob", size: 1 }];
    expect(listed(tree(two), "a.ts", 10)?.text.split("\n").at(-1)).toContain(
      `Continue with ${PAGE}?after=a.ts`,
    );
  });

  it.each([
    ["an array, as the contents API answers", '[{"name":"a.ts","type":"file"}]'],
    ["an object with no tree", '{"type":"file","name":"README.md"}'],
    ["JSON null", "null"],
    ["not JSON", "<html>rate limited</html>"],
  ])("declines %s, so the caller returns it as it came", (_label, body) => {
    expect(listed(body)).toBeUndefined();
  });
});
