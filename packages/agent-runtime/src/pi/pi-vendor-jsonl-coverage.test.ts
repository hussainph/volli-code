import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "./vendor/pi-harness/context";
import { NodeExecutionEnv } from "./vendor/pi-harness/env/nodejs";
import {
  commitWrite,
  insertEntry,
  insertUsage,
  type CommittedWrite,
} from "./vendor/pi-harness/session/commit";
import {
  isJsonlStorageHeader,
  isLegacyV3SessionHeader,
  parseJsonlSessionHeader,
} from "./vendor/pi-harness/session/jsonl/codec";
import { runJsonlFork, type JsonlForkInput } from "./vendor/pi-harness/session/jsonl/fork";
import {
  parseJsonlTransaction,
  publishFileAtomically,
  readJsonlHeader,
} from "./vendor/pi-harness/session/jsonl/io";
import { JsonlSessionRepo } from "./vendor/pi-harness/session/jsonl/repo";
import { JsonlStorage } from "./vendor/pi-harness/session/jsonl/storage";
import type {
  JsonlSessionMetadata,
  JsonlStorageHeader,
} from "./vendor/pi-harness/session/jsonl/types";
import type { Write } from "./vendor/pi-harness/session/types";
import { emptyUsage } from "./vendor/pi-harness/session/usage";
import {
  appendList,
  branchTip,
  deleteList,
  deleteValue,
  laneConfig,
  laneState,
  list,
  setValue,
  value,
} from "./vendor/pi-harness/session/values";
import { err, FileError, getOrThrow, type FileSystem } from "./vendor/pi-harness/types";

const context = BACKGROUND_CONTEXT;
let directory: string;
let env: NodeExecutionEnv;
beforeEach(async () => {
  const root = resolve("../../.bench-tmp/pi-migration-vc496/jsonl-tests");
  await mkdir(root, { recursive: true });
  directory = await mkdtemp(join(root, "case-"));
  env = new NodeExecutionEnv({ cwd: directory });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await env.cleanup(context);
  await rm(directory, { recursive: true, force: true });
});

function overrides<T extends object>(target: T, replacements: Partial<T>): T {
  return new Proxy(target, {
    get(inner, property, receiver) {
      if (Object.hasOwn(replacements, property)) return Reflect.get(replacements, property);
      const member: unknown = Reflect.get(inner, property, receiver);
      return typeof member === "function" ? member.bind(inner) : member;
    },
  });
}
function gate() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolvePromiseInner) => {
    resolvePromise = resolvePromiseInner;
  });
  return { promise, release: resolvePromise };
}
function header(extra: Partial<JsonlStorageHeader> = {}): JsonlStorageHeader {
  return {
    kind: "header",
    v: 4,
    id: "source",
    cwd: directory,
    createdAt: 0,
    storageVersion: 1,
    ...extra,
  };
}
function legacyHeader() {
  return {
    type: "session",
    version: 3,
    id: "legacy",
    cwd: directory,
    timestamp: "2025-01-01T00:00:00.000Z",
  };
}
async function rawFile(name: string, records: unknown[], tail = ""): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n" + tail);
  return path;
}
function repo(fileSystem: FileSystem = env, now: (() => number) | undefined = () => 0) {
  return new JsonlSessionRepo({ fileSystem, sessionsRoot: join(directory, "sessions"), now });
}
function metadata(path: string, extra: Partial<JsonlSessionMetadata> = {}): JsonlSessionMetadata {
  return {
    id: "source",
    cwd: directory,
    createdAt: 0,
    storageVersion: 1,
    path,
    modifiedAt: 0,
    ...extra,
  };
}
function failure() {
  return err<never, FileError>(new FileError("permission_denied", "injected disk failure"));
}
function laneWrites(): Write[] {
  return [
    insertEntry({ type: "custom", id: "root", parentId: null, customType: "note", data: "root" }),
    insertEntry({
      type: "custom",
      id: "child",
      parentId: "root",
      customType: "note",
      data: "child",
    }),
    setValue(branchTip("main"), "child"),
    setValue(laneConfig("main"), {
      model: { provider: "test", modelId: "test" },
      thinkingLevel: "off",
      activeToolNames: [],
    }),
    setValue(laneState("main"), {
      currentOperationId: "pending",
      lastOperationId: "old",
      inbox: [],
    }),
  ];
}
function committed(writes: Write[]): CommittedWrite[] {
  return writes.map((write, index) => commitWrite(write, index + 1, 0));
}
async function forkFile(
  input: JsonlForkInput,
  fork: Parameters<typeof runJsonlFork>[0]["fork"] = { scope: "tree" },
) {
  const destinationPath = join(directory, "fork.jsonl");
  await runJsonlFork(
    { input, fileSystem: env, destinationPath, destinationHeader: header({ id: "fork" }), fork },
    context,
  );
  return destinationPath;
}

