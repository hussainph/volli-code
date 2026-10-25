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
  private buffer = "";
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
    if (this.buffer !== "") this.line(this.buffer, events);
    this.buffer = "";
    this.dispatch(events);
    return events;
  }

  private feed(text: string): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.overflowed) return events;
    let start = 0;
    if (this.pendingCarriageReturn && text.startsWith("\n")) start = 1;
    this.pendingCarriageReturn = false;
    let buffer = this.buffer + text.slice(start);
    let index: number;
    while ((index = buffer.search(/[\r\n]/)) !== -1) {
      const line = buffer.slice(0, index);
      if (buffer[index] === "\r") {
        if (index + 1 === buffer.length) {
          // A CR at the end of a chunk may be the first half of CRLF.
          this.pendingCarriageReturn = true;
          buffer = buffer.slice(index + 1);
          this.line(line, events);
          continue;
        }
        buffer = buffer.slice(buffer[index + 1] === "\n" ? index + 2 : index + 1);
      } else {
        buffer = buffer.slice(index + 1);
      }
      this.line(line, events);
    }
    if (buffer.length > MAX_SSE_LINE_LENGTH) {
      this.overflowed = true;
      this.buffer = "";
      return events;
    }
    this.buffer = buffer;
    return events;
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
