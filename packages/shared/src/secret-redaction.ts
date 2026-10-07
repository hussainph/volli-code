/**
 * Secret scrubbing shared by activity history, authority transport and its audit.
 * No truncation: a policy reader must still see the complete command tail.
 */

const REDACTED = "[redacted]";
const PREFIXED_SECRET = /\b(?:sk|pk|gh[pousr]|github_pat|xox[a-z]?)[-_][A-Za-z0-9_-]+/gi;
const AWS_SECRET = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const JWT_SECRET = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// Labels are alphanumeric words separated by one space or hyphen. A label
// cannot consume the five-hyphen delimiter (separator and word are disjoint).
// Never search a body with regex: unmatched BEGIN candidates must not each
// rescan the remaining uncontrolled text.
const PEM_BOUNDARY = /-----(BEGIN|END) ([A-Z0-9]+(?:[ -][A-Z0-9]+)*)-----/g;
const BASIC_SECRET = /\bbasic\s+[A-Za-z0-9+/]+=*/gi;
// A cookie header includes later cookies/attributes, but never a shell tail.
const COOKIE_HEADER_SECRET = /\b(?:set-cookie|cookie)[ \t]*[:=][ \t]*/gi;
const COOKIE_ATTRIBUTE_NAME_UNIT = /^[A-Za-z0-9!#$%*+.^_`~-]$/;
const COOKIE_FLAGS = ["secure", "httponly", "partitioned"];
const BEARER_SECRET = /\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const AUTHORIZATION_HEADER_SECRET = /\bauthorization\s*:\s*(basic|bearer)\s+[^\s,;|&()<>]+/gi;
// Start at the fixed scheme delimiter and stay within one authority, so a
// failed match cannot rescan a long scheme or cross into a URL path. Quotes
// and other punctuation before @ may be credentials, not prose delimiters.
const URL_USERINFO_SECRET = /(:\/\/)[^\s/]*@/g;
const COMMAND_BASIC_AUTH_PREFIX = /(?:^|[\s;|&()])(?:--(?:proxy-)?user(?:[ \t]+|=)|-[uU][ \t]*)/g;
// Consume a whole name even without an assignment. Requiring a separator in
// this regex would retry each hyphen-delimited suffix of a long near miss.
const NAMED_ASSIGNMENT = /\b(api[ \t]+key|[A-Za-z_][A-Za-z0-9_-]*)([ \t]*[=:][ \t]*)?/g;
const SENSITIVE_KEY =
  /(?:token|apikey|password|passwd|secret|authorization|credential|accesskeyid)/i;
// A bare `key` also names a keyboard key in browser actions; only prefixed
// keys are credentials (API keys are already recognized above).
const KEY_SUFFIX = /(?:[_\s-](?:key|pwd)(?:[_\s-]?id)?|^pwd)$/i;
const SECRET_MARKER = new RegExp(
  [
    "key|token|password|passwd|secret|authorization|credential|pwd",
    PREFIXED_SECRET.source,
    AWS_SECRET.source,
    JWT_SECRET.source,
    "-----BEGIN ",
    BEARER_SECRET.source,
    BASIC_SECRET.source,
    COOKIE_HEADER_SECRET.source,
    URL_USERINFO_SECRET.source,
    COMMAND_BASIC_AUTH_PREFIX.source,
  ].join("|"),
  "i",
);

/** Sensitive field names, including vendor-prefixed environment variable names. */
export function isSensitiveKey(value: string): boolean {
  return (
    SENSITIVE_KEY.test(value.replace(/[^a-z]/gi, "")) ||
    KEY_SUFFIX.test(value.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))
  );
}

/** Half-open offsets in the original string, measured in UTF-16 code units. */
export interface PayloadSecretSpan {
  start: number;
  end: number;
}

export type PemSecretSpan = PayloadSecretSpan;

/**
 * Compose a source map through the real display pipeline. Each pass visits its
 * boundaries once; synthetic replacement text maps to the removed source span.
 * Space masks are not equivalent: they break concatenated shell words, and can
 * lose an assignment suffix after an earlier pass removes a PEM's stray quote.
 */
class SpanCollector {
  readonly spans: PayloadSecretSpan[];
  readonly originalSource: boolean;
  private offsets: number[] = [];
  private next: number[] = [];
  private copied = 0;

