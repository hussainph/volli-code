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
   * Half a mebibyte rather than the two this started at, because the element
   * bound below does not constrain a page built from few, very large elements
   * and the parse itself was measured at ~2s for 2 MiB of prose. An article
   * page is 50–200 KiB of markup; this is generous against that and cheap
   * against the 25,000 characters any of it can become.
   */
  htmlChars: 512 * 1024,
  /**
   * How deep the tree may be before it is flattened.
   *
   * Real documents are shallow: a complex page nests perhaps 30 levels, and
   * anything past this is generated, broken, or built to be expensive. Deeper
   * elements are replaced by their own text rather than removed, so the words
   * survive and only the scaffolding is lost — a page cannot hide its article
   * from Volli by burying it, only its structure.
   */
  maxDepth: 64,
  /**
   * How many elements may be scored.
   *
   * Depth alone is not enough — a shallow document made of very many small
   * elements is the same bill paid the other way round, and Readability's cost
   * in element count is quadratic: measured here, 2,000 elements cost 256ms,
   * 4,000 cost 709ms, 8,000 cost 2.5s and 16,000 cost 10.8s.
   *
   * Counted in document order, so what survives is the top of the page. That
   * is what sets the number, and it is not set from the output bound: chrome
   * comes *before* the article, so the budget has to be large enough to reach
   * past a page's navigation or it cuts the very thing it was spent looking
   * for. A documentation sidebar of 2,500 links — the shape `extract.test.ts`
   * pins — is the case that decides this, and a tighter bound was measured
   * dropping that page's article on the floor.
   *
   * So: generous enough for a real page's chrome plus its article, and no more.
   * Past this the document is one a person would not have read either.
   */
  maxElements: 3_000,
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
 */
function structureBoundOffset(
  html: string,
  maxDepth: number,
  maxElements: number,
): number | undefined {
  let depth = 0;
  let elements = 0;
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) return undefined;
    // A comment or a doctype opens nothing; skip past it without counting.
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      if (close === -1) return undefined;
      index = close + 3;
      continue;
    }
    if (html.startsWith("<!", open) || html.startsWith("<?", open)) {
      const close = html.indexOf(">", open);
      if (close === -1) return undefined;
      index = close + 1;
      continue;
    }
    const closing = html.startsWith("</", open);
    const nameAt = open + (closing ? 2 : 1);
    const name = /^[a-zA-Z][^\s/>]*/.exec(html.slice(nameAt, nameAt + 64))?.[0]?.toLowerCase();
    if (name === undefined) {
      // A bare `<` in text. Not a tag, and not a reason to stop reading.
      index = open + 1;
      continue;
    }
    const close = html.indexOf(">", open);
    if (close === -1) return undefined;
    if (closing) {
      depth = Math.max(0, depth - 1);
      index = close + 1;
      continue;
    }
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const end = html.toLowerCase().indexOf(`</${name}`, close);
      index = end === -1 ? html.length : end;
      continue;
    }
    elements += 1;
    if (elements > maxElements) return open;
    // `<br/>` and friends close themselves and never nest.
    if (!VOID_ELEMENTS.has(name) && html[close - 1] !== "/") {
      depth += 1;
      if (depth > maxDepth) return open;
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
    sanitize(doc);
    // Before anything walks the tree for meaning. Readability's cost is a
    // function of the shape it is handed, so the shape is bounded first.
    const flattened = boundStructure(doc, limits);
    // jsdom always creates a body for a `text/html` document, so this is the
    // parser's contract rather than a hope about the page. `body` is captured
    // before Readability runs, because `parse()` mutates the document it is
    // given and the fallback must convert what was there, not what it left.
    const body = doc.body!.innerHTML;
    const turndown = converter();

    const article = new Readability(doc).parse();
    // `null` is Readability's own answer for "no article here"; an article
    // whose content is empty is the same answer in a different shape.
    if (article === null || article.content == null || article.content.trim() === "") {
      return {
        text: turndown.turndown(body).trim(),
        extracted: false,
        truncated: truncated || flattened,
      };
    }
    // Readability finds the title from `<title>`, then the page's own heading;
    // either way it is the page's word for itself, not Volli's.
    /* v8 ignore next -- the type permits a nullish title, but parse() synthesizes one from the document whenever it returns an article at all. */
    const title = (article.title ?? "").trim();
    const heading = title === "" ? "" : `# ${title}\n\n`;
    return {
      text: `${heading}${turndown.turndown(article.content)}`.trim(),
      extracted: true,
      truncated: truncated || flattened,
    };
  } finally {
    // The window holds timers and a document; without this it stays alive until
    // the collector notices, once per fetch.
    dom.window.close();
  }
}
