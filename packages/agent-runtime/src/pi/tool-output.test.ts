import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_RESULT_MAX_BYTES } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  cutMiddle,
  cutResultText,
  READ_LINE_MAX_BYTES,
  TOOL_OUTPUT_DIRECTORY_MAX_BYTES,
  toolOutputCut,
  toolOutputDirectoryFor,
  ToolOutputStore,
} from "./tool-output";

function scratch(): { root: string; workspace: string; directory: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "volli-tool-output-")));
  const workspace = join(root, "worktree");
  mkdirSync(workspace);
  return { root, workspace, directory: join(root, "sessions", "--ws--", "s.tool-output") };
}

describe("toolOutputDirectoryFor", () => {
  it("names a sibling of the sidecar after it", () => {
    expect(toolOutputDirectoryFor("/data/pi-sessions/--ws--/2026_abc.jsonl")).toBe(
      "/data/pi-sessions/--ws--/2026_abc.tool-output",
    );
  });
});

describe("cutMiddle", () => {
  it("leaves text that fits alone", () => {
    expect(cutMiddle("short", 5)).toBeNull();
    expect(cutMiddle("", 0)).toBeNull();
  });

  it("keeps half the budget from each end around a marker that counts what it left out", () => {
    const cut = cutMiddle("0123456789\nabcdefghij", 10);
    expect(cut).toEqual({
      text: "01234…11 chars truncated…fghij",
      removedChars: 11,
      totalBytes: 21,
      totalLines: 2,
      longestLineBytes: 10,
    });
  });

  it("counts lines as a reader does: a final newline ends a line, it does not start one", () => {
    expect(cutMiddle("ab\ncdefgh\n", 4)).toMatchObject({ totalLines: 2, longestLineBytes: 6 });
    expect(cutMiddle("\n\n\n\n\n\n", 4)).toMatchObject({ totalLines: 6, longestLineBytes: 0 });
    expect(cutMiddle("x".repeat(9), 4)).toMatchObject({ totalLines: 1, longestLineBytes: 9 });
  });

  it("cuts on character boundaries, never through a multi-byte character", () => {
    // Each "é" is two bytes and each "😀" four, so a byte budget lands mid-character.
    const text = `${"é".repeat(10)}${"😀".repeat(10)}`;
    const cut = cutMiddle(text, 11)!;
    // Five bytes for the start end mid-"é", so it keeps two; six for the end
    // start mid-"😀", so it keeps one.
    expect(cut.text).toBe(`éé…${8 + 9} chars truncated…😀`);
    expect(cut.text).not.toContain("\uFFFD");
    expect(cut.totalBytes).toBe(60);
    // An odd budget gives the extra byte to the end.
    expect(cutMiddle("abcdefghij", 5)!.text).toBe("ab…5 chars truncated…hij");
  });
});

