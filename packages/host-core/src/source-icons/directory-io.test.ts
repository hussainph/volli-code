/** Real bundled-Node precursor: inherited fd, pipes, errors, kill and close. */
import processes from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import type { ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { pinnedSourceIconIo } from "./directory-io";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
  }
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "source-icon-directory-"));
  roots.push(root);
  const fd = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  return { root, fd };
}
function spySpawn() {
  // Spy on Node's mutable default object, then update its real ESM bindings.
  // Every invocation still starts an actual process via the original spawn.
  const spy = vi.spyOn(processes, "spawn");
  syncBuiltinESMExports();
  return spy;
}
function observeChild(child: ChildProcess) {
  children.push(child);
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  return { child, closed: () => closed };
}

describe("source icon directory child lifecycle under real Node", () => {
  it("round trips through real stdin/stdout and inherited directory fd without inherited Node options", async () => {
    const f = await directory();
    const spawn = spySpawn(); // call-through; never replaces the child
    vi.stubEnv("NODE_OPTIONS", "--synthetic-option-must-not-reach-icon-child");
    const body = JSON.stringify({ text: "synthetic Unicode λ", data: "x".repeat(256 * 1024) });
    try {
      const writing = pinnedSourceIconIo(f.root, f.fd, body);
      const writer = observeChild(spawn.mock.results.at(-1)!.value as ChildProcess);
      await writing;
      expect(writer.closed()).toBe(true);
      expect(writer.child.exitCode).toBe(0);
      expect(await readFile(join(f.root, "cache-v1.json"), "utf8")).toBe(body);
      const reading = pinnedSourceIconIo(f.root, f.fd);
      const reader = observeChild(spawn.mock.results.at(-1)!.value as ChildProcess);
      expect((await reading).toString("utf8")).toBe(body);
      expect(reader.closed()).toBe(true);
      const options = spawn.mock.calls[0]![2]!;
      expect(options.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
      expect(options.stdio).toEqual(["pipe", "pipe", "ignore", f.fd.fd]);
    } finally {
      await f.fd.close();
    }
  });

  it("rejects a real cwd/fd mismatch without cleanup or writes in the replacement directory", async () => {
    const f = await directory();
    const replacement = join(f.root, "replacement");
    await mkdir(replacement);
    const sentinel = ".cache-00000000-0000-4000-8000-000000000001";
    await writeFile(join(replacement, sentinel), "untouched");
    const spawn = spySpawn();
    try {
      const writing = pinnedSourceIconIo(replacement, f.fd, "synthetic");
      const seen = observeChild(spawn.mock.results.at(-1)!.value as ChildProcess);
      await expect(writing).rejects.toThrow("directory I/O unavailable");
      expect(seen.closed()).toBe(true);
      expect(seen.child.exitCode).toBe(1);
      expect(await readFile(join(replacement, sentinel), "utf8")).toBe("untouched");
    } finally {
      await f.fd.close();
    }
  });

  it("joins actual spawn error and close for a missing cwd", async () => {
    const f = await directory();
    const spawn = spySpawn();
    try {
      const reading = pinnedSourceIconIo(join(f.root, "missing"), f.fd);
      const seen = observeChild(spawn.mock.results.at(-1)!.value as ChildProcess);
      const error = vi.fn();
      seen.child.on("error", error);
      await expect(reading).rejects.toThrow("directory I/O unavailable");
      expect(error).toHaveBeenCalledOnce();
      expect(seen.closed()).toBe(true);
    } finally {
      await f.fd.close();
    }
  });

  it("kills and joins the real child after a real stdin stream error", async () => {
    const f = await directory();
    const spawn = spySpawn();
    try {
      const writing = pinnedSourceIconIo(f.root, f.fd, "x".repeat(1024 * 1024));
      const seen = observeChild(spawn.mock.results.at(-1)!.value as ChildProcess);
      const kill = vi.spyOn(seen.child, "kill");
      const streamError = vi.fn();
      seen.child.stdin!.on("error", streamError);
      seen.child.stdin!.destroy(new Error("synthetic pipe failure"));
      await expect(writing).rejects.toThrow("directory I/O unavailable");
      expect(streamError).toHaveBeenCalled();
      expect(kill).toHaveBeenCalledWith("SIGKILL");
      expect(seen.closed()).toBe(true);
    } finally {
      await f.fd.close();
    }
  });

  it("kills a real child whose input cannot finish and rejects only after its physical close", async () => {
    const f = await directory();
    const original = processes.spawn;
    let kill: ReturnType<typeof vi.spyOn> | undefined;
    let closed = false;
    // Fault only the pipe's EOF delivery. The spawned executable, inherited fd,
    // pinned cwd, fixed production deadline, SIGKILL and close are all real.
    spySpawn().mockImplementation((...args: Parameters<typeof processes.spawn>) => {
      const child = original(...args);
      children.push(child);
      child.once("close", () => {
        closed = true;
      });
      kill = vi.spyOn(child, "kill");
      if (child.stdin !== null) vi.spyOn(child.stdin, "end").mockReturnValue(child.stdin);
      return child;
    });
    try {
      await expect(pinnedSourceIconIo(f.root, f.fd, "synthetic")).rejects.toThrow(
        "directory I/O unavailable",
      );
      expect(kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(closed).toBe(true);
      expect(children.at(-1)!.signalCode).toBe("SIGKILL");
    } finally {
      await f.fd.close();
    }
  });
});
