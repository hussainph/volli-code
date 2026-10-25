import { describe, expect, it } from "vite-plus/test";

import { decodeRunnerRecords, encodeRunnerRecords, runnerRecordStore } from "./record";

const DANA = "11111111-1111-4111-8111-111111111111";
const SAM = "55555555-5555-4555-8555-555555555555";
const RUNNER = "22222222-2222-4222-8222-222222222222";
const log = { warn: () => {} };

const broken = () => ({
  read: (): string => {
    throw new Error("disk");
  },
  write: () => {
    throw new Error("disk");
  },
});

describe("this Mac's runner record", () => {
  it("keeps one record per person in one row", () => {
    let value: string | undefined;
    const row = () => ({ read: () => value, write: (next: string) => void (value = next) });
    const dana = runnerRecordStore(row, DANA, log);
    const sam = runnerRecordStore(row, SAM, log);
    expect(dana.read()).toBeNull();
    dana.write({ runnerId: RUNNER, hostname: "danas-mac", tombstone: null });
    sam.write({ runnerId: RUNNER, hostname: "danas-mac", tombstone: "removed" });
    expect(dana.read()).toEqual({ runnerId: RUNNER, hostname: "danas-mac", tombstone: null });
    expect(sam.read()?.tombstone).toBe("removed");
  });

  it("reads anything unreadable as nothing remembered, and an unknown tombstone as removed", () => {
    for (const raw of [
      undefined,
      "",
      "null",
      "[]",
      '{"v":2,"accounts":{}}',
      '{"v":1,"accounts":null}',
    ]) {
      expect(decodeRunnerRecords(raw)).toEqual({});
    }
    const raw = encodeRunnerRecords({
      [DANA]: { runnerId: RUNNER, hostname: "h", tombstone: "something-newer" as never },
    });
    expect(decodeRunnerRecords(raw)[DANA]?.tombstone).toBe("removed");
    expect(
      decodeRunnerRecords('{"v":1,"accounts":{"x":{"runnerId":"bad","hostname":"h"},"y":7}}'),
    ).toEqual({});
  });

  it("logs and carries on over a degraded database", () => {
    const warnings: string[] = [];
    const store = runnerRecordStore(broken, DANA, {
      warn: (message) => void warnings.push(message),
    });
    expect(store.read()).toBeNull();
    store.write({ runnerId: RUNNER, hostname: "h", tombstone: null });
    expect(warnings).toHaveLength(2);
    expect(runnerRecordStore(() => null, DANA, log).read()).toBeNull();
    runnerRecordStore(() => null, DANA, log).write({
      runnerId: RUNNER,
      hostname: "h",
      tombstone: null,
    });
  });
});