describe("JSONL wire validation and atomic publication", () => {
  it("rejects invalid optional ancestry and high-water fields rather than admitting malformed v3/v4 headers", () => {
    for (const extra of [
      { parentSession: 0 },
      { parentSession: null },
      { timestamp: "invalid" },
      { cwd: 0 },
      { id: null },
    ]) {
      const candidate = { ...legacyHeader(), ...extra };
      expect(isLegacyV3SessionHeader(candidate)).toBe(false);
      expect(parseJsonlSessionHeader(JSON.stringify(candidate)).ok).toBe(false);
    }
    for (const extra of [
      { legacyParentSessionPath: 0 },
      { legacyParentSessionPath: null },
      { parentSessionId: null },
      { nextSeq: 0 },
      { nextSeq: 1.5 },
      { createdAt: -1 },
      { storageVersion: 0 },
    ]) {
      const candidate = { ...header(), ...extra };
      expect(isJsonlStorageHeader(candidate)).toBe(false);
      expect(parseJsonlSessionHeader(JSON.stringify(candidate)).ok).toBe(false);
    }
    expect(isLegacyV3SessionHeader({ ...legacyHeader(), parentSession: "parent.jsonl" })).toBe(
      true,
    );
    expect(
      isJsonlStorageHeader(
        header({ parentSessionId: "parent", legacyParentSessionPath: "parent.jsonl", nextSeq: 2 }),
      ),
    ).toBe(true);
  });

  it("reports missing, unterminated, invalid and unreadable headers with their cause", async () => {
    for (const text of ["", "\n", JSON.stringify(header()), "not JSON\n", "{}\n"]) {
      const path = join(directory, "header.jsonl");
      await writeFile(path, text);
      const reader = getOrThrow(await env.openTextLineReader(path, context));
      await expect(readJsonlHeader(reader, path, context)).rejects.toThrow(
        /missing header|invalid header/,
      );
      await reader.close(context);
    }
    const path = await rawFile("header.jsonl", [header()]);
    const reader = getOrThrow(await env.openTextLineReader(path, context));
    const error = new FileError("permission_denied", "reader failed");
    await expect(
      readJsonlHeader(overrides(reader, { readLine: async () => err(error) }), path, context),
    ).rejects.toMatchObject({ cause: error });
    await reader.close(context);
  });

  it("validates each transaction write before replay, including all discriminants and numeric bounds", () => {
    for (const [candidate, message] of [
      [null, "transaction write"],
      [[[]], "transaction write"],
      [{ kind: "usage", seq: 0 }, "write seq"],
      [{ kind: "usage", seq: 1.5 }, "write seq"],
      [{ kind: "entry", seq: 1, timestamp: -1 }, "entry timestamp"],
      [{ kind: "value", seq: 1, op: "replace" }, "value operation"],
      [{ kind: "list", seq: 1, op: "replace" }, "list operation"],
      [{ kind: "unknown", seq: 1 }, "write kind"],
    ] as const)
      expect(() => parseJsonlTransaction(JSON.stringify(candidate))).toThrow(message);
    expect(() => parseJsonlTransaction("{")).toThrow("not valid JSON");
    expect(parseJsonlTransaction("[]")).toEqual([]);
    const writes = committed([
      setValue(value("v"), 1),
      deleteValue(value("v")),
      appendList(list("l"), 1),
      deleteList(list("l")),
      insertUsage({ id: "usage", usage: emptyUsage(), adjustment: false }),
    ]);
    expect(parseJsonlTransaction(JSON.stringify(writes))).toEqual(writes);
  });

  it.each(["stage", "append", "rename", "callback"] as const)(
    "keeps the published bytes unchanged and removes staging on %s failure",
    async (stage) => {
      const path = join(directory, "published.jsonl");
      await writeFile(path, "original\n");
      const fs = overrides<FileSystem>(env, {
        ...(stage === "stage" ? { writeFile: async () => failure() } : {}),
        ...(stage === "append" ? { appendFile: async () => failure() } : {}),
        ...(stage === "rename" ? { renameFile: async () => failure() } : {}),
      });
      await expect(
        publishFileAtomically(fs, path, context, async (append) => {
          await append("replacement\n");
          if (stage === "callback") throw new Error("callback failed");
        }),
      ).rejects.toThrow(/injected disk failure|callback failed/);
      expect(await readFile(path, "utf8")).toBe("original\n");
      expect(getOrThrow(await env.exists(`${path}.tmp`, context))).toBe(false);
      await publishFileAtomically(env, path, context, async (append) => {
        await append("first\n");
        await append("second\n");
      });
      expect(await readFile(path, "utf8")).toBe("first\nsecond\n");
    },
  );
});

