import { declaredWorkerExitKind } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { declareStatelessWorker } from "./stateless-worker";

describe("declareStatelessWorker", () => {
  it("tags a worker as the host's quit reads it", () => {
    const worker = {};
    declareStatelessWorker(worker);
    expect(declaredWorkerExitKind(worker)).toBe("stateless");
  });
});
