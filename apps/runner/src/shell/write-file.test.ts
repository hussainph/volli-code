import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { atomicWrite, durableWrite } from "./write-file";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "example-write-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a whole-file write", () => {
  it("replaces the file at exactly the mode asked for", () => {
    const path = join(root, "unit");
    atomicWrite(path, "one", 0o600);
    atomicWrite(path, "two", 0o644);
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(readdirSync(root)).toEqual(["unit"]);
  });

  it("leaves no temporary file when it cannot rename over the target", () => {
    const path = join(root, "occupied");
    mkdirSync(join(path, "inside"), { recursive: true });
    expect(() => atomicWrite(path, "x", 0o600)).toThrow();
    expect(readdirSync(root)).toEqual(["occupied"]);
  });
});

describe("a durable write", () => {
  it("replaces the file whole at the mode asked for, bytes or text", () => {
    const path = join(root, "credential");
    durableWrite(path, "one", 0o600);
    durableWrite(path, Buffer.from("two"), 0o600);
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(["credential"]);
  });

  it("leaves no temporary file when it cannot rename over the target", () => {
    const path = join(root, "occupied");
    mkdirSync(join(path, "inside"), { recursive: true });
    expect(() => durableWrite(path, "x", 0o600)).toThrow();
    expect(readdirSync(root)).toEqual(["occupied"]);
  });
});
