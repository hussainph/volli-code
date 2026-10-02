import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "../../test-fixtures/pi-0.99.2-memory";
import { BACKGROUND_CONTEXT } from "./vendor/pi-harness/context";
import { NodeExecutionEnv } from "./vendor/pi-harness/env/nodejs";
import { insertEntry, insertUsage } from "./vendor/pi-harness/session/commit";
import { InMemoryStorageState } from "./vendor/pi-harness/session/in-memory-storage-state";
import {
  LegacyV3Source,
  metadataFromLegacyV3Header,
} from "./vendor/pi-harness/session/jsonl/legacy-v3";
import { MutationLine } from "./vendor/pi-harness/session/mutation-line";
import { StorageBackedSession } from "./vendor/pi-harness/session/session";
import type { Write } from "./vendor/pi-harness/session/types";
import { emptyUsage } from "./vendor/pi-harness/session/usage";
import {
  appendList,
  branchTip,
  entryLabel,
  laneConfig,
  laneState,
  list,
  setValue,
  value as storedValue,
} from "./vendor/pi-harness/session/values";

const context = BACKGROUND_CONTEXT;
const user: AgentMessage = { role: "user", content: "user", timestamp: 0 };
function apply(state: InMemoryStorageState, commitWrites: Write[]): void {
  state.applyValidated(state.prepareCommit(commitWrites, 10).writes);
}
function seeded(): InMemoryStorageState {
  const state = new InMemoryStorageState();
  apply(state, [
    insertEntry({ type: "message", id: "root", parentId: null, message: user }),
    insertEntry({
      type: "custom",
      id: "child",
      parentId: "root",
      customType: "note",
      data: "value",
    }),
    insertEntry({ type: "message", id: "sibling", parentId: "root", message: user }),
    setValue(branchTip("main"), "child"),
    setValue(laneConfig("main"), {
      model: { provider: "test", modelId: "test" },
      thinkingLevel: "off",
      activeToolNames: [],
    }),
    setValue(laneState("main"), { currentOperationId: "op", lastOperationId: "old", inbox: [] }),
  ]);
  return state;
}

