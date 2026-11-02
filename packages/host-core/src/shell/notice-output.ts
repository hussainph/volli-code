import { StringDecoder } from "node:string_decoder";
import { pemSecretSpans } from "@volli/shared";
import { pendingNoticeSecretStart } from "../secrets/index";

/**
 * One pipe's sanitized context as it stands: `settled` lines (redacted, each
 * ending in a newline) followed by a redacted `tail`. Within one `epoch` the
 * settled list only grows, and nothing a later chunk brings can change it, so
 * a reader that has seen `settledCount` lines need only look at what follows.
 * The list is shared and appended in place; read only `settledCount` entries.
 */
export interface NoticeView {
  readonly epoch: number;
  readonly settled: readonly string[];
  readonly settledCount: number;
  readonly tail: string;
}

/**
 * Text appended after a candidate segment to prove the shared redactor's
 * "any marker present" gate cannot change how the segment redacts: it is a
 * marker (`key`) that is not itself a credential or an assignment.
 */
const GATE_PROBE = "key";

/**
 * The shared command basic-auth prefix (`redactBasicAuth` in
 * `@volli/shared` secret-redaction.ts). Its value may run on across lines
 * inside a quote without being rewritten when it holds no colon yet, so a
 * segment containing one never settles.
 */
const COMMAND_BASIC_AUTH_PREFIX = /(?:^|[\s;|&()])(?:--(?:proxy-)?user(?:[ \t]+|=)|-[uU][ \t]*)/;

/**
 * The shared scheme patterns whose `\s` reaches across newlines (Basic,
 * Bearer, `Authorization:`): a segment whose last word is one of them may
 * still own the next line's first word.
 */
const OPEN_SCHEME = /(?:bearer|basic|authorization)$/i;

/**
 * One pipe's redaction context. Never cut raw input to produce a notice: a
 * credential or PEM block may span chunks and lines. A sanitized newline is
 * NOT by itself a safe eviction checkpoint (e.g. `Bearer \n` still owns the
 * next word). If the complete context exceeds the bound, fail closed rather
 * than expose a fragment whose beginning was discarded. Ordinary shell output
 * remains separately readable through the existing bounded ring.
 *
 * Given `version` — the credential owner's redaction version, for a redactor
 * that withholds a trailing credential prefix — complete lines whose
 * redaction provably cannot change settle: they are redacted once and kept,
 * and later chunks redact only what follows them. The result is exactly the
 * whole-context redaction; a context nothing can be proved about simply stays
 * unsettled and is redacted whole, as without `version`.
 */
export class NoticeOutput {
  readonly #decoder = new StringDecoder("utf8");
  /** Raw text after the settled lines. */
  #raw = "";
  /** The raw source of the settled lines, kept to redo them on a version change. */
  #settledRaw: string[] = [];
  #settled: string[] = [];
  #epoch = 0;
  #version: number | undefined;
  #bytes = 0;
  #exceeded = false;
  #failed = false;

  constructor(
    private readonly redact: (text: string) => string,
    private readonly maxBytes: number,
    private readonly version?: () => number,
  ) {}

  get exceeded(): boolean {
    return this.#exceeded;
  }

  get withheld(): boolean {
    return this.#exceeded || this.#failed;
  }

  feed(chunk: Buffer): void {
    if (this.withheld) return;
    this.#bytes += chunk.length;
    if (this.#bytes > this.maxBytes) {
      this.#raw = "";
      this.#settledRaw = [];
      this.#settled = [];
      this.#exceeded = true;
      return;
    }
    this.#raw += this.#decoder.write(chunk);
  }

  finish(): void {
    if (!this.withheld) this.#raw += this.#decoder.end();
  }

  snapshot(): string {
    const view = this.view();
    if (view === null) {
      return this.#exceeded
        ? "[Output withheld: secure redaction context exceeded its bound.]\n"
        : "[Output withheld: credential redaction failed.]\n";
    }
    return view.settled.slice(0, view.settledCount).join("") + view.tail;
  }

