/**
 * Reading one public web document, with the socket under Volli's control.
 *
 * `@volli/shared` owns the pure question — may this URL be read, is this
 * address on the public Internet — and this module owns everything that policy
 * cannot answer from data alone: resolution, the connection, the response, and
 * the bounds on all three. It lives in `agent-runtime` rather than Electron
 * main because the runtime is hosted outside Electron by design; a boundary
 * that only exists in main is not a boundary a worker-hosted runtime has.
 *
 * The rebinding defence is the reason this uses `node:http`/`node:https`
 * directly. Validating a hostname and then handing that hostname to a client is
 * not a defence: the client resolves it again, and the second answer is the one
 * the socket uses. Here the answers are resolved once, every one of them is
 * classified, and the approved list is handed back to the client as its
 * `lookup`, so there is no second resolution to poison. The hostname is kept
 * for SNI and certificate verification; only the destination address is pinned.
 */

import { lookup as resolveHostname } from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";

import {
  admitWebTarget,
  classifyWebAddress,
  type AdmittedWebTarget,
  type RuntimeWebDocument,
  type WebScheme,
  type WebTargetRuleId,
} from "@volli/shared";

import { extractReadableMarkdown } from "./extract";

/** Every rule this module can cite, beyond the ones admission already owns. */
export const WEB_FETCH_RULE_IDS = [
  /** A hostname resolved to at least one address that is not the public Internet. */
  "fetch.address",
  /** A hostname resolved to nothing, so there is no address to approve. */
  "fetch.unresolvable",
  /** The connection failed, or the server spoke something this client could not read. */
  "fetch.transport",
  /** The server answered with a redirect, which this slice reports rather than follows. */
  "fetch.redirect",
  /** The server answered, but not with a document. */
  "fetch.status",
  /** The response was not a media type Volli reads as text. */
  "fetch.type",
  /** The response declared a character encoding Volli will not decode. */
  "fetch.charset",
  /** The response body arrived compressed, which this slice cannot bound. */
  "fetch.encoding",
  /** The response body ran past the byte bound before it ended. */
  "fetch.too-large",
  /** The document arrived intact but could not be read into text. */
  "fetch.unreadable",
  /** The host held the request past one of its deadlines. */
  "fetch.timeout",
  /** The caller withdrew the request. */
  "fetch.cancelled",
] as const;

/** A refusal's name: admission's rules, plus this module's own. */
export type WebFetchRuleId = (typeof WEB_FETCH_RULE_IDS)[number] | WebTargetRuleId;

/**
 * A refusal, thrown rather than returned because the contract's success value
 * is a document. The rule is carried beside the message so a caller can count
 * and record refusals without reading English.
 *
 * Reasons are written by Volli and never quote the server. A refusal is
 * destined for a ledger and for a model's context, and a remote host that could
 * choose its wording would have found a way to put text there without serving a
 * document Volli would accept.
 */
export class WebFetchRefusal extends Error {
  readonly rule: WebFetchRuleId;

  constructor(rule: WebFetchRuleId, reason: string) {
    super(reason);
    this.name = "WebFetchRefusal";
    this.rule = rule;
  }
}

/**
 * The longest a host may be when a refusal names it.
 *
 * Refusal text is the one thing this module hands a model *outside* the
 * untrusted-content envelope: `refusalText` presents it as Volli's own words,
 * because Volli writes it. That claim only holds while the sentence cannot be
 * filled with somebody else's writing — and once redirects are followed, the
 * host in it may have been chosen by the previous hop rather than by the
 * caller. A URL parser does not bound a hostname: `new URL()` accepts five
 * thousand characters of one quite happily, and a redirect to it produces a
 * named refusal without a single DNS packet having to succeed.
 *
 * So every host reaching a message goes through {@link named} first. Sixty-four
 * characters identifies any real host — DNS itself stops at 253, and the ones
 * people read are far shorter — while being far too little to carry an
 * instruction.
 */
const NAMED_HOST_CHARS = 64;

/**
 * One host, rendered short enough to be a name rather than a message.
 *
 * The ellipsis matters: a truncated host is visibly truncated, so a reader is
 * never shown a shortened name that looks like a whole one.
 */
function named(host: string): string {
  return host.length <= NAMED_HOST_CHARS ? host : `${host.slice(0, NAMED_HOST_CHARS)}…`;
}