describe("retained memory state projections used by both storage backends", () => {
  it("forks coherent branch/tree snapshots without copying spend or transient operation state", () => {
    const state = seeded();
    const application = storedValue<string>("application");
    const items = list<string>("items");
    apply(state, [
      setValue(application, "application"),
      appendList(items, "first"),
      appendList(items, "second"),
      setValue(entryLabel("root"), "root label"),
      setValue(entryLabel("sibling"), "sibling label"),
      setValue(storedValue("pi.op.state", "op"), "transient"),
      appendList(list("pi.pending.output"), "transient"),
      insertUsage({
        id: "usage",
        adjustment: false,
        usage: { ...emptyUsage(), input: 3, totalTokens: 3 },
      }),
    ]);
    const branch = state.createFork({
      scope: "branch",
      branch: "main",
      entryId: "child",
      position: "before",
    });
    expect(branch.scanEntries({ order: "asc" }).map((entry) => entry.id)).toEqual(["root"]);
    expect(branch.getValue(branchTip("main"))?.value).toBe("root");
    expect(branch.getValue(entryLabel("root"))?.value).toBe("root label");
    expect(branch.getValue(entryLabel("sibling"))).toBeUndefined();
    expect(branch.getValue(application)).toBeUndefined();
    expect(branch.readList(items)).toEqual([]);
    expect(branch.getValue(laneState("main"))?.value).toEqual({
      currentOperationId: null,
      lastOperationId: null,
      inbox: [],
    });
    expect(branch.getStats()).toEqual({ messageCount: 1, usage: emptyUsage() });
    const tree = state.createFork({ scope: "tree" });
    expect(tree.scanEntries({ order: "asc" })).toEqual(state.scanEntries({ order: "asc" }));
    expect(tree.getValue(application)?.value).toBe("application");
    expect(tree.readList(items).map(({ value }) => value)).toEqual(["first", "second"]);
    expect(tree.getValue(storedValue("pi.op.state", "op"))).toBeUndefined();
    expect(tree.readList(list("pi.pending.output"))).toEqual([]);
    expect(tree.getStats().usage).toEqual(emptyUsage());
    expect(tree.prepareCommit([setValue(application, "new")], 11).result.firstSeq).toBe(
      state.prepareCommit([], 11).result.firstSeq,
    );
    expect(
      state
        .createFork({ scope: "branch", branch: "main" })
        .scanEntries({ order: "asc" })
        .map((entry) => entry.id),
    ).toEqual(["root", "child"]);
    expect(
      state
        .createFork({ scope: "branch", branch: "main", entryId: "root", position: "before" })
        .scanEntries({}),
    ).toEqual([]);
    expect(() => state.createFork({ scope: "branch", branch: "missing" })).toThrow(
      "Unknown source branch",
    );
    const unconfigured = new InMemoryStorageState();
    apply(unconfigured, [setValue(branchTip("main"), null)]);
    expect(() => unconfigured.createFork({ scope: "branch", branch: "main" })).toThrow(
      "not a configured AgentLane",
    );
    apply(unconfigured, [
      setValue(laneConfig("main"), {
        model: { provider: "test", modelId: "test" },
        thinkingLevel: "off",
        activeToolNames: [],
      }),
    ]);
    expect(() => unconfigured.createFork({ scope: "branch", branch: "main" })).toThrow(
      "not a configured AgentLane",
    );
    apply(unconfigured, [
      setValue(laneState("main"), { currentOperationId: null, lastOperationId: null, inbox: [] }),
    ]);
    expect(unconfigured.createFork({ scope: "branch", branch: "main" }).scanEntries({})).toEqual(
      [],
    );
  });

  it("orders Unicode keys and respects entry, branch, usage and list pagination", () => {
    const state = seeded();
    const items = list<string>("items");
    apply(state, [
      setValue(storedValue("keys", "aa"), 1),
      setValue(storedValue("keys", "a"), 2),
      setValue(storedValue("keys", "😀"), 3),
      setValue(storedValue("keys", "文"), 4),
      appendList(items, "first"),
      appendList(items, "second"),
      insertUsage({ id: "u1", adjustment: false, usage: emptyUsage() }),
      insertUsage({ id: "u2", adjustment: false, usage: emptyUsage() }),
    ]);
    expect(state.scanValues(storedValue("keys")).map(({ address }) => address.key)).toEqual([
      "a",
      "aa",
      "文",
      "😀",
    ]);
    expect(state.scanValues(storedValue("keys", "ab"))).toEqual([]);
    const elements = state.readList(items);
    expect(
      state.readList(items, { cursor: { seq: elements[0].seq } }).map(({ value }) => value),
    ).toEqual(["second"]);
    expect(
      state
        .readList(items, { order: "desc", cursor: { seq: elements[1].seq }, limit: 1 })
        .map(({ value }) => value),
    ).toEqual(["first"]);
    expect(state.scanBranchStructure({ start: "child", order: "oldestFirst" })).toMatchObject([
      { id: "root", type: "message" },
      { id: "child", customType: "note" },
    ]);
    expect(
      state
        .scanBranch({
          start: "child",
          order: "oldestFirst",
          cursor: { seq: 1 },
          customType: "note",
          type: "custom",
          limit: 1,
        })
        .map((entry) => entry.id),
    ).toEqual(["child"]);
    expect(
      state.scanBranch({ start: "child", cursor: { seq: 2 } }).map((entry) => entry.id),
    ).toEqual(["root"]);
    expect(state.scanBranch({ start: "child", stopAtId: "child" })).toHaveLength(1);
    expect(state.scanBranch({ start: "child", stopAtType: "custom" })).toHaveLength(1);
    expect(state.scanBranch({ start: "child", type: "message", customType: "absent" })).toEqual([]);
    expect(
      state.scanEntries({ customType: "note", type: "custom", fromSeq: 2, toSeq: 2, limit: 1 }),
    ).toMatchObject([{ id: "child" }]);
    expect(state.scanEntries({ fromSeq: 3, toSeq: 1 })).toEqual([]);
    const rows = state.scanUsage({});
    expect(rows.map((row) => row.id)).toEqual(["u1", "u2"]);
    expect(
      state
        .scanUsage({ order: "desc", fromSeq: rows[0].seq, toSeq: rows[1].seq, limit: 1 })
        .map((row) => row.id),
    ).toEqual(["u2"]);
    expect(state.scanUsage({ fromSeq: rows[1].seq, toSeq: rows[0].seq })).toEqual([]);
    for (const next of [0, 1.5, Number.POSITIVE_INFINITY])
      expect(() => state.advanceNextSeq(next)).toThrow("Invalid storage sequence high-water mark");
    state.advanceNextSeq(100);
    expect(state.prepareCommit([], 0).result.firstSeq).toBe(100);
    expect(() => state.scanBranch({ start: "missing" })).toThrow("Unknown branch start");
    const exposed = state.getEntries(["child"]).get("child")!;
    exposed.parentId = "missing";
    expect(() => state.scanBranch({ start: "child" })).toThrow("Corrupt branch: missing parent");
    expect(() => state.createFork({ scope: "branch", branch: "main" })).toThrow(
      "Corrupt source branch: missing parent",
    );
  });

  it("rejects queued work when a mutation line is sealed and preserves the first close error", async () => {
    const line = new MutationLine();
    let release!: () => void;
    const active = line.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const queued = line.run(() => "not run");
    const error = new Error("closed");
    const assertion = expect(queued).rejects.toBe(error);
    const draining = line.seal(error);
    line.seal(new Error("later"));
    release();
    await active;
    await assertion;
    await draining;
    await expect(line.run(() => "not run")).rejects.toBe(error);
  });

  it("retains session mutation isolation, pagination, label deletion and stale-branch errors", async () => {
    const storage = new MemoryStorage();
    let next = 0;
    const session = new StorageBackedSession(
      { id: "session", createdAt: 0, storageVersion: 1 },
      storage,
      { idGenerator: { next: () => `entry-${++next}` } },
    );
    for (const name of ["", "bad\u0000name"])
      await expect(session.createBranch(name, null, context)).rejects.toThrow("Invalid branch");
    const branch = await session.createBranch("main", null, context);
    expect(await branch.findEntry(undefined, context)).toBeUndefined();
    const root = await branch.appendMessage(user, context);
    const child = await branch.appendCustomEntry("note", "value", context);
    await expect(session.createBranch("main", null, context)).rejects.toThrow(
      "Branch already exists",
    );
    await expect(session.createBranch("other", "missing", context)).rejects.toThrow(
      "Unknown target",
    );
    expect((await session.findEntry(undefined, context))?.id).toBe(child);
    await session.setName("name", context);
    await session.setName(undefined, context);
    expect(await session.getName(context)).toBeUndefined();
    await session.setLabel(root, "label", context);
    await session.setLabel(root, undefined, context);
    expect(await session.getLabel(root, context)).toBeUndefined();
    expect(
      await session.findEntries(
        { order: "asc", cursor: { seq: Number.MAX_SAFE_INTEGER } },
        context,
      ),
    ).toEqual([]);
    expect(await session.findEntries({ order: "desc", cursor: { seq: 1 } }, context)).toEqual([]);
    expect(
      (
        await session.findEntries(
          { order: "asc", cursor: { seq: (await session.getEntry(root, context))!.seq } },
          context,
        )
      ).map((entry) => entry.id),
    ).toEqual([child]);
    expect(
      (
        await session.findEntries(
          { order: "desc", cursor: { seq: (await session.getEntry(child, context))!.seq } },
          context,
        )
      ).map((entry) => entry.id),
    ).toEqual([root]);
    expect(await session.findEntry({ limit: 0 }, context)).toBeUndefined();
    expect(await branch.findEntry({ limit: 0 }, context)).toBeUndefined();
    const mutation = await session.beginMutation(context);
    expect(await mutation.getStats(context)).toMatchObject({ messageCount: 1 });
    expect(await mutation.getEntries([root], context)).toHaveProperty("size", 1);
    expect(await mutation.scanValues(branchTip("main"), context)).toHaveLength(1);
    expect(await mutation.readList(list("absent"), undefined, context)).toEqual([]);
    expect(await mutation.scanBranch({ start: child }, context)).toHaveLength(2);
    await mutation.commit([], context);
    await expect(mutation.commit([], context)).rejects.toThrow("commit already attempted");
    await mutation.end(context);
    await mutation.end(context);
    expect(() => mutation.getStats(context)).toThrow("outside its mutation callback");
    const failed = await session.beginMutation(context);
    const pending: AgentMessage = {
      role: "assistant",
      api: "anthropic-messages",
      provider: "test",
      model: "test",
      content: [],
      stopReason: "pending",
      timestamp: 0,
      usage: emptyUsage(),
    };
    await expect(
      failed.commit(
        [insertEntry({ type: "message", id: "pending", parentId: child, message: pending })],
        context,
      ),
    ).rejects.toThrow("Cannot persist a pending assistant message");
    await failed.end(context);
    await session.deleteValue(branchTip("main"), context);
    await expect(branch.getTipId(context)).rejects.toThrow("Unknown branch");
    await expect(branch.appendMessage(user, context)).rejects.toThrow("Unknown branch");
    await session.close(context);
  });
});

