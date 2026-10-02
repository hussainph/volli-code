import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import type Database from "better-sqlite3";
import {
  createSessionEngine,
  createSessionRuntime,
  sessionRootThreadId,
  type HostNotice,
  type HostNoticeOutbox,
  type HostedSessionRuntime,
} from "@volli/session-engine";
import { DEFAULT_AUTHORITY_POLICY, sessionHostNoticeMetadata } from "@volli/shared";
import { readHostNotice } from "@volli/session-presentation";
import { protectionScript } from "../../../../../packages/agent-runtime/test-fixtures/protection-script";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { createSessionWakeBus } from "../session-wake";
import { insertProject } from "../db/projects-repo";
import { buildBackupDataDocument } from "../backup/data-document";
import { openRawDb, openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { createFileTranscriptArtifactStore } from "./transcript-artifacts";
import { createPiNativeAdapter } from "./pi-adapter";
import { createHostNoticeDelivery } from "./durable-host-notice-delivery";
import { createSqliteHostNoticeOutbox } from "./sqlite-host-notice-outbox";
import type { HostNoticeDelivery } from "./host-notice-delivery";

let db: TestDb | undefined;
let clock = 1000;
const runtimes: HostedSessionRuntime[] = [];
const deliveries: HostNoticeDelivery[] = [];
const reopened: Database.Database[] = [];
afterEach(async () => {
  for (const delivery of deliveries.splice(0)) delivery.close();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const handle of reopened.splice(0)) handle.close();
  db?.cleanup();
  db = undefined;
});

function setup() {
  db = openTestDb();
  insertProject(db.db, testProject({ id: "project" }));
  const directory = join(dirname(db.dbPath), "workspace");
  mkdirSync(directory);
  return { directory, dbPath: db.dbPath };
}
function launch(
  handle: Database.Database,
  directory: string,
  outboxOverride?: (outbox: HostNoticeOutbox) => HostNoticeOutbox,
) {
  const writer = createSqliteSessionLedger(handle);
  const wakeBus = createSessionWakeBus(
    createSessionEngine({
      ledger: writer,
      clock: { now: () => clock++ },
      ids: { next: (kind) => `${kind}-${clock++}` },
    }),
    { db: handle },
  );
  const engine = wakeBus.engine;
  const script = protectionScript([{ text: "I read the shell notice." }]);
  const executor = createPiNativeAdapter({
    sessionDataDir: join(dirname(directory), "pi"),
    models: script.models,
    now: () => clock++,
    usageLimits: {
      fetch: async () => {
        throw new Error("fixture has no network");
      },
    },
    resolveRuntimeContext: async (sessionId) => ({
      role: "project",
      location: "main-checkout",
      projectId: "project",
      ticketId: null,
      rootThreadId: sessionRootThreadId(sessionId),
      brief: "Legacy frozen Session",
      authorityPolicy: { ...DEFAULT_AUTHORITY_POLICY, enforcement: "off" },
      priorAuthorityDenials: 0,
      model: { providerId: "protection-fixture", modelId: "scripted", reasoningLevel: "off" },
      // A pre-shell frozen surface. The notice is content, not a new tool or
      // prompt mutation; a reconstructed Pi adapter must still accept it.
      toolSurface: ["read"],
      promptResources: [],
    }),
  });
  const venue = { id: "local", kind: "local" as const };
  const runtime = createSessionRuntime({
    engine,
    executor,
    artifacts: createFileTranscriptArtifactStore(join(dirname(directory), "transcripts")),
    locations: {
      resolve: async () => ({ directory, venue }),
      prepare: async () => ({ directory, venue }),
      reaffirm: async () => undefined,
    },
    clock: { now: () => clock++ },
    ids: { next: (kind) => `rt-${kind}-${clock++}` },
  });
  runtimes.push(runtime);
  const reports: string[] = [];
  const outbox = createSqliteHostNoticeOutbox(handle, writer);
  const delivery = createHostNoticeDelivery({
    runtime,
    outbox: outboxOverride?.(outbox) ?? outbox,
    subscribeEvents: (listener) => wakeBus.subscribe(({ event }) => listener(event)),
    report: (message) => reports.push(message),
  });
  deliveries.push(delivery);
  return { writer, engine, runtime, delivery, outbox, reports, script };
}
async function create(f: ReturnType<typeof launch>) {
  return (
    await f.runtime.command({
      commandId: `create-${clock++}`,
      command: {
        kind: "session.create",
        projectId: "project",
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: "Reader",
      },
    })
  ).sessionId;
}
async function attach(f: ReturnType<typeof launch>, sessionId: string) {
  const result = await f.runtime.command({
    commandId: `attach-${clock++}`,
    sessionId,
    command: { kind: "adapter.attach", continuity: "fresh" },
  });
  expect(result.receipt?.status, JSON.stringify(result.receipt)).toBe("accepted");
}
function notice(sessionId: string): HostNotice {
  return {
    sessionId,
    commandId: `shell:${sessionId}:shell:exit`,
    messageId: `shell:${sessionId}:shell:exit:message`,
    text: "[Volli: shell exited]\n<untrusted-shell-output id=original-nonce>\nsanitized output\n</untrusted-shell-output>",
    label: "shell exit notice",
    metadata: sessionHostNoticeMetadata({
      kind: "background-shell",
      event: "exited",
      shellId: "shell",
      label: "Tests",
      code: 0,
      signal: null,
      runtimeMs: 500,
      byPerson: false,
    }),
  };
}
async function reconstruct(f: ReturnType<typeof launch>, paths: ReturnType<typeof setup>) {
  f.delivery.close();
  await f.runtime.close();
  db!.db.close();
  const handle = openRawDb(paths.dbPath);
  reopened.push(handle);
  handle.pragma("foreign_keys = ON");
  return launch(handle, paths.directory);
}

