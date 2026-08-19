/**
 * Asking one search provider a question, and coming back with references.
 *
 * The sibling of `./safe-fetch.ts` and deliberately its shape: a narrow port, a
 * socket Volli owns, refusals that are named rather than thrown as whatever the
 * network produced. What differs is what is being reached and why, and both
 * differences are the reason this is a separate module rather than an option on
 * that one.
 *
 * **It returns references, never contents.** A search says where to look; a
 * fetch reads. Keeping them apart is what stops a cheap-looking query from
 * quietly reading five arbitrary pages — the research note's example is Jina's
 * `s.jina.ai`, which fetches the top five results behind a search-shaped call.
 * Nothing here opens a result URL, and there is no code path that could.
 *
 * **The endpoint is a person's, not a model's.** `./search-endpoint.ts` owns
 * that distinction and the narrow relaxation it earns; this module is where it
 * is *proven*, because a name admitted as this machine still has to resolve to
 * this machine before a socket goes anywhere.
 *
 * **A credential is in play.** The host supplies it — this module reads no
 * environment variable, no file, no keychain and no setting — and the whole of
 * its safety is that it goes to one admitted origin and comes back out in
 * nothing. Redirects are refused rather than followed, because a followed
 * redirect is the credential arriving at a host the provider chose after the
 * fact. Refusal text is written by Volli and never quotes a provider's header,
 * body or the request Volli sent, because refusals are read by the model and
 * kept in a ledger.
 *
 * What comes back is third-party text, all of it, the URLs included. This module
 * bounds it and hands it on; the tool above states what it is.
 */

import type { ClientRequest, IncomingMessage } from "node:http";

import { classifyWebAddress, type RuntimeWebSearchResults } from "@volli/shared";

import {
  isThisMachine,
  admitSearchEndpoint,
  type AdmittedSearchEndpoint,
  type SearchEndpointRuleId,
} from "./search-endpoint";
import {
  openWebRequest,
  pinnedLookup,
  resolveWebAddresses,
  WEB_FETCH_USER_AGENT,
  type WebAddressResolver,
  type WebFetchAddress,
  type WebRequestOptions,
  type WebScheme,
} from "./safe-fetch";

/** Every rule this module can cite, beyond the ones endpoint admission owns. */
export const WEB_SEARCH_RULE_IDS = [
  /** The query was empty, or longer than a query Volli will send. */
  "search.query",
  /** The configured provider asked for something Volli will not send on its behalf. */
  "search.provider",
  /** The endpoint resolved to an address that does not match the class it was admitted as. */
  "search.address",
  /** The endpoint resolved to nothing, so there is no address to approve. */
  "search.unresolvable",
  /** The connection failed, or the provider spoke something this client could not read. */
  "search.transport",
  /** The provider redirected, which this module reports rather than follows. */
  "search.redirect",
  /** The provider answered, but not with results. */
  "search.status",
  /** The answer was not JSON Volli reads. */
  "search.type",
  /** The answer arrived compressed, which this module cannot bound. */
  "search.encoding",
  /** The answer ran past the byte bound before it ended. */
  "search.too-large",
  /** The answer was not JSON at all, or not an answer this provider recognises. */
  "search.unreadable",
  /** The provider held the request past one of its deadlines. */
  "search.timeout",
  /** The caller withdrew the search. */
  "search.cancelled",
] as const;

/** A refusal's name: endpoint admission's rules, plus this module's own. */
export type WebSearchRuleId = (typeof WEB_SEARCH_RULE_IDS)[number] | SearchEndpointRuleId;

/**
 * A refusal, thrown rather than returned because the contract's success value is
 * a set of references. The rule travels beside the message so a caller can count
 * and record refusals without reading English.
 *
 * Every message here is Volli's own words. None of them quote a provider's
 * response, and none of them can contain a credential: what a refusal names is
 * the endpoint's hostname, a status code, or Node's own error code.
 */