  /** The sanitized context, or `null` while it is withheld. */
  view(): NoticeView | null {
    if (this.withheld) return null;
    try {
      // A redaction can itself change the version (the store reads its values
      // on first use); then everything is redone under the version it read.
      for (let attempt = 0; ; attempt += 1) {
        const before = this.version?.();
        if (before !== this.#version) {
          this.#unsettle();
          this.#version = before;
        }
        // Bounded: a third pass redacts the whole context once, as without
        // a version, under whatever the redactor reads at that moment.
        const settling = before !== undefined && attempt < 2;
        if (settling) this.#settle();
        const tail = this.#redactTail();
        if (settling && this.version?.() !== before) continue;
        return {
          epoch: this.#epoch,
          settled: this.#settled,
          settledCount: this.#settled.length,
          tail,
        };
      }
    } catch {
      // Lost context cannot become safe again just because the next callback
      // succeeds. Keep this pipe withheld for the rest of its lifetime.
      this.#failed = true;
      this.#raw = "";
      this.#settledRaw = [];
      this.#settled = [];
      this.#bytes = 0;
      return null;
    }
  }

  /** The redactor may now read settled text differently: start them over. */
  #unsettle(): void {
    if (this.#settledRaw.length === 0) return;
    this.#raw = this.#settledRaw.join("") + this.#raw;
    this.#settledRaw = [];
    this.#settled = [];
    this.#epoch += 1;
  }

  #redactTail(): string {
    const raw = this.#raw;
    // Recognize pending structure BEFORE a transformation can hide its
    // opening. Complete spans are protected together with exact values by
    // the credential owner's notice redactor; default shared redaction also
    // removes complete blocks. At EOF a complete span needs no following
    // text, so treating it as pending here is harmless. Settled text holds no
    // PEM opening and ends in a newline, so every span and pending start of
    // the whole context lies in this tail.
    const spans = pemSecretSpans(raw, true);
    let from = pendingNoticeSecretStart(raw);
    // A pending inner block may overlap a complete outer one. Cut before
    // their union, never inside the complete block (which would destroy
    // its closing boundary before the default redactor sees it).
    for (let i = spans.length - 1; i >= 0; i -= 1) {
      const span = spans[i]!;
      if (span.end === raw.length || (from !== null && span.end > from))
        from = from === null ? span.start : Math.min(from, span.start);
    }
    return from === null ? this.redact(raw) : `${this.redact(raw.slice(0, from))}[redacted]`;
  }

  /** Settle the longest run of complete lines that can be proved independent. */
  #settle(): void {
    const raw = this.#raw;
    const end = settleCandidate(raw);
    if (end === 0) return;
    const segment = raw.slice(0, end);
    let redacted: string;
    try {
      redacted = this.redact(segment);
      if (!this.#independent(segment, redacted)) return;
    } catch {
      // Proving nothing is not a failure; the whole-tail redaction decides.
      return;
    }
    this.#settledRaw.push(segment);
    this.#settled.push(redacted);
    this.#raw = raw.slice(end);
  }

  /**
   * Whether `redact(segment + later) === redacted + redact(later)` for every
   * later text, given what {@link settleCandidate} already established about
   * the raw segment (complete lines, balanced shell quotes, no PEM opening, no
   * command basic-auth prefix, no scheme left open at its end).
   */
  #independent(segment: string, redacted: string): boolean {
    // A trailing credential prefix (withheld by the owner's notice redactor)
    // would have replaced the final newline: none may continue below.
    if (!redacted.endsWith("\n") || openScheme(redacted, solidEnd(redacted))) return false;
    // Every rewrite stays within its line, and a rewritten line held no quote
    // or escape that its rewrite could have unbalanced for what follows.
    const before = segment.split("\n");
    const after = redacted.split("\n");
    if (before.length !== after.length) return false;
    for (let i = 0; i < before.length; i += 1) {
      if (before[i] !== after[i] && /['"\\]/.test(before[i]!)) return false;
    }
    // Later text can turn the shared redactor's marker gate on; prove the
    // segment reads the same when it is on.
    return this.redact(segment + GATE_PROBE) === redacted + this.redact(GATE_PROBE);
  }
}

