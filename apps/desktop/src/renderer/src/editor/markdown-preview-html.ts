/**
 * What HTML the read-only Markdown Preview is willing to draw — the one policy
 * both of its layers read (VC-307).
 *
 * Preview renders files nobody vetted: a README off a pull request, a plan an
 * agent wrote into this worktree. Three things judge that markup, in this
 * order, and they are deliberately not the same judgement:
 *
 *  1. **This module's gate** ({@link renderableHtmlBlock}), over one raw HTML
 *     BLOCK, before anything is rendered. It is LOUD: a block it turns down is
 *     replaced by a visible `HTML block not rendered` marker rather than being
 *     quietly cleaned, because a reader of a file deserves to know that a piece
 *     of it is not on screen.
 *  2. **The renderer's sanitizer**, the chat chain taken whole
 *     (`chatRehypePlugins`), which parses and cleans everything that survives.
 *  3. **The preview's hardening pass** (`markdown-preview-rehype.ts`), which
 *     re-judges the SANITIZED tree against the sets below — including the
 *     inline HTML this gate never sees, because inline markup is one token in a
 *     paragraph and has no block to mark.
 *
 * ## Parse, then judge
 *
 * The gate used regular expressions until a review broke them with valid HTML:
 * `<div title=">" onclick="alert(1)">` hides the handler behind a quoted
 * delimiter, and `href="java&#x73;cript:…"` hides the scheme behind an entity.
 * Neither is exotic; both are simply what an HTML parser reads differently from
 * a regular expression. So the block is parsed with the platform's own parser
 * into an INERT document — `DOMParser` runs no script, loads no resource and
 * fires no request — and its elements, attributes and decoded URL values are
 * judged there, which is the only reading that agrees with the browser's.
 *
 * ## Why the tag list is ours, intersected
 *
 * {@link PREVIEW_TAGS} is this module's own list narrowed by the sanitizer's:
 * the intersection can never be WIDER than what the renderer would keep (so a
 * tag we admit cannot be silently stripped downstream — the loss the marker
 * exists to prevent), and it can never FOLLOW the sanitizer if a future release
 * widens it. The second half is not hypothetical: a review widened that schema
 * with `math`/`mtext` and the MathML reached the document, because everything
 * downstream derived its opinion from that one list.
 */
import { CHAT_SANITIZED_TAG_NAMES } from "@renderer/components/ui/ai-elements/chat-markdown";

/**
 * Elements a preview may draw: prose, structure, tables, disclosures, and the
 * one input markdown itself produces (a task list's disabled checkbox).
 *
 * Everything absent is either meaningless here (`form`, `button`), foreign
 * (`svg`, `math`), or a way to fetch and execute (`iframe`, `source`, `video`).
 */
const OWN_TAGS: readonly string[] = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "li",
  "ol",
  "p",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "section",
  "span",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "tt",
  "ul",
  "var",
];

/** The elements a preview draws: ours, and never wider than the renderer's own. */
export const PREVIEW_TAGS: ReadonlySet<string> = new Set(
  OWN_TAGS.filter((tag) => CHAT_SANITIZED_TAG_NAMES.has(tag)),
);

/**
 * Allowed in the rendered tree, refused in a RAW BLOCK: `input` is how markdown
 * writes a task list's checkbox, and chrome typed into a document by hand is
 * not the same thing.
 */
const RAW_BLOCK_DENIED_TAGS: ReadonlySet<string> = new Set(["input"]);

/**
 * Elements whose whole subtree goes, rather than being unwrapped.
 *
 * Two reasons appear here and they travel together: an element that FETCHES
 * (`source`, `video`, `link`, `object`) and an element whose children are not
 * HTML at all (`svg`, `math`, `template`, `noscript`) — unwrapping either would
 * leave its markup or its script text loose in the document. A `picture` is
 * deliberately absent: it is an inert wrapper, and unwrapping it keeps the
 * `<img>` a person meant while its `<source>` candidates go.
 */
export const PREVIEW_DROPPED_TAGS: ReadonlySet<string> = new Set([
  "applet",
  "audio",
  "base",
  "canvas",
  "embed",
  "frame",
  "frameset",
  "iframe",
  "link",
  "math",
  "meta",
  "noscript",
  "object",
  "portal",
  "script",
  "source",
  "style",
  "svg",
  "template",
  "track",
  "video",
]);

/** Attributes any allowed element may carry: naming, direction, and layout hints. */
const GLOBAL_ATTRIBUTES: ReadonlySet<string> = new Set([
  "align",
  "className",
  "dir",
  "id",
  "lang",
  "title",
]);

/** Attributes only certain elements may carry, in hast's camel case. */
const ELEMENT_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ["href", "dataFootnoteRef", "dataFootnoteBackref"],
  img: ["src", "alt", "width", "height"],
  input: ["type", "checked", "disabled"],
  ol: ["start", "reversed"],
  li: ["value"],
  td: ["colSpan", "rowSpan", "headers", "scope"],
  th: ["colSpan", "rowSpan", "headers", "scope"],
  details: ["open"],
  section: ["dataFootnotes"],
  table: ["width"],
};

/** `aria-*` in hast's camel case (`ariaLabel`): naming, never a request. */
const ARIA_ATTRIBUTE = /^aria[A-Z]/;

/** Whether an element of `tagName` may keep the hast property `name`. */
export function allowsPreviewAttribute(tagName: string, name: string): boolean {
  if (ARIA_ATTRIBUTE.test(name)) return true;
  if (GLOBAL_ATTRIBUTES.has(name)) return true;
  return (ELEMENT_ATTRIBUTES[tagName] ?? []).includes(name);
}

