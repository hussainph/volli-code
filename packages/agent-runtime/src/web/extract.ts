/**
 * Turning one page of HTML into the part of it worth reading.
 *
 * A fetched document arrives as markup, and markup is mostly not the document:
 * navigation, cookie banners, sidebars and script tags routinely outweigh the
 * article by an order of magnitude. Handing that to a model spends its context
 * on chrome and, past a character bound, spends the whole budget before the
 * prose begins — a documentation page whose `<head>` and nav run past the bound
 * returns a table of contents and nothing else.
 *
 * So extraction happens here, and it happens *before* the bound is applied.
 * That ordering is the point of the module: truncating markup and then
 * extracting from the remains would find nothing, because the remains are the
 * header. Read the whole document, take the article out of it, then bound the
 * article.
 *
 * Everything in here treats its input as hostile. The DOM is inert — no
 * scripts, no resource loads, no navigation — and the sanitising pass runs
 * before either conversion path sees a node, so a page cannot reach the
 * converter with an event handler, a frame or a hidden instruction still
 * attached.
 */

import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";

/**
 * The bounds extraction runs inside, beside the transport's own.
 *
 * Three of them, and the two structural ones exist because the byte bound alone
 * does not bound the work. Readability walks a candidate's ancestors for every
 * candidate it scores, so its cost climbs with the *shape* of a document rather
 * than its size: measured here, a 43 KiB page of `<div>`s nested 400 deep held
 * the thread for 34 seconds, and 256 KiB of the same shape for over 90. That
 * page passes a 2 MiB byte bound without noticing it.
 *
 * This matters more than it would in a worker. `webPortsFor` builds the fetcher
 * in Electron's main process, which also owns SQLite, the IPC bridge, the
 * `volli` CLI socket and every terminal — and extraction is synchronous, so no
 * deadline, timer or abort signal can interrupt it once it starts. A bound that
 * is not enforced before the work begins is not enforced at all.
 */
export const WEB_EXTRACT_LIMITS = {
  /**
   * Decoded characters handed to the parser.
   *
   * The transport already caps the body at 5 MiB, and a DOM is far more
   * expensive per byte than the bytes were: parsing, sanitising and then
   * Readability's several passes over a multi-megabyte document is work a page
   * should not be able to ask of this process. An article does not need more
   * than this, so a document past the bound is read up to it rather than
   * refused — the prose is at the top, and a partial article beats no article.
   *
   * Back to two mebibytes, from the half this had been tightened to. The
   * tightening was aimed at a page "built from few, very large elements", which
   * {@link maxElements} could not constrain — but that is the shape a document
   * with diagrams has, and the bound was cutting real ones: sqlite.org's
   * `lang_select.html` is 2 MB of inline SVG railroad diagrams around its prose,
   * and half a mebibyte of it yielded 839 characters of a 37,269-character
   * page.
   *
   * What makes the wider bound affordable is that the two expensive shapes are
   * now bounded by something else. An element-dense document is cut by
   * {@link maxElements} long before it reaches this, and the diagrams that make
   * a document large without making it dense are stepped over by
   * {@link SKIPPED_SUBTREES} rather than counted. What is left — 2 MiB of few,
   * large elements — measured at 0.6-1.0s to parse, against the 2.4s that
   * {@link maxElements} already permits at its own worst case. The ceiling on
   * this module's cost did not move; only the number of real pages under it did.
   */
  htmlChars: 2 * 1024 * 1024,
  /**
   * How deep the tree may be before it is flattened.
   *
   * Real documents are shallow: a complex page nests perhaps 30 levels, and
   * anything past this is generated, broken, or built to be expensive. Deeper
   * elements are replaced by their own text rather than removed, so the words
   * survive and only the scaffolding is lost — a page cannot hide its article
   * from Volli by burying it, only its structure.
   *
   * The number is unchanged, but what it counts was wrong before: the pre-parse
   * scan tracked depth as a counter that only came down on an explicit end tag,
   * so on the minified markup most of the web serves it never came down at all.
   * See {@link structureBoundOffset} — it now walks a stack of open elements,
   * and 64 finally means sixty-four levels rather than sixty-four omitted end
   * tags.
   */
  maxDepth: 64,
  /**
   * How many elements may be scored.
   *
   * Depth alone is not enough — a shallow document made of very many small
   * elements is the same bill paid the other way round, and Readability's cost
   * climbs faster than the count does.
   *
   * Counted in document order, so what survives is the top of the page. That
   * is what sets the number, and it is not set from the output bound: chrome
   * comes *before* the article, so the budget has to be large enough to reach
   * past a page's navigation or it cuts the very thing it was spent looking
   * for. A documentation sidebar of 2,500 links — the shape `extract.test.ts`
   * pins — is the case that decides this, and a tighter bound was measured
   * dropping that page's article on the floor.
   *
   * Eight thousand rather than the three it started at, because three was
   * cutting ordinary documentation and buying nothing for it. Measured against
   * real pages: electronjs.org's `session` API returned 22,215 characters of a
   * possible 84,489, undici.nodejs.org 6,526 of 32,456, and vitest.dev's
   * `expect` page 21,895 of 64,128 — the last of those short of even the
   * 25,000-character output bound, so the tighter limit was spending a budget
   * it did not need to spend. Syntax highlighting is what does it: Shiki emits
   * one `<span>` per token, so a page of code examples spends thousands of
   * elements on a single article.
   *
   * The worst case did not move. Against the shapes Readability is slowest on,
   * 8,000 elements cost 2.3s where 3,000 cost 2.5s — the expensive shape is
   * deep nesting, which {@link maxDepth} bounds, not breadth. 12,000 was
   * measured at 5.4s, which is past what this process should ever spend
   * synchronously, so the bound sits here.
   */
  maxElements: 8_000,
} as const;