/**
 * The bounds every fetch runs inside.
 *
 * Constants rather than settings: each one is a claim about what a document
 * read may cost, and widening one is a reviewed change rather than a caller's
 * choice. The character bound is the tighter reading of the research note's
 * "100 KiB or 25,000 characters" — 25,000 characters cannot exceed 100 KiB of
 * UTF-8 in the scripts this slice decodes.
 */
export const WEB_FETCH_LIMITS = {
  /** Response headers, enforced by Node's own parser. */
  headerBytes: 16 * 1024,
  /** Body bytes read off the socket, counted rather than believed. */
  bodyBytes: 5 * 1024 * 1024,
  /** Characters handed back to the caller. */
  textChars: 25_000,
  /** Connect, TLS and response headers. A host that has said nothing by here has stalled. */
  headerMs: 10_000,
  /**
   * The whole read, redirects included, so a body delivered one byte at a time
   * still ends and a chain of hops cannot renew its own deadline.
   */
  totalMs: 20_000,
  /**
   * How many redirects one read may follow.
   *
   * Not following them at all was the single largest cause of this tool failing
   * on ordinary URLs: measured across thirty real documentation and article
   * pages, five were refused outright for a redirect, and every one of the five
   * was benign — `vitejs.dev` to `vite.dev`, `docs.anthropic.com` to
   * `platform.claude.com`, a `www.` strip, and two path canonicalisations. A
   * boundary that refuses those does not protect anyone; it teaches the model
   * to reach for a shell, which is the same read with none of this policy in
   * front of it.
   *
   * Four, because real chains are short — http to https, apex to `www`, then a
   * path canonicalisation is already the long case — and because each hop is a
   * fresh admission, resolution and connection, all of it inside the one
   * {@link totalMs} budget.
   *
   * Every hop is re-admitted from scratch, so a redirect can reach no target
   * that the caller could not have named directly. What the destination may
   * *not* do is downgrade a secure read onto plain http, which is a property of
   * the move rather than of the destination and is enforced in the loop.
   */
  maxRedirects: 4,
} as const;

export type WebFetchLimits = { -readonly [K in keyof typeof WEB_FETCH_LIMITS]: number };

/** The identity Volli presents, so an operator can see who called and why. */
export const WEB_FETCH_USER_AGENT = "Volli/1.0 (+https://volli.app)";

/**
 * The media types this slice will read, and the name each is read under.
 *
 * `html` is a served kind, not a returned one: HTML is the one type whose
 * bytes are not text a model can use, so it alone goes through extraction
 * before it reaches a caller. The other two are returned as they arrived.
 */
type ServedKind = "html" | "text" | "markdown";
const READABLE_TYPES: ReadonlyMap<string, ServedKind> = new Map([
  ["text/html", "html"],
  // Served by anything publishing XHTML — the IANA registries among them — and
  // it is HTML as far as every step after this one is concerned.
  ["application/xhtml+xml", "html"],
  ["text/plain", "text"],
  ["text/markdown", "markdown"],
  ["text/x-markdown", "markdown"],
]);

/**
 * Media types refused with a reason rather than guessed at.
 *
 * These are the families whose bytes are not text in any encoding, so sniffing
 * them would only be a slower way to reach the same answer. Refusing by family
 * also gives the caller a sentence worth reading — "that is a PDF" — instead of
 * a decoder's worth of replacement characters.
 */
const UNREADABLE_FAMILIES = ["image/", "audio/", "video/", "font/"];
const UNREADABLE_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/msword",
  "application/wasm",
  "application/octet-stream",
]);

/**
 * How the served media type maps to the way this slice will read it.
 *
 * Exact match first, then the structured-syntax suffixes and the `text/*`
 * family. The suffix rules are what make this hold up against the long tail:
 * `application/atom+xml`, `application/ld+json` and `application/vnd.api+json`
 * are all text a reader can use, and none of them can be listed in advance.
 *
 * A type nobody here recognises returns `undefined`, which sends the body to
 * {@link sniffKind} rather than to a refusal. Refusing an unfamiliar label was
 * the old behaviour and it was wrong in the common direction: a server that
 * sends no `Content-Type`, or an idiosyncratic one, is far more often serving
 * an ordinary page than serving something dangerous, and the bytes themselves
 * settle it.
 */