export class WebSearchRefusal extends Error {
  readonly rule: WebSearchRuleId;

  constructor(rule: WebSearchRuleId, reason: string) {
    super(reason);
    this.name = "WebSearchRefusal";
    this.rule = rule;
  }
}

/**
 * The bounds every search runs inside.
 *
 * Constants rather than settings, for `WEB_FETCH_LIMITS`' reason: each is a
 * claim about what a search may cost, and widening one is a reviewed change
 * rather than a caller's choice. The reference and field bounds are the ones
 * that matter most — they decide how much attacker-chosen text can occupy a
 * model's context off the back of one tool call.
 */
export const WEB_SEARCH_LIMITS = {
  /** Characters of query Volli will send. Longer is a prompt, not a search. */
  queryChars: 400,
  /** Response headers, enforced by Node's own parser. */
  headerBytes: 16 * 1024,
  /** Response bytes read off the socket, counted rather than believed. */
  bodyBytes: 512 * 1024,
  /** References handed back. */
  references: 8,
  /** Characters of one reference's title. */
  titleChars: 200,
  /** Characters of one reference's snippet. */
  snippetChars: 400,
  /** Characters of one reference's URL. */
  urlChars: 2048,
  /** Connect, TLS and response headers. */
  headerMs: 10_000,
  /** The whole search, so an answer delivered one byte at a time still ends. */
  totalMs: 15_000,
} as const;

export type WebSearchLimits = { -readonly [K in keyof typeof WEB_SEARCH_LIMITS]: number };

/**
 * The identity Volli presents to a provider.
 *
 * Deliberately the same string a fetch sends: Volli is one client, and an
 * operator reading their own instance's logs should see one name.
 */
export const WEB_SEARCH_USER_AGENT = WEB_FETCH_USER_AGENT;

/** What a provider is asked for. */
export interface WebSearchRequest {
  /** The query, trimmed and inside the character bound. */
  query: string;
  /** The most references Volli will pass on, so a provider can ask for no more. */
  limit: number;
}

/**
 * The one HTTP call a provider wants made, as data rather than as a socket.
 *
 * A provider describes a request and never performs one. That is the whole
 * reason this port is shaped this way: if each provider brought its own client,
 * then admission, address pinning, redirect refusal, byte bounds and the
 * credential rule would be re-implemented once per provider and only checkable
 * once per provider. Here a provider chooses a URL, a verb, its own headers and
 * its own body, and every rule in this file applies to all of them equally.
 */
export interface WebSearchCall {
  /** The full URL, query included. Judged by {@link admitSearchEndpoint} before use. */
  readonly url: string;
  /** Defaults to `GET`. `POST` exists because search APIs are split between the two. */
  readonly method?: "GET" | "POST";
  /** Headers this provider needs, its credential among them. Never logged, never returned. */
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON Volli serializes and sends. Only with `POST`. */
  readonly body?: unknown;
}

/** One reference, as a provider reads it out of its own answer. */
export interface WebSearchReference {
  title: string;
  url: string;
  snippet: string;
}

/**
 * One search provider, as everything above it sees one.
 *
 * Two methods and no transport. A provider owns exactly what only it can know —
 * the URL its API lives at, the header its key goes in, the shape of its
 * answer — and owns nothing about safety, which is what makes a new provider a
 * small, reviewable addition rather than a new boundary to audit.
 *
 * A credential reaches an implementation through its own construction, from the
 * host that holds it. Nothing in this package reads a key from anywhere.
 */
export interface WebSearchProvider {
  /** Volli's name for this provider, shown as provenance. Never the provider's own words. */
  readonly id: string;
  /** Describe the one request that answers this query. */
  describe(request: WebSearchRequest): WebSearchCall;
  /**
   * Read this provider's own answer into references.
   *
   * Given already-parsed JSON, so no implementation writes a parser. Entries it
   * cannot read are skipped and a payload it does not recognise throws; either
   * way the boundary bounds whatever comes back before anyone else sees it.
   */
  read(payload: unknown): readonly WebSearchReference[];
}

