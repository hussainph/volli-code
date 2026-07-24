import { describe, expect, it, vi } from "vite-plus/test";

import {
  createLazyInitializer,
  waitForLanguageWorkerRegistration,
  workerKindForLabel,
} from "./monaco-runtime";

describe("createLazyInitializer", () => {
  it("shares one initialization promise across concurrent and later callers", async () => {
    const runtime = { name: "monaco" };
    const initialize = vi.fn(async () => runtime);
    const load = createLazyInitializer(initialize);

    const [first, second] = await Promise.all([load(), load()]);
    const third = await load();

    expect(first).toBe(runtime);
    expect(second).toBe(runtime);
    expect(third).toBe(runtime);
    expect(initialize).toHaveBeenCalledTimes(1);
  });
});

describe("workerKindForLabel", () => {
  it.each([
    ["json", "json"],
    ["css", "css"],
    ["scss", "css"],
    ["less", "css"],
    ["html", "html"],
    ["handlebars", "html"],
    ["razor", "html"],
    ["typescript", "typescript"],
    ["javascript", "typescript"],
    ["plaintext", "editor"],
  ] as const)("routes Monaco's %s label to the %s worker", (label, expected) => {
    expect(workerKindForLabel(label)).toBe(expected);
  });
});

describe("waitForLanguageWorkerRegistration", () => {
  it("yields while Monaco's asynchronous language activation is still registering", async () => {
    const worker = vi.fn();
    const getWorker = vi
      .fn<() => Promise<typeof worker>>()
      .mockRejectedValueOnce("TypeScript not registered!")
      .mockResolvedValue(worker);
    const waitForNextAttempt = vi.fn(async () => undefined);

    await expect(
      waitForLanguageWorkerRegistration(getWorker, { attempts: 2, waitForNextAttempt }),
    ).resolves.toBe(worker);
    expect(getWorker).toHaveBeenCalledTimes(2);
    expect(waitForNextAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not hide a non-registration worker failure", async () => {
    const failure = new Error("worker chunk failed to load");
    const getWorker = vi.fn<() => Promise<never>>().mockRejectedValue(failure);
    const waitForNextAttempt = vi.fn(async () => undefined);

    await expect(
      waitForLanguageWorkerRegistration(getWorker, { attempts: 5, waitForNextAttempt }),
    ).rejects.toBe(failure);
    expect(getWorker).toHaveBeenCalledTimes(1);
    expect(waitForNextAttempt).not.toHaveBeenCalled();
  });
});
