import { describe, expect, it } from "vite-plus/test";

import {
  classifyWorker,
  decideQuitExit,
  declareWorkerExitKind,
  declaredWorkerExitKind,
  quitReason,
  type DeclaredWorkerKind,
} from "./quit-exit";

describe("decideQuitExit", () => {
  it("exits as before when no worker is running", () => {
    expect(decideQuitExit([])).toBe("exit");
  });

  it("exits now when every live worker is read-only", () => {
    expect(decideQuitExit(["read-only"])).toBe("exit-now");
    expect(decideQuitExit(["read-only", "read-only"])).toBe("exit-now");
  });

  it("waits, as before, for a worker that may be writing or that nobody declared", () => {
    expect(decideQuitExit(["read-only", "writing"])).toBe("exit");
    expect(decideQuitExit(["read-only", "unknown"])).toBe("exit");
    expect(decideQuitExit(["unknown"])).toBe("exit");
  });

  it("never cuts an upgrade short, whatever else is running", () => {
    expect(decideQuitExit(["upgrade"])).toBe("finish-upgrade-first");
    expect(decideQuitExit(["read-only", "upgrade"])).toBe("finish-upgrade-first");
    expect(decideQuitExit(["unknown", "upgrade", "writing"])).toBe("finish-upgrade-first");
  });
});

describe("classifyWorker", () => {
  it("allows an immediate exit only for workers that write nothing live", () => {
    const allowed: DeclaredWorkerKind[] = ["automatic-backup", "database-reader", "stateless"];
    for (const kind of allowed) expect(classifyWorker(kind)).toBe("read-only");
  });

  it("treats a check as read-only only once the quit holds its claim", () => {
    expect(classifyWorker("database-check")).toBe("writing");
    expect(classifyWorker("database-check", true)).toBe("read-only");
  });

  it("forbids it for an upgrade, a claim notwithstanding, and for anything undeclared", () => {
    expect(classifyWorker("database-upgrade", true)).toBe("upgrade");
    expect(classifyWorker(undefined)).toBe("unknown");
    expect(classifyWorker(undefined, true)).toBe("unknown");
  });
});

describe("declareWorkerExitKind", () => {
  it("tags a worker under the registered symbol, so another package can read it", () => {
    const worker = {};
    expect(declaredWorkerExitKind(worker)).toBeUndefined();
    declareWorkerExitKind(worker, "stateless");
    expect(declaredWorkerExitKind(worker)).toBe("stateless");
    expect((worker as Record<symbol, unknown>)[Symbol.for("volli.worker-exit-kind")]).toBe(
      "stateless",
    );
    // Not enumerable: nothing that copies or logs the worker carries it along.
    expect(Object.keys(worker)).toEqual([]);
  });

  it("reads every declared kind back, and nothing else", () => {
    for (const kind of [
      "database-check",
      "database-upgrade",
      "automatic-backup",
      "database-reader",
      "stateless",
    ] as const) {
      const worker = {};
      declareWorkerExitKind(worker, kind);
      expect(declaredWorkerExitKind(worker)).toBe(kind);
    }
    expect(
      declaredWorkerExitKind({ [Symbol.for("volli.worker-exit-kind")]: "writer" }),
    ).toBeUndefined();
  });
});

describe("quitReason", () => {
  const none = {
    updateInstall: false,
    relaunch: false,
    systemShutdown: false,
    lastWindowClosed: false,
  };

  it("names the most specific reason main knows", () => {
    expect(quitReason(none)).toBe("quit");
    expect(quitReason({ ...none, lastWindowClosed: true })).toBe("last-window-closed");
    expect(quitReason({ ...none, systemShutdown: true, lastWindowClosed: true })).toBe(
      "system-shutdown",
    );
    expect(quitReason({ ...none, relaunch: true, systemShutdown: true })).toBe("relaunch");
    expect(quitReason({ ...none, updateInstall: true, relaunch: true })).toBe("update-install");
  });
});
