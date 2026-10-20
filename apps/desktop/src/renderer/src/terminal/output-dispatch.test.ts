import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { TerminalEngine } from "./engine";
import { deliverTerminalOutput } from "./output-dispatch";

/** An engine whose only live method is `write`; the rest are inert. */
function engineWith(write: TerminalEngine["write"]): TerminalEngine {
  return {
    attach: vi.fn(),
    write,
    onData: vi.fn(() => () => {}),
    onResize: vi.fn(() => () => {}),
    setPaused: vi.fn(),
    fit: vi.fn(),
    focus: vi.fn(),
    adjustFontSize: vi.fn(),
    resetFontSize: vi.fn(),
    dispose: vi.fn(),
  };
}

const event = { sessionId: "s1", data: "hello" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deliverTerminalOutput", () => {
  it("acks only once the engine releases the chunk, and only once", () => {
    let parsed: (() => void) | undefined;
    const write = vi.fn((_data: string, onParsed?: () => void) => {
      parsed = onParsed;
    });
    const ack = vi.fn();

    deliverTerminalOutput(event, engineWith(write), ack);

    expect(write).toHaveBeenCalledWith("hello", expect.any(Function));
    expect(ack).not.toHaveBeenCalled();
    parsed?.();
    parsed?.();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith("s1", 5);
  });

  it("acks at once when no engine exists for the session", () => {
    const ack = vi.fn();
    deliverTerminalOutput(event, undefined, ack);
    expect(ack).toHaveBeenCalledWith("s1", 5);
  });

  it("acks a chunk whose write throws, and logs rather than rethrows", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("write data discarded, use flow control to avoid losing data");
    const ack = vi.fn();

    expect(() =>
      deliverTerminalOutput(
        event,
        engineWith(() => {
          throw boom;
        }),
        ack,
      ),
    ).not.toThrow();

    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith("s1", 5);
    expect(error).toHaveBeenCalledWith("terminal output dropped:", boom);
  });

  it("does not ack twice when an engine releases the chunk and then throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ack = vi.fn();
    deliverTerminalOutput(
      event,
      engineWith((_data, onParsed) => {
        onParsed?.();
        throw new Error("late failure");
      }),
      ack,
    );
    expect(ack).toHaveBeenCalledTimes(1);
  });
});
