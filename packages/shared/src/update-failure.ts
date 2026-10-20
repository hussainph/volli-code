/**
 * One short, shareable sentence from an updater failure (VC-294).
 *
 * electron-updater's error text is a measurement, not a message: an
 * `HttpError` carries the feed URL, the request method and a JSON dump of the
 * response headers (request ids, cookies, CDN hosts), across several lines.
 * The house rule is that a fault surface shows what is wrong and keeps the
 * measurements in the log. So Settings → Updates and the support report — which
 * a person pastes into a public issue — both show only this summary; the raw
 * text stays in the main-process `[updater]` log line.
 *
 * Deliberately lossy and conservative: the first line only, cut before any
 * JSON or `Headers:` dump, with URLs, host names, IP addresses, header-shaped
 * `name: value` pairs and anything credential-shaped removed, then the first
 * sentence, capped. Pure, so main and the renderer share one answer.
 */
import { redactPayloadSecrets } from "./secret-redaction";

/** Longest summary shown; past it the sentence ends in an ellipsis. */
export const UPDATE_FAILURE_SUMMARY_MAX = 120;

/** What a failure with nothing left to say after stripping reads as. */
export const UPDATE_FAILURE_FALLBACK = "Unknown error";

const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]*/giu;
/** The start of a dump: a JSON body, or a labelled header/response block. */
const DUMP = /[{[]|\b(?:headers?|response|body)\s*:/iu;
/** `content-type: x`, `x-request-id: y`, and the few bare header names that carry places or credentials. */
const HEADER_PAIR =
  /\b(?:[a-z0-9]+(?:-[a-z0-9]+)+|authorization|cookie|method|url|host|location|server|etag)\s*:\s*[^\s,;]*/giu;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/gu;
const HOST =
  /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|app|cloud|co|ai|us|info|xyz|me)(?::\d+)?\b/giu;

export function summarizeUpdateFailure(raw: string): string {
  const line =
    raw
      .split(/\r?\n/u)
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  const dumpAt = line.search(DUMP);
  let text = redactPayloadSecrets(dumpAt < 0 ? line : line.slice(0, dumpAt));
  text = text
    .replace(URL, "")
    .replace(HEADER_PAIR, "")
    .replace(IPV4, "")
    .replace(HOST, "")
    // What the removals leave behind: empty brackets and quotes, doubled
    // spaces, a space before punctuation, and dangling separators at the end.
    .replace(/\(\s*\)|\[\s*\]|"\s*"|'\s*'/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/\s+([:,;.!?])/gu, "$1")
    .replace(/[\s:,;-]+$/u, "")
    .replace(/^[\s:,;-]+/u, "");
  const sentence = text.split(/(?<=[.!?])\s/u)[0]!;
  if (sentence.length === 0) return UPDATE_FAILURE_FALLBACK;
  if (sentence.length <= UPDATE_FAILURE_SUMMARY_MAX) return sentence;
  return `${sentence.slice(0, UPDATE_FAILURE_SUMMARY_MAX - 1).trimEnd()}…`;
}
