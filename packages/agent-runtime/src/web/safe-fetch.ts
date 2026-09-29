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
import {
  STATUS_CODES,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
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
import { GITHUB_API_HOST, githubDirectoryFor, githubListing, githubRead } from "./github";

/** Every rule this module can cite, beyond the ones admission already owns. */
export const WEB_FETCH_RULE_IDS = [
  /** A hostname resolved to at least one address that is not the public Internet. */
  "fetch.address",
  /** A hostname resolved to nothing, so there is no address to approve. */
  "fetch.unresolvable",
  /** The connection failed, or the server spoke something this client could not read. */
  "fetch.transport",
  /** A redirect chain that ended without a document: a loop, no destination, or too many hops. */
  "fetch.redirect",
  /** A redirect that would have moved a secure read onto plain http. */
  "fetch.downgrade",
  /** The server answered with an HTTP error status instead of the document. */
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
 * The rules that report what happened to a read rather than a policy that
 * stopped one.
 *
 * The line this draws is the one a model acts on. A 404, a timeout or a host
 * that does not resolve is a fact about the URL or the network — the same fact
 * any client would have met — and the useful response is a better URL or a
 * later retry. A non-public address, a disallowed scheme or a type Volli does
 * not read is Volli's policy, and there the useful response is to stop. Telling
 * a model that a 404 was "refused" and "must not be attempted another way" was
 * measured doing the opposite of both: in the owner's transcripts a plain HTTP
 * status was the most common web refusal by far — more than every other rule
 * put together — and the models that met one read a policy wall and gave up or
 * went to `curl`.
 */
const OUTCOME_RULES: ReadonlySet<WebFetchRuleId> = new Set([
  "fetch.status",
  "fetch.unresolvable",
  "fetch.transport",
  "fetch.redirect",
  "fetch.unreadable",
  "fetch.timeout",
  "fetch.cancelled",
]);

/**
 * Whether a read stopped at Volli's policy or at what the world answered.
 *
 * `policy`: Volli judged the request and declined it; the request is not the
 * caller's to adjust. `outcome`: the request was allowed and made (or was being
 * made), and the server or the network is what said no.
 */
export type WebFetchRefusalKind = "policy" | "outcome";

/**
 * A read that did not produce a document, thrown rather than returned because
 * the contract's success value is a document. The rule is carried beside the
 * message so a caller can count and record these without reading English, and
 * {@link kind} says whether it was a policy or an outcome.
 *
 * The name predates that split and is kept because every caller already names
 * it: a `fetch.status` "refusal" is an HTTP error reported as the fact it is,
 * and the tool that renders it says so in those words.
 *
 * Reasons are written by Volli and never quote the server. A refusal is
 * destined for a ledger and for a model's context, and a remote host that could
 * choose its wording would have found a way to put text there without serving a
 * document Volli would accept. {@link status} is a number, and the phrase shown
 * beside it is Node's, not the server's.
 */
export class WebFetchRefusal extends Error {
  readonly rule: WebFetchRuleId;
  readonly kind: WebFetchRefusalKind;
  /** The HTTP status a server answered with, for `fetch.status` alone. */
  readonly status: number | undefined;

  constructor(rule: WebFetchRuleId, reason: string, status?: number) {
    super(reason);
    this.name = "WebFetchRefusal";
    this.rule = rule;
    this.kind = OUTCOME_RULES.has(rule) ? "outcome" : "policy";
    this.status = status;
  }
}

/** `404 Not Found`: the number the server sent, and the standard phrase for it. */
export function httpStatusLine(status: number): string {
  const phrase = STATUS_CODES[status];
  return phrase === undefined ? `HTTP ${status}` : `${status} ${phrase}`;
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
/**
 * Where an unreadable type's refusal says what it was, in words a model can
 * act on rather than a media type it has to decode.
 */
const UNREADABLE_NOUNS: ReadonlyMap<string, string> = new Map([
  ["image/", "an image"],
  ["audio/", "audio"],
  ["video/", "video"],
  ["font/", "a font"],
  ["application/pdf", "a PDF"],
]);
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
]);

/**
 * Types that are text by any reading but whose names say so in no suffix.
 *
 * Source files are the point: a CDN serving `lib/index.ts` as
 * `application/typescript`, or a shell script as `application/x-sh`, is
 * serving exactly the text a model reading code wants. SVG is here rather than
 * under `image/` because an SVG *is* its source — XML a reader can use — where
 * every other image is bytes.
 */
const TEXT_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/ecmascript",
  "application/typescript",
  "application/x-typescript",
  "application/x-sh",
  "application/x-shellscript",
  "application/toml",
  "application/yaml",
  "application/x-yaml",
  "application/sql",
  "application/graphql",
  "application/x-ndjson",
  "application/jsonl",
  "application/x-python",
  "application/x-ruby",
  "application/x-httpd-php",
  "image/svg+xml",
]);