/** The narrow port the runtime is given. One query in, bounded references out. */
export interface WebSearch {
  search(input: { query: string; signal: AbortSignal }): Promise<RuntimeWebSearchResults>;
}

/** The options Volli hands the HTTP client. Exported so a test can read them. */
export type WebSearchRequestOptions = WebRequestOptions;

/** Turn one prepared request into a live one. */
export type WebSearchRequestOpener = (
  scheme: WebScheme,
  options: WebSearchRequestOptions,
) => ClientRequest;

/** What building a search needs: one provider, plus the seams a test replaces. */
export interface WebSearchOptions {
  provider: WebSearchProvider;
  resolve?: WebAddressResolver;
  open?: WebSearchRequestOpener;
  /** Bounds, overridable so a test can prove a deadline in milliseconds. Production passes none. */
  limits?: WebSearchLimits;
}

/**
 * Headers Volli sends for itself, which a provider may not set.
 *
 * Not a hygiene list. Each of these decides something the rest of this module
 * depends on: what Volli is willing to receive, that it is not compressed, how
 * the body is framed, and that no ambient session rides along. A provider that
 * needs one of them is a provider this boundary cannot honestly carry, and
 * saying so is better than sending it and finding out.
 *
 * `authorization` is deliberately absent — it is a credential header several
 * search APIs use, and the credential rule here is about *where* a key goes,
 * not which header it travels in.
 */
const VOLLI_OWNED_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "user-agent",
  "accept",
  "accept-encoding",
  "content-type",
  "content-length",
  "connection",
  "transfer-encoding",
  "cookie",
]);

/** The media types Volli will read a provider's answer as. */
function readsAsJson(media: string): boolean {
  return media === "application/json" || media.endsWith("+json");
}

/** Read one header as a single value; a repeated header is not a place to guess. */
function header(response: IncomingMessage, name: string): string | undefined {
  const value = response.headers[name];
  /* v8 ignore next -- Node joins repeats of every header read here; only set-cookie arrives as an array, and this never reads it. */
  return Array.isArray(value) ? value[0] : value;
}

/** Split `application/json; charset=utf-8` into the two decisions it carries. */
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

/**
 * One field of a reference, as Volli is willing to carry it.
 *
 * Three separate jobs, all of them about text somebody else wrote. Whitespace
 * and control characters collapse, because these are one-line fields and a
 * newline in one is a third party writing the shape of the list Volli renders
 * around it. Bidi overrides and zero-width characters go, because a transcript
 * is read by a person too and those characters decide how a line *appears* to
 * read rather than what it says. And the result is cut to a bound, because the
 * number of characters a single tool call can put in a model's context is not a
 * remote party's to choose.
 */
function oneLine(text: string, bound: number): string {
  const flattened = text
    // `\p{Cf}` by name rather than the ranges it covers: bidi overrides,
    // zero-width joins and the byte-order mark are all Unicode *format*
    // characters, and naming the category is both shorter and harder to get
    // subtly wrong than a hand-written list of the ones we thought of.
    .replaceAll(/\p{Cf}/gu, "")
    .replaceAll(/[\s\p{Cc}]+/gu, " ")
    .trim();
  return flattened.length > bound ? flattened.slice(0, bound) : flattened;
}

/**
 * The addresses this search is allowed to reach, or a refusal.
 *
 * Every answer is judged against the class the endpoint was admitted as, not
 * just the one a client would have picked. For a public endpoint that is the
 * ordinary public-Internet rule. For a self-hosted one it is the stricter
 * question — is this actually *this machine* — and it is asked here rather than
 * taken on trust from the name, because a name resolves wherever its operator
 * points it and `searxng.localhost` pointed at the LAN would otherwise be a
 * private-network reach wearing a reserved name.
 */
