import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { installLayout } from "./layout";
import {
  answer,
  failureJson,
  lingerOf,
  ManagementError,
  must,
  readManaged,
  unitState,
  writeManaged,
  type CommandResult,
} from "./management";

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

describe("the management commands' answers", () => {
  it("prints one line of JSON, success or typed failure, and lets a bug through", async () => {
    const lines: string[] = [];
    const out = (text: string) => lines.push(text);
    expect(await answer(out, () => ({ v: 1, ok: true }))).toBe(0);
    expect(
      await answer(out, async () => {
        throw new ManagementError("not-root", "Run it as root.", [], 77);
      }),
    ).toBe(77);
    expect(
      await answer(out, () => {
        throw new ManagementError("command-failed", "x failed.", ["stderr line"]);
      }),
    ).toBe(1);
    expect(lines).toEqual([
      '{"v":1,"ok":true}\n',
      '{"v":1,"ok":false,"code":"not-root","message":"Run it as root."}\n',
      '{"v":1,"ok":false,"code":"command-failed","message":"x failed.","detail":["stderr line"]}\n',
    ]);
    await expect(
      answer(out, () => {
        throw new TypeError("a bug");
      }),
    ).rejects.toThrow("a bug");
    expect(failureJson(new ManagementError("usage", "No."))).toEqual({
      v: 1,
      ok: false,
      code: "usage",
      message: "No.",
    });
  });

  it("names a tool that must succeed and did not", () => {
    expect(must(() => ok("fine"), "true", [])).toEqual(ok("fine"));
    expect(() =>
      must(() => ({ code: 2, stdout: "", stderr: "" }), "systemctl", ["enable", "x"]),
    ).toThrow("systemctl enable x failed (exit 2).");
  });

  it("reads systemd's unit state and logind's lingering, or says it does not know", () => {
    expect(unitState(() => ok("ActiveState=active\nUnitFileState=enabled\n"), "system")).toEqual({
      name: "volli-hostd.service",
      active: "active",
      enabled: "enabled",
    });
    expect(unitState(() => ok("ActiveState=\n"), "user")).toMatchObject({
      active: "unknown",
      enabled: "unknown",
    });
    expect(unitState(() => ({ code: 1, stdout: "", stderr: "" }), "user").active).toBe("unknown");
    expect(lingerOf(() => ok("yes\n"), "a")).toBe(true);
    expect(lingerOf(() => ok("no\n"), "a")).toBe(false);
    expect(lingerOf(() => ok("\n"), "a")).toBeNull();
    expect(lingerOf(() => ({ code: 1, stdout: "", stderr: "" }), "a")).toBeNull();
  });
});

describe("the managed record", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hostd-managed-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is read back only for its own mode, and never from a file that is not one", () => {
    const layout = installLayout("system", { prefix: root, home: root, env: {} });
    expect(readManaged(layout)).toBeNull();
    mkdirSync(layout.root, { recursive: true });
    const record = {
      v: 1,
      mode: "system",
      version: "1.0.0",
      port: 7420,
      installedAt: "t",
    } as const;
    writeManaged(layout, record);
    expect(readManaged(layout)).toEqual(record);
    expect(readManaged({ ...layout, mode: "user" })).toBeNull();
    for (const text of [
      "[]",
      "{}",
      '{"v":1,"mode":"system","version":1}',
      '{"v":1,"mode":"system","version":"1","port":"x"}',
    ]) {
      writeFileSync(layout.managedFile, text);
      expect(readManaged(layout)).toBeNull();
    }
  });
});