export type WebExtractLimits = { -readonly [K in keyof typeof WEB_EXTRACT_LIMITS]: number };

/**
 * Elements removed outright, with their subtrees.
 *
 * Two different reasons, deliberately in one list. `script`, `style`,
 * `noscript`, `iframe`, `object`, `embed`, `link` and `meta` are removed
 * because they are executable, remote or metadata — things that must not reach
 * a converter regardless of what they would render as. `img`, `svg` and
 * `canvas` are removed because they carry no text a model can read and would
 * otherwise arrive as Markdown image syntax wrapping a URL, which is tokens
 * spent to say nothing and a third-party URL placed in context for free.
 *
 * `form` is *not* here, and its absence is load-bearing: some frameworks wrap
 * an entire page body in one, so removing forms wholesale is a way to delete
 * the article. Forms are neutralised below instead, by taking their controls
 * and leaving their contents.
 */
const DISCARDED = [
  "script",
  "style",
  "noscript",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "template",
  "img",
  "svg",
  "canvas",
  "audio",
  "video",
];

/** Interactive controls: no text worth reading, and the part of a form that acts. */
const CONTROLS = ["input", "button", "select", "textarea", "label", "fieldset"];

/**
 * Attributes by which a page states outright that it is hiding something.
 *
 * Invisible text is where an injection attempt hides: a paragraph positioned
 * off-screen reads identically to the model and not at all to the person who
 * looked at the page before asking for it. Removing it is not a complete
 * defence — the envelope around the result is what actually says "not
 * instructions", and a stylesheet can hide anything without touching the markup
 * — but text the author hid is text nobody asked to read.
 */
const HIDDEN = ["[hidden]", '[aria-hidden="true"]'];

/**
 * Inline-style declarations that mean the author hid this element.
 *
 * Read as declarations rather than matched as substrings. `[style*="display:
 * none"]` is two selectors that each miss `display : none`, `DISPLAY:NONE` and
 * `display:none !important`, and a hiding rule that can be evaded by a space is
 * not a rule. Parsing the attribute costs one split and answers every spelling
 * at once.
 */
const HIDING_DECLARATIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["display", new Set(["none"])],
  ["visibility", new Set(["hidden", "collapse"])],
  ["opacity", new Set(["0", "0.0", "0%", ".0"])],
  ["font-size", new Set(["0", "0px", "0em", "0rem", "0%", "0pt"])],
]);

