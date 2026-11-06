import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  readDaemonStatus,
  EMPTY_STATE,
  readNowRequest,
  readReported,
  readSmallFile,
  readUpdateRequest,
  readUpdaterState,
  STATE_HISTORY,
  writeNowRequest,
  writeReported,
  writeUpdateRequest,
  writeUpdaterState,
  type UpdateOutcome,
} from "./files";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-update-files-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("reading a small file", () => {
  it("reads a regular file and answers null for a missing one", () => {
    writeFileSync(join(root, "a"), "hello");
    expect(readSmallFile(join(root, "a"), 10)).toBe("hello");
    expect(readSmallFile(join(root, "missing"), 10)).toBeNull();
  });

  it("refuses a file another account owns, when asked who should", () => {
    writeFileSync(join(root, "a"), "hello");
    expect(readSmallFile(join(root, "a"), 10, process.getuid!())).toBe("hello");
    expect(() => readSmallFile(join(root, "a"), 10, process.getuid!() + 1)).toThrow(
      /not owned by the runner's account/u,
    );
  });

  it("refuses a symlink, a directory and an oversized file", () => {
    writeFileSync(join(root, "target"), "{}");
    symlinkSync(join(root, "target"), join(root, "link"));
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "big"), "x".repeat(20));
    expect(() => readSmallFile(join(root, "link"), 10)).toThrow();
    expect(() => readSmallFile(join(root, "dir"), 10)).toThrow(/not a regular file/u);
    expect(() => readSmallFile(join(root, "big"), 10)).toThrow(/larger than 10/u);
  });
});

describe("the update request", () => {
  const path = () => join(root, "data", "update", "request.json");

  it("round-trips both phases with a fresh id each time", () => {
    const stage = writeUpdateRequest(path(), {
      phase: "stage",
      version: "0.4.0",
      manifestUrl: "https://example.com/m.json",
      urgent: false,
    });
    expect(statSync(path()).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "data", "update")).mode & 0o777).toBe(0o700);
    expect(readUpdateRequest(path())).toEqual(stage);
    const activate = writeUpdateRequest(path(), {
      phase: "activate",
      version: "0.4.0",
      urgent: true,
    });
    expect(activate.id).not.toBe(stage.id);
    expect(readUpdateRequest(path())).toEqual(activate);
  });

  it("is null when absent", () => {
    expect(readUpdateRequest(path())).toBeNull();
  });

  it("refuses anything that is not exactly a request", () => {
    const valid = {
      v: 1,
      id: ID,
      phase: "stage",
      version: "0.4.0",
      manifestUrl: "https://example.com/m.json",
      urgent: false,
    };
    const cases: unknown[] = [
      null,
      [],
      "x",
      { ...valid, extra: 1 },
      { ...valid, v: 2 },
      { ...valid, id: "nope" },
      { ...valid, id: 5 },
      { ...valid, version: "../x" },
      { ...valid, urgent: "yes" },
      { ...valid, manifestUrl: 3 },
      { ...valid, phase: "rollback" },
      { v: 1, id: ID, phase: "activate", version: "0.4.0", urgent: false, manifestUrl: "x" },
    ];
    mkdirSync(join(root, "data", "update"), { recursive: true });
    for (const value of cases) {
      writeFileSync(path(), JSON.stringify(value));
      expect(() => readUpdateRequest(path())).toThrow();
    }
  });
});

const outcome = (id: string): UpdateOutcome => ({
  id,
  kind: "update_staged",
  version: "0.4.0",
  fromVersion: "0.3.0",
  reason: null,
  at: "2026-11-01T00:00:00.000Z",
});

