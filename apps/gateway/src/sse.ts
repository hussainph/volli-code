/**
 * An incremental server-sent events parser (the WHATWG event stream format),
 * fed the relayed bytes as they pass so the gateway can read the provider's
 * usage report without holding the stream.
 *
 * It parses only to meter. A line longer than its bound stops the parser, not
 * the relay: the bytes still reach the runner, and the call is metered as
 * whatever was read before.
 */

export interface SseEvent {
  /** The `event:` field; absent means the default `message` type. */
  event?: string;
  data: string;
}

/** The longest line kept while waiting for its end. */
export const MAX_SSE_LINE_LENGTH = 4 * 1024 * 1024;

export class SseParser {
  private readonly decoder = new TextDecoder();
  private tail: string[] = [];
  private tailLength = 0;
  private event: string | undefined;
  private data: string[] = [];
  private pendingCarriageReturn = false;
  /** True once a line exceeded {@link MAX_SSE_LINE_LENGTH}; nothing more is parsed. */
  overflowed = false;

  push(chunk: Uint8Array): SseEvent[] {
    return this.feed(this.decoder.decode(chunk, { stream: true }));
  }

  /** Flushes the tail. A final event with no blank line after it is dispatched too. */
  end(): SseEvent[] {
    const events = this.feed(this.decoder.decode());
    if (this.overflowed) return events;
    if (this.tailLength > 0) this.line(this.tail.join(""), events);
    this.tail = [];
    this.tailLength = 0;
    this.dispatch(events);
    return events;
  }

  private feed(input: string): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.overflowed) return events;
    let text = input;
    if (this.pendingCarriageReturn && text !== "") {
      this.pendingCarriageReturn = false;
      if (text.startsWith("\n")) text = text.slice(1);
    }
    // A chunk with no line end only extends the held tail. The tail is kept as
    // a list and joined once a line ends, so one long line arriving in many
    // chunks costs one copy, not one per chunk.
    if (!/[\r\n]/.test(text)) {
      this.tail.push(text);
      this.tailLength += text.length;
      if (this.tailLength > MAX_SSE_LINE_LENGTH) this.overflow();
      return events;
    }
    const held = this.tailLength;
    const buffer = this.tail.join("") + text;
    this.tail = [];
    this.tailLength = 0;
    let lineStart = 0;
    let nextLf = buffer.indexOf("\n", held);
    let nextCr = buffer.indexOf("\r", held);
    while (nextLf !== -1 || nextCr !== -1) {
      const end = nextLf === -1 ? nextCr : nextCr === -1 ? nextLf : Math.min(nextLf, nextCr);
      this.line(buffer.slice(lineStart, end), events);
      if (end === nextCr && end + 1 === buffer.length) {
        // A CR at the end of a chunk may be the first half of CRLF.
        this.pendingCarriageReturn = true;
        lineStart = end + 1;
        break;
      }
      lineStart = end === nextCr && buffer[end + 1] === "\n" ? end + 2 : end + 1;
      if (nextLf !== -1 && nextLf < lineStart) nextLf = buffer.indexOf("\n", lineStart);
      if (nextCr !== -1 && nextCr < lineStart) nextCr = buffer.indexOf("\r", lineStart);
    }
    const rest = buffer.slice(lineStart);
    if (rest.length > MAX_SSE_LINE_LENGTH) {
      this.overflow();
      return events;
    }
    if (rest !== "") {
      this.tail.push(rest);
      this.tailLength = rest.length;
    }
    return events;
  }

  private overflow(): void {
    this.overflowed = true;
    this.tail = [];
    this.tailLength = 0;
  }

  private line(line: string, events: SseEvent[]): void {
    if (line === "") {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
  }

  private dispatch(events: SseEvent[]): void {
    if (this.data.length > 0) {
      events.push({
        ...(this.event === undefined ? {} : { event: this.event }),
        data: this.data.join("\n"),
      });
    }
    this.event = undefined;
    this.data = [];
  }
}
