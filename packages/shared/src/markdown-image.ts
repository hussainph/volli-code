/**
 * One rule for what a markdown `![alt](src)` may load, shared by every surface
 * that draws prose (VC-273).
 *
 * Three renderers draw markdown in this app — the Monaco Document Mode
 * projection over a Ticket Body, `marked` + DOMPurify over comments, and
 * Streamdown over the chat transcript — and before this module each carried its
 * own idea of a legal image source. They disagreed in every direction: the
 * transcript admitted `/abs/path` and `file:` (neither of which a renderer on
 * an app origin can ever load) while blocking `volli-blob:`, the one scheme
 * that works; DOMPurify's default URI allowlist silently deleted `volli-blob:`
 * and `data:` `src` attributes outright; Document Mode assigned whatever string
 * it found straight onto an `<img>`. So the same picture broke three different
 * ways depending on where it was written, which is the bug this module exists
 * to make impossible.
 *
 * The policy is deliberately narrow, and each admission earns its place:
 *
 *  - `volli-blob:<hash>` is the canonical durable form. It resolves through the
 *    Blob store rather than a worktree, so it still renders after retention has
 *    pruned the checkout the file was materialized into, and its bytes are
 *    served with `default-src 'none'` (`blob-protocol.ts`).
 *  - An attachment named by its materialized path — `.volli/attachments/spec.png`
 *    — is what an agent naturally writes, because that is the path the Ticket
 *    brief handed it. Resolving it to the Blob it already names is what makes
 *    agent-authored markdown work without asking a model to know a URL scheme.
 *  - `data:image/*` is inert and self-contained. Restricted to image types: a
 *    bare `data:` admission is an XSS vector the moment this predicate is
 *    reused for a link `href`, and this module should not be a trap.
 *
 * Everything else is refused, and remote URLs are refused SEPARATELY from
 * unresolvable ones because they are a different fact about the world. A
 * transcript rendering `https://tracker.example/pixel.png` would let anything
 * that can write markdown into a session phone home with the user's IP on
 * render — the previous chat renderer's "local/data only" stance, kept
 * deliberately rather than inherited by accident. An unresolvable source is
 * merely a name we cannot find. A caller that collapsed the two would have to
 * pick one wrong word for both.
 *
 * Pure, and in `@volli/shared` rather than beside any one renderer, for the
 * same reason `@lezer/markdown` outlived the editor it arrived with: this
 * decision is about markdown and Blobs, not about Monaco, `marked` or
 * Streamdown, and it must survive all three being replaced.
 */

import {
  blobUrl,
  materializedBlobNames,
  parseBlobUrl,
  SESSION_ATTACHMENTS_REL_DIR,
  type NamedBlobLink,
} from "./blob";

/**
 * What a renderer should do with one markdown image source.
 *
 * `remote` and `unresolved` are both refusals, and both are drawn rather than
 * dropped: an image that silently vanishes is indistinguishable from one the
 * author never wrote, and in Document Mode — which hides the `![alt](src)`
 * syntax it replaces — it would leave an unexplained gap on the page.
 */
export type MarkdownImageResolution =
  | { kind: "render"; src: string }
  /** A remote URL we decline to fetch, so rendering cannot leak that this was read. */
  | { kind: "remote" }
  /** Well-formed but naming nothing this app can serve. */
  | { kind: "unresolved" };

/** Schemes that mean "somewhere else on the network". Refused as {@link MarkdownImageResolution} `remote`. */
const REMOTE_SCHEME = /^(?:https?|ftps?|wss?):/i;
/** Inert, self-contained bytes. Image types only — a bare `data:` is a document, not a picture. */
const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+[;,]/i;
/** Any scheme at all — asked last, so a bare file name is never read as one. */
const ANY_SCHEME = /^[a-z][a-z0-9.+-]*:/i;

/**
 * What a markdown URL NAMES, before any surface decides what to do about it.
 *
 * One classification, because every markdown renderer in this app has to make
 * it and they must not disagree: the transcript, the Ticket body, and the file
 * Preview each resolve a source differently (Blobs, attachments, repository
 * paths) but "this is remote" and "this is some other scheme" mean the same
 * thing in all three, and a surface that answered `unresolved` where another
 * said `remote` would tell a person the wrong thing about the same URL.
 */
export type MarkdownUrlKind =
  /** Inert image bytes carried by the URL itself. */
  | "data-image"
  /** Somewhere on the network, the protocol-relative `//host/path` form included. */
  | "remote"
  /** Some other scheme: an app's own, `file:`, or one that executes. */
  | "scheme"
  /** No scheme at all — a name, to be resolved against something. */
  | "path";

/** See {@link MarkdownUrlKind}. Leading and trailing space is not part of a URL. */
export function classifyMarkdownUrl(value: string): MarkdownUrlKind {
  const trimmed = value.trim();
  if (DATA_IMAGE.test(trimmed)) return "data-image";
  if (REMOTE_SCHEME.test(trimmed) || trimmed.startsWith("//")) return "remote";
  if (ANY_SCHEME.test(trimmed)) return "scheme";
  return "path";
}