/**
 * Offsets far enough outside the viewport to be a hiding technique.
 *
 * The `left: -9999px` idiom, and its relatives. Bounded rather than "any
 * negative offset" because small negative offsets are ordinary layout — a
 * hanging bullet or an overlapped edge — and deleting those would be deleting
 * the page.
 */
const OFFSCREEN_PROPERTIES: ReadonlySet<string> = new Set([
  "left",
  "top",
  "right",
  "bottom",
  "text-indent",
  "margin-left",
  "margin-top",
]);
const OFFSCREEN_DISTANCE = 1000;

/** Whether one element's own `style` attribute says it is not to be seen. */
function hiddenByStyle(style: string): boolean {
  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator === -1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    // `!important` removed before the value is judged, so a page cannot opt out
    // of being read as hidden by insisting on it.
    const value = declaration
      .slice(separator + 1)
      .trim()
      .toLowerCase()
      .replace(/\s*!\s*important$/, "")
      .trim();
    if (HIDING_DECLARATIONS.get(property)?.has(value) === true) return true;
    if (OFFSCREEN_PROPERTIES.has(property)) {
      const offset = Number.parseFloat(value);
      if (Number.isFinite(offset) && offset <= -OFFSCREEN_DISTANCE) return true;
    }
  }
  return false;
}

/** Link schemes that never survive into the output. */
const UNSAFE_SCHEMES = ["javascript:", "data:", "vbscript:", "file:"];

/** Elements that never open a level, so a run of them is not a deep document. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * Elements whose content is text, not markup.
 *
 * Skipped wholesale while measuring, because a `<` inside a script is not a tag
 * and counting it as one would let a page's own source decide where this reads
 * the document as too deep.
 */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style", "textarea", "title"]);

/**
 * Subtrees the scan steps over instead of counting.
 *
 * {@link DISCARDED} deletes both of these outright once there is a tree, so
 * every element inside one is an element the budget is spent measuring and then
 * throws away. On a page with diagrams that is not a rounding error: sqlite.org
 * draws its syntax as inline SVG, and `lang_select.html` holds 7,668 `<path>`
 * and 4,000 `<polygon>` elements — more than the whole element budget — in front
 * of prose that then never gets read. Skipping them is not a relaxation of the
 * bound; it is the bound counting the thing it is actually there to limit.
 *
 * The subtree still counts as one element, so a page made of ten thousand empty
 * `<svg>` tags is bounded exactly as before.
 */
const SKIPPED_SUBTREES: ReadonlySet<string> = new Set(["svg", "math"]);

/**
 * The offset just past this element's subtree, for a subtree being stepped over.
 *
 * Nesting-aware, because SVG may contain SVG, and stopping at the first `</svg`
 * would resume the scan in the middle of a subtree that is still open. A
 * subtree that never closes runs to the end of the document, which is the same
 * answer the parser will reach.
 *
 * Takes the folded copy of the document rather than the document, because it is
 * called once per skipped subtree and folding here would be folding the whole
 * document once per `<svg>` on the page. See {@link asciiFold}.
 */
function endOfSubtree(folded: string, name: string, from: number): number {
  let depth = 1;
  let index = from;
  while (depth > 0) {
    const next = folded.indexOf(`<${name}`, index);
    const close = folded.indexOf(`</${name}`, index);
    if (close === -1) return folded.length;
    // A nested opening before the next close means one more level to unwind.
    if (next !== -1 && next < close) {
      const past = next + name.length + 1;
      // Only a real start tag, not `<svgfoo`: the tag name ends where a name
      // character stops, which is the same rule the main scan reads tags by.
      // An empty slice — the tag ending the document — matches nothing and so
      // counts as a real tag, which is what it is.
      if (!/^[a-zA-Z0-9-]/.test(folded.slice(past, past + 1))) depth += 1;
      index = past;
      continue;
    }
    depth -= 1;
    index = close + name.length + 2;
  }
  return index;
}

