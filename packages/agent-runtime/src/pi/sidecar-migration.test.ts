import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, value } from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it } from "vite-plus/test";
import { migrateLegacySidecar } from "./sidecar-migration";

/**
 * A sidecar exactly as pi-agent-core 0.84.3 wrote one.
 *
 * These are not invented bytes. They were produced by installing 0.84.3 beside
 * this checkout and running the calls this runtime used to make — `create`
 * with a metadata bag, `appendMessage` twice, `appendCustomEntry` once — and
 * copying the resulting file. Everything the migration keys off is here: the
 * `version: 4` header with no `v`, the application metadata bag, and entries
 * tagged with the `lane` that 0.85.0 replaced with branches.
 */
function legacySidecar(cwd: string, id: string): string {
  const createdAt = 1_788_646_281_478;
  return (
    [
      {
        kind: "header",
        version: 4,
        id,
        createdAt,
        cwd,
        metadata: { volliSessionId: "s1", volliThreadId: "t1", volliAttachmentId: "a1" },
      },
      {
        kind: "entry",
        lane: "main",
        type: "message",
        id: "entry-1",
        message: { role: "user", content: "work from before the upgrade", timestamp: createdAt },
        parentId: null,
        seq: 1,
        timestamp: createdAt,
      },
      {
        kind: "entry",
        lane: "main",
        type: "message",
        id: "entry-2",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", thinkingSignature: "sig-old" },
            { type: "text", text: "an answer from 0.84.3" },
          ],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-fable-5-1",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: createdAt,
        },
        parentId: "entry-1",
        seq: 2,
        timestamp: createdAt,
      },
      {
        kind: "entry",
        lane: "main",
        type: "custom",
        id: "entry-3",
        customType: "volli.observation.v1",
        data: { kind: "message-settled" },
        parentId: "entry-2",
        seq: 3,
        timestamp: createdAt,
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n"
  );
}

/** The session-directory name Pi derives from a workspace path, both versions alike. */
function sessionDirectoryName(cwd: string): string {
  return `--${cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")}--`;
}

interface Fixture {
  root: string;
  cwd: string;
  sessionsRoot: string;
  path: string;
  id: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "volli-sidecar-migration-"));
  const cwd = join(root, "worktree");
  const sessionsRoot = join(root, "sessions");
  const id = "01a073a0-5102-7f36-8090-562632afb0c7";
  mkdirSync(cwd, { recursive: true });
  const directory = join(sessionsRoot, sessionDirectoryName(cwd));
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `2026-09-05T22-11-21-478Z_${id}.jsonl`);
  writeFileSync(path, legacySidecar(cwd, id));
  return { root, cwd, sessionsRoot, path, id };
}

function repoFor(owned: Fixture): JsonlSessionRepo {
  return new JsonlSessionRepo({
    fileSystem: new NodeExecutionEnv({ cwd: owned.root }),
    sessionsRoot: owned.sessionsRoot,
  });
}

