import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createSessionEngine,
  createSessionRuntime,
  sessionRootThreadId,
  type NativeAttachmentSpec,
} from "@volli/session-engine";
import type { SessionAttentionKind, SessionInteractionPrompt } from "@volli/shared";
import {
  scriptedProvider,
  type ScriptedReply,
} from "../../../agent-runtime/test-fixtures/scripted-provider";
import { insertProject } from "../db/projects-repo";
import { createSqliteSessionFollowUpLedger } from "../db/session-follow-up-repo";
import { openRawDb, openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { closeStaleAttachments } from "./boot-recovery";
import { createPiNativeAdapter } from "./pi-adapter";
import { createFileTranscriptArtifactStore } from "./transcript-artifacts";

let db: TestDb | undefined;
let clock = 10_000;
const hosts = new Set<ReturnType<typeof createSessionRuntime>>();
afterEach(async () => {
  for (const host of hosts) await host.close();
  hosts.clear();
  db?.cleanup();
  db = undefined;
});

const QUESTION = "Which implementation should continue?";
const OPTIONS = [{ id: "first", label: "First implementation" }];
const provenance = { source: { kind: "system" as const, id: "test", detail: null }, venue: null };

function fixture() {
  const database = openTestDb();
  db = database;
  const root = dirname(database.dbPath);
  const directory = join(root, "workspace");
  const sessionDataDir = join(root, "pi");
  mkdirSync(directory);
  insertProject(database.db, testProject({ id: "project", path: directory }));
  const replies: ScriptedReply[] = [
    { tool: { name: "ask_user", args: { question: QUESTION, options: OPTIONS } } },
    { text: "The next message opened a new turn." },
  ];
  const script = scriptedProvider(replies);
  const venue = { id: "local", kind: "local" as const };
  const artifacts = createFileTranscriptArtifactStore(join(root, "transcripts"));

  function launch() {
    const engine = createSessionEngine({
      ledger: createSqliteSessionLedger(database.db),
      clock: { now: () => clock++ },
      ids: { next: (kind) => `${kind}-${clock++}` },
    });
    const attachSpecs: NativeAttachmentSpec[] = [];
    const failures: unknown[] = [];
    const control: { attachFailure: Error | null } = { attachFailure: null };
    const adapter = createPiNativeAdapter({
      sessionDataDir,
      models: script.models,
      usageLimits: { fetch: async () => { throw new Error("Fixture has no network"); } },
      now: () => clock++,
      resolveRuntimeContext: async (sessionId) => ({
        role: "project",
        projectId: "project",
        ticketId: null,
        rootThreadId: sessionRootThreadId(sessionId),
        brief: "Crash recovery regression fixture",
        model: { providerId: "scripted-fixture", modelId: "scripted", reasoningLevel: "off" },
        toolSurface: ["read", "edit", "write", "execute", "ask_user"],
        promptResources: [],
      }),
    });
    const host = createSessionRuntime({
      engine,
      executor: {
        ...adapter,
        attach: async (spec, sink) => {
          attachSpecs.push(spec);
          if (control.attachFailure) throw control.attachFailure;
          return adapter.attach(spec, sink);
        },
      },
      followUps: createSqliteSessionFollowUpLedger(database.db),
      // Explicit recovery wakes exercise retry; no background backoff races.
      followUpRetryDelaysMs: [],
      onFollowUpFailure: (error) => { failures.push(error); },
      artifacts,
      locations: {
        resolve: async () => ({ directory, venue }),
        prepare: async () => ({ directory, venue }),
        reaffirm: async () => undefined,
      },
      clock: { now: () => clock++ },
      ids: { next: (kind) => `runtime-${kind}-${clock++}` },
    });
    hosts.add(host);
    return { engine, host, attachSpecs, failures, control };
  }

  async function restart(prior: ReturnType<typeof launch>, crash = false) {
    // Freeze the bytes that survived the process, then dispose live resources.
    // Restoring those bytes excludes graceful-shutdown cancellations and tool
    // results: a relaunch must recover the lost promise, not our close().
    database.db.pragma("wal_checkpoint(TRUNCATE)");
    const ledger = crash ? readFileSync(database.dbPath) : null;
    const sidecars = new Map<string, Buffer>();
    if (crash) {
      for (const entry of readdirSync(sessionDataDir, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
          const path = join(entry.parentPath, entry.name);
          sidecars.set(path, readFileSync(path));
        }
      }
    }
    await prior.host.close();
    hosts.delete(prior.host);
    database.db.close();
    if (ledger) {
      rmSync(`${database.dbPath}-wal`, { force: true });
      rmSync(`${database.dbPath}-shm`, { force: true });
      writeFileSync(database.dbPath, ledger);
      for (const [path, bytes] of sidecars) writeFileSync(path, bytes);
    }
    database.db = openRawDb(database.dbPath);
    database.db.pragma("foreign_keys = ON");
    return launch();
  }

  async function boot(current: ReturnType<typeof launch>) {
    const errors: unknown[] = [];
    const closed = await closeStaleAttachments({
      engine: current.engine,
      reconcile: (input) => current.host.reconcile(input),
      projectIds: ["project"],
      newId: () => `boot-${clock++}`,
      now: () => clock++,
      onError: (_id, error) => { errors.push(error); },
    });
    return { closed, errors };
  }

  return { ...launch(), launch, restart, boot, database, script, replies, sessionDataDir };
}

type Host = ReturnType<typeof fixture>;
type Launch = ReturnType<Host["launch"]>;

async function start(f: Host) {
  const { sessionId } = await f.host.command({
    commandId: `create-${clock++}`,
    command: {
      kind: "session.create",
      projectId: "project",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Crash recovery",
    },
  });
  await f.engine.getOrRecordSessionInput({
    sessionId,
    input: { kind: "tool-surface", tools: ["read", "edit", "write", "execute", "ask_user"] },
    provenance,
  });
  const attached = await f.host.command({
    sessionId,
    commandId: `attach-${clock++}`,
    command: { kind: "adapter.attach", continuity: "fresh" },
  });
  expect(attached.receipt?.status).toBe("accepted");
  const commandId = `submit-${clock++}`;
  const result = await f.host.command({
    sessionId,
    commandId,
    command: {
      kind: "message.submit",
      settle: "opened",
      message: { id: "initial-message", role: "user", parts: [{ type: "text", text: "Ask before proceeding" }] },
    },
  });
  expect(result.receipt?.status).toBe("accepted");
  await expect.poll(async () => (await f.host.projection({ sessionId })).projection.interactions.active.length).toBe(1);
  const projection = (await f.host.projection({ sessionId })).projection;
  expect(projection.turnActive).toBe(true);
  return { sessionId, commandId, attachmentId: projection.liveExecutor!.id, interaction: projection.interactions.active[0]! };
}

async function queue(current: Launch, sessionId: string, commandId = "queue-next") {
  const result = await current.host.command({
    commandId,
    sessionId,
    command: {
      kind: "message.submit",
      delivery: "queue",
      message: { id: "next-message", role: "user", parts: [{ type: "text", text: "Continue after restart" }] },
    },
  });
  expect(result.receipt?.status).toBe("accepted");
  await current.host.recoverFollowUps();
}

async function raise(current: Launch, sessionId: string, kind: Extract<SessionAttentionKind, "partial_turn_interrupted" | "auth_required" | "permission_required" | "configuration_invalid" | "adapter_unrecoverable">, id = "blocker", attachmentId: string | null = null) {
  await current.engine.observe({
    id: `raise-${clock++}`,
    sessionId,
    occurredAt: clock++,
    provenance,
    kind: "attention.raised",
    attention: kind === "adapter_unrecoverable"
      ? { id, kind, attachmentId, detail: `Unresolved ${kind}`, diagnostic: null, resetsAt: null }
      : { id, kind, attachmentId, detail: `Unresolved ${kind}`, diagnostic: null },
  });
}

async function assertDeliveredOnce(f: Host, current: Launch, sessionId: string) {
  await current.host.recoverFollowUps();
  const projection = (await current.host.projection({ sessionId })).projection;
  expect(projection.queue).toEqual([]);
  expect(projection.interactions.active).toEqual([]);
  expect(projection.attention.active.filter(({ kind }) => kind === "partial_turn_interrupted")).toEqual([]);
  const events = await current.engine.listEvents({ sessionId });
  expect(events.filter(({ payload }) => payload.kind === "turn.started")).toHaveLength(2);
  expect(events.filter(({ payload }) => payload.kind === "command.recorded" && payload.command.intent.kind === "message.submit")).toHaveLength(2);
  expect(f.script.requests.filter((request) => JSON.stringify(request).includes("Continue after restart"))).toHaveLength(1);
}

async function assertNoAnswers(current: Launch, sessionId: string) {
  const events = await current.engine.listEvents({ sessionId });
  expect(events.filter(({ payload }) => payload.kind === "interaction.resolved")).toEqual([]);
}

// The provider alone is scripted. Session admission, SQLite events/queue,
// Pi sidecars, boot recovery and the adapter's parked ask are production code.
describe("crash recovery through the durable Pi binding (VC-753)", () => {
  it("reconciles an accepted command with a different persisted timestamp without a false recovery failure", async () => {
    const f = fixture();
    const { sessionId, commandId } = await start(f);
    // Pre-fix builds recorded wall-clock acceptance after Pi's marker. Keep
    // that historical fact; recovery must reconcile it, not rewrite it.
    const row = f.database.db.prepare("SELECT id, payload FROM session_events WHERE session_id = ? AND json_extract(payload, '$.kind') = 'command.receipt.recorded' AND json_extract(payload, '$.receipt.commandId') = ?").get(sessionId, commandId) as { id: string; payload: string };
    const payload = JSON.parse(row.payload);
    payload.receipt.acceptedAt += 5_000;
    f.database.db.prepare("UPDATE session_events SET payload = ? WHERE id = ?").run(JSON.stringify(payload), row.id);
    f.database.db.prepare("UPDATE session_command_receipts SET receipt = ? WHERE command_id = ?").run(JSON.stringify(payload.receipt), commandId);
    f.database.db.prepare("DELETE FROM session_projection_checkpoints WHERE session_id = ?").run(sessionId);
    const current = await f.restart(f, true);
    expect(await f.boot(current)).toEqual({ closed: 0, errors: [] });
    expect((await current.host.projection({ sessionId })).projection.liveExecutor).not.toBeNull();
    const events = await current.engine.listEvents({ sessionId });
    expect(events.filter(({ payload }) => payload.kind === "command.receipt.recorded" && payload.receipt.commandId === commandId)).toHaveLength(1);
    await current.host.reconcile({ sessionId, attachmentId: (await current.host.projection({ sessionId })).projection.liveExecutor!.id });
    expect((await current.host.projection({ sessionId })).projection.attention.active.some(({ detail }) => detail?.includes("terminal receipt"))).toBe(false);
  });

  it("abandons a pending flat ask durably, supplies a failed tool result, and delivers the queued follow-up once", async () => {
    const f = fixture();
    const { sessionId, interaction } = await start(f);
    await queue(f, sessionId);
    expect((await f.host.projection({ sessionId })).projection.queue).toHaveLength(1);
    const current = await f.restart(f, true);
    expect(await f.boot(current)).toEqual({ closed: 0, errors: [] });
    const recovered = (await current.host.projection({ sessionId })).projection;
    expect(recovered.interactions.active).toEqual([]);
    const events = await current.engine.listEvents({ sessionId });
    expect(events.map(({ payload }) => payload)).toContainEqual(expect.objectContaining({ kind: "interaction.cancelled", interactionId: interaction.id, reason: "abandoned" }));
    expect(events.map(({ payload }) => payload)).toContainEqual(expect.objectContaining({ kind: "interaction.opened", interaction: expect.objectContaining({ title: QUESTION }) }));
    await assertNoAnswers(current, sessionId);
    // A second launch must read the cancellation, not reopen the card.
    const relaunched = await f.restart(current);
    expect(await f.boot(relaunched)).toEqual({ closed: 0, errors: [] });
    await assertDeliveredOnce(f, relaunched, sessionId);
    await assertNoAnswers(relaunched, sessionId);
    const results = f.script.requests.at(-1)!.filter((message) => message.role === "toolResult" && message.toolName === "ask_user");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: true });
    expect(JSON.stringify(results[0])).toContain("No answer was obtained");
    expect(JSON.stringify(results[0])).not.toContain("Chose:");
  });

  it("abandons every prompt of a persisted questions ask without inventing answers", async () => {
    const f = fixture();
    const { sessionId, interaction } = await start(f);
    // A multi-question card is existing durable vocabulary. Seed that history
    // rather than make this regression depend on today's ask_user schema: an
    // older/newer writer's card must recover on the same path as a flat ask.
    const prompts: SessionInteractionPrompt[] = [
      { id: "implementation", label: QUESTION, detail: null, options: OPTIONS.map((option) => ({ ...option, description: null })), multiple: false, custom: true },
      { id: "verification", label: "Which verification should run?", detail: null, options: [{ id: "focused", label: "Focused tests", description: null }], multiple: false, custom: true },
    ];
    const row = f.database.db.prepare("SELECT id, payload FROM session_events WHERE session_id = ? AND json_extract(payload, '$.kind') = 'interaction.opened'").get(sessionId) as { id: string; payload: string };
    const payload = JSON.parse(row.payload);
    payload.interaction.prompts = prompts;
    f.database.db.prepare("UPDATE session_events SET payload = ? WHERE id = ?").run(JSON.stringify(payload), row.id);
    f.database.db.prepare("DELETE FROM session_projection_checkpoints WHERE session_id = ?").run(sessionId);
    await queue(f, sessionId);
    const current = await f.restart(f, true);
    expect(await f.boot(current)).toEqual({ closed: 0, errors: [] });
    const events = await current.engine.listEvents({ sessionId });
    expect(events.map(({ payload }) => payload)).toContainEqual(expect.objectContaining({ kind: "interaction.opened", interaction: expect.objectContaining({ prompts }) }));
    expect(events.map(({ payload }) => payload)).toContainEqual(expect.objectContaining({ kind: "interaction.cancelled", interactionId: interaction.id, reason: "abandoned" }));
    const relaunched = await f.restart(current);
    await f.boot(relaunched);
    await assertDeliveredOnce(f, relaunched, sessionId);
    await assertNoAnswers(relaunched, sessionId);
  });

  it("a cancelled ask plus only the obsolete boot warning admits the next queued message", async () => {
    const f = fixture();
    const { sessionId, interaction, attachmentId } = await start(f);
    await f.host.cancelInteraction({ sessionId, interactionId: interaction.id, reason: "withdrawn" });
    await expect.poll(async () => (await f.host.projection({ sessionId })).projection.turnActive).toBe(false);
    const current = await f.restart(f);
    await raise(current, sessionId, "partial_turn_interrupted", `${attachmentId}:boot-recovery`, attachmentId);
    await current.engine.observe({
      id: `closed-${clock++}`, sessionId, attachmentId, occurredAt: clock++, provenance,
      kind: "attachment.closed", outcome: "interrupted",
    });
    await queue(current, sessionId);
    await assertDeliveredOnce(f, current, sessionId);
    await assertNoAnswers(current, sessionId);
    const relaunched = await f.restart(current);
    const events = await relaunched.engine.listEvents({ sessionId });
    expect(events.map(({ payload }) => payload)).toContainEqual(expect.objectContaining({ kind: "interaction.cancelled", interactionId: interaction.id, reason: "withdrawn" }));
  });

  it("keeps a failed attach visible and retryable without dropping or duplicating the message", async () => {
    const f = fixture();
    const { sessionId } = await start(f);
    const current = await f.restart(f, true);
    await f.boot(current);
    // A closed interrupted binding needs a fresh context-replay attach.
    const attachmentId = (await current.host.projection({ sessionId })).projection.liveExecutor!.id;
    const released = await current.host.command({ commandId: "release-recovered", sessionId, command: { kind: "adapter.release", attachmentId } });
    expect(released.receipt?.status).toBe("completed");
    current.control.attachFailure = new Error("Scripted attach unavailable");
    await queue(current, sessionId);
    const projection = (await current.host.projection({ sessionId })).projection;
    expect(projection.queue).toHaveLength(1);
    expect(projection.queue![0]!.message.parts).toEqual([{ type: "text", text: "Continue after restart" }]);
    expect(projection.attention.active).toContainEqual(expect.objectContaining({ kind: "adapter_unrecoverable", detail: expect.stringContaining("Scripted attach unavailable") }));
    expect(f.script.requests).toHaveLength(1);
    current.control.attachFailure = null;
    // Successful explicit attachment is the existing recovery action and
    // clears genuine attach failure Attention; queue recovery then sends once.
    const attached = await current.host.command({ commandId: "retry-attach", sessionId, command: { kind: "adapter.attach", continuity: "context_replay" } });
    expect(attached.receipt?.status).toBe("accepted");
    await assertDeliveredOnce(f, current, sessionId);
  });

  it.each(["auth_required", "permission_required", "configuration_invalid", "adapter_unrecoverable"] as const)(
    "does not bypass a genuine %s blocker to deliver a recovered queued message",
    async (kind) => {
      const f = fixture();
      const { sessionId } = await start(f);
      const current = await f.restart(f, true);
      await f.boot(current);
      await raise(current, sessionId, kind);
      await queue(current, sessionId);
      const projection = (await current.host.projection({ sessionId })).projection;
      expect(projection.queue).toHaveLength(1);
      expect(projection.queue![0]!.state).toBe("queued");
      expect(projection.attention.active).toContainEqual(expect.objectContaining({ id: "blocker", kind }));
      expect(f.script.requests).toHaveLength(1);
      await assertNoAnswers(current, sessionId);
    },
  );

  it("keeps a live human wait unbounded rather than admitting a queued message", async () => {
    const f = fixture();
    const { sessionId, interaction } = await start(f);
    await queue(f, sessionId);
    clock += 24 * 60 * 60 * 1_000;
    await f.host.recoverFollowUps();
    const projection = (await f.host.projection({ sessionId })).projection;
    expect(projection.interactions.active[0]?.id).toBe(interaction.id);
    expect(projection.queue).toHaveLength(1);
    expect(f.script.requests).toHaveLength(1);
    await assertNoAnswers(f, sessionId);
  });
});