/**
 * The document with its ASCII letters folded to lower case, for tag matching.
 *
 * Built once per scan, and that is the whole point of it. Both the raw-text
 * branch and {@link endOfSubtree} need a case-insensitive search for a closing
 * tag, and both used to fold the entire document to get one — inside the scan
 * loop, once per element. That made the scan quadratic in the size of the
 * document while bounding nothing: measured, 2 MiB of `<script></script>` pairs
 * held this thread for 59 seconds. Extraction is synchronous and runs in
 * Electron's main process, so neither the fetch deadline nor an abort signal
 * could interrupt it — the whole app was frozen for the duration.
 *
 * Folded over `[A-Z]` rather than with `toLowerCase()`, because every offset
 * this scan returns indexes the *original* string and the two must therefore
 * line up character for character. `toLowerCase()` does not promise that: U+0130
 * lowercases to two code units, so one such character in a document would shift
 * every offset after it and cut the markup in the wrong place. A tag name is
 * ASCII, so folding ASCII is all this needs.
 */
function asciiFold(html: string): string {
  return html.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * Start tags that close an element the page never bothered to close.
 *
 * HTML makes these end tags optional, and this is not an obscure corner of the
 * specification — it is what every minifier emits. `<ul><li>a<li>b<li>c</ul>`
 * is three siblings, not three levels, and a scan that reads the second `<li>`
 * as nesting inside the first has stopped measuring the document and started
 * measuring how terse its author was.
 *
 * Each key is a start tag; the value is the set of currently-open elements it
 * implicitly ends. The sets hold only siblings, never a container, which is
 * what keeps the unwinding below self-limiting: a run of unclosed `<li>` pops
 * back to the `<ul>` and stops there, because `ul` is not in any of them.
 *
 * Taken from the "optional tags" rules in the HTML standard, restricted to the
 * ones that actually appear in served markup. It does not need to be complete:
 * a rule this misses costs a slightly early truncation point on a page nobody
 * minified, and never admits anything, because the scan admits nothing.
 */
const IMPLIED_END_TAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["li", new Set(["li", "p"])],
  ["dt", new Set(["dt", "dd", "p"])],
  ["dd", new Set(["dt", "dd", "p"])],
  ["option", new Set(["option"])],
  ["optgroup", new Set(["option", "optgroup"])],
  ["td", new Set(["td", "th", "p"])],
  ["th", new Set(["td", "th", "p"])],
  ["tr", new Set(["td", "th", "tr", "p"])],
  ["tbody", new Set(["td", "th", "tr", "thead", "tbody", "tfoot"])],
  ["tfoot", new Set(["td", "th", "tr", "thead", "tbody", "tfoot"])],
  ["thead", new Set(["td", "th", "tr", "thead", "tbody", "tfoot"])],
  ["rt", new Set(["rt", "rp"])],
  ["rp", new Set(["rt", "rp"])],
]);

/**
 * Block-level starts that end an open `<p>`.
 *
 * `</p>` is the most commonly omitted end tag there is, and unlike the list and
 * table rules above, what closes a paragraph is "almost any block element"
 * rather than a short list of siblings. Kept separate for that reason.
 */
const CLOSES_PARAGRAPH: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "search",
  "section",
  "table",
  "ul",
]);

/**
 * How far back an unmatched `</x>` is allowed to look for its start tag.
 *
 * A close tag naming an element that was never opened is stray markup and is
 * ignored, which means answering "is `x` open?" on every one of them. Scanning
 * the whole stack each time is quadratic on a page that emits many stray closes
 * — a cheap way to make this scan expensive — and a real `</x>` sits within a
 * few levels of its start. Past this the close is treated as stray, which costs
 * an early truncation point on a pathological page and nothing on a real one.
 */
const CLOSE_SEARCH_DEPTH = 64;

/**
 * Where this markup first outgrows its structural bounds, if it ever does.
 *
 * A scan, not a parse, and the distinction is what makes it safe to write. It
 * decides one thing — how many characters of the document are worth handing to
 * jsdom — and every security decision still happens afterwards, on the real
 * parsed DOM. Being approximate costs a slightly different truncation point; it
 * cannot admit anything, because it admits nothing.
 *
 * It has to run here rather than on the tree, because by the time there is a
 * tree the damage is done, in three separate ways. Building a pathologically
 * nested document is itself the expense; jsdom's descendant walks are recursive
 * generators that overflow the stack on a document nested a few thousand deep,
 * a crash no bound applied afterwards can catch; and removing a hundred
 * thousand elements one at a time costs more than parsing them did. Cutting the
 * string is the only bound that runs before all three.
 *
 * Depth is a *stack of open element names*, not a counter, and that is the
 * whole difference between this measuring nesting and measuring punctuation.
 * A counter decremented on `</x>` drifts upward forever on ordinary minified
 * markup, because HTML lets a page omit most of its end tags: measured against
 * real documentation sites, that drift cut electronjs.org at 5.2% of the
 * document and nodejs.org at 31.2%, each inside a list or table whose end tags
 * were merely absent. Popping by name — and applying the implied-end rules a
 * browser applies — is what makes a flat sidebar of sixty-five links read as a
 * flat sidebar of sixty-five links.
 */
