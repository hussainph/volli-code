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

/** The bounds extraction runs inside, beside the transport's own. */
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
   */
  htmlChars: 2 * 1024 * 1024,
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
 * Selectors for content the page itself has decided not to show.
 *
 * Invisible text is where an injection attempt hides: a paragraph positioned
 * off-screen reads identically to the model and not at all to the person who
 * looked at the page before asking for it. Removing it is not a complete
 * defence — the envelope around the result is what actually says "not
 * instructions" — but text the author hid is text nobody asked to read.
 */
const HIDDEN = [
  "[hidden]",
  '[aria-hidden="true"]',
  '[style*="display:none"]',
  '[style*="display: none"]',
];

/** Link schemes that never survive into the output. */
const UNSAFE_SCHEMES = ["javascript:", "data:", "vbscript:", "file:"];

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
  /** Whether Readability found an article, as opposed to the whole body being converted. */
  extracted: boolean;
  /** Whether the markup was cut at {@link WEB_EXTRACT_LIMITS.htmlChars} before parsing. */
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
  const truncated = html.length > limits.htmlChars;
  const source = truncated ? html.slice(0, limits.htmlChars) : html;

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
      return { text: turndown.turndown(body).trim(), extracted: false, truncated };
    }
    // Readability finds the title from `<title>`, then the page's own heading;
    // either way it is the page's word for itself, not Volli's.
    /* v8 ignore next -- the type permits a nullish title, but parse() synthesizes one from the document whenever it returns an article at all. */
    const title = (article.title ?? "").trim();
    const heading = title === "" ? "" : `# ${title}\n\n`;
    return {
      text: `${heading}${turndown.turndown(article.content)}`.trim(),
      extracted: true,
      truncated,
    };
  } finally {
    // The window holds timers and a document; without this it stays alive until
    // the collector notices, once per fetch.
    dom.window.close();
  }
}