function declaredKind(media: string): ServedKind | undefined {
  const exact = READABLE_TYPES.get(media);
  if (exact !== undefined) return exact;
  if (media.endsWith("+xml")) return "text";
  if (media.endsWith("+json")) return "text";
  if (media === "application/json" || media === "application/xml") return "text";
  // Everything else under `text/` is text by the registry's own definition:
  // `text/csv`, `text/tab-separated-values`, `text/x-rst`, and whatever is
  // registered next.
  if (media.startsWith("text/")) return "text";
  return undefined;
}

/**
 * What the bytes look like, when the server would not say.
 *
 * Only ever reached for a type this module could not name, and it answers with
 * the two things it can tell apart: markup, and not-markup. A body holding NUL
 * bytes is binary in every encoding this decodes and is refused outright — that
 * is the check standing between an unlabelled response and a decoder asked to
 * read a PNG as prose.
 *
 * Deliberately shallow. It looks at the head of the body, matches the two
 * openings that mean HTML, and otherwise says text; a sniffer that tried to be
 * clever here would be a second content-type parser with its own disagreements.
 */
function sniffKind(body: Buffer): ServedKind | undefined {
  const head = body.subarray(0, 1024);
  if (head.includes(0)) return undefined;
  const start = head.toString("latin1").trimStart().toLowerCase();
  if (
    start.startsWith("<!doctype html") ||
    start.startsWith("<html") ||
    start.startsWith("<?xml")
  ) {
    return "html";
  }
  return "text";
}

/**
 * The label to decode a body under, and whether it was worth trusting.
 *
 * A charset allowlist used to guard this, and it refused every page outside a
 * seven-label list — which is to say every page in Japanese, Chinese, Korean,
 * Greek, Hebrew or Cyrillic that had not moved to UTF-8. That is a large part
 * of the web answered with "Volli does not decode that" when the decoder in
 * Node reads all of them: `TextDecoder` implements the WHATWG encoding set, and
 * asking it is both more complete and more honest than a list maintained here.
 *
 * Unknown labels fall back to UTF-8 rather than refusing. Decoding is not
 * parsing — whatever comes out is sanitised, extracted and bounded exactly like
 * any other page — so the cost of guessing wrong is mojibake in the output, and
 * the cost of refusing is the whole document.
 */
function decoderFor(label: string): TextDecoder {
  try {
    // Non-fatal so a byte that is not valid in the declared encoding becomes
    // U+FFFD instead of throwing away the page around it.
    return new TextDecoder(label, { fatal: false });
  } catch {
    return new TextDecoder("utf-8", { fatal: false });
  }
}

/**
 * The encoding a document is actually in, in the order the evidence counts.
 *
 * A byte-order mark is the document's own statement and outranks the header,
 * which is often a server default nobody set. The header comes next. Failing
 * both, an HTML document usually says so in its own `<meta>`, which is where
 * the answer lives for the many pages served as bare `text/html`.
 */
function charsetFor(body: Buffer, declared: string | undefined, kind: ServedKind): string {
  if (body.length >= 2) {
    if (body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
    if (body[0] === 0xfe && body[1] === 0xff) return "utf-16be";
  }
  if (declared !== undefined && declared !== "") return declared;
  if (kind === "html") {
    // The head only: past this a `charset=` is page content rather than a
    // declaration, and the declaration is required to be near the top.
    const head = body.subarray(0, 2048).toString("latin1");
    const found =
      /<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_:.-]+)/i.exec(head)?.[1] ??
      /<\?xml[^>]+encoding\s*=\s*["']([a-zA-Z0-9_:.-]+)/i.exec(head)?.[1];
    if (found !== undefined) return found.toLowerCase();
  }
  return "utf-8";
}

/** One address a hostname resolved to, in the shape `node:dns` reports it. */
export interface WebFetchAddress {
  readonly address: string;
  readonly family: number;
}

/** Resolve every address a socket could reach for this hostname. */
export type WebAddressResolver = (hostname: string) => Promise<readonly WebFetchAddress[]>;