/** Schemes a preview link may carry. Opening one is main's job (`will-navigate`), never the page's. */
const LINK_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto", "tel"]);

/**
 * Whether one URL value may sit behind a person's click.
 *
 * Judged AFTER the parser has decoded entities and with whitespace and control
 * characters removed, because `java&#x73;cript:` and `java\tscript:` are the
 * same instruction to a browser and differ only on the way in.
 */
export function safeLinkUrl(value: string): boolean {
  const scheme = schemeOf(value);
  return scheme === null || LINK_SCHEMES.has(scheme);
}

/** The scheme of a URL value, lowercased, or `null` when it names none (relative, anchor, empty). */
function schemeOf(value: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(stripInvisible(value));
  return match === null ? null : match[1].toLowerCase();
}

/**
 * Everything a browser ignores inside a URL before it reads the scheme.
 *
 * Character by character rather than by regular expression: the characters that
 * matter here are the control ones, and a regex class holding them is exactly
 * what `no-control-regex` exists to question.
 */
function stripInvisible(value: string): string {
  return [...value].filter((ch) => ch.charCodeAt(0) > 0x20 && ch.charCodeAt(0) !== 0x7f).join("");
}

/**
 * Attributes that make the browser fetch, beacon or navigate on its own, in
 * every spelling the parser and hast use for them.
 */
const AUTO_FETCHING_ATTRIBUTES: ReadonlySet<string> = new Set([
  "background",
  "data",
  "formaction",
  "httpequiv",
  "lowsrc",
  "manifest",
  "ping",
  "poster",
  "profile",
  "srcdoc",
  "srcset",
  "usemap",
  "xlinkhref",
]);

/** Whether `name` is one of those, ignoring the `-`/`:` an author or a parser may spell it with. */
function autoFetchingAttribute(name: string): boolean {
  return AUTO_FETCHING_ATTRIBUTES.has(name.toLowerCase().replace(/[-:]/g, ""));
}

/** Attributes whose value is a URL a person may follow, rather than one the page loads. */
const LINK_ATTRIBUTES: ReadonlySet<string> = new Set(["href", "cite", "action", "longdesc"]);

/** `url(…)` inside a `style` value: a stylesheet's own way of making a request. */
const STYLE_URL = /url\s*\(/i;

/**
 * `<!doctype`, `<![CDATA[`, `<?…`: markup an HTML parser swallows into a
 * comment, a quirks mode, or nothing at all. Asked on the raw text, because
 * after parsing there is nothing left to ask about — and a block that quietly
 * became nothing is exactly what the marker exists to announce.
 */
const NON_ELEMENT_MARKUP = /<[!?](?!--)/;

/**
 * Whether one raw HTML block may be handed to the renderer at all.
 *
 * Conservative by construction: unknown markup is refused, not repaired. A
 * refusal costs a visible marker; an admission the sanitizer would have had to
 * clean costs the reader a silent hole in their file, and an admission nobody
 * cleans costs them their machine.
 *
 * Comments are ignored rather than scanned: the sanitizer deletes comment
 * nodes, so what is inside one cannot reach the page, and refusing a block over
 * the word `script` in a comment would hide the paragraph written around it.
 */
export function renderableHtmlBlock(html: string): boolean {
  if (NON_ELEMENT_MARKUP.test(html)) return false;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  // BOTH roots: the parser hoists `<link>`, `<meta>` and `<base>` into the head
  // of the document it builds, and a gate that walked only the body would never
  // see them.
  return renderableElements(parsed.head) && renderableElements(parsed.body);
}

function renderableElements(root: Element): boolean {
  for (const element of root.querySelectorAll("*")) {
    // `localName` rather than `tagName`: foreign content (`<svg>`, `<math>`)
    // keeps its own case, and this comparison must not depend on that.
    const tag = element.localName;
    if (!PREVIEW_TAGS.has(tag) || RAW_BLOCK_DENIED_TAGS.has(tag)) return false;
    for (const attribute of element.attributes) {
      if (!renderableAttribute(tag, attribute.name, attribute.value)) return false;
    }
  }
  return true;
}

function renderableAttribute(tagName: string, rawName: string, value: string): boolean {
  const name = rawName.toLowerCase();
  if (name.startsWith("on")) return false;
  if (autoFetchingAttribute(name)) return false;
  // A style declaration is inert; a `url()` inside one is a request. The
  // sanitizer drops the attribute either way, so admitting the inert form only
  // decides whether the block's TEXT is readable — and half the centred READMEs
  // in the world carry one.
  if (name === "style") return !STYLE_URL.test(value);
  if (name === "src") return tagName === "img" && !dangerousImageUrl(value);
  if (LINK_ATTRIBUTES.has(name)) return safeLinkUrl(value);
  return true;
}

/**
 * An `<img src>` as an author wrote it, judged before anything resolves it: a
 * relative repository path is fine (`markdown-preview-image.ts` reads it through
 * main's safe reader), `http(s)` is fine as a NAME (the resolver refuses to
 * fetch it and draws a notice instead), `data:image` is inert, and every other
 * scheme is refused.
 */
function dangerousImageUrl(value: string): boolean {
  const scheme = schemeOf(value);
  if (scheme === null) return false;
  if (scheme === "http" || scheme === "https") return false;
  return !/^data:image\//i.test(stripInvisible(value));
}
