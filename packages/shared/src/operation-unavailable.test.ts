import { describe, expect, it } from "vite-plus/test";

import {
  isOperationCancelled,
  isOperationUnavailable,
  OPERATION_CANCELLED,
  OPERATION_UNAVAILABLE,
  OperationCancelledError,
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

describe("OperationCancelled", () => {
  it("brands a cancel apart from an unavailable operation", () => {
    const error = new OperationCancelledError("The dry run was cancelled.");
    expect(isOperationCancelled(error)).toBe(true);
    expect(isOperationUnavailable(error)).toBe(false);
    expect(isOperationCancelled(new OperationUnavailableError("x"))).toBe(false);
    expect(error.message).toBe("The dry run was cancelled.");
    expect(error.name).toBe("OperationCancelledError");
  });

  it("matches the well-known brand across module instances, and nothing else", () => {
    expect(isOperationCancelled({ [Symbol.for("@volli/operation-cancelled")]: true })).toBe(true);
    expect(OPERATION_CANCELLED).toBe(Symbol.for("@volli/operation-cancelled"));
    for (const other of [new Error("cancelled"), null, undefined, "cancelled", 1, {}]) {
      expect(isOperationCancelled(other)).toBe(false);
    }
  });
});