function pinAddresses(
  endpoint: AdmittedSearchEndpoint,
  addresses: readonly WebFetchAddress[],
): readonly WebFetchAddress[] {
  if (addresses.length === 0) {
    throw new WebSearchRefusal(
      "search.unresolvable",
      `${endpoint.hostname} did not resolve to any address.`,
    );
  }
  for (const candidate of addresses) {
    if (endpoint.reach === "this-machine") {
      if (isThisMachine(candidate.address)) continue;
      throw new WebSearchRefusal(
        "search.address",
        `${endpoint.hostname} resolves to ${candidate.address}, which is not this machine; a self-hosted search endpoint must be.`,
      );
    }
    const verdict = classifyWebAddress(candidate.address);
    if (verdict.outcome === "refuse") {
      throw new WebSearchRefusal(
        "search.address",
        `${endpoint.hostname} resolves to ${candidate.address}, which is not on the public Internet: ${verdict.reason}`,
      );
    }
  }
  return addresses;
}

/**
 * The request Volli sends, in full.
 *
 * Volli's own headers first and the provider's over them — after
 * {@link VOLLI_OWNED_HEADERS} has already refused any overlap, so the order is
 * documentation rather than the control. `agent: false` gives the request its
 * own connection rather than a pooled one, and no cookie jar, `Authorization`
 * of Volli's own, or proxy is involved: `node:http` reads no proxy environment
 * variable, so "no proxy" is a property of this client rather than a setting to
 * remember.
 */
function requestOptions(
  endpoint: AdmittedSearchEndpoint,
  url: URL,
  call: WebSearchCall,
  body: string | undefined,
  addresses: readonly WebFetchAddress[],
  limits: WebSearchLimits,
): WebSearchRequestOptions {
  return {
    protocol: `${endpoint.scheme}:`,
    hostname: endpoint.hostname,
    port: endpoint.port,
    path: `${url.pathname}${url.search}`,
    method: call.method ?? "GET",
    headers: {
      "user-agent": WEB_SEARCH_USER_AGENT,
      accept: "application/json",
      // Identity only. A compressed answer is a decompression bound this module
      // has not written, and asking for one Volli cannot police is careless.
      "accept-encoding": "identity",
      ...(body === undefined
        ? {}
        : {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
          }),
      ...call.headers,
    },
    agent: false,
    lookup: pinnedLookup(addresses),
    maxHeaderSize: limits.headerBytes,
    // The name, never the pinned address: TLS verifies the certificate against
    // the endpoint a person configured, and an IP here would quietly stop that.
    servername: endpoint.hostname,
  };
}

/**
 * What the provider asked for, checked against what Volli is willing to send.
 *
 * A provider is Volli's own code, so this is a contract check rather than a
 * defence against a hostile party — but it is a refusal and not a crash,
 * because the alternative to refusing a badly-described call is making it.
 */
function checkCall(call: WebSearchCall): string | undefined {
  for (const name of Object.keys(call.headers ?? {})) {
    if (VOLLI_OWNED_HEADERS.has(name.toLowerCase())) {
      throw new WebSearchRefusal(
        "search.provider",
        `The configured search provider asked Volli to set ${name.toLowerCase()}, which Volli sends for itself.`,
      );
    }
  }
  if (call.body === undefined) return undefined;
  if ((call.method ?? "GET") !== "POST") {
    throw new WebSearchRefusal(
      "search.provider",
      "The configured search provider described a body on a request that does not carry one.",
    );
  }
  return JSON.stringify(call.body);
}