function structureBoundOffset(
  html: string,
  maxDepth: number,
  maxElements: number,
): number | undefined {
  // The elements currently open, outermost first. Its length is the depth.
  const open: string[] = [];
  // One fold for the whole scan, shared by every case-insensitive search below.
  const folded = asciiFold(html);
  let elements = 0;
  let index = 0;

  /**
   * Unwind the implied end tags a start tag brings with it.
   *
   * Stops at the first open element the rule does not name, which is the
   * container: `ul` appears in no implied set, so unclosed `<li>`s pop back to
   * their list and no further, and the same shape holds for table sections,
   * definition lists and option groups.
   */
  const closeImplied = (starting: string): void => {
    const implied = IMPLIED_END_TAGS.get(starting);
    const closesParagraph = CLOSES_PARAGRAPH.has(starting);
    if (implied === undefined && !closesParagraph) return;
    while (open.length > 0) {
      const top = open[open.length - 1]!;
      if (implied?.has(top) !== true && !(closesParagraph && top === "p")) break;
      open.pop();
    }
  };

  while (index < html.length) {
    const start = html.indexOf("<", index);
    if (start === -1) return undefined;
    // A comment or a doctype opens nothing; skip past it without counting.
    if (html.startsWith("<!--", start)) {
      const close = html.indexOf("-->", start + 4);
      if (close === -1) return undefined;
      index = close + 3;
      continue;
    }
    if (html.startsWith("<!", start) || html.startsWith("<?", start)) {
      const close = html.indexOf(">", start);
      if (close === -1) return undefined;
      index = close + 1;
      continue;
    }
    const closing = html.startsWith("</", start);
    const nameAt = start + (closing ? 2 : 1);
    const name = /^[a-zA-Z][^\s/>]*/.exec(html.slice(nameAt, nameAt + 64))?.[0]?.toLowerCase();
    if (name === undefined) {
      // A bare `<` in text. Not a tag, and not a reason to stop reading.
      index = start + 1;
      continue;
    }
    const close = html.indexOf(">", start);
    if (close === -1) return undefined;
    if (closing) {
      // Pop back to the element this actually closes, so the unclosed children
      // it was holding go with it. A name that is not open at all is stray
      // markup a browser would discard, and discarding it here keeps a page
      // from popping its way out of the document.
      const from = Math.max(0, open.length - CLOSE_SEARCH_DEPTH);
      for (let level = open.length - 1; level >= from; level -= 1) {
        if (open[level] === name) {
          open.length = level;
          break;
        }
      }
      index = close + 1;
      continue;
    }
    // Counted before the raw-text branch rather than after it. `script`,
    // `style`, `textarea` and `title` are elements, and leaving them outside
    // the budget meant a page could serve an unbounded number of them — the
    // element bound is the one thing standing between this scan and a document
    // built entirely out of the tags it declined to count.
    elements += 1;
    if (elements > maxElements) return start;
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const end = folded.indexOf(`</${name}`, close);
      index = end === -1 ? html.length : end;
      continue;
    }
    // A subtree the sanitiser is going to delete anyway: counted once, stepped
    // over, and never allowed to spend the budget on its own contents.
    if (SKIPPED_SUBTREES.has(name) && html[close - 1] !== "/") {
      index = endOfSubtree(folded, name, close + 1);
      continue;
    }
    closeImplied(name);
    // `<br/>` and friends close themselves and never nest.
    if (!VOID_ELEMENTS.has(name) && html[close - 1] !== "/") {
      open.push(name);
      if (open.length > maxDepth) return start;
    }
    index = close + 1;
  }
  return undefined;
}

