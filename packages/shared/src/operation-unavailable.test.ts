import { describe, expect, it } from "vite-plus/test";

import {
  isOperationUnavailable,
  OPERATION_UNAVAILABLE,
  OperationUnavailableError,
} from "./operation-unavailable";

describe("OperationUnavailable", () => {
  it("brands the error a handler throws, and keeps its message for the client", () => {
    const error = new OperationUnavailableError("Model Access is unavailable on this host");
    expect(isOperationUnavailable(error)).toBe(true);
    expect(error.message).toBe("Model Access is unavailable on this host");
    expect(error.name).toBe("OperationUnavailableError");
    expect(error).toBeInstanceOf(Error);
  });

  it("matches the well-known brand across module instances, and nothing else", () => {
    expect(isOperationUnavailable({ [Symbol.for("@volli/operation-unavailable")]: true })).toBe(
      true,
    );
    expect(OPERATION_UNAVAILABLE).toBe(Symbol.for("@volli/operation-unavailable"));
    for (const other of [new Error("unavailable"), null, undefined, "unavailable", 1, {}]) {
      expect(isOperationUnavailable(other)).toBe(false);
    }
  });
});
