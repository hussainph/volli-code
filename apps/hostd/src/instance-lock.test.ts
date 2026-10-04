import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { HostdBootError } from "./boot-error";
import { acquireInstanceLock } from "./instance-lock";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hostd-lock-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the instance lock", () => {
  it("is held until released, and releasing twice is harmless", () => {
    const first = acquireInstanceLock(dataDir);
    expect(() => acquireInstanceLock(dataDir)).toThrow(HostdBootError);
    first.release();
    first.release();
    acquireInstanceLock(dataDir).release();
  });
});