describe("migrating a sidecar written before the Pi 0.85.0 bump", () => {
  it("is the difference between an invisible session and a readable one", async () => {
    // The failure this exists to prevent, stated as the two measurements that
    // bracket it. 0.85.0 does not report an old sidecar as damaged: `list`
    // simply does not return it, so an upgraded attach reports that the
    // Session does not exist.
    const owned = fixture();
    const repo = repoFor(owned);

    expect(await repo.list({ cwd: owned.cwd }, BACKGROUND_CONTEXT)).toEqual([]);

    expect(await migrateLegacySidecar(owned.path)).toEqual({
      kind: "migrated",
      entries: 3,
      identity: { volliSessionId: "s1", volliThreadId: "t1", volliAttachmentId: "a1" },
    });

    const listed = await repo.list({ cwd: owned.cwd }, BACKGROUND_CONTEXT);
    expect(listed.map((candidate) => candidate.id)).toEqual([owned.id]);
  });

  it("carries the conversation across whole, signatures included", async () => {
    // The whole safety argument for touching a person's durable history: no
    // entry is added, removed or rewritten. A signed thinking block is the
    // sharpest thing to check, because it is the one payload whose value is
    // destroyed by a single changed byte.
    const owned = fixture();
    await migrateLegacySidecar(owned.path);
    const repo = repoFor(owned);
    const [candidate] = await repo.list({ cwd: owned.cwd }, BACKGROUND_CONTEXT);
    const session = await repo.open(candidate!, BACKGROUND_CONTEXT);
    const branch = await session.branch("main", BACKGROUND_CONTEXT);

    const entries = await branch!.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
    expect(entries.map((entry) => entry.type)).toEqual(["message", "message", "custom"]);
    expect(entries.map((entry) => entry.id)).toEqual(["entry-1", "entry-2", "entry-3"]);
    const assistant = entries[1] as { message: { content: unknown[] } };
    expect(assistant.message.content[0]).toEqual({
      type: "thinking",
      thinking: "",
      thinkingSignature: "sig-old",
    });

    // And the branch is a branch, not a museum: the Session can carry on.
    await branch!.appendMessage(
      { role: "user", content: "after the upgrade", timestamp: 1 },
      BACKGROUND_CONTEXT,
    );
    expect(await branch!.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT)).toHaveLength(4);
  });

  it("moves the attachment identity out of the header bag and into the value store", async () => {
    // 0.85.0 deleted the opaque `metadata` field the three binding ids lived
    // in. Losing them would not be cosmetic: the attach refuses a sidecar
    // whose identity it cannot read, so a migration that dropped them would
    // turn every recovered Session into a refused one.
    const owned = fixture();
    await migrateLegacySidecar(owned.path);
    const repo = repoFor(owned);
    const [candidate] = await repo.list({ cwd: owned.cwd }, BACKGROUND_CONTEXT);
    const session = await repo.open(candidate!, BACKGROUND_CONTEXT);

    expect((await session.getValue(value("volli.identity.v1"), BACKGROUND_CONTEXT))?.value).toEqual(
      { volliSessionId: "s1", volliThreadId: "t1", volliAttachmentId: "a1" },
    );
  });

  it("runs once and then leaves the file alone", async () => {
    // Idempotence is what makes it safe to attempt on every attach that finds
    // no candidate, which is the only place it can be attempted from.
    const owned = fixture();
    expect((await migrateLegacySidecar(owned.path)).kind).toBe("migrated");
    const afterFirst = readFileSync(owned.path, "utf8");

    expect(await migrateLegacySidecar(owned.path)).toEqual({
      kind: "skipped",
      reason: "current-format",
    });
    expect(readFileSync(owned.path, "utf8")).toBe(afterFirst);
  });

  it("anchors main at main's own last entry, never a sibling lane's", async () => {
    // 0.84.3 could hold more than one lane in a file, and their entries are
    // interleaved by write order. A migration that took the last entry
    // regardless of lane would point `main` at an entry that was never on it,
    // and the branch walk would follow that entry's parents into history this
    // Session had elided — the resurrection the branch-not-file read exists to
    // prevent, arrived at from the other direction.
    const owned = fixture();
    const lines = readFileSync(owned.path, "utf8").trimEnd().split("\n");
    const sibling = JSON.stringify({
      kind: "entry",
      lane: "sibling",
      type: "custom",
      id: "sibling-entry",
      customType: "volli.observation.v1",
      data: { kind: "message-settled" },
      parentId: null,
      seq: 4,
      timestamp: 1_788_646_281_500,
    });
    // Written last, so file order and lane order disagree.
    writeFileSync(owned.path, `${[...lines, sibling].join("\n")}\n`);

    await migrateLegacySidecar(owned.path);
    const repo = repoFor(owned);
    const [candidate] = await repo.list({ cwd: owned.cwd }, BACKGROUND_CONTEXT);
    const session = await repo.open(candidate!, BACKGROUND_CONTEXT);
    const branch = await session.branch("main", BACKGROUND_CONTEXT);

    const entries = await branch!.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
    expect(entries.map((entry) => entry.id)).toEqual(["entry-1", "entry-2", "entry-3"]);
    expect(entries.map((entry) => entry.id)).not.toContain("sibling-entry");
  });

  it("does not touch a file it does not recognise", async () => {
    const owned = fixture();
    const foreign = join(owned.root, "not-a-session.jsonl");
    writeFileSync(foreign, `${JSON.stringify({ hello: "world" })}\n`);

    expect(await migrateLegacySidecar(foreign)).toEqual({
      kind: "skipped",
      reason: "unrecognized",
    });
    expect(readFileSync(foreign, "utf8")).toBe(`${JSON.stringify({ hello: "world" })}\n`);
  });

  it("reports a file that is not there rather than creating one", async () => {
    const owned = fixture();
    expect(await migrateLegacySidecar(join(owned.root, "absent.jsonl"))).toEqual({
      kind: "skipped",
      reason: "unrecognized",
    });
  });

  it("migrates a sidecar whose bag never held an identity, without inventing one", async () => {
    // A 0.84.3 sidecar written by something other than this runtime, or by a
    // build older than the identity binding. The history is still worth
    // rescuing; the identity is not something to guess, and the attach's own
    // check refuses what it cannot read.
    const owned = fixture();
    const lines = readFileSync(owned.path, "utf8").trimEnd().split("\n");
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    delete header["metadata"];
    writeFileSync(owned.path, [JSON.stringify(header), ...lines.slice(1)].join("\n") + "\n");

    expect(await migrateLegacySidecar(owned.path)).toEqual({
      kind: "migrated",
      entries: 3,
      identity: null,
    });
    const repo = repoFor(owned);
    const [candidate] = await repo.list({ cwd: owned.cwd }, BACKGROUND_CONTEXT);
    const session = await repo.open(candidate!, BACKGROUND_CONTEXT);
    expect(await session.getValue(value("volli.identity.v1"), BACKGROUND_CONTEXT)).toBeUndefined();
  });
});
