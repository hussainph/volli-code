import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MCP_RESULT_MAX_BYTES } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  cutMiddle,
  cutResultText,
  listSavedOutput,
  SAVED_LINE_MAX_BYTES,
  savedOutputDirectoriesIn,
  splitLongLines,
  TOOL_OUTPUT_TOTAL_MAX_BYTES,
  ToolOutputLedger,
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

describe("savedOutputDirectoriesIn", () => {
  it("keeps only absolute, saved-output-shaped paths inside the data directory, once each", () => {
    const data = "/data/pi-sessions";
    expect(
      savedOutputDirectoriesIn(
        [
          `${data}/--ws--/a.tool-output/tc-1.txt`,
          `${data}/--ws--/a.tool-output/tc-2.txt`,
          `${data}/--ws--/b.tool-output/tc-1.txt`,
          `${data}/--ws--/b.tool-output/../../../escape.tool-output/x.txt`,
          `${data}/--ws--/not-output/tc-1.txt`,
          `${data}/--ws--/a.tool-output`,
          "/elsewhere/--ws--/c.tool-output/tc-1.txt",
          "relative/--ws--/c.tool-output/tc-1.txt",
          undefined,
          7,
        ],
        data,
      ),
    ).toEqual([`${data}/--ws--/a.tool-output`, `${data}/--ws--/b.tool-output`]);
  });
});

