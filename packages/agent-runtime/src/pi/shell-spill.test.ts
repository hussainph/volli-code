import { describe, expect, it } from "vite-plus/test";
import { ShellSpillBudget } from "./shell-spill";

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