/**
 * The resolver Volli actually uses.
 *
 * `all: true` because one answer is not the question: a name with an A record
 * and a AAAA record has two ways to be reached, and approving the first one a
 * client happened to pick would leave the other unexamined.
 *
 * The system resolver rather than a direct nameserver query, so this sees what
 * this machine sees — hosts file included. A name a user has pointed at their
 * own machine is exactly the case that must reach classification, and a query
 * that went straight to DNS would never learn about it.
 */
export const resolveWebAddresses: WebAddressResolver = async (hostname) =>
  await resolveHostname(hostname, { all: true, verbatim: true });

/** The options Volli hands the HTTP client. Exported so a test can read them. */
export type WebRequestOptions = RequestOptions;

/** Turn one prepared request into a live one. */
export type WebRequestOpener = (scheme: WebScheme, options: WebRequestOptions) => ClientRequest;

/**
 * The client Volli actually uses.
 *
 * `node:https` for a secure target and `node:http` for a plain one, chosen from
 * the admitted scheme rather than from anything the response can influence, so
 * an https target cannot end up on a plain socket. Neither client reads a proxy
 * environment variable, keeps a cookie jar, or carries ambient credentials, and
 * no option here relaxes certificate or hostname verification.
 */
export const openWebRequest: WebRequestOpener = (scheme, options) =>
  scheme === "https" ? httpsRequest(options) : httpRequest(options);

/**
 * What one successful read returns.
 *
 * The shape is declared in `@volli/shared` as {@link RuntimeWebDocument},
 * because the Session spec offers this document as a port and that package owns
 * the spec. One declaration, two names: the runtime keeps its own word for it,
 * and neither side can drift from the other.
 */
export type SafeWebFetchResult = RuntimeWebDocument;

/** The narrow port the runtime is given. One URL in, one bounded document out. */
export interface SafeWebFetch {
  fetch(input: { url: string; signal: AbortSignal }): Promise<SafeWebFetchResult>;
}

/** Seams a test replaces. Production supplies none of them. */
export interface SafeWebFetchOptions {
  resolve?: WebAddressResolver;
  open?: WebRequestOpener;
  /**
   * Bounds, overridable so a test can prove a deadline in milliseconds rather
   * than in the twenty real seconds the product waits. Production passes none.
   */
  limits?: WebFetchLimits;
}

/**
 * The addresses this fetch is allowed to reach, or a refusal.
 *
 * Every answer is judged, not just the one a client would have picked: a
 * hostname that resolves to one public address and one link-local address is a
 * hostname whose operator is aiming at something local, and which address a
 * connection ends up on is not this policy's to gamble on.
 *
 * The refused address is named in the reason. In production these strings come
 * from `node:dns` and are always IP literals, so this cannot become a channel
 * for arbitrary remote text.
 */
function pinAddresses(
  hostname: string,
  addresses: readonly WebFetchAddress[],
): readonly WebFetchAddress[] {
  // Nothing to connect to is a refusal, not an empty success: a resolver that
  // returns no answers has told us it could not say where this name lives.
  if (addresses.length === 0) {
    throw new WebFetchRefusal(
      "fetch.unresolvable",
      `${named(hostname)} did not resolve to any address.`,
    );
  }
  for (const candidate of addresses) {
    const verdict = classifyWebAddress(candidate.address);
    if (verdict.outcome === "refuse") {
      throw new WebFetchRefusal(
        "fetch.address",
        `${named(hostname)} resolves to ${candidate.address}, which is not on the public Internet: ${verdict.reason}`,
      );
    }
  }
  return addresses;
}

/**
 * The client's resolver, replaced by the answers already approved.
 *
 * Node asks with `all: true`; the single-answer shape is honoured too, because
 * a lookup that returned the wrong shape would fail open into the client's own
 * DNS path, which is the exact hole this closes.
 *
 * Exported for `./search.ts`, which reaches a different kind of endpoint under a
 * different policy but must pin its socket the same way. One implementation of
 * the trick, so neither boundary can drift into resolving twice.
 */
export function pinnedLookup(
  addresses: readonly WebFetchAddress[],
): NonNullable<RequestOptions["lookup"]> {
  const answers = addresses.map(({ address, family }) => ({ address, family }));
  return ((_hostname, options, callback) => {
    const [first] = answers;
    if (options.all === true || first === undefined) {
      callback(null, answers as never);
      return;
    }
    callback(null, first.address as never, first.family);
  }) as NonNullable<RequestOptions["lookup"]>;
}