describe("ToolOutputStore", () => {
  it("saves the whole text behind its header, readable only by the user", async () => {
    const { workspace, directory } = scratch();
    const output = new ToolOutputStore({ directory, workspacePath: workspace });

    const save = await output.save({ callId: "toolu_01/A b", header: "HEADER", text: "whole ✓" });

    expect(save).toEqual({
      saved: true,
      path: expect.stringMatching(/s\.tool-output\/toolu_01_A_b\.[0-9a-f]{8}\.txt$/u),
      savedBytes: Buffer.byteLength("whole ✓"),
      totalBytes: Buffer.byteLength("whole ✓"),
    });
    const path = (save as { path: string }).path;
    expect(readFileSync(path, "utf8")).toBe("HEADER\n\nwhole ✓");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    // An id with nothing usable in it still makes a name.
    await expect(output.save({ callId: "", header: "H", text: "t" })).resolves.toMatchObject({
      saved: true,
      path: expect.stringMatching(/\/call\.[0-9a-f]{8}\.txt$/u),
    });
  });

  it("caps one file on a character boundary and reports how much it holds", async () => {
    const { workspace, directory } = scratch();
    // Four bytes end inside "é", so the file keeps the three before it.
    const output = new ToolOutputStore({ directory, workspacePath: workspace, fileMaxBytes: 4 });

    const save = await output.save({ callId: "c", header: "H", text: "abcé€xyz" });

    expect(save).toMatchObject({ saved: true, savedBytes: 3, totalBytes: 11 });
    expect(readFileSync((save as { path: string }).path, "utf8")).toBe("H\n\nabc");
  });

  it("stops saving at the directory bound, counting what an earlier attachment saved", async () => {
    const { workspace, directory } = scratch();
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "earlier.txt"), "x".repeat(90));
    mkdirSync(join(directory, "not-counted"));
    const output = new ToolOutputStore({
      directory,
      workspacePath: workspace,
      directoryMaxBytes: 100,
    });

    // 90 already there; "H\n\n" plus 5 bytes fits, the next save does not.
    await expect(output.save({ callId: "a", header: "H", text: "12345" })).resolves.toMatchObject({
      saved: true,
    });
    await expect(output.save({ callId: "b", header: "H", text: "1" })).resolves.toEqual({
      saved: false,
      reason: "this Session's saved tool output has reached its 100 B limit",
      totalBytes: 1,
    });
    await expect(output.save({ callId: "c", header: "H", text: "1" })).resolves.toMatchObject({
      saved: false,
    });
    expect(readdirSync(directory)).toHaveLength(3);
  });

  it("reports a directory it could not make as a reason, without rejecting", async () => {
    const { root, workspace } = scratch();
    writeFileSync(join(root, "blocked"), "a file where the directory would go");
    const output = new ToolOutputStore({
      directory: join(root, "blocked", "s.tool-output"),
      workspacePath: workspace,
    });

    await expect(output.save({ callId: "c", header: "H", text: "t" })).resolves.toEqual({
      saved: false,
      reason: expect.stringMatching(/^it could not be written: /u),
      totalBytes: 1,
    });
  });

  it("knows a read of one of its files, however the path is spelled, and nothing else", async () => {
    const { root, workspace, directory } = scratch();
    const output = new ToolOutputStore({ directory, workspacePath: workspace });
    // Nothing saved yet: no directory, so nothing is held.
    expect(output.holds(join(directory, "x.txt"))).toBe(false);

    const save = await output.save({ callId: "c", header: "H", text: "t" });
    const path = (save as { path: string }).path;
    expect(output.holds(path)).toBe(true);
    expect(output.holds(`@${path}`)).toBe(true);
    expect(output.holds(`../sessions/--ws--/s.tool-output/${path.split("/").at(-1)}`)).toBe(true);
    expect(output.holds(join(workspace, "notes.txt"))).toBe(false);
    expect(output.holds(join(root, "sessions", "--ws--", "s.tool-output-other", "x"))).toBe(false);
    expect(output.holds(undefined)).toBe(false);
  });

  it("knows a carried attachment's files, and marks any saved output under the data directory", async () => {
    const { root, workspace } = scratch();
    const data = join(root, "sessions");
    const own = join(data, "--ws--", "now.tool-output");
    const carried = join(data, "--ws--", "earlier.tool-output");
    const other = join(data, "--elsewhere--", "other.tool-output");
    for (const directory of [carried, other]) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "x.txt"), "x");
    }
    writeFileSync(join(data, "--ws--", "not-output.txt"), "x");
    const output = new ToolOutputStore({
      directory: own,
      carriedDirectories: [carried],
      dataDirectory: data,
      workspacePath: workspace,
    });

    expect(output.readableDirectories).toEqual([own, carried]);
    expect(output.holds(join(carried, "x.txt"))).toBe(true);
    // Marked, though not this Session's to read: any attachment's saved output.
    expect(output.holds(join(other, "x.txt"))).toBe(true);
    expect(output.holds(join(data, "--ws--", "not-output.txt"))).toBe(false);
    expect(output.holds(join(workspace, "x.txt"))).toBe(false);
    // A data directory that is not there marks nothing beyond the store's own.
    const bare = new ToolOutputStore({
      directory: own,
      dataDirectory: join(root, "missing"),
      workspacePath: workspace,
    });
    expect(bare.holds(join(other, "x.txt"))).toBe(false);
  });

  it("holds nothing once a symlink stands where its directory was", async () => {
    const { root, workspace } = scratch();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "secret.txt"), "s");
    const directory = join(root, "linked.tool-output");
    symlinkSync(elsewhere, directory);
    const output = new ToolOutputStore({ directory, workspacePath: workspace });

    expect(output.holds(join(directory, "secret.txt"))).toBe(false);
  });

  it("defaults its bounds to the outer result bound and the directory bound", async () => {
    const { workspace, directory } = scratch();
    const output = new ToolOutputStore({ directory, workspacePath: workspace });
    const text = "y".repeat(MCP_RESULT_MAX_BYTES + 3);

    const save = await output.save({ callId: "big", header: "H", text });

    expect(save).toMatchObject({
      saved: true,
      savedBytes: MCP_RESULT_MAX_BYTES,
      totalBytes: text.length,
    });
    expect(TOOL_OUTPUT_DIRECTORY_MAX_BYTES).toBeGreaterThan(MCP_RESULT_MAX_BYTES);
  });
});

