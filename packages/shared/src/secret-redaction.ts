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
const BEARER_SECRET = /\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const AUTHORIZATION_HEADER_SECRET = /\bauthorization\s*:\s*(basic|bearer)\s+[^\s,;|&()<>]+/gi;
// Start at the fixed scheme delimiter and stay within one authority, so a
// failed match cannot rescan a long scheme or cross into a URL path.
const URL_USERINFO_SECRET = /(:\/\/)[^\s/\\?#"'<>]*@/g;
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

/** Scan boundaries once, then merge overlapping/nested complete blocks. */
function redactPemBlocks(value: string): string {
  PEM_BOUNDARY.lastIndex = 0;
  const pending = new Map<string, number>();
  const blocks: Array<{ start: number; end: number }> = [];
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
  if (blocks.length === 0) return value;
  blocks.sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let copied = 0;
  for (const block of blocks) {
    if (block.start >= copied) {
      parts.push(value.slice(copied, block.start), REDACTED);
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

function redactBasicAuth(value: string): string {
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
    parts.push(value.slice(copied, start), `${credentials.slice(0, colon + 1)}${REDACTED}${quote}`);
    copied = end;
  }
  parts.push(value.slice(copied));
  return parts.join("");
}

function redactAssignments(value: string): string {
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
    parts.push(value.slice(copied, match.index), `${match[0].slice(0, separator + 1)} ${REDACTED}`);
    copied = end;
    NAMED_ASSIGNMENT.lastIndex = end;
  }
  parts.push(value.slice(copied));
  return parts.join("");
}

/** Redact credential text without truncating or swallowing unquoted command tails. */
export function redactPayloadSecrets(value: string): string {
  if (!SECRET_MARKER.test(value)) return value;
  return redactAssignments(
    redactBasicAuth(redactPemBlocks(value).replace(URL_USERINFO_SECRET, "$1[redacted]@"))
      .replace(PREFIXED_SECRET, REDACTED)
      .replace(AWS_SECRET, REDACTED)
      .replace(JWT_SECRET, REDACTED)
      .replace(
        AUTHORIZATION_HEADER_SECRET,
        (_match, scheme: string) => `Authorization: ${scheme} ${REDACTED}`,
      )
      .replace(BEARER_SECRET, `Bearer ${REDACTED}`),
  );
}
