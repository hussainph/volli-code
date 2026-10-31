import { openSync } from "node:fs";
import { PassThrough } from "node:stream";
import { ReadStream } from "node:tty";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { loginTerminal } from "./terminal";

const fake = vi.hoisted(() => ({ tty: undefined as unknown as PassThrough }));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  openSync: vi.fn(() => 42),
}));
vi.mock("node:tty", async (original) => ({
  ...(await original<typeof import("node:tty")>()),
  ReadStream: vi.fn(function () {
    return fake.tty;
  }),
}));

const originalTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
afterEach(() => {
  if (originalTTY === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
  else Object.defineProperty(process.stdin, "isTTY", originalTTY);
  vi.clearAllMocks();
});
const prompt = {
  promptId: "p",
  kind: "secret" as const,
  message: "Enter key",
  placeholder: null,
  options: [],
};

describe("live terminal source selection", () => {
  it("does not open any input for a flow with no prompts", () => {
    const write = vi.fn();
    const terminal = loginTerminal(write);
    terminal.write("Visit the device page\n");
    terminal.close();
    expect(write).toHaveBeenCalledWith("Visit the device page\n");
    expect(openSync).not.toHaveBeenCalled();
  });

  it("reads piped input without opening /dev/tty and reuses the reader", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const write = vi.fn();
    const terminal = loginTerminal(write);
    const first = terminal.read(prompt, new AbortController().signal);
    process.stdin.emit("data", Buffer.from("TEST-piped-key\n"));
    expect(await first).toBe("TEST-piped-key");
    const next = terminal.read(prompt, new AbortController().signal);
    process.stdin.emit("data", Buffer.from("TEST-next-key\n"));
    expect(await next).toBe("TEST-next-key");
    terminal.close();
    expect(openSync).not.toHaveBeenCalled();
    expect(write.mock.calls.flat().join("")).not.toContain("TEST-piped-key");
  });

  it("uses /dev/tty for interactive input, suppresses echo and releases it", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    fake.tty = new PassThrough();
    const write = vi.fn();
    const terminal = loginTerminal(write);
    const reading = terminal.read(prompt, new AbortController().signal);
    fake.tty.write("TEST-hidden-key\r");
    expect(await reading).toBe("TEST-hidden-key");
    expect(openSync).toHaveBeenCalledWith("/dev/tty", "r+");
    expect(ReadStream).toHaveBeenCalledWith(42);
    expect(write.mock.calls.flat().join("")).not.toContain("TEST-hidden-key");
    terminal.close();
    expect(fake.tty.destroyed).toBe(true);
  });
});