describe("splitLongLines", () => {
  it("splits only lines over the bound, on character boundaries, and says whether it did", () => {
    const untouched = Buffer.from("short\nlines\n");
    expect(splitLongLines(untouched, 8)).toEqual({ bytes: untouched, split: false });
    expect(splitLongLines(Buffer.from("abcdefghij\nxy"), 4).bytes.toString()).toBe(
      "abcd\nefgh\nij\nxy",
    );
    // "é" is two bytes: a bound of three keeps one and moves the next along.
    expect(splitLongLines(Buffer.from("aéé\n"), 3).bytes.toString()).toBe("aé\né\n");
    // A bound smaller than one character still moves past it.
    expect(splitLongLines(Buffer.from("😀😀"), 2).bytes.toString()).toBe("😀\n😀");
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
    });
  });

  it("counts lines as a reader does: a final newline ends a line, it does not start one", () => {
    expect(cutMiddle("ab\ncdefgh\n", 4)).toMatchObject({ totalLines: 2 });
    expect(cutMiddle("\n\n\n\n\n\n", 4)).toMatchObject({ totalLines: 6 });
    expect(cutMiddle("x".repeat(9), 4)).toMatchObject({ totalLines: 1 });
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

  it("knows the files its history names, and marks any saved output under the data directory", async () => {
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
      namedDirectories: [carried, own],
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

  it("splits lines longer than read returns, and says so in the header", async () => {
    const { workspace, directory } = scratch();
    const output = new ToolOutputStore({ directory, workspacePath: workspace });
    const line = "{".repeat(SAVED_LINE_MAX_BYTES + 5);

    const save = await output.save({ callId: "c", header: "H.", text: line });

    const saved = readFileSync((save as { path: string }).path, "utf8");
    expect(saved).toBe(
      `H. Lines longer than 16.0 KiB are split across several lines here; the text is otherwise exactly what the tool returned.\n\n${"{".repeat(SAVED_LINE_MAX_BYTES)}\n{{{{{`,
    );
    expect(save).toMatchObject({ savedBytes: line.length, totalBytes: line.length });
  });

  it("refuses to write through a link standing where its directory goes", async () => {
    const { root, workspace } = scratch();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    const directory = join(root, "planted.tool-output");
    symlinkSync(elsewhere, directory);
    const output = new ToolOutputStore({ directory, workspacePath: workspace });

    await expect(output.save({ callId: "c", header: "H", text: "t" })).resolves.toEqual({
      saved: false,
      reason: "its directory is not a real directory",
      totalBytes: 1,
    });
    expect(readdirSync(elsewhere)).toEqual([]);
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

/** A saved file `ageMs` old, in `<root>/--ws--/<attachment>.tool-output/<file>`. */
function savedFile(root: string, name: string, bytes: number, ageMs: number): string {
  const directory = join(root, "--ws--", `${name.split("/")[0]}.tool-output`);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name.split("/")[1]!);
  writeFileSync(path, "x".repeat(bytes));
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
  return path;
}

describe("ToolOutputLedger", () => {
  it("lists every attachment's saved files, oldest first, and nothing else", async () => {
    const { root } = scratch();
    const data = join(root, "sessions");
    const newer = savedFile(data, "a/new.txt", 3, 1_000);
    const older = savedFile(data, "b/old.txt", 5, 60_000);
    mkdirSync(join(data, "--ws--", "a.tool-output", "nested"));
    writeFileSync(join(data, "--ws--", "sidecar.jsonl"), "{}");
    writeFileSync(join(data, "stray.txt"), "x");

    expect(await listSavedOutput(data)).toEqual([
      { path: older, bytes: 5, modifiedAt: expect.any(Number) },
      { path: newer, bytes: 3, modifiedAt: expect.any(Number) },
    ]);
    expect(await listSavedOutput(join(root, "missing"))).toEqual([]);
  });

  it("removes the oldest saved files, across attachments, to make room under the bound", async () => {
    const { root } = scratch();
    const data = join(root, "sessions");
    const oldest = savedFile(data, "a/1.txt", 40, 30_000);
    const middle = savedFile(data, "b/2.txt", 40, 20_000);
    const newest = savedFile(data, "a/3.txt", 10, 10_000);
    const ledger = new ToolOutputLedger({ dataDirectory: data, maxBytes: 100 });
    const written: string[] = [];
    const write = (name: string, bytes: number) => async () => {
      const path = join(data, "--ws--", "c.tool-output", name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "y".repeat(bytes));
      written.push(path);
      return path;
    };

    // 90 held; 9 more fits without touching anything.
    await expect(ledger.admit(9, write("4.txt", 9))).resolves.toBe(true);
    expect(existsSync(oldest)).toBe(true);
    // 99 held; 40 more needs room down to nine tenths: the two oldest go.
    await expect(ledger.admit(40, write("5.txt", 40))).resolves.toBe(true);
    expect([existsSync(oldest), existsSync(middle), existsSync(newest)]).toEqual([
      false,
      false,
      true,
    ]);
    // One file over the whole bound is refused, and nothing is written for it.
    await expect(ledger.admit(101, write("6.txt", 101))).resolves.toBe(false);
    expect(written).toHaveLength(2);
    // A failed write is the caller's, and the next admit still runs.
    await expect(
      ledger.admit(1, async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    await expect(ledger.admit(1, write("7.txt", 1))).resolves.toBe(true);
    expect(TOOL_OUTPUT_TOTAL_MAX_BYTES).toBe(1_024 * 1_024 * 1_024);
  });

  it("rereads the disk before evicting, so files removed elsewhere are not counted twice", async () => {
    const { root } = scratch();
    const data = join(root, "sessions");
    const first = savedFile(data, "a/1.txt", 60, 20_000);
    const kept = savedFile(data, "b/2.txt", 30, 10_000);
    const ledger = new ToolOutputLedger({ dataDirectory: data, maxBytes: 100 });
    const write = (name: string, bytes: number) => async () => {
      const path = join(data, "--ws--", "c.tool-output", name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "y".repeat(bytes));
      return path;
    };
    await ledger.admit(5, write("3.txt", 5));
    // Main removed the oldest file on its own; the ledger still counts it.
    rmSync(first);
    await expect(ledger.admit(50, write("4.txt", 50))).resolves.toBe(true);
    expect(existsSync(kept)).toBe(true);
  });

  it("bounds a store's saves across attachments, and says when one is over the whole bound", async () => {
    const { workspace, root } = scratch();
    const data = join(root, "sessions");
    const ledger = new ToolOutputLedger({ dataDirectory: data, maxBytes: 64 });
    const directory = join(data, "--ws--", "s.tool-output");
    const output = new ToolOutputStore({ directory, workspacePath: workspace, ledger });

    await expect(
      output.save({ callId: "a", header: "H", text: "x".repeat(10) }),
    ).resolves.toMatchObject({
      saved: true,
    });
    await expect(output.save({ callId: "b", header: "H", text: "x".repeat(70) })).resolves.toEqual({
      saved: false,
      reason: "it is over the 1.0 GiB limit on all saved tool output",
      totalBytes: 70,
    });
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