describe("JSONL fork input and lane contracts", () => {
  it("rejects wrong format, identity and storage version without publishing any destination", async () => {
    for (const sourceHeader of [
      legacyHeader(),
      header({ id: "changed" }),
      header({ cwd: "changed" }),
      header({ storageVersion: 2 }),
    ]) {
      const path = await rawFile("source.jsonl", [sourceHeader]);
      await expect(forkFile({ kind: "closed", metadata: metadata(path) })).rejects.toThrow(
        /expected format 4|identity does not match|unsupported storage version/,
      );
      expect(getOrThrow(await env.exists(join(directory, "fork.jsonl"), context))).toBe(false);
    }
  });

  it("refuses splitting a transaction at a captured sequence and excludes later complete transactions", async () => {
    const writes = committed([setValue(value("app"), "first"), setValue(value("other"), "second")]);
    const path = await rawFile("source.jsonl", [header(), writes]);
    await expect(forkFile({ kind: "open", metadata: metadata(path), nextSeq: 2 })).rejects.toThrow(
      "crosses fork sequence boundary 2",
    );
    await rawFile("source.jsonl", [header(), [], writes[0], writes[1]], "torn");
    const destination = await forkFile({ kind: "open", metadata: metadata(path), nextSeq: 2 });
    const fork = await JsonlStorage.open({ fileSystem: env, path: destination }, context);
    expect((await fork.getValue(value("app"), context))?.value).toBe("first");
    expect(await fork.getValue(value("other"), context)).toBeUndefined();
    expect(await fork.captureForkNextSeq(context)).toBe(2);
    await fork.close(context);
  });

  it("derives a closed empty fork's sequence from an absent header high-water mark", async () => {
    const path = await rawFile("source.jsonl", [header(), []]);
    const destination = await forkFile({ kind: "closed", metadata: metadata(path) });
    const fork = await JsonlStorage.open({ fileSystem: env, path: destination }, context);
    expect(await fork.captureForkNextSeq(context)).toBe(1);
    await fork.close(context);
  });

  it("folds lane deletion and recreation, surviving scalar/list rows and both branch projections", async () => {
    const writes = committed([
      ...laneWrites(),
      deleteValue(branchTip("main")),
      setValue(branchTip("main"), "child"),
      deleteValue(laneConfig("main")),
      laneWrites()[3]!,
      deleteValue(laneState("main")),
      laneWrites()[4]!,
      setValue(value("app"), "obsolete"),
      setValue(value("app"), "current"),
      appendList(list("items"), "obsolete"),
      deleteList(list("items")),
      appendList(list("items"), "surviving"),
      insertUsage({ id: "spend", usage: { ...emptyUsage(), input: 5 }, adjustment: false }),
    ]);
    const path = await rawFile("source.jsonl", [header(), writes]);
    const destination = await forkFile({ kind: "closed", metadata: metadata(path) });
    const tree = await JsonlStorage.open({ fileSystem: env, path: destination }, context);
    expect((await tree.getValue(value("app"), context))?.value).toBe("current");
    expect(
      (await tree.readList(list("items"), undefined, context)).map((row) => row.value),
    ).toEqual(["surviving"]);
    expect(await tree.scanUsage({}, context)).toEqual([]);
    await tree.close(context);
    const branchPath = await forkFile(
      { kind: "closed", metadata: metadata(path) },
      { scope: "branch", branch: "main", entryId: "child", position: "before" },
    );
    const branch = await JsonlStorage.open({ fileSystem: env, path: branchPath }, context);
    expect((await branch.scanEntries({}, context)).map((entry) => entry.id)).toEqual(["root"]);
    expect((await branch.getValue(branchTip("main"), context))?.value).toBe("root");
    expect(await branch.getValue(value("app"), context)).toBeUndefined();
    await branch.close(context);
  });

  it("rejects source lanes whose tip, configuration or state was removed", async () => {
    for (const deletion of [
      deleteValue(branchTip("main")),
      deleteValue(laneConfig("main")),
      deleteValue(laneState("main")),
    ]) {
      const path = await rawFile("source.jsonl", [
        header(),
        committed([...laneWrites(), deletion]),
      ]);
      await expect(
        forkFile({ kind: "closed", metadata: metadata(path) }, { scope: "branch", branch: "main" }),
      ).rejects.toThrow(/Unknown source branch|not a configured AgentLane/);
    }
  });

  it("cleans a partially staged fork after a source-reader failure in the copy pass", async () => {
    const path = await rawFile("source.jsonl", [header(), committed(laneWrites())]);
    let opened = 0;
    const fs = overrides<FileSystem>(env, {
      openTextLineReader: async (sourcePath, ctx) => {
        const result = await env.openTextLineReader(sourcePath, ctx);
        opened++;
        if (!result.ok || opened !== 2) return result;
        let lines = 0;
        return {
          ok: true,
          value: overrides(result.value, {
            readLine: async (readContext) => {
              lines++;
              return lines === 2 ? failure() : result.value.readLine(readContext);
            },
          }),
        };
      },
    });
    const destinationPath = join(directory, "fork.jsonl");
    await expect(
      runJsonlFork(
        {
          input: { kind: "closed", metadata: metadata(path) },
          fileSystem: fs,
          destinationPath,
          destinationHeader: header({ id: "fork" }),
          fork: { scope: "tree" },
        },
        context,
      ),
    ).rejects.toThrow("Failed to read JSONL fork source");
    expect(getOrThrow(await env.exists(destinationPath, context))).toBe(false);
    expect(getOrThrow(await env.exists(`${destinationPath}.tmp`, context))).toBe(false);
  });
});