  constructor(value: string, spans: PayloadSecretSpan[], originalSource = false) {
    this.spans = spans;
    this.originalSource = originalSource;
    if (!originalSource) {
      for (let index = 0; index <= value.length; index += 1) this.offsets.push(index);
    }
  }

  replace(start: number, end: number, display: string): void {
    if (this.originalSource) {
      this.spans.push({ start, end });
      return;
    }
    const sourceStart = this.offsets[start]!;
    this.spans.push({ start: sourceStart, end: this.offsets[end]! });
    for (; this.copied < start; this.copied += 1) {
      this.next.push(this.offsets[this.copied]!);
    }
    for (let index = 0; index < display.length; index += 1) this.next.push(sourceStart);
    this.copied = end;
  }

  finishPass(value: string): string {
    if (this.originalSource) return value;
    for (; this.copied < this.offsets.length; this.copied += 1) {
      this.next.push(this.offsets[this.copied]!);
    }
    this.offsets = this.next;
    this.next = [];
    this.copied = 0;
    return value;
  }
}

function replacement(
  start: number,
  end: number,
  display: string,
  collector?: SpanCollector,
): string {
  collector?.replace(start, end, display);
  return display;
}

function replaceSecrets(
  value: string,
  pattern: RegExp,
  display: string | ((match: string, group: string) => string),
  collector?: SpanCollector,
): string {
  return value.replace(pattern, (match: string, ...args: Array<string | number>) => {
    const start = args.at(-2) as number;
    return replacement(
      start,
      start + match.length,
      typeof display === "string" ? display : display(match, args[0] as string),
      collector,
    );
  });
}

/** Original-source spans let exact-value redactors protect overlapping PEMs too. */
export function pemSecretSpans(value: string, includeIncomplete = false): PemSecretSpan[] {
  PEM_BOUNDARY.lastIndex = 0;
  const pending = new Map<string, number>();
  const blocks: PemSecretSpan[] = [];
  let match: RegExpExecArray | null;
  while ((match = PEM_BOUNDARY.exec(value)) !== null) {
    const label = match[2]!;
    if (match[1] === "BEGIN") {
      // The first unmatched opening for this label owns its first closing.
      if (!pending.has(label)) pending.set(label, match.index);
    } else {
      const start = pending.get(label);
      if (start !== undefined) {
        blocks.push({ start, end: PEM_BOUNDARY.lastIndex });
        pending.delete(label);
      }
    }
  }
  blocks.sort((a, b) => a.start - b.start);
  if (includeIncomplete) {
    // A still-open label owns its remaining body even when another complete
    // block overlaps its opening. Coverage by that block is not closure.
    for (const start of pending.values()) blocks.push({ start, end: value.length });
    blocks.sort((a, b) => a.start - b.start);
    // A literal opening not covered by a complete span owns the rest of a
    // live preview, even before its label/delimiter has finished arriving.
    let block = 0;
    let coveredThrough = 0;
    for (let from = 0; from < value.length;) {
      const opening = value.indexOf("-----BEGIN ", from);
      if (opening === -1) break;
      while (block < blocks.length && blocks[block]!.start <= opening)
        coveredThrough = Math.max(coveredThrough, blocks[block++]!.end);
      if (opening >= coveredThrough) {
        blocks.push({ start: opening, end: value.length });
        break;
      }
      from = opening + 11;
    }
  }
  return blocks.toSorted((a, b) => a.start - b.start);
}

/** Scan boundaries once, then merge overlapping/nested complete blocks. */
function redactPemBlocks(value: string, collector?: SpanCollector): string {
  const blocks = pemSecretSpans(value);
  if (blocks.length === 0) return value;
  const parts: string[] = [];
  let copied = 0;
  for (const block of blocks) {
    if (block.start >= copied) {
      parts.push(
        value.slice(copied, block.start),
        replacement(block.start, block.end, REDACTED, collector),
      );
    } else if (block.end > copied) {
      // A crossing block extends the removed source region, without adding
      // another display marker.
      parts.push(replacement(copied, block.end, "", collector));
    }
    copied = Math.max(copied, block.end);
  }
  parts.push(value.slice(copied));
  return parts.join("");
}

