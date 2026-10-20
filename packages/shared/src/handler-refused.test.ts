import { describe, expect, it } from "vite-plus/test";

import { HANDLER_REFUSED, HandlerRefusedError, isHandlerRefused } from "./handler-refused";

describe("HandlerRefused", () => {
  it("brands the error the map throws, and keeps its message and hint for the client", () => {
    const error = new HandlerRefusedError(
      "ticket.move is not open to this caller.",
      "Ask a person.",
    );
    expect(isHandlerRefused(error)).toBe(true);
    expect(error.message).toBe("ticket.move is not open to this caller.");
    expect(error.hint).toBe("Ask a person.");
    expect(error.name).toBe("HandlerRefusedError");
    expect(error).toBeInstanceOf(Error);
    expect(new HandlerRefusedError("No.").hint).toBeNull();
  });

  it("matches the well-known brand across module instances, and nothing else", () => {
    expect(isHandlerRefused({ [Symbol.for("@volli/handler-refused")]: true })).toBe(true);
    expect(HANDLER_REFUSED).toBe(Symbol.for("@volli/handler-refused"));
    for (const other of [new Error("refused"), null, undefined, "refused", 1, {}]) {
      expect(isHandlerRefused(other)).toBe(false);
    }
  });
});