/**
 * The request Volli sends, in full.
 *
 * Nothing here comes from the caller but the target itself: one method, one
 * header set, no cookie jar, no `Authorization`, no proxy. `node:http` reads no
 * proxy environment variable of its own, so "no proxy" is a property of using
 * this client rather than a setting to remember. `agent: false` gives the
 * request its own connection rather than a pooled one from a shared agent.
 */
function requestOptions(
  target: AdmittedWebTarget,
  url: URL,
  addresses: readonly WebFetchAddress[],
  limits: WebFetchLimits,
): WebRequestOptions {
  return {
    protocol: `${target.scheme}:`,
    hostname: target.hostname,
    port: target.port,
    // The fragment is deliberately absent: it is never sent, and rebuilding the
    // path from the parsed URL is what keeps it that way.
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: {
      "user-agent": WEB_FETCH_USER_AGENT,
      // Preference-ordered rather than equal: a host that can serve Markdown or
      // plain text hands back bytes that need no extraction, and one that
      // cannot serves the HTML it would have served anyway. Asking for HTML
      // first would make every negotiation return the one type that costs the
      // most to read.
      //
      // The catch-all on the end is not decoration. A server that honours
      // `Accept` strictly and serves something outside this list — XHTML, an
      // API's JSON, `text/x-rst` — answers 406 without it, which is a document
      // Volli can read refused over a header Volli sent.
      accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1",
      // Identity only. A compressed body is a decompression bound this slice
      // has not written, and asking for one Volli cannot police is careless.
      "accept-encoding": "identity",
    },
    agent: false,
    lookup: pinnedLookup(addresses),
    maxHeaderSize: limits.headerBytes,
    // The name, never the pinned address: TLS verifies the certificate against
    // the host the user asked for, and an IP here would quietly stop that.
    servername: target.hostname,
  };
}

/** Read one header as a single value; a repeated header is not a place to guess. */
function header(response: IncomingMessage, name: string): string | undefined {
  const value = response.headers[name];
  /* v8 ignore next -- Node joins repeats of every header read here; only set-cookie arrives as an array, and this never reads it. */
  return Array.isArray(value) ? value[0] : value;
}

/** Split `text/html; charset=utf-8` into the two decisions it carries. */
function contentType(response: IncomingMessage): { media: string; charset: string | undefined } {
  const raw = header(response, "content-type") ?? "";
  const [media = "", ...parameters] = raw.split(";");
  const charset = parameters
    .map((parameter) => parameter.trim().toLowerCase())
    .find((parameter) => parameter.startsWith("charset="))
    ?.slice("charset=".length)
    .replaceAll('"', "");
  // Absent rather than defaulted: "the server said nothing" is what sends
  // `charsetFor` to the document's own declaration, and a default here would
  // answer that question before it was asked.
  return { media: media.trim().toLowerCase(), charset };
}

/**
 * Turn validated bytes into the bounded document a caller reads.
 *
 * For the two media types that are already text, the body is the document and
 * the only question is the bound. For HTML it is not: the body is markup whose
 * article is usually a minority of its bytes, so it goes through extraction
 * first and the bound is applied to what comes out. That order is the whole
 * defence against chrome-heavy pages — bounding the markup would spend the
 * budget on the `<head>` before the article began, which on a documentation
 * site is a table of contents and nothing else.
 */