describe("JSONL storage lifecycle and replay", () => {
  it("creates nonempty state, forwards scans and usage, then rejects every closed admission", async () => {
    const path = join(directory, "storage.jsonl");
    const storage = await JsonlStorage.create(
      { fileSystem: env, path },
      header(),
      [
        ...laneWrites(),
        setValue(value("app"), "value"),
        appendList(list("items"), "item"),
        insertUsage({ id: "usage", usage: emptyUsage(), adjustment: false }),
      ],
      context,
    );
    expect((await storage.getEntries(["root", "child"], context)).size).toBe(2);
    expect(await storage.scanValues(value("app"), context)).toHaveLength(1);
    expect(await storage.readList(list("items"), undefined, context)).toHaveLength(1);
    expect(await storage.scanBranch({ start: "child" }, context)).toHaveLength(2);
    expect(
      await storage.scanBranchStructure({ start: "child", order: "oldestFirst" }, context),
    ).toMatchObject([{ id: "root" }, { id: "child" }]);
    expect(await storage.scanEntries({}, context)).toHaveLength(2);
    expect(await storage.scanUsage({}, context)).toMatchObject([{ id: "usage" }]);
    expect(await storage.getStats(context)).toMatchObject({ messageCount: 0 });
    const closing = storage.close(context);
    expect(storage.close(context)).toBe(closing);
    const admissions = [
      () => storage.commit([], context),
      () => storage.getEntries([], context),
      () => storage.getValue(value("app"), context),
      () => storage.scanValues(value("app"), context),
      () => storage.readList(list("items"), undefined, context),
      () => storage.scanBranch({ start: "child" }, context),
      () => storage.scanBranchStructure({ start: "child" }, context),
      () => storage.scanEntries({}, context),
      () => storage.scanUsage({}, context),
      () => storage.getStats(context),
      () => storage.captureForkNextSeq(context),
    ];
    for (const admit of admissions) await expect(admit()).rejects.toThrow("JsonlStorage is closed");
    await closing;
  });

  it("drains admitted writes on close and recovers the sequence after a failed append", async () => {
    const path = join(directory, "storage.jsonl");
    const started = gate();
    const release = gate();
    let fail = true;
    const fs = overrides<FileSystem>(env, {
      appendFile: async (filePath, content, ctx) => {
        if (filePath === path && fail) {
          started.release();
          await release.promise;
          return failure();
        }
        return env.appendFile(filePath, content, ctx);
      },
    });
    const storage = await JsonlStorage.create({ fileSystem: fs, path }, header(), [], context);
    const write = storage.commit([setValue(value("app"), "failed")], context);
    const rejected = expect(write).rejects.toThrow("Failed to append JSONL storage");
    await started.promise;
    const boundary = storage.captureForkNextSeq(context);
    release.release();
    await rejected;
    expect(await boundary).toBe(1);
    expect(await storage.getValue(value("app"), context)).toBeUndefined();
    fail = false;
    const admitted = storage.commit([setValue(value("app"), "committed")], context);
    const closing = storage.close(context);
    expect((await admitted).seqs).toEqual([1]);
    await closing;
    const reopened = await JsonlStorage.open({ fileSystem: env, path }, context);
    expect((await reopened.getValue(value("app"), context))?.value).toBe("committed");
    await reopened.close(context);
  });

  it("reports replay line numbers and keeps corrupt bytes untouched", async () => {
    const path = await rawFile("storage.jsonl", [header(), { kind: "value", op: "set", seq: 0 }]);
    const original = await readFile(path, "utf8");
    await expect(JsonlStorage.open({ fileSystem: env, path }, context)).rejects.toMatchObject({
      message: expect.stringContaining("line 2"),
      cause: expect.any(Error),
    });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("uses the timer fallback for time-sliced UTF-8 replay when setImmediate is unavailable", async () => {
    const writes = Array.from({ length: 30 }, (_, index) =>
      commitWrite(setValue(value("app", String(index)), "日本語🙂"), index + 1, 0),
    );
    const path = await rawFile("storage.jsonl", [header(), ...writes]);
    vi.stubGlobal("setImmediate", undefined);
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      clock += 9;
      return clock;
    });
    const timer = vi.spyOn(globalThis, "setTimeout");
    const storage = await JsonlStorage.open({ fileSystem: env, path }, context);
    expect(timer).toHaveBeenCalled();
    expect((await storage.getValue(value("app", "29"), context))?.value).toBe("日本語🙂");
    await storage.close(context);
  });

  it.each(["stage", "append", "rename"] as const)(
    "retains legacy backing and caller sequence on failed %s upgrade, then retries atomically",
    async (stage) => {
      const path = await rawFile("legacy.jsonl", [
        legacyHeader(),
        {
          type: "message",
          id: "entry",
          parentId: null,
          timestamp: legacyHeader().timestamp,
          message: { role: "user", content: "legacy", timestamp: 0 },
        },
      ]);
      const original = await readFile(path, "utf8");
      let fail = true;
      const fs = overrides<FileSystem>(env, {
        writeFile: (filePath, content, ctx) =>
          fail && stage === "stage"
            ? Promise.resolve(failure())
            : env.writeFile(filePath, content, ctx),
        appendFile: (filePath, content, ctx) =>
          fail && stage === "append"
            ? Promise.resolve(failure())
            : env.appendFile(filePath, content, ctx),
        renameFile: (source, destination, ctx) =>
          fail && stage === "rename"
            ? Promise.resolve(failure())
            : env.renameFile(source, destination, ctx),
      });
      const storage = await JsonlStorage.open({ fileSystem: fs, path }, context);
      const nextSeq = await storage.captureForkNextSeq(context);
      expect((await storage.commit([], context)).seqs).toEqual([]);
      expect(storage.isLegacyV3()).toBe(true);
      await expect(storage.commit([setValue(value("app"), "caller")], context)).rejects.toThrow(
        "injected disk failure",
      );
      expect(await readFile(path, "utf8")).toBe(original);
      expect(getOrThrow(await env.exists(`${path}.tmp`, context))).toBe(false);
      expect(storage.isLegacyV3()).toBe(true);
      expect(await storage.captureForkNextSeq(context)).toBe(nextSeq);
      expect(await storage.getValue(value("app"), context)).toBeUndefined();
      fail = false;
      const result = await storage.commit([setValue(value("app"), "caller")], context);
      expect(result.firstSeq).toBe(nextSeq + 1);
      expect(result.seqs).toEqual([nextSeq + 1]);
      expect(storage.isLegacyV3()).toBe(false);
      expect(await storage.scanUsage({}, context)).toMatchObject([
        { adjustment: true, details: { source: "v3-import" } },
      ]);
      await storage.close(context);
      const reopened = await JsonlStorage.open({ fileSystem: env, path }, context);
      expect((await reopened.getValue(value("app"), context))?.value).toBe("caller");
      expect(await reopened.captureForkNextSeq(context)).toBe(nextSeq + 2);
      await reopened.close(context);
    },
  );
});