/** The words a refusal uses for a type Volli does not read. */
function unreadableNoun(media: string): string {
  for (const [prefix, noun] of UNREADABLE_NOUNS) if (media.startsWith(prefix)) return noun;
  return "a binary file";
}

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
  if (TEXT_TYPES.has(media)) return "text";
  if (media.endsWith("+xml")) return "text";
  if (media.endsWith("+json")) return "text";
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
 * `application/octet-stream` lands here too rather than being refused by name.
 * It is what CDNs and object stores label any file whose extension they do not
 * map — which for code research is most source files — and the bytes settle
 * whether it is a release archive or a `.rs` file far better than the label.
 * Beside the NUL check, a head that is more than a tenth control bytes is
 * binary too: some formats go a long way before their first zero.
 *
 * Deliberately shallow. It looks at the head of the body, matches the two
 * openings that mean HTML, and otherwise says text; a sniffer that tried to be
 * clever here would be a second content-type parser with its own disagreements.
 */
function sniffKind(body: Buffer): ServedKind | undefined {
  const head = body.subarray(0, 1024);
  if (head.includes(0)) return undefined;
  // Tab, line feed, vertical tab, form feed, carriage return and escape are
  // what text files actually carry; every other C0 byte, and DEL, is not.
  const control = head.filter(
    (byte) =>
      (byte < 0x20 && ![0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b].includes(byte)) || byte === 0x7f,
  ).length;
  if (control * 10 > head.length) return undefined;
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
 * What a refusal adds when a name resolved into benchmarking space.
 *
 * No public site lives in 198.18.0.0/15, but a great many machines resolve
 * every name into it: proxy and VPN clients running "fake-IP" DNS (Clash,
 * Surge, Stash, sing-box and their kin) hand out addresses from exactly this
 * range and map each one back to a hostname inside the tunnel. The refusal is
 * still right — from here, a fake-IP answer and a hostile DNS record pointing
 * at a range nobody routes are the same answer, and the proxy that would
 * receive the connection can reach whatever it was configured to, private
 * networks included. What changes is what the reader should do about it, which
 * is nothing a model can: the person running the machine can switch the proxy
 * to real-IP DNS, or exclude the host from its fake-IP range.
 */
const FAKE_IP_NOTE =
  " On this machine that usually means a local proxy or VPN is answering DNS in fake-IP mode; the person running it can switch that proxy to real-IP DNS, or exempt this host from fake-IP, for Volli to read it.";

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
        `${named(hostname)} resolves to ${candidate.address}, which is not on the public Internet: ${verdict.reason}${
          verdict.class === "benchmarking" ? FAKE_IP_NOTE : ""
        }`,
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
      //
      // GitHub's API is asked in its own media type, which is what its
      // documentation says every client should send and what keeps its
      // answers in the stable JSON shape the directory listing reads.
      accept:
        target.hostname === GITHUB_API_HOST
          ? "application/vnd.github+json, application/json;q=0.9, */*;q=0.1"
          : "text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1",
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
  read: GithubReadKind | undefined,
): SafeWebFetchResult {
  const { media, charset } = contentType(response);
  // A type this module knows, or failing that whatever the bytes say they are.
  // Asked before the unreadable families, because `image/svg+xml` is the one
  // `image/` type that is text.
  const declared = declaredKind(media);
  if (
    declared === undefined &&
    (UNREADABLE_TYPES.has(media) || UNREADABLE_FAMILIES.some((one) => media.startsWith(one)))
  ) {
    throw new WebFetchRefusal(
      "fetch.type",
      `${named(target.hostname)} served ${media}, which is ${unreadableNoun(media)}. ${TEXT_ONLY}`,
    );
  }
  const kind = declared ?? sniffKind(body);
  if (kind === undefined) {
    throw new WebFetchRefusal(
      "fetch.type",
      `${named(target.hostname)} served binary data rather than text. ${TEXT_ONLY}`,
    );
  }
  let decoded = decoderFor(charsetFor(body, charset, kind)).decode(body);
  // Read from the whole body, before any bound: the contents API spends around
  // five hundred characters of JSON on each entry, so cutting the JSON first
  // would list a fiftieth of a large directory and then fail to parse it.
  const listing = read === "directory" ? githubListing(decoded) : undefined;
  if (listing !== undefined) decoded = listing;

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
    ...(read === "raw-file" ? { via: "github-raw-file" as const } : {}),
    ...(listing === undefined ? {} : { via: "github-directory-listing" as const }),
  };
}

/** What a type refusal says Volli does read, so the next URL can be a better one. */
const TEXT_ONLY =
  "Volli reads text: web pages, Markdown, plain text, JSON, XML and source files, not images, audio, video, fonts, PDFs or archives.";

type GithubReadKind = NonNullable<ReturnType<typeof githubRead>>["kind"];

/**
 * A number of seconds a header states, read only if it is one.
 *
 * `Retry-After` may be a count of seconds or an HTTP date, and
 * `X-RateLimit-Reset` is a Unix time; anything else is ignored rather than
 * quoted, which is what keeps these headers from being a way for a server to
 * put words in Volli's sentence. Capped at a day, past which "later" is the
 * more honest thing to say.
 */