/** Track surrounding quotes incrementally, never rescanning each preceding prefix. */
function quoteTracker(value: string): (end: number) => string {
  let index = 0;
  let quote = "";
  return (end) => {
    for (; index < end; index += 1) {
      const character = value.charAt(index);
      if (character === "\\" && quote !== "'") index += 1;
      else if (character === quote) quote = "";
      else if (quote === "" && (character === '"' || character === "'")) quote = character;
    }
    return quote;
  };
}

/**
 * End of a shell word, with concatenated quotes and escaped separators intact.
 * This is not an evaluator: substitutions are never run, and unquoted shell
 * separators terminate a value so redaction cannot hide a chained operation.
 * An enclosing quote (e.g. bash -c 'TOKEN=dummy') also ends the inner value.
 */
function assignmentValueEnd(
  value: string,
  start: number,
  stopComma: boolean,
  boundaryQuote: string,
): number {
  let quote = "";
  let index = start;
  for (; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (character === "\\" && quote !== "'") {
      index += 1;
    } else if (quote !== "") {
      if (character === quote) quote = "";
    } else if (character === boundaryQuote) {
      break;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/[\s;|&()<>]/.test(character) || (stopComma && character === ",")) {
      break;
    }
  }
  return Math.min(index, value.length);
}

function redactBasicAuth(value: string, collector?: SpanCollector): string {
  COMMAND_BASIC_AUTH_PREFIX.lastIndex = 0;
  const quoteBefore = quoteTracker(value);
  const parts: string[] = [];
  let copied = 0;
  let match: RegExpExecArray | null;
  while ((match = COMMAND_BASIC_AUTH_PREFIX.exec(value)) !== null) {
    const start = COMMAND_BASIC_AUTH_PREFIX.lastIndex;
    const end = assignmentValueEnd(value, start, false, quoteBefore(match.index));
    const credentials = value.slice(start, end);
    const colon = credentials.indexOf(":");
    COMMAND_BASIC_AUTH_PREFIX.lastIndex = end;
    if (colon < 0) continue;
    const first = credentials.charAt(0);
    const quote = first === '"' || first === "'" ? first : "";
    parts.push(
      value.slice(copied, start),
      replacement(start, end, `${credentials.slice(0, colon + 1)}${REDACTED}${quote}`, collector),
    );
    copied = end;
  }
  parts.push(value.slice(copied));
  return parts.join("");
}

function redactAssignments(value: string, collector?: SpanCollector): string {
  NAMED_ASSIGNMENT.lastIndex = 0;
  const quoteBefore = quoteTracker(value);
  const parts: string[] = [];
  let copied = 0;
  let match: RegExpExecArray | null;
  while ((match = NAMED_ASSIGNMENT.exec(value)) !== null) {
    if (match[2] === undefined || !isSensitiveKey(match[1]!)) continue;
    // The header pass has already scrubbed these credentials; retain the
    // authentication scheme rather than treating it as the assigned value.
    if (
      /^authorization$/i.test(match[1]!) &&
      match[2].includes(":") &&
      /^(?:basic|bearer) \[redacted\]/i.test(value.slice(NAMED_ASSIGNMENT.lastIndex))
    ) {
      continue;
    }
    const end = assignmentValueEnd(
      value,
      NAMED_ASSIGNMENT.lastIndex,
      true,
      quoteBefore(match.index),
    );
    const separator = match[0].search(/[=:]/);
    parts.push(
      value.slice(copied, match.index),
      replacement(match.index, end, `${match[0].slice(0, separator + 1)} ${REDACTED}`, collector),
    );
    copied = end;
    NAMED_ASSIGNMENT.lastIndex = end;
  }
  parts.push(value.slice(copied));
  return parts.join("");
}

function skipHorizontalSpace(value: string, from: number): number {
  while (value[from] === " " || value[from] === "\t") from += 1;
  return from;
}

