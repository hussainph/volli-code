import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { EXAMPLE } from "../testing/identity";

import { BootError } from "./boot-error";
import { acquireInstanceLock, lockFileName } from "./instance-lock";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "example-lock-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the instance lock", () => {
  it("is held until released, and releasing twice is harmless", () => {
    const first = acquireInstanceLock(EXAMPLE, dataDir);
    expect(() => acquireInstanceLock(EXAMPLE, dataDir)).toThrow(BootError);
    first.release();
    first.release();
    acquireInstanceLock(EXAMPLE, dataDir).release();
  });
});

describe("an instance lock it cannot take", () => {
  it("is a data-directory refusal, not another daemon", () => {
    mkdirSync(join(dataDir, lockFileName(EXAMPLE)));
    let thrown: unknown;
    try {
      acquireInstanceLock(EXAMPLE, dataDir);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BootError);
    expect(thrown).toMatchObject({
      reason: "data-dir",
      fields: { lockPath: join(dataDir, "example.lock") },
    });
  });

  it("names the program when another one holds it", () => {
    const held = acquireInstanceLock(EXAMPLE, dataDir);
    try {
      expect(() => acquireInstanceLock(EXAMPLE, dataDir)).toThrow(
        `Another volli-example is serving ${dataDir}`,
      );
    } finally {
      held.release();
    }
  });
});
