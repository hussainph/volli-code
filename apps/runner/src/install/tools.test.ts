import * as fs from "node:fs";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { confirmPurge, mustRun, runTool } from "./tools";

vi.mock("node:fs", async (original) => {
  const real = await original<typeof fs>();
  return {
    ...real,
    openSync: vi.fn(real.openSync),
    readSync: vi.fn(real.readSync),
    writeSync: vi.fn(real.writeSync),
    closeSync: vi.fn(real.closeSync),
  };
});
afterEach(() => vi.mocked(fs.openSync).mockReset().mockImplementation(fsOpen));
const fsOpen = vi.mocked(fs.openSync).getMockImplementation()!;

it("runs a real process through argv/env without a shell and reports only the exit code", () => {
  const result = runTool(
    process.execPath,
    ["-e", "process.stdout.write(process.env.TEST_VALUE);process.exit(7)"],
    { env: { TEST_VALUE: "from-env" } },
  );
  expect(result).toEqual({ status: 7, stdout: "from-env" });
  expect(runTool("/does-not-exist", [])).toEqual({ status: 1, stdout: "" });
  expect(runTool(process.execPath, ["-e", ""], { inherit: true })).toEqual({
    status: 0,
    stdout: "",
  });
  expect(runTool(process.execPath, ["-e", "process.stdout.write('ok')"]).stdout).toBe("ok");
  expect(mustRun(() => ({ status: 0, stdout: "ok" }), "tool", [])).toEqual({
    status: 0,
    stdout: "ok",
  });
  expect(() => mustRun(() => ({ status: 1, stdout: "secret" }), "tool", ["secret"])).toThrow(
    "tool failed",
  );
});

it("requires yes from /dev/tty, and refuses when no controlling terminal exists", () => {
  vi.mocked(fs.openSync).mockImplementation(() => {
    throw new Error("no tty");
  });
  expect(confirmPurge("Delete?")).toBe(false);
  vi.mocked(fs.openSync).mockReturnValue(42);
  vi.mocked(fs.writeSync).mockReturnValue(0);
  vi.mocked(fs.closeSync).mockImplementation(() => {});
  for (const answer of ["yes\n", "no\n"]) {
    vi.mocked(fs.readSync).mockImplementation((_fd, buffer) => {
      Buffer.from(answer).copy(buffer as Buffer);
      return answer.length;
    });
    expect(confirmPurge("Delete?")).toBe(answer === "yes\n");
  }
  expect(fs.openSync).toHaveBeenCalledWith("/dev/tty", "r+");
  expect(fs.closeSync).toHaveBeenCalledWith(42);
});
