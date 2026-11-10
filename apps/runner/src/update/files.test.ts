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

const requestPath = () => join(root, "data", "update", "request.json");

describe("the update request", () => {
  it("round-trips both phases with a fresh id each time", () => {
    const stage = writeUpdateRequest(requestPath(), {
      phase: "stage",
      version: "0.4.0",
      manifestUrl: "https://example.com/m.json",
      urgent: false,
    });
    expect(statSync(requestPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "data", "update")).mode & 0o777).toBe(0o700);
    expect(readUpdateRequest(requestPath())).toEqual(stage);
    const activate = writeUpdateRequest(requestPath(), {
      phase: "activate",
      version: "0.4.0",
      urgent: true,
    });
    expect(activate.id).not.toBe(stage.id);
    expect(readUpdateRequest(requestPath())).toEqual(activate);
  });

  it("is null when absent", () => {
    expect(readUpdateRequest(requestPath())).toBeNull();
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
      writeFileSync(requestPath(), JSON.stringify(value));
      expect(() => readUpdateRequest(requestPath())).toThrow();
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

const updaterStatePath = () => join(root, "update-state.json");

describe("the updater state", () => {
  it("is empty until written, then durable and world-readable", () => {
    expect(readUpdaterState(updaterStatePath())).toEqual(EMPTY_STATE);
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
    writeUpdaterState(updaterStatePath(), state);
    expect(statSync(updaterStatePath()).mode & 0o777).toBe(0o644);
    expect(readUpdaterState(updaterStatePath())).toEqual(state);
  });

  it("keeps bounded histories", () => {
    const ids = Array.from({ length: STATE_HISTORY + 5 }, (_, index) => `id-${index}`);
    writeUpdaterState(updaterStatePath(), {
      ...EMPTY_STATE,
      handled: ids,
      outcomes: ids.map(outcome),
    });
    const read = readUpdaterState(updaterStatePath());
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
      writeFileSync(updaterStatePath(), JSON.stringify(value));
      expect(() => readUpdaterState(updaterStatePath())).toThrow();
    }
    writeFileSync(
      updaterStatePath(),
      JSON.stringify({ ...EMPTY_STATE, previous: "0.3.0", staged: null }),
    );
    expect(readUpdaterState(updaterStatePath()).previous).toBe("0.3.0");
    writeFileSync(
      updaterStatePath(),
      JSON.stringify({
        ...EMPTY_STATE,
        outcomes: [{ ...outcome("a"), fromVersion: null, reason: "x" }],
      }),
    );
    expect(readUpdaterState(updaterStatePath()).outcomes[0]?.reason).toBe("x");
  });
});

const nowRequestPath = () => join(root, "update-now.json");

describe("update --now", () => {
  it("round-trips, world-readable", () => {
    expect(readNowRequest(nowRequestPath())).toBeNull();
    writeNowRequest(nowRequestPath(), "0.4.0", new Date(0));
    expect(statSync(nowRequestPath()).mode & 0o777).toBe(0o644);
    expect(readNowRequest(nowRequestPath())).toEqual({
      v: 1,
      version: "0.4.0",
      at: "1970-01-01T00:00:00.000Z",
    });
    writeNowRequest(nowRequestPath(), null, new Date(0));
    expect(readNowRequest(nowRequestPath())?.version).toBeNull();
  });

  it("refuses a damaged one", () => {
    for (const value of [
      null,
      { v: 2, version: null, at: "x" },
      { v: 1, version: "x", at: "x" },
      { v: 1, version: null, at: 1 },
    ]) {
      writeFileSync(nowRequestPath(), JSON.stringify(value));
      expect(() => readNowRequest(nowRequestPath())).toThrow();
    }
  });
});

const reportedPath = () => join(root, "data", "update", "reported.json");

describe("the reported set", () => {
  it("round-trips, bounded, and reads anything unreadable as empty", () => {
    expect(readReported(reportedPath())).toEqual(new Set());
    const ids = Array.from({ length: STATE_HISTORY * 2 + 3 }, (_, index) => `id-${index}`);
    writeReported(reportedPath(), ids);
    expect([...readReported(reportedPath())]).toEqual(ids.slice(-STATE_HISTORY * 2));
    writeFileSync(reportedPath(), "{");
    expect(readReported(reportedPath())).toEqual(new Set());
    writeFileSync(reportedPath(), JSON.stringify({ not: "a list" }));
    expect(readReported(reportedPath())).toEqual(new Set());
    expect(readFileSync(reportedPath(), "utf8")).toContain("not");
  });
});

const daemonStatusPath = () => join(root, "runner-status.json");

describe("the daemon's status, read by the applier", () => {
  it("reads a status and nothing else", () => {
    expect(readDaemonStatus(root)).toBeNull();
    writeFileSync(
      daemonStatusPath(),
      JSON.stringify({ state: "online", pid: 7, version: "0.4.0" }),
    );
    expect(readDaemonStatus(root)).toMatchObject({ state: "online", pid: 7 });
    for (const value of [
      "{",
      "null",
      '{"state":"online","pid":1.5,"version":"x"}',
      '{"state":1}',
      '{"state":"online","pid":1}',
    ]) {
      writeFileSync(daemonStatusPath(), value);
      expect(readDaemonStatus(root)).toBeNull();
    }
  });

  it("never follows a link the daemon's account planted", () => {
    writeFileSync(
      join(root, "elsewhere"),
      JSON.stringify({ state: "online", pid: 7, version: "0.4.0" }),
    );
    symlinkSync(join(root, "elsewhere"), daemonStatusPath());
    expect(readDaemonStatus(root)).toBeNull();
  });
});