function secondsFrom(value: string | undefined, epoch: boolean): number | undefined {
  const trimmed = value?.trim() ?? "";
  let seconds: number;
  if (/^\d{1,12}$/.test(trimmed)) {
    seconds = epoch ? Number(trimmed) - Math.floor(Date.now() / 1000) : Number(trimmed);
  } else if (!epoch && trimmed.length <= 64 && !Number.isNaN(Date.parse(trimmed))) {
    seconds = Math.round((Date.parse(trimmed) - Date.now()) / 1000);
  } else {
    return undefined;
  }
  if (seconds > 86_400) return undefined;
  return Math.max(0, seconds);
}

/** "in 42 seconds", "in about 7 minutes": a wait a reader can plan around. */
function waitPhrase(seconds: number): string {
  if (seconds < 120) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  return `about ${Math.ceil(seconds / 60)} minutes`;
}

/**
 * What an HTTP error status means for the caller's next step.
 *
 * Every sentence is Volli's: the status is a number, the phrase is Node's
 * table, and the only headers read are the ones that are numbers. The GitHub
 * cases are named because they were the bulk of the measured failures — 404s
 * on guessed `raw.githubusercontent.com` paths, and the API's hourly limit for
 * callers without a token — and both have a concrete better move.
 */
function statusRefusal(
  status: number,
  response: IncomingMessage,
  target: AdmittedWebTarget,
  requestedUrl: string,
): WebFetchRefusal {
  const host = named(target.hostname);
  const retry = secondsFrom(header(response, "retry-after"), false);
  let reason: string;
  if (
    target.hostname === GITHUB_API_HOST &&
    (status === 403 || status === 429) &&
    header(response, "x-ratelimit-remaining")?.trim() === "0"
  ) {
    const reset = secondsFrom(header(response, "x-ratelimit-reset"), true);
    reason = [
      "GitHub's API rate limit for requests without a token is used up for this machine's address",
      reset === undefined ? "; it resets within the hour." : `; it resets in ${waitPhrase(reset)}.`,
      " Until then, read files through their github.com blob URLs or raw.githubusercontent.com, which do not count against it; directory listings (tree URLs) and api.github.com do.",
    ].join("");
  } else if (status === 429) {
    reason = `${host} is rate limiting requests${
      retry === undefined ? "" : ` and asked for a retry after ${waitPhrase(retry)}`
    }. Wait before reading from it again, or read the same content from another source.`;
  } else if (status === 404 || status === 410) {
    // Built from the URL the caller asked for, so it points at their own
    // repository rather than anywhere a redirect chose.
    const directory = githubDirectoryFor(new URL(requestedUrl));
    reason =
      directory === undefined
        ? `${host} has no document at that URL. Check the path, or use web_search to find where it lives.`
        : `GitHub has no file at that path and ref. The ref or the path is probably wrong (a default branch may be main or master, and files move); list the directory at ${named(directory)} to see which files exist.`;
  } else if (status === 401 || status === 403 || status === 407) {
    reason = `${host} would not serve it without access Volli does not have; Volli sends no cookies or credentials. Look for a public copy of the same content.`;
  } else if (status >= 500) {
    reason = `${host} failed to serve it${
      retry === undefined ? "" : ` and asked for a retry after ${waitPhrase(retry)}`
    }. This is the server's error; reading it again later may work.`;
  } else {
    reason = `${host} rejected the request. Check the URL, or read the same content from another source.`;
  }
  return new WebFetchRefusal("fetch.status", reason, status);
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
  | { outcome: "redirect"; location: string };

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
    read: GithubReadKind | undefined,
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
          settle({ outcome: "redirect", location: next });
          return;
        }
        // An error page is a page. It is written by the same host, arrives
        // with the same content type, and saying "404" is more use to a
        // caller than handing its body onward as though it were the document
        // that was asked for. It is an outcome rather than a policy, and the
        // reason says what to do next in Volli's words, from the status and
        // the few headers that are numbers.
        if (status < 200 || status > 299) {
          request.destroy();
          refuse(statusRefusal(status, response, target, requestedUrl));
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
                read,
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
      // A GitHub page whose content lives somewhere readable is read there.
      // The rewritten URL is only a starting point: the first hop admits,
      // resolves and pins it like any URL a caller could have named.
      const github = githubRead(new URL(requestedUrl));

      // Every URL this read has already been sent to. A redirect back to one of
      // them is a loop, and a loop that is merely bounded by the hop count
      // spends the whole budget discovering what the first repeat already said.
      let href = github?.href ?? requestedUrl;
      const seen = new Set<string>([requestedUrl, href]);
      let scheme = admission.target.scheme;

      for (let followed = 0; ; followed += 1) {
        const result = await hop(requestedUrl, href, input.signal, started, github?.kind);
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
            "fetch.downgrade",
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