function document(
  requestedUrl: string,
  target: AdmittedWebTarget,
  url: URL,
  response: IncomingMessage,
  body: Buffer,
  limits: WebFetchLimits,
): SafeWebFetchResult {
  const { media, charset } = contentType(response);
  if (UNREADABLE_TYPES.has(media) || UNREADABLE_FAMILIES.some((one) => media.startsWith(one))) {
    throw new WebFetchRefusal(
      "fetch.type",
      `${named(target.hostname)} served ${media}, which is not a document Volli reads as text.`,
    );
  }
  // A type this module knows, or failing that whatever the bytes say they are.
  const kind = declaredKind(media) ?? sniffKind(body);
  if (kind === undefined) {
    throw new WebFetchRefusal(
      "fetch.type",
      `${named(target.hostname)} served a document Volli does not read as text.`,
    );
  }
  const decoded = decoderFor(charsetFor(body, charset, kind)).decode(body);

  let text: string;
  let truncated: boolean;
  // `html` is narrowed away here, so what reaches the contract is exactly the
  // two kinds the contract allows: text that arrived as text, and text that
  // had to be taken out of markup to exist.
  let returned: Exclude<ServedKind, "html">;
  if (kind === "html") {
    // Extraction is bounded, but it is a parser and two converters over hostile
    // markup, and a bound is a claim about the shapes we thought of. A page that
    // finds a way to make one of them throw gets a named refusal rather than an
    // exception crossing the boundary — this runs in Electron's main process,
    // where an unhandled throw is the whole app rather than one fetch.
    let extracted;
    try {
      extracted = extractReadableMarkdown(decoded, target.url);
    } catch {
      throw new WebFetchRefusal(
        "fetch.unreadable",
        `${named(target.hostname)} served a document Volli could not read.`,
      );
    }
    text = extracted.text;
    truncated = extracted.truncated || extracted.text.length > limits.textChars;
    returned = "markdown";
  } else {
    text = decoded;
    truncated = decoded.length > limits.textChars;
    returned = kind;
  }
  // An empty document is the one answer that helps nobody. It reads as a broken
  // tool rather than as a fact about the page, and a model that gets one
  // reaches for the shell to run the same read without this policy in front of
  // it — the exact failure this boundary exists to make unnecessary. Extraction
  // already falls back through the whole body, its visible text and finally the
  // page's own metadata, so arriving here means the response genuinely carried
  // no text at all, and saying so is both true and actionable.
  if (text.trim() === "") {
    throw new WebFetchRefusal(
      "fetch.unreadable",
      `${named(target.hostname)} served a page with no readable text in it; its content is probably rendered by scripts, which Volli does not run.`,
    );
  }
  return {
    requestedUrl,
    finalUrl: target.url,
    origin: url.origin,
    contentType: returned,
    text: truncated ? text.slice(0, limits.textChars) : text,
    truncated,
  };
}

/**
 * One hop's outcome: the document, or somewhere else to look.
 *
 * A redirect is returned rather than followed here, because following it is a
 * policy decision and this function performs no policy. The loop above takes
 * the location back through admission, resolution and pinning from the top.
 */
type HopResult =
  | { outcome: "document"; document: SafeWebFetchResult }
  | { outcome: "redirect"; location: string; status: number };