/**
 * Strip everything the converter must not see.
 *
 * Runs on the parsed document rather than on the markup, because attribute and
 * subtree removal expressed as string surgery is how a sanitiser gets bypassed:
 * the parser has already decided what the tags are, and working from its answer
 * means there is no second interpretation for a malformed page to exploit.
 */
function sanitize(doc: Document): void {
  for (const selector of [...DISCARDED, ...CONTROLS, ...HIDDEN]) {
    for (const node of doc.querySelectorAll(selector)) node.remove();
  }
  // Every element carrying an inline style, judged by its declarations rather
  // than by the shape of its attribute text. Collected from a static list, so
  // removing one element cannot disturb the walk over the others.
  for (const element of doc.querySelectorAll("[style]")) {
    /* v8 ignore next -- the selector matched this element on that attribute, so it is present. */
    if (hiddenByStyle(element.getAttribute("style") ?? "")) element.remove();
  }
  // Forms lose their tag but keep their children, so a page that wraps its body
  // in one still has a body afterwards.
  for (const form of doc.querySelectorAll("form")) form.replaceWith(...form.childNodes);
  for (const element of doc.querySelectorAll("*")) {
    // Names and values captured first: attributes are removed inside the loop,
    // a live map iterated while it changes is how an attribute gets skipped,
    // and judging the value as it was captured is judging the page rather than
    // a half-mutated remnant of it.
    const captured = Array.from(element.attributes, ({ name, value }) => ({ name, value }));
    for (const { name, value } of captured) {
      const lowered = name.toLowerCase();
      // Every `on*` attribute, rather than a list of the ones known today: the
      // set of event names grows, and a sanitiser written against a snapshot of
      // it is a sanitiser with a gap in it.
      if (lowered.startsWith("on")) element.removeAttribute(name);
      if ((lowered === "href" || lowered === "src") && unsafe(value)) {
        element.removeAttribute(name);
      }
    }
  }
}

/** Whether a URL attribute names a scheme that must not reach the output. */
function unsafe(value: string): boolean {
  // Control characters and whitespace are stripped first because a browser
  // strips them too, and `java\tscript:` is the oldest trick here. Written as a
  // filter rather than a regular expression so the characters being removed are
  // visible as code points, not as a class a reader has to decode.
  const normalized = [...value]
    .filter((character) => character.charCodeAt(0) > 0x20)
    .join("")
    .toLowerCase();
  return UNSAFE_SCHEMES.some((scheme) => normalized.startsWith(scheme));
}

/**
 * Cut the tree down to a shape whose scoring cost is bounded.
 *
 * Runs after {@link sanitize} and before Readability, which is the only place
 * it can run: sanitize is what removes `script` and `style`, and flattening a
 * subtree to its own text before that would inline script source into the
 * article as though a page had written it in prose.
 *
 * Two bounds, walked in document order in a single pass. Past
 * {@link WEB_EXTRACT_LIMITS.maxDepth} an element keeps its text and loses its
 * descendants — the words survive, the scaffolding that made them expensive
 * does not. Past {@link WEB_EXTRACT_LIMITS.maxElements} the rest of the
 * document is dropped, tail first, because the article is at the top.
 *
 * Iterative rather than recursive: the input is a hostile document of unbounded
 * depth, and a recursive walk over it would overflow the stack, which is the
 * same denial this function exists to prevent.
 *
 * @returns whether either bound actually bit.
 */
