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
  /** The whole read, so a body delivered one byte at a time still ends. */
  totalMs: 20_000,
} as const;

export type WebFetchLimits = { -readonly [K in keyof typeof WEB_FETCH_LIMITS]: number };

/** The identity Volli presents, so an operator can see who called and why. */
export const WEB_FETCH_USER_AGENT = "Volli/1.0 (+https://volli.app)";

/** The media types this slice will read, and the name each is reported under. */
const READABLE_TYPES: ReadonlyMap<string, SafeWebFetchResult["contentType"]> = new Map([
  ["text/html", "html"],
  ["text/plain", "text"],
  ["text/markdown", "markdown"],
]);

/**
 * The encodings this slice will decode, mapped to the label `TextDecoder` knows.
 *
 * An allowlist because guessing is how a decoder becomes a parser: an encoding
 * Volli does not recognise is refused rather than read as UTF-8 and silently
 * mangled.
 */
const READABLE_CHARSETS: ReadonlyMap<string, string> = new Map([
  ["utf-8", "utf-8"],
  ["utf8", "utf-8"],
  ["us-ascii", "utf-8"],
  ["ascii", "utf-8"],
  ["iso-8859-1", "windows-1252"],
  ["latin1", "windows-1252"],
  ["windows-1252", "windows-1252"],
]);

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
    throw new WebFetchRefusal("fetch.unresolvable", `${hostname} did not resolve to any address.`);
  }
  for (const candidate of addresses) {
    const verdict = classifyWebAddress(candidate.address);
    if (verdict.outcome === "refuse") {
      throw new WebFetchRefusal(
        "fetch.address",
        `${hostname} resolves to ${candidate.address}, which is not on the public Internet: ${verdict.reason}`,
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
      accept: "text/html, text/plain, text/markdown",
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
function contentType(response: IncomingMessage): { media: string; charset: string } {
  const raw = header(response, "content-type") ?? "";
  const [media = "", ...parameters] = raw.split(";");
  const charset = parameters
    .map((parameter) => parameter.trim().toLowerCase())
    .find((parameter) => parameter.startsWith("charset="))
    ?.slice("charset=".length)
    .replaceAll('"', "");
  return { media: media.trim().toLowerCase(), charset: charset ?? "utf-8" };
}

/** Decode the collected bytes, then bound what the caller is handed. */
function document(
  target: AdmittedWebTarget,
  url: URL,
  response: IncomingMessage,
  body: Buffer,
  limits: WebFetchLimits,
): SafeWebFetchResult {
  const { media, charset } = contentType(response);
  const kind = READABLE_TYPES.get(media);
  if (kind === undefined) {
    throw new WebFetchRefusal(
      "fetch.type",
      `${target.hostname} served a document Volli does not read as text.`,
    );
  }
  const encoding = READABLE_CHARSETS.get(charset);
  if (encoding === undefined) {
    throw new WebFetchRefusal(
      "fetch.charset",
      `${target.hostname} served a character encoding Volli does not decode.`,
    );
  }
  const decoded = new TextDecoder(encoding).decode(body);
  const truncated = decoded.length > limits.textChars;
  return {
    requestedUrl: target.url,
    finalUrl: target.url,
    origin: url.origin,
    contentType: kind,
    text: truncated ? decoded.slice(0, limits.textChars) : decoded,
    truncated,
  };
}

/** Build the fetcher. */
export function createSafeWebFetch(options: SafeWebFetchOptions = {}): SafeWebFetch {
  const resolve = options.resolve ?? resolveWebAddresses;
  const open = options.open ?? openWebRequest;
  const limits = options.limits ?? WEB_FETCH_LIMITS;

  return {
    async fetch(input) {
      // Before admission, resolution or a socket: a withdrawn request is work
      // nobody is waiting for, and the cheapest place to notice is first.
      if (input.signal.aborted) {
        throw new WebFetchRefusal("fetch.cancelled", "The request was cancelled before it ran.");
      }
      const admission = admitWebTarget(input.url);
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
          `${target.hostname} could not be resolved.`,
        );
      }
      const addresses = pinAddresses(target.hostname, answers);
      // Parsing the href admission produced, not the caller's string: this is
      // the URL the policy accepted, already canonical, and re-reading it is
      // how the path reaches the socket without a second interpretation of the
      // original input.
      const url = new URL(target.url);

      return await new Promise<SafeWebFetchResult>((settle, refuse) => {
        const request = open(target.scheme, requestOptions(target, url, addresses, limits));

        // Two deadlines rather than an inactivity timer: a host that answers a
        // byte at a time is never idle, and would hold a socket open forever
        // under a timer that only watches for silence.
        const deadlines = [
          setTimeout(() => stop("before answering"), limits.headerMs),
          setTimeout(() => stop("before finishing"), limits.totalMs),
        ];
        function stop(when: string): void {
          abandon();
          request.destroy();
          refuse(
            new WebFetchRefusal("fetch.timeout", `${target.hostname} ran out of time ${when}.`),
          );
        }

        // One cleanup for every way out, including the ordinary one: a deadline
        // left armed keeps a process awake, and a listener left on a long-lived
        // signal is a leak per fetch.
        function abandon(): void {
          for (const deadline of deadlines) clearTimeout(deadline);
          input.signal.removeEventListener("abort", cancel);
        }

        function cancel(): void {
          abandon();
          request.destroy();
          refuse(
            new WebFetchRefusal(
              "fetch.cancelled",
              `The request to ${target.hostname} was cancelled.`,
            ),
          );
        }

        input.signal.addEventListener("abort", cancel, { once: true });
        request.on("close", abandon);

        request.on("error", (error) => {
          // Node's own code for the failure — `ECONNRESET`, `HPE_HEADER_OVERFLOW`
          // — which is generated here rather than chosen by the host, so it can
          // be recorded without quoting the other end.
          const code = (error as NodeJS.ErrnoException).code ?? error.name;
          refuse(
            new WebFetchRefusal(
              "fetch.transport",
              `Volli could not read ${target.hostname}: the connection failed (${code}).`,
            ),
          );
        });

        request.on("response", (response) => {
          clearTimeout(deadlines[0]);
          /* v8 ignore next -- a parsed response always carries a status; 0 refuses below rather than reading a headless answer as success. */
          const status = response.statusCode ?? 0;
          // A redirect is a new target, and a new target is a new policy
          // decision — not something a response header gets to make on Volli's
          // behalf. Reported, so a caller can ask for the new URL deliberately
          // and have it admitted, resolved and pinned like any other.
          if (status >= 300 && status <= 399) {
            request.destroy();
            refuse(
              new WebFetchRefusal(
                "fetch.redirect",
                `${target.hostname} redirected the request (${status}); Volli does not follow redirects.`,
              ),
            );
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
                `${target.hostname} answered ${status} rather than serving the document.`,
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
                `${target.hostname} compressed its answer, which Volli cannot bound in this slice.`,
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
                `${target.hostname} declared a body over the ${limits.bodyBytes} byte bound.`,
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
                  `${target.hostname} served more than ${limits.bodyBytes} bytes.`,
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            try {
              settle(document(target, url, response, Buffer.concat(chunks), limits));
            } catch (error) {
              refuse(error);
            }
          });
        });

        request.end();
      });
    },
  };
}

export type { WebScheme };