let directory: string;
let env: NodeExecutionEnv;
const timestamp = "2025-01-01T00:00:00.000Z";
beforeEach(async () => {
  const root = resolvePath("../../.bench-tmp/pi-migration-vc496/vendor-storage-tests");
  await mkdir(root, { recursive: true });
  directory = await mkdtemp(join(root, "case-"));
  env = new NodeExecutionEnv({ cwd: directory });
});
afterEach(async () => {
  await env.cleanup(context);
  await rm(directory, { recursive: true, force: true });
});
const header = () => ({
  type: "session" as const,
  version: 3 as const,
  id: "legacy",
  timestamp,
  cwd: directory,
});
async function legacy(entries: Record<string, unknown>[], extra = ""): Promise<string> {
  const path = join(directory, "legacy.jsonl");
  await writeFile(
    path,
    [header(), ...entries].map((rawRecord) => JSON.stringify(rawRecord)).join("\n") + "\n" + extra,
  );
  return path;
}
function record(
  type: string,
  id: string,
  parentId: string | null,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type, id, parentId, timestamp, ...fields };
}
async function writes(source: LegacyV3Source, select?: (id: string) => boolean) {
  const result = [];
  for await (const write of source.writes(context, select)) result.push(write);
  return result;
}

describe("retained v3 import recovery and metadata", () => {
  it("folds branch-local configuration, labels and custom messages without duplicating historical usage", async () => {
    const records = [
      record("model_change", "model", null, { provider: "test", modelId: "model" }),
      record("thinking_level_change", "thinking", "model", { thinkingLevel: "high" }),
      record("active_tools_change", "tools", "thinking", { activeToolNames: ["read"] }),
      record("custom_message", "custom", "tools", {
        customType: "note",
        content: "custom",
        display: false,
        details: { detail: 1 },
      }),
      record("label", "label", "custom", { targetId: "custom", label: "label" }),
      record("label", "delete-label", "label", { targetId: "custom" }),
      record("label", "config-label", "delete-label", {
        targetId: "model",
        label: "no retained target",
      }),
      record("session_info", "name", "config-label", { name: "session name" }),
      record("branch_summary", "branch", "name", {
        fromId: "root",
        summary: "branch summary",
        fromHook: true,
        usage: { ...emptyUsage(), input: 2, totalTokens: 2 },
      }),
      record("label", "surviving-label", "branch", { targetId: "branch", label: "branch label" }),
    ];
    const path = await legacy(records, "unterminated");
    const source = await LegacyV3Source.read(env, path, context);
    const imported = await writes(source);
    expect(imported.filter((write) => write.kind === "entry")).toMatchObject([
      {
        type: "message",
        message: {
          role: "custom",
          content: "custom",
          details: { detail: 1 },
          timestamp: Date.parse(timestamp),
        },
      },
      { type: "branch_summary", fromId: null, fromHook: true },
    ]);
    expect(
      imported.filter((write) => write.kind === "value" && write.namespace === "pi.entry.label"),
    ).toMatchObject([{ value: "branch label" }]);
    expect(source.importedUsage.input).toBe(2);
    expect(source.values).toContainEqual(
      expect.objectContaining({ namespace: "pi.session.name", value: "session name" }),
    );
    expect(source.values).toContainEqual(
      expect.objectContaining({
        namespace: "pi.lane.config",
        value: {
          model: { provider: "test", modelId: "model" },
          thinkingLevel: "high",
          activeToolNames: ["read"],
        },
      }),
    );
    expect([...source.entryStructures()]).toHaveLength(2);
    expect(await readFile(path, "utf8")).toContain("unterminated");
    expect(() => source.translateForkEntryId("missing")).toThrow("does not exist");
    expect(() => source.translateForkEntryId("model")).toThrow("not a retained entry");
    expect(imported[0]).toMatchObject({ id: source.translateForkEntryId("custom") });
    expect((await writes(source, () => false)).every((write) => write.kind === "value")).toBe(true);
  });

  it("preserves nested compaction tails and empty branch summaries while selecting only one checkpoint", async () => {
    const records = [
      record("message", "user", null, { message: user }),
      record("custom", "annotation", "user", { customType: "note", data: "annotation" }),
      record("branch_summary", "empty", "annotation", { fromId: "user", summary: "" }),
      record("custom_message", "custom", "empty", {
        customType: "note",
        content: "custom",
        display: true,
      }),
      record("branch_summary", "nonempty", "custom", { fromId: "user", summary: "branch summary" }),
      record("compaction", "c1", "nonempty", {
        firstKeptEntryId: "user",
        summary: "one",
        tokensBefore: 10,
      }),
      record("compaction", "c2", "c1", {
        firstKeptEntryId: "c1",
        summary: "two",
        tokensBefore: 20,
        fromHook: true,
      }),
    ];
    const source = await LegacyV3Source.read(env, await legacy(records), context);
    const all = await writes(source);
    const first = all.find(
      (write) => write.kind === "entry" && write.type === "compaction" && write.summary === "one",
    );
    expect(first).toMatchObject({
      retainedTail: [
        user,
        { role: "custom", content: "custom" },
        { role: "branchSummary", summary: "branch summary" },
      ],
      fromHook: false,
    });
    const secondId = source.translateForkEntryId("c2");
    const selected = await writes(source, (id) => id === secondId);
    expect(selected.filter((write) => write.kind === "entry")).toMatchObject([
      {
        type: "compaction",
        retainedTail: [{ role: "compactionSummary", summary: "one", tokensBefore: 10 }],
        fromHook: true,
      },
    ]);
  });

  it("rejects broken identity/ancestry and changed or shortened source files instead of guessing", async () => {
    for (const [records, message] of [
      [[record("message", "bad", "missing", { message: user })], "missing or forward parent"],
      [
        [
          record("custom", "same", null, { customType: "note" }),
          record("custom", "same", "same", { customType: "note" }),
        ],
        "Duplicate legacy v3 entry id",
      ],
      [[record("unsupported", "bad", null)], "Unsupported legacy v3 record type"],
    ] as const)
      await expect(LegacyV3Source.read(env, await legacy([...records]), context)).rejects.toThrow(
        message,
      );
    const invalidJson = await legacy([]);
    await writeFile(invalidJson, JSON.stringify(header()) + "\nnot JSON\n");
    await expect(LegacyV3Source.read(env, invalidJson, context)).rejects.toThrow("not valid JSON");
    const nullId = await legacy([
      record("custom", "placeholder", null, { id: null, customType: "note" }),
    ]);
    await expect(LegacyV3Source.read(env, nullId, context)).rejects.toThrow(
      "no retained ancestor: null",
    );
    const badLabel = await legacy([
      record("label", "label", null, { targetId: "missing", label: "label" }),
    ]);
    await expect(LegacyV3Source.read(env, badLabel, context)).rejects.toThrow(
      "Missing legacy v3 entry reference",
    );
    const v4 = join(directory, "v4.jsonl");
    await writeFile(
      v4,
      JSON.stringify({
        v: 4,
        kind: "header",
        storageVersion: 1,
        id: "v4",
        createdAt: 0,
        cwd: directory,
      }) + "\n",
    );
    await expect(LegacyV3Source.read(env, v4, context)).rejects.toThrow("expected format 3 header");
    const original = [record("message", "user", null, { message: user })];
    for (const changed of [
      [
        { v: 4, kind: "header", storageVersion: 1, id: "v4", createdAt: 0, cwd: directory },
        ...original,
      ],
      [{ ...header(), cwd: "changed" }, ...original],
      [{ ...header(), id: "changed" }, ...original],
      [header(), record("message", "changed", null, { message: user })],
      [header()],
      [header(), JSON.stringify(original[0]).slice(0, -1)],
    ]) {
      const path = await legacy(original);
      const source = await LegacyV3Source.read(env, path, context);
      await writeFile(
        path,
        changed
          .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
          .join("\n") + (changed.length === 2 && typeof changed[1] === "string" ? "" : "\n"),
      );
      await expect(writes(source)).rejects.toThrow(
        /Legacy v3 source (header changed|changed|ended before captured entries)/,
      );
    }
    const path = await legacy([
      record("message", "user", null, { message: user }),
      record("compaction", "bad", "user", {
        firstKeptEntryId: "missing",
        summary: "bad",
        tokensBefore: 1,
      }),
    ]);
    const source = await LegacyV3Source.read(env, path, context);
    await expect(writes(source)).rejects.toThrow("not on its parent branch");
  });

  it("does not resurrect older configuration values when the nearest legacy change omitted one", async () => {
    const records = [
      record("model_change", "model", null, { provider: "test", modelId: "model" }),
      record("thinking_level_change", "thinking", "model", { thinkingLevel: "high" }),
      record("message", "user", "thinking", { message: user }),
    ];
    const valid = await LegacyV3Source.read(env, await legacy(records), context);
    expect(valid.values).toContainEqual(
      expect.objectContaining({
        namespace: "pi.lane.config",
        value: {
          model: { provider: "test", modelId: "model" },
          thinkingLevel: "high",
          activeToolNames: [],
        },
      }),
    );
    const invalid = await LegacyV3Source.read(
      env,
      await legacy([...records, record("thinking_level_change", "omitted", "user")]),
      context,
    );
    expect(invalid.values.some((value) => value.namespace === "pi.lane.config")).toBe(false);
  });

  it("resolves parent session ids when possible and preserves unresolved paths", async () => {
    const parent = join(directory, "parent.jsonl");
    await writeFile(parent, JSON.stringify({ ...header(), id: "parent" }) + "\n");
    expect(
      await metadataFromLegacyV3Header(env, { ...header(), parentSession: parent }, context),
    ).toMatchObject({ parentSessionId: "parent" });
    for (const content of ["", "not JSON\n"]) {
      await writeFile(parent, content);
      expect(
        await metadataFromLegacyV3Header(env, { ...header(), parentSession: parent }, context),
      ).toMatchObject({ legacyParentSessionPath: parent });
    }
    expect(
      await metadataFromLegacyV3Header(
        env,
        { ...header(), parentSession: join(directory, "missing") },
        context,
      ),
    ).toMatchObject({ legacyParentSessionPath: join(directory, "missing") });
  });
});