/**
 * The materialized attachment name each Blob hash answers to, for
 * {@link resolveMarkdownImageSrc}'s path branch.
 *
 * Built from {@link materializedBlobNames}, the SAME derivation that decides
 * what the files are called on disk, so a name that resolves here is exactly
 * the name the agent was given in the brief. Deriving it independently would
 * eventually disagree — and it would disagree precisely in the collision case
 * (`spec.png` and a second `spec.png` becoming `spec-2.png`) that the naming
 * rule exists to handle.
 */
export function attachmentHashesByName(links: readonly NamedBlobLink[]): Map<string, string> {
  const names = materializedBlobNames(links);
  const byName = new Map<string, string>();
  for (const link of links) {
    // Never misses: materializedBlobNames maps every link in the list it was
    // given — the same assertion `blobsSectionInput` makes over the same map.
    byName.set(names.get(link.linkId)!, link.blobHash);
  }
  return byName;
}

/** Strips a `?query` / `#fragment` a markdown author may have appended. */
function withoutSuffix(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

/**
 * The attachment file name `src` names, or `null`.
 *
 * Two accepted shapes, and the narrowness is the point — this must not become
 * a general "does any path end in something that looks familiar" match:
 *
 *  - anything ending in `.volli/attachments/<name>`, which covers the relative
 *    form the brief hands out, a `./`-prefixed one, and the absolute path an
 *    agent gets from a tool that echoed the full worktree path back;
 *  - a bare `<name>` with no separator at all, which is what someone writes
 *    when the picture is simply "the one attached to this ticket".
 *
 * A path with directories that are NOT the attachments directory is refused
 * even when its basename matches, because `docs/spec.png` is a claim about a
 * repository file and answering it with an unrelated attachment would be a
 * quiet lie.
 */
function attachmentNameFrom(src: string): string | null {
  const path = withoutSuffix(src).replace(/\\/g, "/");
  if (path === "") return null;
  const marker = `${SESSION_ATTACHMENTS_REL_DIR}/`;
  const at = path.lastIndexOf(marker);
  if (at !== -1) {
    const name = path.slice(at + marker.length);
    // Reject a nested path under the directory: attachments are flat, so
    // `.volli/attachments/sub/x.png` names nothing we materialized.
    return name === "" || name.includes("/") ? null : name;
  }
  return path.includes("/") ? null : path;
}

/**
 * How to draw one markdown image source. See the module note for the policy.
 *
 * `attachments` maps materialized attachment name to Blob hash — build it with
 * {@link attachmentHashesByName} from the Ticket's or Session's own links. An
 * empty map is a perfectly ordinary input (a surface with no attachments), and
 * simply means no path resolves.
 */
export function resolveMarkdownImageSrc(
  src: string,
  attachments: ReadonlyMap<string, string> = new Map(),
): MarkdownImageResolution {
  const trimmed = src.trim();
  if (trimmed === "") return { kind: "unresolved" };

  // Canonical form first: already a Blob URL, already durable.
  const hash = parseBlobUrl(trimmed);
  if (hash !== null) return { kind: "render", src: blobUrl(hash) };

  switch (classifyMarkdownUrl(trimmed)) {
    // Inert, self-contained bytes. Image types only — see the module note.
    case "data-image":
      return { kind: "render", src: trimmed };
    case "remote":
      return { kind: "remote" };
    // Any other scheme (`file:`, `javascript:`, an app scheme) names something a
    // renderer on this origin must not or cannot load. Asked before the path
    // branch so a scheme can never be mistaken for a bare file name.
    case "scheme":
      return { kind: "unresolved" };
    case "path":
      break;
  }

  const name = attachmentNameFrom(trimmed);
  if (name === null) return { kind: "unresolved" };
  const attached = attachments.get(name);
  return attached === undefined
    ? { kind: "unresolved" }
    : { kind: "render", src: blobUrl(attached) };
}

/**
 * The one-line explanation a refused image shows in place of the picture.
 *
 * Here rather than in each renderer so the transcript, the Ticket body and a
 * comment all say the same thing about the same situation. Short enough to sit
 * inline where a picture would have been, and it names the cause rather than
 * apologising: a person who wrote a URL needs to know the URL is why.
 */
export function markdownImageNotice(resolution: { kind: "remote" | "unresolved" }): string;
export function markdownImageNotice(resolution: MarkdownImageResolution): string | null;
/*
 * Two signatures, no second implementation: a caller that has already narrowed
 * to a REFUSAL always gets a sentence, and saying so in the type spares it a
 * `?? ""` fallback that no test could ever reach (the file Preview's image
 * path, VC-307). The general signature is unchanged for everyone else.
 */
export function markdownImageNotice(resolution: MarkdownImageResolution): string | null {
  switch (resolution.kind) {
    case "render":
      return null;
    case "remote":
      return "Remote image not loaded";
    case "unresolved":
      return "Image unavailable";
  }
}