function boundStructure(doc: Document, limits: WebExtractLimits): boolean {
  let bounded = false;
  let remaining = limits.maxElements;
  // Children are pushed in reverse so the stack pops them in document order,
  // which is what makes "the elements past the bound" mean the tail of the page
  // rather than an arbitrary branch of it.
  const stack: Array<{ element: Element; depth: number }> = [];
  const push = (parent: Element, depth: number): void => {
    const children = parent.children;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ element: children[index]!, depth });
    }
  };

  // jsdom always gives a `text/html` document a body, the same contract the
  // caller reads `innerHTML` from.
  push(doc.body!, 1);
  while (stack.length > 0) {
    const { element, depth } = stack.pop()!;
    if (remaining <= 0) {
      element.remove();
      bounded = true;
      continue;
    }
    remaining -= 1;
    if (depth >= limits.maxDepth) {
      // Only a claim about this element when it actually has structure below it;
      // a leaf at the bound is an ordinary leaf and nothing was lost.
      if (element.firstElementChild !== null) {
        // The subtree becomes one text node: the prose is kept and the
        // structure that made it expensive to score is spent.
        /* v8 ignore next -- `textContent` is null only on a document or a doctype, and this is an element. */
        const words = element.textContent ?? "";
        element.replaceChildren(doc.createTextNode(words));
        bounded = true;
      }
      continue;
    }
    push(element, depth + 1);
  }
  return bounded;
}

/**
 * The Markdown converter, configured once.
 *
 * ATX headings and fenced code because both survive being read back as text by
 * a model, which is the only consumer. Turndown brings its own DOM for the
 * string it is handed, so nothing here shares state with the document above.
 */
function converter(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  // Belt and braces: these are already gone from the document, but the fallback
  // path converts a serialized string and this costs nothing to state twice.
  turndown.remove(["script", "style", "noscript", "iframe", "object", "embed"]);
  return turndown;
}

/**
 * The page's own description of itself, taken before sanitising removes it.
 *
 * `<title>` and the description metas are the last thing left to say about a
 * page whose body carries no prose — a client-rendered application shell, where
 * the server sent a loading `<div>` and everything a reader wants arrives later
 * from JavaScript Volli does not run. It is thin, but it is the page's own
 * words about itself, and it is the difference between a short answer and an
 * empty one.
 *
 * Read before {@link sanitize}, which removes `<meta>` outright and would
 * otherwise leave nothing to find.
 */
interface PageMetadata {
  title: string;
  description: string;
}

/** One `<meta>` value by name or property, trimmed, or an empty string. */
function meta(doc: Document, selector: string): string {
  return (doc.querySelector(selector)?.getAttribute("content") ?? "").trim();
}

/** What the page says it is, from the head it served. */
function readMetadata(doc: Document): PageMetadata {
  return {
    /* v8 ignore next -- jsdom's `title` is "" for a document without one, never nullish. */
    title: (doc.title ?? "").trim(),
    description:
      meta(doc, 'meta[name="description" i]') ||
      meta(doc, 'meta[property="og:description" i]') ||
      meta(doc, 'meta[name="twitter:description" i]'),
  };
}

/** What extraction produced, and how much of the page it stands for. */
export interface ExtractedDocument {
  /** The article as Markdown, unbounded — the caller owns the character bound. */
  text: string;
  /**
   * Whether Readability found an article, as opposed to the whole body being
   * converted.
   *
   * Observability rather than control: no caller branches on it, and the two
   * paths return the same kind of thing. It is here because they are genuinely
   * different paths through this module and the tests pin which one ran —
   * without it, "Readability declined and the fallback carried the page" is
   * only visible as a guess about the text.
   */
  extracted: boolean;
  /**
   * Whether any bound in {@link WEB_EXTRACT_LIMITS} bit: the markup cut before
   * parsing, the tree flattened past its depth, or its tail dropped past the
   * element count. One flag for all three because they say the same thing to a
   * reader — this stands for less than the whole page.
   */
  truncated: boolean;
}

/**
 * Read one HTML document down to its article, as Markdown.
 *
 * Readability is Firefox's Reader View engine, which is the same judgement a
 * person gets when they click the reader icon: it scores blocks by text density
 * and link ratio and returns the winner. When it declines — a page that is
 * genuinely a list of links, an index, a search result — there is no article to
 * find, and the whole body is converted instead. That fallback is why this
 * never returns nothing: a page with no article still has text, and "no
 * article" is not the same answer as "no content".
 *
 * The body is serialized to a string *before* Readability runs, because
 * `parse()` mutates the document it was given. Keeping the string is cheaper
 * than cloning the DOM and cheaper than parsing the markup a second time, and
 * without it the fallback would convert whatever Readability left behind.
 *
 * @param html The decoded document.
 * @param url The URL it came from, used only to resolve relative links.
 */
