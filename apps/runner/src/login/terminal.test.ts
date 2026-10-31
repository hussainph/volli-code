import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { loginTerminal } from "./terminal";

const originalTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
afterEach(() => {
  if (originalTTY === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
  else Object.defineProperty(process.stdin, "isTTY", originalTTY);
});
const prompt = {
  promptId: "p",
  kind: "secret" as const,
  message: "Enter key",
  placeholder: null,
  options: [],
};

describe("live terminal source selection", () => {
  it("does not read input for a flow with no prompts", () => {
    const write = vi.fn();
    const terminal = loginTerminal(write);
    terminal.write("Visit the device page\n");
    terminal.close();
    expect(write).toHaveBeenCalledWith("Visit the device page\n");
  });

  it("reads piped input and reuses the reader", async () => {
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
    expect(write.mock.calls.flat().join("")).not.toContain("TEST-piped-key");
  });

  it("uses the inherited terminal without reopening it under the service uid", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const write = vi.fn();
    const terminal = loginTerminal(write);
    const reading = terminal.read(prompt, new AbortController().signal);
    process.stdin.emit("data", Buffer.from("TEST-hidden-key\r"));
    expect(await reading).toBe("TEST-hidden-key");
    expect(write.mock.calls.flat().join("")).not.toContain("TEST-hidden-key");
    terminal.close();
    expect(process.stdin.destroyed).toBe(false);
  });
});