/** Build the fetcher. */
export function createSafeWebFetch(options: SafeWebFetchOptions = {}): SafeWebFetch {
  const resolve = options.resolve ?? resolveWebAddresses;
  const open = options.open ?? openWebRequest;
  const limits = options.limits ?? WEB_FETCH_LIMITS;

  /**
   * Admit, resolve and pin one URL, then read what is at the end of it.
   *
   * Every hop runs this whole function, and that is the property that makes
   * following a redirect safe: a redirected target gets the same admission, the
   * same address classification and the same pinned connection as a URL a
   * person typed. Nothing is carried over from the previous hop but the
   * deadline the caller is waiting on.
   */
  async function hop(
    requestedUrl: string,
    href: string,
    signal: AbortSignal,
    started: number,
  ): Promise<HopResult> {
    const admission = admitWebTarget(href);
    if (admission.outcome === "refuse") {
      throw new WebFetchRefusal(admission.rule, admission.reason);
    }
    const { target } = admission;
    // A resolver that throws has said the same thing as one that answers
    // nothing, and the caller gets Volli's word for it rather than a system
    // error carrying a hostname and an errno through the transcript.
    let answers: readonly WebFetchAddress[];
    try {
      answers = await resolve(target.hostname);
    } catch {
      throw new WebFetchRefusal(
        "fetch.unresolvable",
        `${named(target.hostname)} could not be resolved.`,
      );
    }
    const addresses = pinAddresses(target.hostname, answers);
    // Asked twice, because resolution takes real time and the listener that
    // watches for a withdrawal is only installed once the request exists. A
    // turn interrupted inside that window would otherwise still open a socket
    // and still hand back a page — and an `abort` listener added to a signal
    // that has already fired is never called, so without this check the
    // withdrawal is not merely late, it is lost.
    if (signal.aborted) {
      throw new WebFetchRefusal(
        "fetch.cancelled",
        `The request to ${named(target.hostname)} was cancelled before it was sent.`,
      );
    }
    // Parsing the href admission produced, not the caller's string: this is
    // the URL the policy accepted, already canonical, and re-reading it is
    // how the path reaches the socket without a second interpretation of the
    // original input.
    const url = new URL(target.url);

    return await new Promise<HopResult>((settle, refuse) => {
      const request = open(target.scheme, requestOptions(target, url, addresses, limits));

      // Two deadlines rather than an inactivity timer: a host that answers a
      // byte at a time is never idle, and would hold a socket open forever
      // under a timer that only watches for silence.
      //
      // The total one is measured from when the *caller's* read began rather
      // than from this hop, so a chain of redirects cannot buy itself twenty
      // fresh seconds per hop. Whatever is left of the budget is what this
      // hop gets, and a chain that has already spent it stops here.
      const remaining = Math.max(0, limits.totalMs - (Date.now() - started));
      const deadlines = [
        setTimeout(() => stop("before answering"), Math.min(limits.headerMs, remaining)),
        setTimeout(() => stop("before finishing"), remaining),
      ];
      function stop(when: string): void {
        abandon();
        request.destroy();
        refuse(
          new WebFetchRefusal(
            "fetch.timeout",
            `${named(target.hostname)} ran out of time ${when}.`,
          ),
        );
      }

      // One cleanup for every way out, including the ordinary one: a deadline
      // left armed keeps a process awake, and a listener left on a long-lived
      // signal is a leak per fetch.
      function abandon(): void {
        for (const deadline of deadlines) clearTimeout(deadline);
        signal.removeEventListener("abort", cancel);
      }

      function cancel(): void {
        abandon();
        request.destroy();
        refuse(
          new WebFetchRefusal(
            "fetch.cancelled",
            `The request to ${named(target.hostname)} was cancelled.`,
          ),
        );
      }

      signal.addEventListener("abort", cancel, { once: true });
      request.on("close", abandon);

      request.on("error", (error) => {
        // Node's own code for the failure — `ECONNRESET`, `HPE_HEADER_OVERFLOW`
        // — which is generated here rather than chosen by the host, so it can
        // be recorded without quoting the other end.
        const code = (error as NodeJS.ErrnoException).code ?? error.name;
        refuse(
          new WebFetchRefusal(
            "fetch.transport",
            `Volli could not read ${named(target.hostname)}: the connection failed (${code}).`,
          ),
        );
      });

      request.on("response", (response) => {
        clearTimeout(deadlines[0]);
        /* v8 ignore next -- a parsed response always carries a status; 0 refuses below rather than reading a headless answer as success. */
        const status = response.statusCode ?? 0;
        // A redirect is a new target, and a new target is a new policy
        // decision — not something a response header gets to make on Volli's
        // behalf. So it is handed back rather than followed here, and the loop
        // puts it through admission, classification and pinning from the top.
        if (status >= 300 && status <= 399) {
          const location = header(response, "location")?.trim();
          request.destroy();
          if (location === undefined || location === "") {
            refuse(
              new WebFetchRefusal(
                "fetch.redirect",
                `${named(target.hostname)} answered ${status} without saying where to look instead.`,
              ),
            );
            return;
          }
          // Resolved against the URL this hop actually used, so a relative
          // `Location` — which is most of them — becomes an absolute target
          // the policy can judge. A `Location` that is not a URL at all is a
          // refusal rather than a guess.
          let next: string;
          try {
            next = new URL(location, url).href;
          } catch {
            refuse(
              new WebFetchRefusal(
                "fetch.redirect",
                `${named(target.hostname)} answered ${status} pointing somewhere Volli cannot read as a URL.`,
              ),
            );
            return;
          }
          settle({ outcome: "redirect", location: next, status });
          return;
        }
        // An error page is a page. It is written by the same host, arrives
        // with the same content type, and saying "404" is more use to a
        // caller than handing its body onward as though it were the document
        // that was asked for.
        if (status < 200 || status > 299) {
          request.destroy();
          refuse(
            new WebFetchRefusal(
              "fetch.status",
              `${named(target.hostname)} answered ${status} rather than serving the document.`,
            ),
          );
          return;
        }
        // Volli asked for `identity`. A server that compresses anyway has
        // handed back bytes whose decompressed size is its choice rather than
        // this module's, and the byte bound below counts what arrives on the
        // socket — which is the small half of a compression bomb.
        const encoding = header(response, "content-encoding")?.trim().toLowerCase();
        if (encoding !== undefined && encoding !== "" && encoding !== "identity") {
          request.destroy();
          refuse(
            new WebFetchRefusal(
              "fetch.encoding",
              `${named(target.hostname)} compressed its answer, which Volli cannot bound in this slice.`,
            ),
          );
          return;
        }
        // `Content-Length` is a claim, and this is the only thing Volli does
        // with it: refuse early when the server itself says the body is over
        // the bound. It is never used to decide when reading is finished, and
        // never believed in the other direction — the count below is what
        // actually stops the read.
        const declared = Number(header(response, "content-length"));
        if (Number.isFinite(declared) && declared > limits.bodyBytes) {
          request.destroy();
          refuse(
            new WebFetchRefusal(
              "fetch.too-large",
              `${named(target.hostname)} declared a body over the ${limits.bodyBytes} byte bound.`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > limits.bodyBytes) {
            request.destroy();
            refuse(
              new WebFetchRefusal(
                "fetch.too-large",
                `${named(target.hostname)} served more than ${limits.bodyBytes} bytes.`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            settle({
              outcome: "document",
              document: document(
                requestedUrl,
                target,
                url,
                response,
                Buffer.concat(chunks),
                limits,
              ),
            });
          } catch (error) {
            refuse(error);
          }
        });
      });

      request.end();
    });
  }

  return {
    async fetch(input) {
      // Before admission, resolution or a socket: a withdrawn request is work
      // nobody is waiting for, and the cheapest place to notice is first.
      if (input.signal.aborted) {
        throw new WebFetchRefusal("fetch.cancelled", "The request was cancelled before it ran.");
      }
      // The whole chain shares one clock, so redirects cannot extend the read
      // past the deadline the caller agreed to.
      const started = Date.now();
      // The URL the caller asked for, canonical as admission normalized it,
      // reported on the document however many hops it took to reach.
      const admission = admitWebTarget(input.url);
      if (admission.outcome === "refuse") {
        throw new WebFetchRefusal(admission.rule, admission.reason);
      }
      const requestedUrl = admission.target.url;

      // Every URL this read has already been sent to. A redirect back to one of
      // them is a loop, and a loop that is merely bounded by the hop count
      // spends the whole budget discovering what the first repeat already said.
      const seen = new Set<string>([requestedUrl]);
      let href = requestedUrl;
      let scheme = admission.target.scheme;

      for (let followed = 0; ; followed += 1) {
        const result = await hop(requestedUrl, href, input.signal, started);
        if (result.outcome === "document") return result.document;
        if (followed >= limits.maxRedirects) {
          throw new WebFetchRefusal(
            "fetch.redirect",
            `Reading ${requestedUrl} passed through ${limits.maxRedirects} redirects without reaching a document.`,
          );
        }
        // Judged here rather than inside admission, because it is the one rule
        // that is about the *move* rather than about the destination: an https
        // URL that ends on a plain-http hop has been quietly downgraded, and the
        // caller asked for a verified connection. The reverse is ordinary and
        // permitted — http to https is every site's canonical redirect.
        const destination = new URL(result.location);
        if (scheme === "https" && destination.protocol === "http:") {
          throw new WebFetchRefusal(
            "fetch.redirect",
            `Reading ${requestedUrl} was redirected from https onto plain http at ${named(
              destination.hostname,
            )}, which Volli does not follow.`,
          );
        }
        if (seen.has(destination.href)) {
          // The host, never the href. A `Location` carries a path and a query
          // the server wrote, and this sentence is delivered outside the
          // untrusted-content envelope as Volli's own words — so quoting the
          // whole URL here would hand a redirect the one thing the envelope
          // exists to deny it. Measured before this was written: a self-
          // redirecting `Location` put 10,003 characters of the server's
          // choosing into the refusal.
          throw new WebFetchRefusal(
            "fetch.redirect",
            `Reading ${requestedUrl} came back to a URL at ${named(
              destination.hostname,
            )} it had already followed, so the redirects are a loop.`,
          );
        }
        seen.add(destination.href);
        href = destination.href;
        scheme = destination.protocol === "https:" ? "https" : "http";
      }
    },
  };
}

export type { WebScheme };
