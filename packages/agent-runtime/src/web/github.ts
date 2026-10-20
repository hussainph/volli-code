/**
 * Reading GitHub the way code research actually needs it.
 *
 * A `github.com/<owner>/<repo>/blob/<ref>/<path>` URL names one file, but what
 * github.com serves for it is an application page whose file is a minority of
 * its bytes, and a `tree` URL names a directory whose listing is rendered by
 * scripts Volli does not run. Both are the URLs a model has in hand — they are
 * what search results and READMEs link to — and failing them was one of the
 * main reasons models reached for `curl` and `urllib` instead of `web_fetch`.
 *
 * So both are read from where GitHub keeps the same content as text: a blob
 * from `raw.githubusercontent.com`, a tree from the git trees API. This is a
 * rewrite of *which public URL is read*, never a relaxation of how: the
 * rewritten URL goes through admission, address classification and pinning
 * exactly like any other, and the result names both the URL that was asked for
 * and the one that answered. Only an answer from the host a rewrite expected is
 * treated as GitHub's: if the rewritten URL redirects somewhere else, what comes
 * back is reported as an ordinary redirect and returned as it was served.
 *
 * Pure: nothing here opens a socket.
 */

/** How a GitHub page URL is read instead of as a page. */
export type GithubRead =
  /** A `blob` page, read as the raw file it shows. */
  | { kind: "raw-file"; href: string }
  /**
   * A `tree` page, read as the git trees API's listing of that directory.
   * `page` is the tree URL without its query, which a listing too long for one
   * read names again to continue; `after` is the entry a continuation resumes
   * past.
   */
  | { kind: "directory"; href: string; page: string; after: string | undefined };

/** The hosts that serve github.com's pages. */
const GITHUB_PAGE_HOSTS: ReadonlySet<string> = new Set(["github.com", "www.github.com"]);

/** The one host whose JSON answers are GitHub's REST API. */
export const GITHUB_API_HOST = "api.github.com";

/** The one host that serves a repository's files as they are. */
export const GITHUB_RAW_HOST = "raw.githubusercontent.com";

/** The host a rewrite expects its answer from; anything else is not GitHub's. */
export function githubHostFor(read: GithubRead): string {
  return read.kind === "raw-file" ? GITHUB_RAW_HOST : GITHUB_API_HOST;
}

/**
 * The owner, repository, view, ref and path a github.com URL spells, if it
 * spells one.
 *
 * Segments stay percent-encoded as the URL parser left them, so a path with a
 * space or a `#` in a filename reaches the rewritten URL spelled exactly as it
 * was in the one that was asked for.
 */
function githubParts(
  url: URL,
): { owner: string; repo: string; view: string; ref: string; path: string[] } | undefined {
  if (url.protocol !== "https:" || !GITHUB_PAGE_HOSTS.has(url.hostname)) return undefined;
  const segments = url.pathname.split("/").slice(1);
  // Owner, repository, view and ref are the least any of these URLs spells.
  if (segments.length < 4) return undefined;
  const [owner, repo, view, ref, ...path] = segments as [
    string,
    string,
    string,
    string,
    ...string[],
  ];
  if (owner === "" || repo === "" || ref === "") return undefined;
  // A trailing slash is a directory spelled politely, not an empty filename.
  const trimmed = path.at(-1) === "" ? path.slice(0, -1) : path;
  return { owner, repo, view, ref, path: trimmed };
}

/**
 * Where to read a github.com URL from, or nothing when it is an ordinary page.
 *
 * A ref containing a slash (`feature/x`) is ambiguous in both URL shapes, and
 * the two readers settle it differently: `raw.githubusercontent.com` resolves
 * `<ref>/<path>` itself, so a blob keeps the whole remainder; the trees API is
 * asked for `<ref>:<path>`, so a tree reads its first segment as the ref —
 * which is every branch and tag name without a slash in it.
 *
 * The git trees API rather than the contents API because the contents API
 * stops at 1,000 entries without saying so, and spends about five hundred
 * characters of JSON on each; the trees API lists up to 100,000 entries, says
 * when it stopped, and is a third of the size. `?after=<name>` on a tree URL is
 * Volli's continuation, which GitHub's own page ignores: it lists the entries
 * past that one, for a directory whose listing did not fit in one read.
 */
export function githubRead(url: URL): GithubRead | undefined {
  const parts = githubParts(url);
  if (parts === undefined) return undefined;
  const { owner, repo, view, ref, path } = parts;
  if (view === "blob" && path.length > 0) {
    return {
      kind: "raw-file",
      href: `https://${GITHUB_RAW_HOST}/${owner}/${repo}/${ref}/${path.join("/")}`,
    };
  }
  if (view === "tree") {
    const tree = path.length === 0 ? ref : `${ref}:${path.join("/")}`;
    const directory = path.length === 0 ? "" : `/${path.join("/")}`;
    return {
      kind: "directory",
      href: `https://${GITHUB_API_HOST}/repos/${owner}/${repo}/git/trees/${tree}`,
      page: `https://github.com/${owner}/${repo}/tree/${ref}${directory}`,
      after: url.searchParams.get("after") ?? undefined,
    };
  }
  return undefined;
}

/**
 * The tree URL of the directory holding a GitHub file, for a 404 to point at.
 *
 * Built from the URL the caller asked for — never from anything a server said —
 * so it is the caller's own owner, repository and ref handed back, arranged as
 * the one URL that shows which files actually exist there.
 */