describe("cutResultText and toolOutputCut", () => {
  const cut = cutMiddle("a".repeat(30), 10)!;

  it("names the file holding the whole text", () => {
    const save = { saved: true as const, path: "/p/x.txt", savedBytes: 30, totalBytes: 30 };
    expect(cutResultText(cut, save, 100)).toBe(
      `Warning: truncated output (original token count: 8)\nTotal output lines: 1\n\n${cut.text}\n\n[Full output: /p/x.txt (read it with offset/limit; the output starts at line 3)]`,
    );
    expect(toolOutputCut(cut, save)).toEqual({
      totalBytes: 30,
      totalLines: 1,
      removedChars: 20,
      fullOutputPath: "/p/x.txt",
      savedBytes: 30,
    });
  });

  it("says how much a capped file holds, in readable units", () => {
    const capped = {
      saved: true as const,
      path: "/p/x.txt",
      savedBytes: 2_048,
      totalBytes: 3 * 1_048_576,
    };
    expect(cutResultText(cut, capped, 2_048)).toContain(
      "[The first 2.0 KiB of 3.0 MiB are saved to /p/x.txt (read it with offset/limit; the output starts at line 3); the rest is past the 2.0 KiB limit on one result.]",
    );
  });

  it("points a line longer than read returns at the shell, when there is a file to read", () => {
    const oneLine = cutMiddle("{".repeat(READ_LINE_MAX_BYTES + 1), 10)!;
    const save = { saved: true as const, path: "/p/x.txt", savedBytes: 1, totalBytes: 1 };
    expect(cutResultText(oneLine, save, MCP_RESULT_MAX_BYTES)).toContain(
      `\n[Some lines are longer than read returns (50.0 KiB). Read those in byte ranges from the shell, for example: tail -c +<byte> <file> | head -c ${READ_LINE_MAX_BYTES}]`,
    );
    expect(cutResultText(cut, save, MCP_RESULT_MAX_BYTES)).not.toContain("Some lines");
    const failed = { saved: false as const, reason: "no", totalBytes: 1 };
    expect(cutResultText(oneLine, failed, MCP_RESULT_MAX_BYTES)).not.toContain("Some lines");
  });

  it("says why nothing was saved", () => {
    const failed = {
      saved: false as const,
      reason: "it could not be written: EACCES",
      totalBytes: 30,
    };
    expect(cutResultText(cut, failed, 100)).toContain(
      "[The full output could not be saved: it could not be written: EACCES.]",
    );
    expect(toolOutputCut(cut, failed)).toMatchObject({ fullOutputPath: null, savedBytes: 0 });
  });
});
