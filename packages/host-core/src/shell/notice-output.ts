import { StringDecoder } from "node:string_decoder";
import { pemSecretSpans } from "@volli/shared";
import { pendingNoticeSecretStart } from "../secrets/index";

/**
 * One pipe's redaction context. Never cut raw input to produce a notice: a
 * credential or PEM block may span chunks and lines. A sanitized newline is
 * NOT a safe eviction checkpoint (e.g. `Bearer \n` still owns the next word).
 * If the complete context exceeds the bound, fail closed rather than expose
 * a fragment whose beginning was discarded. Ordinary shell output remains
 * separately readable through the existing bounded ring.
 */
export class NoticeOutput {
  readonly #decoder = new StringDecoder("utf8");
  #raw = "";
  #bytes = 0;
  #exceeded = false;
  #failed = false;

  constructor(
    private readonly redact: (text: string) => string,
    private readonly maxBytes: number,
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
      this.#exceeded = true;
      return;
    }
    this.#raw += this.#decoder.write(chunk);
  }

  finish(): void {
    if (!this.withheld) this.#raw += this.#decoder.end();
  }

  snapshot(): string {
    if (this.#exceeded) return "[Output withheld: secure redaction context exceeded its bound.]\n";
    if (this.#failed) return "[Output withheld: credential redaction failed.]\n";
    try {
      // Recognize pending structure BEFORE a transformation can hide its
      // opening. Complete spans are protected together with exact values by
      // the credential owner's notice redactor; default shared redaction also
      // removes complete blocks. At EOF a complete span needs no following
      // text, so treating it as pending here is harmless.
      const spans = pemSecretSpans(this.#raw, true);
      let from = pendingNoticeSecretStart(this.#raw);
      // A pending inner block may overlap a complete outer one. Cut before
      // their union, never inside the complete block (which would destroy
      // its closing boundary before the default redactor sees it).
      for (let i = spans.length - 1; i >= 0; i -= 1) {
        const span = spans[i]!;
        if (span.end === this.#raw.length || (from !== null && span.end > from))
          from = from === null ? span.start : Math.min(from, span.start);
      }
      return from === null
        ? this.redact(this.#raw)
        : `${this.redact(this.#raw.slice(0, from))}[redacted]`;
    } catch {
      // Lost context cannot become safe again just because the next callback
      // succeeds. Keep this pipe withheld for the rest of its lifetime.
      this.#failed = true;
      this.#raw = "";
      this.#bytes = 0;
      return "[Output withheld: credential redaction failed.]\n";
    }
  }
}

/** A shared one-shot decision can combine independently decoded pipe snapshots. */
export class NoticeMatchWatch {
  #previous = "";

  constructor(
    private readonly test: (line: string) => boolean,
    private readonly onMatch: (line: string) => void,
    private readonly lineMaxChars: number,
  ) {}

  feed(safe: string): void {
    let common = 0;
    const limit = Math.min(this.#previous.length, safe.length);
    while (common < limit && this.#previous[common] === safe[common]) common += 1;
    if (common === safe.length && common === this.#previous.length) return;
    this.#previous = safe;
    // Redaction can replace a multiline suffix as more bytes arrive. Rescan
    // from the last unchanged line boundary, not from a raw output offset.
    const from = common === 0 ? 0 : safe.lastIndexOf("\n", common - 1) + 1;
    for (const rawLine of safe.slice(from).split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      const tested = line.slice(0, this.lineMaxChars);
      if (!this.test(tested)) continue;
      this.onMatch(line);
      return;
    }
  }
}