export function githubDirectoryFor(url: URL): string | undefined {
  let owner: string | undefined;
  let repo: string | undefined;
  let ref: string | undefined;
  let path: string[];
  if (url.hostname === GITHUB_RAW_HOST) {
    [owner, repo, ref, ...path] = url.pathname.split("/").slice(1);
  } else {
    const parts = githubParts(url);
    if (parts === undefined || (parts.view !== "blob" && parts.view !== "tree")) return undefined;
    ({ owner, repo, ref, path } = parts);
  }
  if (owner === undefined || repo === undefined || ref === undefined || path.length === 0) {
    return undefined;
  }
  const parent = path.slice(0, -1);
  const directory = parent.length === 0 ? "" : `/${parent.join("/")}`;
  return `https://github.com/${owner}/${repo}/tree/${ref}${directory}`;
}

/** One entry of a git tree, as far as a listing reads it. */
interface TreeEntry {
  name: string;
  /** `dir`, `file`, `symlink`, `submodule`, or git's own word for anything newer. */
  type: string;
  size: number | undefined;
}

/**
 * One name from the listing, kept to one line.
 *
 * A git path may legally hold a newline, and a listing whose shape a filename
 * can redraw is a listing that can forge entries. Control characters become
 * `?`, which is what `ls` shows for them too.
 */
function oneLine(name: string): string {
  // Character by character, as `markdown-preview-html.ts` does, rather than a
  // regex class holding control characters — the thing `no-control-regex`
  // exists to question.
  return [...name]
    .map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? "?" : ch))
    .join("");
}

/** git's object type and mode, in the words a directory listing uses. */
function entryType(type: string, mode: unknown): string {
  if (type === "tree") return "dir";
  if (type === "commit") return "submodule";
  if (type === "blob") return mode === "120000" ? "symlink" : "file";
  return type;
}

function entryOf(value: unknown): TreeEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { path, type, mode, size } = value as Record<string, unknown>;
  if (typeof path !== "string" || typeof type !== "string") return undefined;
  return {
    name: path,
    type: entryType(type, mode),
    size: typeof size === "number" ? size : undefined,
  };
}

function rank(entry: TreeEntry): number {
  return entry.type === "dir" ? 0 : 1;
}

/** Directories first, then files, each alphabetical — the order a person scans. */
function listingOrder(a: TreeEntry, b: TreeEntry): number {
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

function entryLine(entry: TreeEntry): string {
  const name = oneLine(entry.name);
  switch (entry.type) {
    case "dir":
      return `dir        ${name}/`;
    case "file":
      return `file       ${name}${entry.size === undefined ? "" : `  (${entry.size} bytes)`}`;
    default:
      return `${oneLine(entry.type).slice(0, 10).padEnd(10)} ${name}`;
  }
}

/**
 * Room kept for the lines that close a listing, so they always fit: the
 * continuation line names the tree URL and one filename, and a filename is at
 * most 255 bytes in every filesystem git runs on.
 */
const CLOSING_CHARS = 1_024;

/** What a listing is read against: where to continue it, where it resumes, and its bound. */
export interface GithubListingOptions {
  /** The tree URL, without a query, that a continuation names. */
  page: string;
  /** The entry this read resumes past, from `?after=`. */
  after: string | undefined;
  /** The most characters the listing may hold, closing lines included. */
  budget: number;
}

/**
 * The trees API's JSON for one directory, as a listing a reader can scan.
 *
 * Complete or saying exactly how it is not. Entries are cut on a line
 * boundary before the character bound rather than mid-name, and a cut listing
 * ends with the tree URL that continues it; a tree GitHub's own API returned
 * only part of says so, and `cut` says whether either happened, so the caller
 * can state it in its own voice as well. `undefined` when the JSON is not a
 * tree at all, and the caller then returns what GitHub sent as it was.
 */
export function githubListing(
  json: string,
  options: GithubListingOptions,
): { text: string; cut: boolean } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { tree, truncated } = parsed as Record<string, unknown>;
  if (!Array.isArray(tree)) return undefined;

  const entries = tree
    .map(entryOf)
    .filter((entry) => entry !== undefined)
    .toSorted(listingOrder);
  const total = `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;
  const incomplete =
    truncated === true
      ? [
          "GitHub's API returned only part of this directory, because the whole tree is larger than it will send; entries past the last one here are missing.",
        ]
      : [];
  if (entries.length === 0) {
    return {
      text: ["This directory is empty.", ...incomplete].join("\n"),
      cut: truncated === true,
    };
  }

  const { page, after, budget } = options;
  let start = 0;
  let heading = `${total}:`;
  if (after !== undefined) {
    const at = entries.findIndex((entry) => entry.name === after);
    start = at + 1;
    heading =
      at === -1
        ? `${total}; none is named ${oneLine(after)}, so this lists from the start:`
        : `${total}; continuing after ${oneLine(after)}:`;
  }

  const lines = [heading];
  let used = heading.length;
  let shown = 0;
  for (const entry of entries.slice(start)) {
    const line = entryLine(entry);
    if (used + 1 + line.length > budget - CLOSING_CHARS) break;
    lines.push(line);
    used += 1 + line.length;
    shown += 1;
  }
  const remaining = entries.length - start;
  const bounded = shown < remaining;
  if (bounded) {
    const last = entries[start + shown - 1];
    const resume = last === undefined ? after : last.name;
    lines.push(
      `Listed ${shown} of the ${remaining} entries from here; Volli's character bound cut the rest. Continue with ${page}${
        resume === undefined ? "" : `?after=${encodeURIComponent(resume)}`
      }`,
    );
  }
  return { text: [...lines, ...incomplete].join("\n"), cut: bounded || truncated === true };
}