describe("JSONL repository lifecycle, discovery and reservations", () => {
  it("closes repository admission idempotently without closing separately owned session handles", async () => {
    const repository = repo(env, undefined);
    const session = await repository.create({ cwd: directory, parentSessionId: "parent" }, context);
    expect(session.metadata.parentSessionId).toBe("parent");
    const closing = repository.close(context);
    expect(repository.close(context)).toBe(closing);
    await closing;
    for (const admission of [
      () => repository.create({ cwd: directory }, context),
      () => repository.open(session.metadata, context),
      () => repository.list(undefined, context),
      () => repository.delete(session.metadata, context),
      () => repository.fork(session.metadata, { scope: "tree" }, context),
    ])
      await expect(admission()).rejects.toThrow("JsonlSessionRepo is closed");
    await session.setValue(value("still-open"), true, context);
    await session.close(context);
  });

  it("discovers only valid session files, resolves lossy cwd collisions and orders ties deterministically", async () => {
    const repository = repo();
    expect(await repository.list(undefined, context)).toEqual([]);
    const a = join(directory, "a", "b");
    const b = join(directory, "a-b");
    const sessions = [
      await repository.create({ cwd: a, id: "z" }, context),
      await repository.create({ cwd: b, id: "a" }, context),
    ];
    const sessionDirectory = join(
      directory,
      "sessions",
      `--${a.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
    );
    // Imported files may share an id across cwds whose directory encoding collides.
    await writeFile(
      join(sessionDirectory, "collision.jsonl"),
      JSON.stringify(header({ cwd: a, id: "a" })) + "\n",
    );
    await mkdir(join(sessionDirectory, "nested.jsonl"));
    await writeFile(join(sessionDirectory, "ignored.txt"), "ignored");
    await writeFile(join(sessionDirectory, "empty.jsonl"), "");
    await writeFile(join(sessionDirectory, "invalid.jsonl"), "{}\n");
    await writeFile(
      join(directory, "sessions", "root-file.jsonl"),
      JSON.stringify(header()) + "\n",
    );
    await writeFile(
      join(sessionDirectory, "legacy.jsonl"),
      JSON.stringify({ ...legacyHeader(), cwd: a, parentSession: "missing-parent.jsonl" }) + "\n",
    );
    await writeFile(
      join(sessionDirectory, "ancestry.jsonl"),
      JSON.stringify(
        header({
          cwd: a,
          id: "ancestry",
          parentSessionId: "parent",
          legacyParentSessionPath: "old-parent",
        }),
      ) + "\n",
    );
    const discovered = await repository.list(undefined, context);
    expect(discovered.map((item) => item.id)).toEqual(["legacy", "a", "a", "ancestry", "z"]);
    expect(discovered.filter((item) => item.id === "a").map((item) => item.cwd)).toEqual([b, a]);
    expect(discovered.find((item) => item.id === "ancestry")).toMatchObject({
      parentSessionId: "parent",
      legacyParentSessionPath: "old-parent",
    });
    expect((await repository.list({ cwd: a }, context)).every((item) => item.cwd === a)).toBe(true);
    expect(await repository.list({ cwd: join(directory, "absent") }, context)).toEqual([]);
    for (const session of sessions) await session.close(context);
  });

  it("rejects open, missing and on-disk duplicate identities and deletes only closed files", async () => {
    const repository = repo();
    const session = await repository.create({ cwd: directory, id: "source" }, context);
    await expect(repository.open(session.metadata, context)).rejects.toThrow("already open");
    await expect(repository.create({ cwd: directory, id: "source" }, context)).rejects.toThrow(
      "already exists",
    );
    await expect(repository.delete(session.metadata, context)).rejects.toThrow("Session is open");
    await session.close(context);
    await expect(repository.create({ cwd: directory, id: "source" }, context)).rejects.toThrow(
      "already exists",
    );
    await repository.delete(session.metadata, context);
    await expect(repository.delete(session.metadata, context)).rejects.toThrow("does not exist");
    await expect(repository.open(session.metadata, context)).rejects.toThrow("does not exist");
    const mismatchedPath = await rawFile("mismatched.jsonl", [header()]);
    await expect(
      repository.open(metadata(mismatchedPath, { id: "other" }), context),
    ).rejects.toThrow("identity does not match");
    await expect(
      repository.open(metadata(mismatchedPath, { cwd: "other" }), context),
    ).rejects.toThrow("identity does not match");
    await rawFile("mismatched.jsonl", [header({ storageVersion: 2 })]);
    await expect(repository.open(metadata(mismatchedPath), context)).rejects.toThrow(
      "unsupported storage version",
    );
  });

  it.each(["create", "fork"] as const)(
    "releases %s destination reservation and removes a published file after metadata-read failure",
    async (operation) => {
      let fail = false;
      const repository = repo(
        overrides<FileSystem>(env, {
          fileInfo: (path, ctx) => (fail ? Promise.resolve(failure()) : env.fileInfo(path, ctx)),
        }),
      );
      const source = await repository.create({ cwd: directory, id: "source" }, context);
      fail = true;
      const create = () =>
        operation === "create"
          ? repository.create({ cwd: directory, id: "destination" }, context)
          : repository.fork(source.metadata, { scope: "tree", id: "destination" }, context);
      await expect(create()).rejects.toThrow("Failed to read session");
      fail = false;
      expect((await repository.list(undefined, context)).map((item) => item.id)).toEqual([
        "source",
      ]);
      const retried = await create();
      expect(retried.metadata.id).toBe("destination");
      await retried.close(context);
      await source.close(context);
    },
  );

  it.each(["create", "fork"] as const)(
    "reserves a pending %s destination against both competing create and fork",
    async (operation) => {
      const started = gate();
      const release = gate();
      let block = false;
      const repository = repo(
        overrides<FileSystem>(env, {
          writeFile: async (path, content, ctx) => {
            if (block) {
              started.release();
              await release.promise;
            }
            return env.writeFile(path, content, ctx);
          },
        }),
      );
      const source = await repository.create({ cwd: directory, id: "source" }, context);
      block = true;
      const pending =
        operation === "create"
          ? repository.create({ cwd: directory, id: "destination" }, context)
          : repository.fork(source.metadata, { scope: "tree", id: "destination" }, context);
      await started.promise;
      await expect(
        repository.create({ cwd: directory, id: "destination" }, context),
      ).rejects.toThrow("already exists");
      await expect(
        repository.fork(source.metadata, { scope: "tree", id: "destination" }, context),
      ).rejects.toThrow("already exists");
      await expect(
        repository.fork(source.metadata, { scope: "tree", id: "source" }, context),
      ).rejects.toThrow("already exists");
      release.release();
      const destination = await pending;
      await destination.close(context);
      await source.close(context);
    },
  );

  it("publishes one winner for concurrent opens without the losing close unregistering it", async () => {
    const sourceRepo = repo();
    const source = await sourceRepo.create({ cwd: directory, id: "source" }, context);
    await source.close(context);
    const reached = gate();
    const release = gate();
    let reads = 0;
    const repository = repo(
      overrides<FileSystem>(env, {
        readBinaryFile: async (path, ctx) => {
          reads++;
          if (reads === 2) reached.release();
          await release.promise;
          return env.readBinaryFile(path, ctx);
        },
      }),
    );
    const first = repository.open(source.metadata, context);
    const second = repository.open(source.metadata, context);
    const resultsPromise = Promise.allSettled([first, second]);
    await reached.promise;
    release.release();
    const results = await resultsPromise;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("Missing open winner");
    await expect(repository.open(source.metadata, context)).rejects.toThrow("already open");
    await winner.value.setValue(value("winner"), true, context);
    await winner.value.close(context);
    const reopened = await repository.open(source.metadata, context);
    expect((await reopened.getValue(value("winner"), context))?.value).toBe(true);
    await reopened.close(context);
  });

  it("forks a closed legacy branch with translated entry identity, but refuses an open unupgraded source", async () => {
    const path = await rawFile("legacy.jsonl", [
      legacyHeader(),
      {
        type: "model_change",
        id: "model",
        parentId: null,
        timestamp: legacyHeader().timestamp,
        provider: "test",
        modelId: "test",
      },
      {
        type: "thinking_level_change",
        id: "thinking",
        parentId: "model",
        timestamp: legacyHeader().timestamp,
        thinkingLevel: "off",
      },
      {
        type: "message",
        id: "entry",
        parentId: "thinking",
        timestamp: legacyHeader().timestamp,
        message: { role: "user", content: "legacy", timestamp: 0 },
      },
    ]);
    const sourceMetadata = metadata(path, { id: "legacy" });
    const repository = repo();
    const source = await repository.open(sourceMetadata, context);
    await expect(
      repository.fork(sourceMetadata, { scope: "tree", id: "blocked" }, context),
    ).rejects.toThrow("Cannot fork an open legacy v3");
    await source.close(context);
    const branch = await repository.fork(
      sourceMetadata,
      { scope: "branch", branch: "main", entryId: "entry", id: "branch" },
      context,
    );
    expect(await branch.findEntries({}, context)).toHaveLength(1);
    expect(branch.metadata.parentSessionId).toBe("legacy");
    await branch.close(context);
    await expect(
      repository.fork(
        { ...sourceMetadata, id: "wrong" },
        { scope: "tree", id: "mismatch" },
        context,
      ),
    ).rejects.toThrow("identity does not match");
    const empty = join(directory, "empty.jsonl");
    await writeFile(empty, "");
    await expect(
      repository.fork(metadata(empty), { scope: "tree", id: "empty" }, context),
    ).rejects.toThrow("missing header");
    const invalid = await rawFile("invalid.jsonl", [{}]);
    await expect(
      repository.fork(metadata(invalid), { scope: "tree", id: "invalid" }, context),
    ).rejects.toThrow("invalid header");
  });
});