/** Advance once over an attribute; never backtrack over uncontrolled whitespace. */
function cookieAttribute(
  value: string,
  from: number,
): { valueStart: number | null; end: number } | null {
  const semicolon = skipHorizontalSpace(value, from);
  if (value[semicolon] !== ";") return null;
  const start = skipHorizontalSpace(value, semicolon + 1);
  let nameEnd = start;
  while (nameEnd < value.length && COOKIE_ATTRIBUTE_NAME_UNIT.test(value[nameEnd]!)) nameEnd += 1;
  const equals = skipHorizontalSpace(value, nameEnd);
  if (nameEnd > start && value[equals] === "=") {
    const valueStart = skipHorizontalSpace(value, equals + 1);
    return { valueStart, end: valueStart };
  }
  for (const flag of COOKIE_FLAGS) {
    const end = start + flag.length;
    if (value.slice(start, end).toLowerCase() === flag && !/\w/.test(value[end] ?? ""))
      return { valueStart: null, end };
  }
  return null;
}

/** Scan complete cookie headers without hiding a command after them. */
function redactCookieHeaders(value: string, collector?: SpanCollector): string {
  COOKIE_HEADER_SECRET.lastIndex = 0;
  const quoteBefore = quoteTracker(value);
  const parts: string[] = [];
  let copied = 0;
  let match: RegExpExecArray | null;
  while ((match = COOKIE_HEADER_SECRET.exec(value)) !== null) {
    const boundaryQuote = quoteBefore(match.index);
    let end = assignmentValueEnd(value, COOKIE_HEADER_SECRET.lastIndex, false, boundaryQuote);
    while (true) {
      const attribute = cookieAttribute(value, end);
      if (attribute === null) break;
      end =
        attribute.valueStart === null
          ? attribute.end
          : assignmentValueEnd(value, attribute.valueStart, false, boundaryQuote);
    }
    parts.push(
      value.slice(copied, match.index),
      replacement(match.index, end, `Cookie: ${REDACTED}`, collector),
    );
    copied = end;
    COOKIE_HEADER_SECRET.lastIndex = end;
  }
  parts.push(value.slice(copied));
  return parts.join("");
}

function redactSecrets(value: string, collector?: SpanCollector): string {
  if (!SECRET_MARKER.test(value)) return value;
  const pass = (current: string) => {
    const mapped = collector?.finishPass(current) ?? current;
    return collector?.originalSource ? value : mapped;
  };
  let current = pass(redactPemBlocks(value, collector));
  current = pass(
    replaceSecrets(
      current,
      URL_USERINFO_SECRET,
      (_match, delimiter) => `${delimiter}${REDACTED}@`,
      collector,
    ),
  );
  current = pass(redactBasicAuth(current, collector));
  current = pass(redactCookieHeaders(current, collector));
  current = pass(replaceSecrets(current, PREFIXED_SECRET, REDACTED, collector));
  current = pass(replaceSecrets(current, AWS_SECRET, REDACTED, collector));
  current = pass(replaceSecrets(current, JWT_SECRET, REDACTED, collector));
  current = pass(
    replaceSecrets(
      current,
      AUTHORIZATION_HEADER_SECRET,
      (_match, scheme) => `Authorization: ${scheme} ${REDACTED}`,
      collector,
    ),
  );
  current = pass(replaceSecrets(current, BEARER_SECRET, `Bearer ${REDACTED}`, collector));
  current = pass(replaceSecrets(current, BASIC_SECRET, `Basic ${REDACTED}`, collector));
  return pass(redactAssignments(current, collector));
}

/**
 * Conservative original-source regions to union with exact credential spans.
 * Spans may overlap and are in detector order, not sorted. Safe labels within a
 * replaced region may be included. Incomplete PEMs remain pemSecretSpans' job.
 */
export function payloadSecretSpans(value: string): PayloadSecretSpan[] {
  if (!SECRET_MARKER.test(value)) return [];
  const spans: PayloadSecretSpan[] = [];
  redactSecrets(value, new SpanCollector(value, spans));
  // Also detect raw forms before any shared delimiter disappears. For example,
  // the prefixed pass rewrites Bearer ghp_dummy.suffix to Bearer [redacted].suffix
  // before the scheme pass runs; the whole original Bearer value needs a span.
  redactSecrets(value, new SpanCollector(value, spans, true));
  return spans;
}

/** Redact credential text without truncating or swallowing unquoted command tails. */
export function redactPayloadSecrets(value: string): string {
  return redactSecrets(value);
}