/** Build the search. */
export function createWebSearch(options: WebSearchOptions): WebSearch {
  const { provider } = options;
  const resolve = options.resolve ?? resolveWebAddresses;
  const open = options.open ?? openWebRequest;
  const limits = options.limits ?? WEB_SEARCH_LIMITS;

  /**
   * Turn a provider's answer into the references Volli is willing to carry,
   * and say whether there were more than that.
   *
   * Both halves come from the same place deliberately. "There were more" is a
   * fact about what the provider offered, so it has to be read before the list
   * is cut — a full list is not the same statement as a list that lost
   * something, and a model told the wrong one goes looking for a page nobody
   * has.
   */
  function references(payload: unknown): {
    references: RuntimeWebSearchResults["references"];
    truncated: boolean;
  } {
    let read: readonly WebSearchReference[];
    try {
      read = provider.read(payload);
    } catch {
      // Deliberately not the thrown error's message: a provider reading an
      // attacker-shaped payload can fail with text lifted straight out of it,
      // and that text would land in a ledger and a model's context.
      throw new WebSearchRefusal(
        "search.unreadable",
        `${provider.id} answered with something Volli could not read as search results.`,
      );
    }
    return {
      references: read.slice(0, limits.references).map((reference) => ({
        title: oneLine(reference.title, limits.titleChars),
        url: oneLine(reference.url, limits.urlChars),
        snippet: oneLine(reference.snippet, limits.snippetChars),
      })),
      truncated: read.length > limits.references,
    };
  }

  return {
    async search(input) {
      // Before admission, resolution or a socket: a withdrawn search is work
      // nobody is waiting for, and the cheapest place to notice is first.
      if (input.signal.aborted) {
        throw new WebSearchRefusal("search.cancelled", "The search was cancelled before it ran.");
      }
      const query = input.query.trim();
      if (query === "" || query.length > limits.queryChars) {
        throw new WebSearchRefusal(
          "search.query",
          `A search needs a query of between 1 and ${limits.queryChars} characters.`,
        );
      }
      const call = provider.describe({ query, limit: limits.references });
      const body = checkCall(call);
      const admission = admitSearchEndpoint(call.url);
      if (admission.outcome === "refuse") {
        throw new WebSearchRefusal(admission.rule, admission.reason);
      }
      const { endpoint } = admission;
      // A resolver that throws has said the same thing as one that answers
      // nothing, and the caller gets Volli's word for it rather than a system
      // error carrying a hostname and an errno through the transcript.
      let answers: readonly WebFetchAddress[];
      try {
        answers = await resolve(endpoint.hostname);
      } catch {
        throw new WebSearchRefusal(
          "search.unresolvable",
          `${endpoint.hostname} could not be resolved.`,
        );
      }
      const addresses = pinAddresses(endpoint, answers);
      // Asked twice, because resolution takes real time and the listener that
      // watches for a withdrawal is only installed once the request exists. A
      // turn interrupted inside that window would otherwise still put a
      // credential on the wire, for an answer nobody is waiting for.
      if (input.signal.aborted) {
        throw new WebSearchRefusal(
          "search.cancelled",
          `The search against ${endpoint.hostname} was cancelled before it was sent.`,
        );
      }
      // Parsing the href admission produced, not the provider's string: this is
      // the URL the policy accepted, already canonical.
      const url = new URL(endpoint.url);

      const payload = await new Promise<unknown>((settle, refuse) => {
        const request = open(
          endpoint.scheme,
          requestOptions(endpoint, url, call, body, addresses, limits),
        );

        // Two deadlines rather than an inactivity timer: a provider that answers
        // a byte at a time is never idle, and would hold a socket open forever
        // under a timer that only watches for silence.
        const deadlines = [
          setTimeout(() => stop("before answering"), limits.headerMs),
          setTimeout(() => stop("before finishing"), limits.totalMs),
        ];
        function stop(when: string): void {
          abandon();
          request.destroy();
          refuse(
            new WebSearchRefusal("search.timeout", `${endpoint.hostname} ran out of time ${when}.`),
          );
        }

        // One cleanup for every way out, including the ordinary one: a deadline
        // left armed keeps a process awake, and a listener left on a long-lived
        // signal is a leak per search.
        function abandon(): void {
          for (const deadline of deadlines) clearTimeout(deadline);
          input.signal.removeEventListener("abort", cancel);
        }

        function cancel(): void {
          abandon();
          request.destroy();
          refuse(
            new WebSearchRefusal(
              "search.cancelled",
              `The search against ${endpoint.hostname} was cancelled.`,
            ),
          );
        }

        input.signal.addEventListener("abort", cancel, { once: true });
        request.on("close", abandon);

        request.on("error", (error) => {
          // Node's own code for the failure, which is generated here rather
          // than chosen by the provider, so it can be recorded without quoting
          // the other end.
          const code = (error as NodeJS.ErrnoException).code ?? error.name;
          refuse(
            new WebSearchRefusal(
              "search.transport",
              `Volli could not reach ${endpoint.hostname}: the connection failed (${code}).`,
            ),
          );
        });

        request.on("response", (response) => {
          clearTimeout(deadlines[0]);
          /* v8 ignore next -- a parsed response always carries a status; 0 refuses below rather than reading a headless answer as success. */
          const status = response.statusCode ?? 0;
          // A redirect is a new origin, and a new origin is one this provider's
          // credential was never configured for. Refused rather than followed:
          // there is no version of following it that does not either drop the
          // key mid-conversation or hand it to a host chosen after the fact.
          if (status >= 300 && status <= 399) {
            request.destroy();
            refuse(
              new WebSearchRefusal(
                "search.redirect",
                `${endpoint.hostname} redirected the search (${status}); Volli does not follow a redirect it may be carrying a key into.`,
              ),
            );
            return;
          }
          if (status < 200 || status > 299) {
            request.destroy();
            refuse(
              new WebSearchRefusal(
                "search.status",
                `${endpoint.hostname} answered ${status} rather than search results.`,
              ),
            );
            return;
          }
          const encoding = header(response, "content-encoding")?.trim().toLowerCase();
          if (encoding !== undefined && encoding !== "" && encoding !== "identity") {
            request.destroy();
            refuse(
              new WebSearchRefusal(
                "search.encoding",
                `${endpoint.hostname} compressed its answer, which Volli cannot bound here.`,
              ),
            );
            return;
          }
          const { media, charset } = contentType(response);
          // JSON is UTF-8 by definition, so a provider declaring anything else
          // is not speaking the format this reads — refused rather than decoded
          // as though the label were a detail.
          if (!readsAsJson(media) || (charset !== "utf-8" && charset !== "utf8")) {
            request.destroy();
            refuse(
              new WebSearchRefusal(
                "search.type",
                `${endpoint.hostname} answered with something other than UTF-8 JSON.`,
              ),
            );
            return;
          }
          // `Content-Length` is a claim, and this is the only thing Volli does
          // with it: refuse early when the provider itself says the answer is
          // over the bound. The count below is what actually stops the read.
          const declared = Number(header(response, "content-length"));
          if (Number.isFinite(declared) && declared > limits.bodyBytes) {
            request.destroy();
            refuse(
              new WebSearchRefusal(
                "search.too-large",
                `${endpoint.hostname} declared an answer over the ${limits.bodyBytes} byte bound.`,
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
                new WebSearchRefusal(
                  "search.too-large",
                  `${endpoint.hostname} sent more than ${limits.bodyBytes} bytes.`,
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            try {
              settle(JSON.parse(new TextDecoder("utf-8").decode(Buffer.concat(chunks))));
            } catch {
              // The parser's message quotes the body it choked on, so it is not
              // the thing that gets said.
              refuse(
                new WebSearchRefusal(
                  "search.unreadable",
                  `${endpoint.hostname} answered with something that is not JSON.`,
                ),
              );
            }
          });
        });

        if (body !== undefined) request.write(body);
        request.end();
      });

      return { provider: provider.id, query, ...references(payload) };
    },
  };
}
