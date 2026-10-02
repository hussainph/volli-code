import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  BACKGROUND_CONTEXT,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  NodeExecutionEnv,
  withAbortSignal,
} from "./harness-env";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function workspace(): Promise<NodeExecutionEnv> {
  const cwd = await mkdtemp(join(process.cwd(), ".pi-vendor-test-"));
  directories.push(cwd);
  return new NodeExecutionEnv({ cwd });
}
const inert = [undefined as never, BACKGROUND_CONTEXT] as const;

describe("vendored Pi execution tools", () => {
  it("preserves write/read replies and applies non-cascading multi-edits with BOM/CRLF", async () => {
    const env = await workspace();
    const write = createWriteTool();
    const edit = createEditTool();
    const read = createReadTool();
    expect(
      await write.execute(
        "write",
        { path: "nested/file.txt", content: "\ufeffalpha\r\nbeta\r\ngamma\r\n" },
        () => {},
        { env },
        ...inert,
      ),
    ).toEqual({
      content: [{ type: "text", text: "Successfully wrote to nested/file.txt" }],
      details: undefined,
    });
    const result = await edit.execute(
      "edit",
      {
        path: "nested/file.txt",
        edits: [
          { oldText: "alpha", newText: "beta" },
          { oldText: "beta", newText: "delta" },
        ],
      },
      () => {},
      { env },
      ...inert,
    );
    expect(result.content).toEqual([
      { type: "text", text: "Successfully replaced 2 block(s) in nested/file.txt." },
    ]);
    expect(result.details?.firstChangedLine).toBe(1);
    expect(result.details?.patch).toBe(
      "--- nested/file.txt\n+++ nested/file.txt\n@@ -1,3 +1,3 @@\n-alpha\n beta\n+delta\n gamma\n",
    );
    expect(await readFile(join(env.cwd, "nested/file.txt"), "utf8")).toBe(
      "\ufeffbeta\r\ndelta\r\ngamma\r\n",
    );
    const readResult = await read.execute(
      "read",
      { path: "nested/file.txt", offset: 2, limit: 1 },
      () => {},
      { env },
      ...inert,
    );
    expect(readResult.content).toEqual([
      { type: "text", text: "delta\r\n\n[2 more lines in file. Use offset=3 to continue.]" },
    ]);
  });

  it("serializes concurrent edits through a symlink's canonical file identity", async () => {
    const env = await workspace();
    await createWriteTool().execute(
      "write",
      { path: "file.txt", content: "alpha beta" },
      () => {},
      { env },
      ...inert,
    );
    await symlink(join(env.cwd, "file.txt"), join(env.cwd, "alias.txt"));
    const edit = createEditTool();
    await Promise.all([
      edit.execute(
        "a",
        { path: "file.txt", edits: [{ oldText: "alpha", newText: "first" }] },
        () => {},
        { env },
        ...inert,
      ),
      edit.execute(
        "b",
        { path: "alias.txt", edits: [{ oldText: "beta", newText: "second" }] },
        () => {},
        { env },
        ...inert,
      ),
    ]);
    expect(await readFile(join(env.cwd, "file.txt"), "utf8")).toBe("first second");
  });

  it("rejects cancelled writes and ambiguous edits without changing the file", async () => {
    const env = await workspace();
    const write = createWriteTool();
    await write.execute(
      "write",
      { path: "file.txt", content: "same same" },
      () => {},
      { env },
      ...inert,
    );
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      write.execute(
        "cancelled",
        { path: "file.txt", content: "changed" },
        () => {},
        { env },
        undefined as never,
        withAbortSignal(cancelled.signal, BACKGROUND_CONTEXT),
      ),
    ).rejects.toThrow("aborted");
    await expect(
      createEditTool().execute(
        "ambiguous",
        { path: "file.txt", edits: [{ oldText: "same", newText: "changed" }] },
        () => {},
        { env },
        ...inert,
      ),
    ).rejects.toThrow("Found 2 occurrences");
    expect(await readFile(join(env.cwd, "file.txt"), "utf8")).toBe("same same");
  });

  it("preserves bash progress, merged output and nonzero exit failures", async () => {
    const env = await workspace();
    const bash = createBashTool();
    const updates: unknown[] = [];
    const result = await bash.execute(
      "bash",
      { command: "printf stdout; printf stderr >&2" },
      (update) => updates.push(update),
      { env },
      ...inert,
    );
    // The two pipes may be observed in either order; neither stream may be lost.
    expect(result.content).toEqual([
      { type: "text", text: expect.stringMatching(/^(?:stdoutstderr|stderrstdout)$/) },
    ]);
    expect(updates[0]).toEqual({ content: [], details: undefined });
    expect(updates.at(-1)).toMatchObject({ content: result.content });
    await expect(
      bash.execute("failure", { command: "printf failed; exit 7" }, () => {}, { env }, ...inert),
    ).rejects.toThrow("failed\n\nCommand exited with code 7");
    await expect(
      bash.execute("timeout", { command: "true", timeout: 0 }, () => {}, { env }, ...inert),
    ).rejects.toThrow("Invalid timeout: must be a finite number of seconds");
  });
});