describe("SQLite host notice outbox", () => {
  it("keeps the first complete payload, commits it independently of a failed Session transaction, and retains terminal ids", async () => {
    const paths = setup();
    const f = launch(db!.db, paths.directory);
    const sessionId = await create(f);
    const value = notice(sessionId);
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const failedTransaction = f.writer.transaction(async () => {
      entered.resolve();
      await gate.promise;
      throw new Error("rollback unrelated write");
    });
    const failure = expect(failedTransaction).rejects.toThrow("rollback unrelated write");
    await entered.promise;
    const put = f.outbox.put(value);
    expect(db!.db.prepare("SELECT * FROM host_notice_outbox").all()).toEqual([]);
    gate.resolve();
    await failure;
    expect(await put).toEqual(value);
    const bundle = buildBackupDataDocument(db!.db, { appVersion: "test", now: clock });
    expect(bundle.tables.host_notice_outbox).toEqual({
      columns: ["ordinal", "command_id", "session_id", "notice", "receipt"],
      rows: [[1, value.commandId, value.sessionId, JSON.stringify(value), null]],
    });
    const disk = openRawDb(paths.dbPath);
    try {
      expect(disk.prepare("SELECT notice FROM host_notice_outbox").get()).toEqual({
        notice: JSON.stringify(value),
      });
    } finally {
      disk.close();
    }
    expect(
      await f.outbox.put({
        ...value,
        text: "different nonce",
        metadata: sessionHostNoticeMetadata({ kind: "watch", events: [] }),
      }),
    ).toEqual(value);
    await f.outbox.settle(value.commandId, { status: "accepted" });
    await f.outbox.settle(value.commandId, { status: "dropped", reason: "reader-stopped" });
    expect(await f.outbox.put(value)).toBeNull();
    expect(await f.outbox.pending()).toEqual([]);
    expect(db!.db.prepare("SELECT notice, receipt FROM host_notice_outbox").get()).toEqual({
      notice: null,
      receipt: '{"status":"accepted"}',
    });
  });

  it("keeps arrival order across storage reconstruction, rather than sorting an exit before its match", async () => {
    const paths = setup();
    const first = launch(db!.db, paths.directory);
    const sessionId = await create(first);
    const exit = notice(sessionId);
    const match: HostNotice = {
      ...exit,
      commandId: exit.commandId.replace(/:exit$/, ":match"),
      messageId: exit.messageId.replace(/:exit:message$/, ":match:message"),
      metadata: sessionHostNoticeMetadata({
        kind: "background-shell",
        event: "matched",
        shellId: "shell",
        label: "Tests",
        pattern: "ready",
        regex: false,
      }),
    };
    await first.outbox.put(match);
    await first.outbox.put(exit);
    await first.outbox.put({ ...match, text: "regenerated" });
    const second = await reconstruct(first, paths);
    expect(await second.outbox.pending()).toEqual([match, exit]);
  });

  it("rejects a command id reused by another Session", async () => {
    const paths = setup();
    const f = launch(db!.db, paths.directory);
    const first = await create(f);
    const second = await create(f);
    const value = notice(first);
    await f.outbox.put(value);
    await expect(f.outbox.put({ ...value, sessionId: second })).rejects.toThrow(
      "different Session",
    );
    expect(await f.outbox.pending()).toEqual([value]);
  });

  it("reconstructs storage, Engine, Runtime and Pi before delivering a parked notice to an idle legacy frozen Session", async () => {
    const paths = setup();
    const first = launch(db!.db, paths.directory);
    const sessionId = await create(first);
    const value = notice(sessionId);
    expect(await first.delivery.deliver(value)).toBe("parked");
    const second = await reconstruct(first, paths);
    await second.delivery.recover();
    expect(second.script.requests).toEqual([]);
    await attach(second, sessionId);
    await vi.waitFor(async () => expect(await second.outbox.pending()).toEqual([]));
    expect(second.reports).toEqual([]);
    expect(second.script.requests).toHaveLength(1);
    const snapshot = await second.runtime.snapshot({ sessionId });
    const notices = snapshot.transcript.filter(({ message }) => readHostNotice(message) !== null);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message.metadata).toEqual(value.metadata);
    expect(notices[0]!.message.parts).toEqual([{ type: "text", text: value.text }]);
    expect(await second.delivery.deliver({ ...value, text: "a new nonce" })).toBe(
      "already-settled",
    );
    expect(second.script.requests).toHaveLength(1);
  });

  it("recovers the same payload after failed live delivery with a genuinely rebuilt runtime", async () => {
    const paths = setup();
    const first = launch(db!.db, paths.directory);
    const sessionId = await create(first);
    await attach(first, sessionId);
    const value = notice(sessionId);
    const broken = createHostNoticeDelivery({
      runtime: {
        projection: (input) => first.runtime.projection(input),
        subscribe: (...args) => first.runtime.subscribe(...args),
        command: async () => {
          throw new Error("host disconnected");
        },
      },
      outbox: first.outbox,
      report: (message) => first.reports.push(message),
    });
    deliveries.push(broken);
    await broken.deliver(value);
    await vi.waitFor(() =>
      expect(first.reports).toEqual([expect.stringContaining("host disconnected")]),
    );
    broken.close();
    expect(await first.outbox.pending()).toEqual([value]);
    const second = await reconstruct(first, paths);
    await second.delivery.recover();
    await vi.waitFor(async () => expect(await second.outbox.pending()).toEqual([]));
    const snapshot = await second.runtime.snapshot({ sessionId });
    const submitted = snapshot.transcript.filter(({ message }) => readHostNotice(message) !== null);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.message.parts).toEqual([{ type: "text", text: value.text }]);
    expect(second.script.requests).toHaveLength(1);
  });

  it("recovery cleans up a previously accepted command without issuing a second provider request", async () => {
    const paths = setup();
    const first = launch(db!.db, paths.directory, (outbox) => ({
      ...outbox,
      settle: async () => {
        throw new Error("cleanup interrupted");
      },
    }));
    const sessionId = await create(first);
    await attach(first, sessionId);
    const value = notice(sessionId);
    await first.delivery.deliver(value);
    await vi.waitFor(() =>
      expect(first.reports).toEqual([expect.stringContaining("cleanup interrupted")]),
    );
    expect(await first.outbox.pending()).toEqual([value]);
    const second = await reconstruct(first, paths);
    await second.delivery.recover();
    expect(await second.outbox.pending()).toEqual([]);
    expect(second.script.requests).toEqual([]);
    const snapshot = await second.runtime.snapshot({ sessionId });
    expect(
      snapshot.transcript.filter(({ message }) => readHostNotice(message) !== null),
    ).toHaveLength(1);
  });

  it("a direct Engine stop drops a parked reader immediately, without waiting for another runtime frame", async () => {
    const paths = setup();
    const f = launch(db!.db, paths.directory);
    const sessionId = await create(f);
    const value = notice(sessionId);
    await f.delivery.deliver(value);
    await f.engine.submit({
      commandId: `stop-${clock++}`,
      sessionId,
      provenance: {
        source: { kind: "system", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
      intent: { kind: "session.stop", reason: null, by: { kind: "user" } },
    });
    await vi.waitFor(async () => expect(await f.outbox.pending()).toEqual([]));
    expect(f.reports).toEqual([expect.stringContaining("is stopped")]);
    expect(f.script.requests).toEqual([]);
  });

  it("a stop committed while the host is absent durably drops the recovered notice", async () => {
    const paths = setup();
    const first = launch(db!.db, paths.directory);
    const sessionId = await create(first);
    const value = notice(sessionId);
    await first.outbox.put(value);
    await first.engine.submit({
      commandId: `stop-${clock++}`,
      sessionId,
      provenance: {
        source: { kind: "system", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
      intent: { kind: "session.stop", reason: null, by: { kind: "user" } },
    });
    const second = await reconstruct(first, paths);
    await second.delivery.recover();
    expect(await second.outbox.pending()).toEqual([]);
    expect(second.reports).toEqual([expect.stringContaining("is stopped")]);
    expect(second.script.requests).toEqual([]);
    expect(await second.delivery.deliver(value)).toBe("already-settled");
  });
});