describe("the updater state", () => {
  const path = () => join(root, "update-state.json");

  it("is empty until written, then durable and world-readable", () => {
    expect(readUpdaterState(path())).toEqual(EMPTY_STATE);
    const state = {
      ...EMPTY_STATE,
      staged: { version: "0.4.0", name: "0.4.0-abc" },
      activating: {
        version: "0.4.1",
        name: "0.4.1",
        fromTarget: "/x",
        fromVersion: "0.4.0",
        at: "x",
      },
      outcomes: [outcome("a")],
    };
    writeUpdaterState(path(), state);
    expect(statSync(path()).mode & 0o777).toBe(0o644);
    expect(readUpdaterState(path())).toEqual(state);
  });

  it("keeps bounded histories", () => {
    const ids = Array.from({ length: STATE_HISTORY + 5 }, (_, index) => `id-${index}`);
    writeUpdaterState(path(), { ...EMPTY_STATE, handled: ids, outcomes: ids.map(outcome) });
    const read = readUpdaterState(path());
    expect(read.handled).toEqual(ids.slice(-STATE_HISTORY));
    expect(read.outcomes.map((entry) => entry.id)).toEqual(ids.slice(-STATE_HISTORY));
  });

  it("refuses a damaged state", () => {
    const cases: unknown[] = [
      null,
      { ...EMPTY_STATE, v: 2 },
      { ...EMPTY_STATE, staged: 1 },
      { ...EMPTY_STATE, previous: 1 },
      { ...EMPTY_STATE, bad: [1] },
      { ...EMPTY_STATE, bad: "x" },
      { ...EMPTY_STATE, handled: null },
      { ...EMPTY_STATE, outcomes: {} },
      { ...EMPTY_STATE, outcomes: [null] },
      { ...EMPTY_STATE, outcomes: [{ ...outcome("a"), kind: "other" }] },
      { ...EMPTY_STATE, outcomes: [{ ...outcome("a"), id: 1 }] },
      { ...EMPTY_STATE, outcomes: [{ ...outcome("a"), version: 1 }] },
      { ...EMPTY_STATE, outcomes: [{ ...outcome("a"), fromVersion: 1 }] },
      { ...EMPTY_STATE, outcomes: [{ ...outcome("a"), reason: 1 }] },
      { ...EMPTY_STATE, outcomes: [{ ...outcome("a"), at: 1 }] },
    ];
    for (const value of cases) {
      writeFileSync(path(), JSON.stringify(value));
      expect(() => readUpdaterState(path())).toThrow();
    }
    writeFileSync(path(), JSON.stringify({ ...EMPTY_STATE, previous: "0.3.0", staged: null }));
    expect(readUpdaterState(path()).previous).toBe("0.3.0");
    writeFileSync(
      path(),
      JSON.stringify({
        ...EMPTY_STATE,
        outcomes: [{ ...outcome("a"), fromVersion: null, reason: "x" }],
      }),
    );
    expect(readUpdaterState(path()).outcomes[0]?.reason).toBe("x");
  });
});

describe("update --now", () => {
  const path = () => join(root, "update-now.json");

  it("round-trips, world-readable", () => {
    expect(readNowRequest(path())).toBeNull();
    writeNowRequest(path(), "0.4.0", new Date(0));
    expect(statSync(path()).mode & 0o777).toBe(0o644);
    expect(readNowRequest(path())).toEqual({
      v: 1,
      version: "0.4.0",
      at: "1970-01-01T00:00:00.000Z",
    });
    writeNowRequest(path(), null, new Date(0));
    expect(readNowRequest(path())?.version).toBeNull();
  });

  it("refuses a damaged one", () => {
    for (const value of [
      null,
      { v: 2, version: null, at: "x" },
      { v: 1, version: "x", at: "x" },
      { v: 1, version: null, at: 1 },
    ]) {
      writeFileSync(path(), JSON.stringify(value));
      expect(() => readNowRequest(path())).toThrow();
    }
  });
});

describe("the reported set", () => {
  const path = () => join(root, "data", "update", "reported.json");

  it("round-trips, bounded, and reads anything unreadable as empty", () => {
    expect(readReported(path())).toEqual(new Set());
    const ids = Array.from({ length: STATE_HISTORY * 2 + 3 }, (_, index) => `id-${index}`);
    writeReported(path(), ids);
    expect([...readReported(path())]).toEqual(ids.slice(-STATE_HISTORY * 2));
    writeFileSync(path(), "{");
    expect(readReported(path())).toEqual(new Set());
    writeFileSync(path(), JSON.stringify({ not: "a list" }));
    expect(readReported(path())).toEqual(new Set());
    expect(readFileSync(path(), "utf8")).toContain("not");
  });
});

describe("the daemon's status, read by the applier", () => {
  const path = () => join(root, "runner-status.json");

  it("reads a status and nothing else", () => {
    expect(readDaemonStatus(root)).toBeNull();
    writeFileSync(path(), JSON.stringify({ state: "online", pid: 7, version: "0.4.0" }));
    expect(readDaemonStatus(root)).toMatchObject({ state: "online", pid: 7 });
    for (const value of [
      "{",
      "null",
      '{"state":"online","pid":1.5,"version":"x"}',
      '{"state":1}',
      '{"state":"online","pid":1}',
    ]) {
      writeFileSync(path(), value);
      expect(readDaemonStatus(root)).toBeNull();
    }
  });

  it("never follows a link the daemon's account planted", () => {
    writeFileSync(
      join(root, "elsewhere"),
      JSON.stringify({ state: "online", pid: 7, version: "0.4.0" }),
    );
    symlinkSync(join(root, "elsewhere"), path());
    expect(readDaemonStatus(root)).toBeNull();
  });
});