export function extractReadableMarkdown(
  html: string,
  url: string,
  limits: WebExtractLimits = WEB_EXTRACT_LIMITS,
): ExtractedDocument {
  const overLength = html.length > limits.htmlChars;
  const lengthBounded = overLength ? html.slice(0, limits.htmlChars) : html;
  // Shape before parsing, because parsing is one of the things it protects.
  // What survives is the document up to the point it became pathological, which
  // for an ordinary page is the whole of it and for a hostile one is the part
  // that was still a document.
  const boundAt = structureBoundOffset(lengthBounded, limits.maxDepth, limits.maxElements);
  const source = boundAt === undefined ? lengthBounded : lengthBounded.slice(0, boundAt);
  const truncated = overLength || boundAt !== undefined;

  // A console with no listeners. jsdom otherwise reports a hostile page's parse
  // errors and console calls to this process's stderr, which is a remote host
  // writing to Volli's logs.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(source, {
    url,
    contentType: "text/html",
    // The defaults already refuse both, and both are stated because they are
    // the properties that make this safe rather than incidental behaviour:
    // no script ever runs, and no subresource is ever fetched.
    runScripts: undefined,
    resources: undefined,
    pretendToBeVisual: false,
    virtualConsole,
  });

  try {
    const doc = dom.window.document;
    // Before sanitising, which removes the `<meta>` elements it reads.
    const metadata = readMetadata(doc);
    sanitize(doc);
    // Before anything walks the tree for meaning. Readability's cost is a
    // function of the shape it is handed, so the shape is bounded first.
    const flattened = boundStructure(doc, limits);
    // jsdom always creates a body for a `text/html` document, so this is the
    // parser's contract rather than a hope about the page. Captured before
    // Readability runs, because `parse()` mutates the document it is given and
    // the fallback must convert what was there, not what it left.
    const body = doc.body!.innerHTML;
    const turndown = converter();
    const cut = truncated || flattened;

    const article = new Readability(doc).parse();
    // `null` is Readability's own answer for "no article here"; an article
    // whose content is empty is the same answer in a different shape.
    const content = article?.content ?? "";
    if (content.trim() !== "") {
      // Readability finds the title from `<title>`, then the page's own heading;
      // either way it is the page's word for itself, not Volli's.
      /* v8 ignore next -- the type permits a nullish title, but parse() synthesizes one from the document whenever it returns an article at all. */
      const title = (article?.title ?? "").trim();
      const heading = title === "" ? "" : `# ${title}\n\n`;
      const text = `${heading}${turndown.turndown(content)}`.trim();
      /* v8 ignore next -- unreachable today and kept anyway: Readability only returns an article once it has found several hundred characters of text, so the conversion of one cannot come back empty. That is a fact about the version of a third-party library this happens to be pinned to, not a property of the contract, and the cost of being wrong about it is the empty result the fallbacks below exist to prevent. */
      if (text !== "") return { text, extracted: true, truncated: cut };
    }

    // The two fallbacks below exist because the honest answer to "what does
    // this page say" is almost never nothing, and an empty result is worse than
    // a short one — it is indistinguishable from the fetch having failed, which
    // is what sends a reader off to run the same request without this policy in
    // front of it.

    // The whole body as Markdown: no article, but a page that is genuinely a
    // list of links, an index or a search result still has text on it.
    const whole = turndown.turndown(body).trim();
    if (whole !== "") return { text: whole, extracted: false, truncated: cut };

    // Nothing in the body at all, which is a client-rendered shell: the server
    // sent an empty mounting point and everything a reader wants arrives later
    // from scripts this boundary does not run. The head is all the page sent,
    // and the page's own word for itself beats returning nothing.
    //
    // There is no step between these two. Anything with text in the body
    // reaches the converter as text, so a body Turndown empties is a body that
    // was already empty — a visible-text pass here would be unreachable code
    // pretending to be a safety net.
    const described = [metadata.title === "" ? "" : `# ${metadata.title}`, metadata.description]
      .filter((part) => part !== "")
      .join("\n\n");
    return { text: described, extracted: false, truncated: cut };
  } finally {
    // The window holds timers and a document; without this it stays alive until
    // the collector notices, once per fetch.
    dom.window.close();
  }
}