/**
 * The end of the longest prefix of complete lines after which the shared
 * redactor's shell-quote tracker is closed, no newline is escaped, no PEM
 * opening or command basic-auth prefix occurs, and no Basic/Bearer/
 * Authorization scheme is left open over trailing whitespace; 0 when none.
 */
function settleCandidate(raw: string): number {
  let quote = "";
  let candidate = 0;
  let lineStart = 0;
  // One past the last unit that is neither whitespace nor a colon.
  let solid = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw.charAt(index);
    if (!/\s/.test(character) && character !== ":") solid = index + 1;
    // The shared quote tracker's own reading: an escape (outside single
    // quotes) consumes the next unit, so an escaped newline ends no line.
    if (character === "\\" && quote !== "'") index += 1;
    else if (character === quote) quote = "";
    else if (quote === "" && (character === '"' || character === "'")) quote = character;
    else if (character === "\n") {
      const line = raw.slice(lineStart, index);
      if (line.includes("-----BEGIN") || COMMAND_BASIC_AUTH_PREFIX.test(line)) return candidate;
      lineStart = index + 1;
      if (quote === "" && !openScheme(raw, solid)) candidate = index + 1;
    }
  }
  return candidate;
}

/** Whether `text` ends, at `end` (past whitespace and colons), in an open scheme word. */
function openScheme(text: string, end: number): boolean {
  return OPEN_SCHEME.test(text.slice(Math.max(0, end - "authorization".length), end));
}

/** One past the last unit of `text` that is neither whitespace nor a colon. */
function solidEnd(text: string): number {
  let at = text.length;
  while (at > 0 && (/\s/.test(text.charAt(at - 1)) || text.charAt(at - 1) === ":")) at -= 1;
  return at;
}

/** A shared one-shot decision can combine independently decoded pipe snapshots. */
export class NoticeMatchWatch {
  #epoch: number | null = null;
  #settled: readonly string[] = [];
  #settledCount = 0;
  #tail = "";

  constructor(
    private readonly test: (line: string) => boolean,
    private readonly onMatch: (line: string) => void,
    private readonly lineMaxChars: number,
  ) {}

  /** A whole sanitized snapshot. */
  feed(safe: string): void {
    this.#feed({ epoch: -1, settled: [], settledCount: 0, tail: safe });
  }

  /** A sanitized snapshot whose settled lines need not be read again. */
  feedView(view: NoticeView): void {
    this.#feed(view);
  }

  #feed(view: NoticeView): void {
    // Within one epoch every line already settled is a permanent prefix, so
    // the comparison starts after it; otherwise compare everything.
    const same = view.epoch !== -1 && view.epoch === this.#epoch;
    const previous = same
      ? this.#tail
      : this.#settled.slice(0, this.#settledCount).join("") + this.#tail;
    const next =
      view.settled.slice(same ? this.#settledCount : 0, view.settledCount).join("") + view.tail;
    let common = 0;
    const limit = Math.min(previous.length, next.length);
    while (common < limit && previous[common] === next[common]) common += 1;
    if (common === next.length && common === previous.length) return;
    this.#epoch = view.epoch;
    this.#settled = view.settled;
    this.#settledCount = view.settledCount;
    this.#tail = view.tail;
    // Redaction can replace a multiline suffix as more bytes arrive. Rescan
    // from the last unchanged line boundary, not from a raw output offset.
    // Settled text ends in a newline, so that boundary is never inside it.
    const from = common === 0 ? 0 : next.lastIndexOf("\n", common - 1) + 1;
    for (const rawLine of next.slice(from).split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      const tested = line.slice(0, this.lineMaxChars);
      if (!this.test(tested)) continue;
      this.onMatch(line);
      return;
    }
  }
}
