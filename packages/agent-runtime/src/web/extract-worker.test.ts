/**
 * Extraction in a worker thread: real threads throughout.
 *
 * The scripted worker stands in for the extractor where a test needs a worker
 * to hang, fail or die on cue; the real one — the same module a host bundles —
 * proves the two properties the thread exists for: the calling thread stays
 * responsive while a 2 MiB document is read, and a deadline actually stops a
 * read that is still parsing. Byte-identical output is `extract.test.ts`'s:
 * its last block reads every document of that suite again through the worker.
 */
import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { extractReadableMarkdown, type ExtractedDocument } from "./extract";
import {
  createWorkerWebExtractor,
  extractInProcess,
  serveWebExtractWorker,
  WebExtractError,
  type WebExtractor,
} from "./extract-worker";

const SCRIPTED = new URL("./test-support/scripted-extract-worker.mjs", import.meta.url);
const REAL = new URL("./test-support/extract-worker-under-node.mjs", import.meta.url);

const live = () => new AbortController().signal;

/** Which thread answered: the scripted worker puts its `threadId` in the text. */
async function thread(extract: WebExtractor, path = "/read", signal = live()): Promise<string> {
  return (await extract({ html: "", url: `https://example.com${path}`, signal })).text;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Which workers were handed a read, and which were terminated, in order.
 *
 * By instance rather than by count: a warm worker left by an earlier test
 * leaves on its own idle timer, and that termination is not this test's.
 */
function watchWorkers(): { posted: Worker[]; ended: Set<Worker> } {
  const posted: Worker[] = [];
  const ended = new Set<Worker>();
  const post = Worker.prototype.postMessage;
  const terminate = Worker.prototype.terminate;
  vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker["postMessage"]>
  ) {
    posted.push(this);
    return post.apply(this, args);
  });
  vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
    ended.add(this);
    return terminate.call(this);
  });
  return { posted, ended };
}

/** One request over a real channel, answered by the worker's own handler. */
async function ask(html: string, url: string): Promise<unknown> {
  const { port1, port2 } = new MessageChannel();
  serveWebExtractWorker(port2 as MessagePort);
  const answer = new Promise((resolve) => port1.once("message", resolve));
  // The empty transfer list is Node's second argument, not a browser target origin.
  port1.postMessage({ html, url }, []);
  try {
    return await answer;
  } finally {
    port1.close();
  }
}

describe("the worker side", () => {
  it("answers with exactly what extraction returns", async () => {
    const html = "<html><head><title>T</title></head><body><p>one paragraph</p></body></html>";
    expect(await ask(html, "https://example.com/doc")).toEqual({
      type: "done",
      document: extractReadableMarkdown(html, "https://example.com/doc"),
    });
  });

  it("answers failed, and nothing more, when extraction throws", async () => {
    // jsdom refuses a document whose URL is not one.
    expect(await ask("<p>x</p>", "not a url")).toEqual({ type: "failed" });
  });

  it("refuses to serve outside a worker thread", () => {
    expect(() => serveWebExtractWorker(null)).toThrow(/inside a worker thread/);
  });

  it("is the same extraction on this thread when a host names no worker", async () => {
    const html = "<body><article><p>words on a page</p></article></body>";
    expect(await extractInProcess({ html, url: "https://example.com/", signal: live() })).toEqual(
      extractReadableMarkdown(html, "https://example.com/"),
    );
  });
});

describe("the warm worker", () => {
  it("is reused by the next read", async () => {
    const extract = createWorkerWebExtractor(SCRIPTED, { idleMs: 1_000 });
    expect(await thread(extract)).toBe(await thread(extract));
  });

  it("is not kept at all when idleness is zero", async () => {
    const extract = createWorkerWebExtractor(SCRIPTED, { idleMs: 0 });
    expect(await thread(extract)).not.toBe(await thread(extract));
  });

  it("leaves once it has been idle past its bound", async () => {
    const { posted, ended } = watchWorkers();
    const extract = createWorkerWebExtractor(SCRIPTED, { idleMs: 20 });
    const first = await thread(extract);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ended.has(posted[0]!)).toBe(true);
    expect(await thread(extract)).not.toBe(first);
  });

  it("starts another for a read that finds it busy, and keeps only one afterwards", async () => {
    const { posted, ended } = watchWorkers();
    const extract = createWorkerWebExtractor(SCRIPTED, { idleMs: 1_000 });
    const [a, b] = await Promise.all([thread(extract), thread(extract)]);
    expect(a).not.toBe(b);
    // Exactly one of the two is let go; the other is the one kept.
    expect(posted.slice(0, 2).filter((worker) => ended.has(worker))).toHaveLength(1);
    expect([a, b]).toContain(await thread(extract));
  });

  it("is forgotten when it dies while idle, so the next read is not posted into it", async () => {
    // A short deadline: posting to the dead thread would wait it out.
    const extract = createWorkerWebExtractor(SCRIPTED, { idleMs: 1_000, deadlineMs: 2_000 });
    const dying = await thread(extract, "/die-later");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await thread(extract)).not.toBe(dying);
  });
});

