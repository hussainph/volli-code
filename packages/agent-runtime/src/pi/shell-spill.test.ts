import { describe, expect, it, vi } from "vite-plus/test";
import { CredentialRedactionError } from "@volli/shared";
import { ShellSpillBudget, ShellSpillRedactor } from "./shell-spill";

it("caps queued bytes, distinguishes the exact boundary, and keeps draining after the cap", () => {
  const budget = new ShellSpillBudget();
  const block = new Uint8Array(1024 * 1024);
  for (let i = 0; i < 64; i++) expect(budget.take(block)).toHaveLength(block.length);
  expect(budget.truncatedAt).toBeUndefined();
  expect(budget.take(block)).toHaveLength(0);
  expect(budget.truncatedAt).toBe(ShellSpillBudget.maxBytes);
  expect(budget.take(block)).toHaveLength(0);
});

describe("partial final spill chunk", () => {
  it("counts bytes rather than characters and returns only the remaining prefix", () => {
    const budget = new ShellSpillBudget();
    const block = new Uint8Array(1024 * 1024);
    for (let i = 0; i < 63; i++) budget.take(block);
    budget.take(block.subarray(0, block.length - 3));
    expect(budget.take(Buffer.from("😀end"))).toEqual(Buffer.from("😀").subarray(0, 3));
    expect(budget.truncatedAt).toBe(ShellSpillBudget.maxBytes);
  });
});

const bytes = (text: string) => new TextEncoder().encode(text);
const raise = (): never => {
  throw new Error("raw secret-example-123");
};

describe("ShellSpillRedactor", () => {
  it("passes bytes through untouched with no redaction configured", () => {
    const redactor = new ShellSpillRedactor(undefined);
    const chunk = bytes("raw");
    expect(redactor.push(chunk)).toBe(chunk);
    expect(redactor.end()).toHaveLength(0);
  });

  it("creates its transform on first use only, and releases what it held at the end", () => {
    const create = vi.fn(() => ({
      push: (chunk: Uint8Array) => chunk.subarray(0, 1),
      end: () => bytes("rest"),
    }));
    const unused = new ShellSpillRedactor(create);
    expect(unused.end()).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
    const redactor = new ShellSpillRedactor(create);
    expect(redactor.push(bytes("ab"))).toEqual(bytes("a"));
    expect(redactor.push(bytes("cd"))).toEqual(bytes("c"));
    expect(create).toHaveBeenCalledOnce();
    expect(redactor.end()).toEqual(bytes("rest"));
  });

  it.each([
    ["the factory", { create: true, push: false, end: false }],
    ["a push", { create: false, push: true, end: false }],
    ["the end", { create: false, push: false, end: true }],
  ])("replaces a failure in %s with one fixed error and no cause", (_name, fails) => {
    const redactor = new ShellSpillRedactor(() => {
      if (fails.create) raise();
      return {
        push: (chunk) => (fails.push ? raise() : chunk),
        end: () => (fails.end ? raise() : new Uint8Array(0)),
      };
    });
    let thrown: unknown;
    try {
      redactor.push(bytes("x"));
      redactor.end();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CredentialRedactionError);
    expect((thrown as Error).message).toBe("Credential redaction failed.");
    expect((thrown as Error).cause).toBeUndefined();
    expect(String((thrown as Error).stack)).not.toContain("secret-example-123");
  });
});