describe("a read that does not answer", () => {
  it("is a timeout once past its deadline, and the worker is terminated", async () => {
    const { posted, ended } = watchWorkers();
    const extract = createWorkerWebExtractor(SCRIPTED, { deadlineMs: 300, idleMs: 1_000 });
    const before = await thread(extract);
    await expect(thread(extract, "/hang")).rejects.toMatchObject({ reason: "timeout" });
    expect(ended.has(posted.at(-1)!)).toBe(true);
    // The hung thread is gone, so the next read is a fresh one.
    expect(await thread(extract)).not.toBe(before);
  });

  it("is cancelled when its signal withdraws it, and the worker is terminated", async () => {
    const { posted, ended } = watchWorkers();
    const extract = createWorkerWebExtractor(SCRIPTED, { deadlineMs: 30_000 });
    const withdraw = new AbortController();
    const reading = thread(extract, "/hang", withdraw.signal);
    setTimeout(() => withdraw.abort(), 200);
    await expect(reading).rejects.toMatchObject({ reason: "cancelled" });
    expect(ended.has(posted.at(-1)!)).toBe(true);
  });

  it("is cancelled without a worker when the signal was already withdrawn", async () => {
    const extract = createWorkerWebExtractor(SCRIPTED);
    const withdrawn = new AbortController();
    withdrawn.abort();
    const reading = thread(extract, "/read", withdrawn.signal);
    await expect(reading).rejects.toBeInstanceOf(WebExtractError);
    await expect(reading).rejects.toMatchObject({ reason: "cancelled" });
  });

  it.each([
    ["answers that it failed", "/fail"],
    ["exits", "/exit"],
    ["throws outside the extractor", "/crash"],
  ])("fails when the worker %s, and is not reused", async (_label, path) => {
    const extract = createWorkerWebExtractor(SCRIPTED, { idleMs: 1_000 });
    const before = await thread(extract);
    await expect(thread(extract, path)).rejects.toMatchObject({ reason: "failed" });
    expect(await thread(extract)).not.toBe(before);
  });
});

/** 2 MiB of prose in few, large elements: the shape the parse bound admits whole. */
function twoMebibytePage(): string {
  const paragraph = `<p>${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(40)}</p>\n`;
  let body = "<article><h1>A long page</h1>";
  while (body.length < 2 * 1024 * 1024) body += paragraph;
  return `<!doctype html><html><head><title>Long</title></head><body>${body}</article></body></html>`;
}

describe("the real extraction worker", () => {
  it("keeps this thread responsive while it reads a 2 MiB page", async () => {
    // Measured before the worker: reading this page on the calling thread held
    // it for 1-4 s, the whole read. In the worker this thread only copies the
    // string across and back.
    const extract = createWorkerWebExtractor(REAL, { deadlineMs: 60_000, idleMs: 0 });
    const html = twoMebibytePage();
    let worst = 0;
    let last = performance.now();
    const tick = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 10);
    let read: ExtractedDocument;
    try {
      read = await extract({ html, url: "https://example.com/long", signal: live() });
    } finally {
      clearInterval(tick);
    }
    expect(read.text.startsWith("# Long")).toBe(true);
    expect(read.truncated).toBe(true);
    // A 10 ms tick, so anything near this bound is the copy, not the parse.
    expect(worst).toBeLessThan(250);
  }, 120_000);

  it("is stopped by its deadline in the middle of a real parse", async () => {
    const { posted, ended } = watchWorkers();
    const extract = createWorkerWebExtractor(REAL, { deadlineMs: 50, idleMs: 0 });
    const html = twoMebibytePage();
    const started = performance.now();
    await expect(
      extract({ html, url: "https://example.com/long", signal: live() }),
    ).rejects.toMatchObject({ reason: "timeout" });
    expect(posted).toHaveLength(1);
    expect(ended.has(posted[0]!)).toBe(true);
    // The answer came at the deadline, not when the parse would have finished.
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
