import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createSessionEngine,
  createSessionRuntime,
  sessionRootThreadId,
  type NativeAttachmentSpec,
} from "@volli/session-engine";
import {
  RECOVERED_TURN_INTERRUPTED_DETAIL,
  restartResumeCommandId,
  type SessionAttentionKind,
  type SessionInteractionPrompt,
} from "@volli/shared";
import {
  scriptedProvider,
  type ScriptedReply,
} from "../../../agent-runtime/test-fixtures/scripted-provider";
import { insertProject } from "../db/projects-repo";
import { createSqliteSessionFollowUpLedger } from "../db/session-follow-up-repo";
import { openRawDb, openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { closeStaleAttachments, type BootRecoveredTurns } from "./boot-recovery";
import { resumeRecoveredTurns } from "./restart-resume";
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
// The runtime's queue admission bound covers EVERY attach (its workspace and
// executor stages) and every cold binding rebuild, not only queued messages.
// A short wall-clock bound on all of them made a merely slow real Pi attach
// under CI load a false `rejected` (VC-778). Genuine work keeps the production
// bound; only a stage this fixture deliberately stalls gets the short one.
const PRODUCTION_ADMISSION_BOUND_MS = 30_000;
const STALLED_STAGE_BOUND_MS = 50;

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
    { text: "The interrupted question was not answered." },
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
    const control: {
      attachFailure: Error | null;
      attachGate: Promise<void> | null;
      admissionGate: Promise<void> | null;
      /** Real delay before every attach, to model a slow but healthy executor. */
      attachDelayMs: number;
      /** Set synchronously on entering a gate, before the runtime arms its timer. */
      stalled: boolean;
    } = {
      attachFailure: null,
      attachGate: null,
      admissionGate: null,
      attachDelayMs: 0,
      stalled: false,
    };
    const adapter = createPiNativeAdapter({
      sessionDataDir,
      models: script.models,
      usageLimits: {
        fetch: async () => {
          throw new Error("Fixture has no network");
        },
      },
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
          if (control.attachGate) {
            control.stalled = true;
            await control.attachGate;
          }
          if (control.attachDelayMs > 0)
            await new Promise((resolve) => setTimeout(resolve, control.attachDelayMs));
          if (control.attachFailure) throw control.attachFailure;
          const binding = await adapter.attach(spec, sink);
          const dispatch = binding.dispatch.bind(binding);
          binding.dispatch = async (command) => {
            if (command.kind === "message.submit" && control.admissionGate) {
              control.stalled = true;
              await control.admissionGate;
            }
            return dispatch(command);
          };
          return binding;
        },
      },
      followUps: createSqliteSessionFollowUpLedger(database.db),
      // Explicit recovery wakes exercise retry; no background backoff races.
      followUpRetryDelaysMs: [],
      // Read when each bounded stage arms its timer, which is after the
      // wrappers above have entered (and flagged) any gate synchronously.
      get followUpAdmissionTimeoutMs() {
        return control.stalled ? STALLED_STAGE_BOUND_MS : PRODUCTION_ADMISSION_BOUND_MS;
      },
      onFollowUpFailure: (error) => {
        failures.push(error);
      },
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

  async function boot(
    current: ReturnType<typeof launch>,
    onRecovered?: (recovered: BootRecoveredTurns) => void,
  ) {
    const errors: unknown[] = [];
    const closed = await closeStaleAttachments({
      engine: current.engine,
      reconcile: (input) => current.host.reconcile(input),
      projectIds: ["project"],
      newId: () => `boot-${clock++}`,
      now: () => clock++,
      onError: (_id, error) => {
        errors.push(error);
      },
      ...(onRecovered === undefined ? {} : { onRecovered }),
    });
    return { closed, errors };
  }

  return { ...launch(), launch, restart, boot, database, script, replies, sessionDataDir };
}

type Host = ReturnType<typeof fixture>;
type Launch = ReturnType<Host["launch"]>;

async function start(f: Host, settledPrefix = false) {
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
  expect(attached.receipt?.status, JSON.stringify(attached.receipt)).toBe("accepted");
  if (settledPrefix) {
    const settled = await f.host.command({
      sessionId,
      commandId: `prefix-${clock++}`,
      command: {
        kind: "message.submit",
        message: {
          id: "prefix-message",
          role: "user",
          parts: [{ type: "text", text: "Establish a settled reply before asking" }],
        },
      },
    });
    expect(settled.receipt?.status, JSON.stringify(settled.receipt)).toBe("accepted");
  }
  const commandId = `submit-${clock++}`;
  const result = await f.host.command({
    sessionId,
    commandId,
    command: {
      kind: "message.submit",
      settle: "opened",
      message: {
        id: "initial-message",
        role: "user",
        parts: [{ type: "text", text: "Ask before proceeding" }],
      },
    },
  });
  expect(result.receipt?.status, JSON.stringify(result.receipt)).toBe("accepted");
  await expect
    .poll(
      async () => (await f.host.projection({ sessionId })).projection.interactions.active.length,
    )
    .toBe(1);
  const projection = (await f.host.projection({ sessionId })).projection;
  expect(projection.turnActive).toBe(true);
  return {
    sessionId,
    commandId,
    attachmentId: projection.liveExecutor!.id,
    interaction: projection.interactions.active[0]!,
  };
}

async function queue(current: Launch, sessionId: string, commandId = "queue-next") {
  const result = await current.host.command({
    commandId,
    sessionId,
    command: {
      kind: "message.submit",
      delivery: "queue",
      message: {
        id: "next-message",
        role: "user",
        parts: [{ type: "text", text: "Continue after restart" }],
      },
    },
  });
  expect(result.receipt?.status, JSON.stringify(result.receipt)).toBe("accepted");
  await current.host.recoverFollowUps();
}

async function raise(
  current: Launch,
  sessionId: string,
  kind: Extract<
    SessionAttentionKind,
    | "partial_turn_interrupted"
    | "auth_required"
    | "permission_required"
    | "configuration_invalid"
    | "adapter_unrecoverable"
  >,
  id = "blocker",
  attachmentId: string | null = null,
) {
  await current.engine.observe({
    id: `raise-${clock++}`,
    sessionId,
    occurredAt: clock++,
    provenance,
    kind: "attention.raised",
    attention:
      kind === "adapter_unrecoverable"
        ? { id, kind, attachmentId, detail: `Unresolved ${kind}`, diagnostic: null, resetsAt: null }
        : { id, kind, attachmentId, detail: `Unresolved ${kind}`, diagnostic: null },
  });
}

async function assertDeliveredOnce(f: Host, current: Launch, sessionId: string) {
  await current.host.recoverFollowUps();
  const projection = (await current.host.projection({ sessionId })).projection;
  expect(projection.queue, JSON.stringify(projection.attention.active)).toEqual([]);
  expect(projection.interactions.active).toEqual([]);
  expect(
    projection.attention.active.filter(({ kind }) => kind === "partial_turn_interrupted"),
  ).toEqual([]);
  const events = await current.engine.listEvents({ sessionId });
  expect(events.filter(({ payload }) => payload.kind === "turn.started")).toHaveLength(2);
  expect(
    events.filter(
      ({ payload }) =>
        payload.kind === "command.recorded" && payload.command.intent.kind === "message.submit",
    ),
  ).toHaveLength(2);
  expect(
    f.script.requests.filter((request) =>
      JSON.stringify(request).includes("Continue after restart"),
    ),
  ).toHaveLength(1);
}

function assertFailedAskResult(f: Host) {
  const results: unknown[] = [];
  for (const entry of readdirSync(f.sessionDataDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(entry.parentPath, entry.name), "utf8")
      .trimEnd()
      .split("\n")) {
      const transaction = JSON.parse(line);
      for (const record of Array.isArray(transaction) ? transaction : [transaction]) {
        if (
          record.type === "message" &&
          record.message?.role === "toolResult" &&
          record.message.toolName === "ask_user"
        )
          results.push(record.message);
      }
    }
  }
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ isError: true });
  expect(JSON.stringify(results[0])).toContain("No answer was obtained");
  expect(JSON.stringify(results[0])).not.toContain("Chose:");
}

async function assertNoAnswers(current: Launch, sessionId: string) {
  const events = await current.engine.listEvents({ sessionId });
  expect(events.filter(({ payload }) => payload.kind === "interaction.resolved")).toEqual([]);
}

// The provider alone is scripted. Session admission, SQLite events/queue,
// Pi sidecars, boot recovery and the adapter's parked ask are production code.
describe("crash recovery through the durable Pi binding (VC-753)", () => {
  it("accepts a slow but healthy attach and recovers its binding without a false admission timeout (VC-778)", async () => {
    const f = fixture();
    // Longer than the stalled-stage bound: a fixture that bounded genuine
    // work by it rejected the fresh attach and failed the boot rebuild.
    const slow = STALLED_STAGE_BOUND_MS * 3;
    f.control.attachDelayMs = slow;
    const { sessionId } = await start(f);
    const current = await f.restart(f, true);
    current.control.attachDelayMs = slow;
    expect(await f.boot(current)).toEqual({ closed: 0, errors: [] });
    expect(current.attachSpecs.map(({ continuity }) => continuity)).toEqual(["native_resume"]);
    const recovered = (await current.host.projection({ sessionId })).projection;
    expect(recovered.liveExecutor).not.toBeNull();
    expect(
      recovered.attention.active.filter(({ kind }) => kind === "adapter_unrecoverable"),
    ).toEqual([]);
  });

  it("reconciles an accepted command with a different persisted timestamp without a false recovery failure", async () => {
    const f = fixture();
    const { sessionId, commandId } = await start(f);
    // Pre-fix builds recorded wall-clock acceptance after Pi's marker. Keep
    // that historical fact; recovery must reconcile it, not rewrite it.
    let changed = 0;
    for (const entry of readdirSync(f.sessionDataDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(entry.parentPath, entry.name);
      const lines = readFileSync(path, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => {
          const transaction = JSON.parse(line);
          for (const record of Array.isArray(transaction) ? transaction : [transaction]) {
            if (
              record.type === "custom" &&
              record.data?.kind === "command-accepted" &&
              record.data.commandId === commandId
            ) {
              record.timestamp -= 5_000;
              changed += 1;
            }
          }
          return JSON.stringify(transaction);
        });
      writeFileSync(path, `${lines.join("\n")}\n`);
    }
    expect(changed).toBe(1);
    const current = await f.restart(f, true);
    expect(await f.boot(current)).toEqual({ closed: 0, errors: [] });
    expect((await current.host.projection({ sessionId })).projection.liveExecutor).not.toBeNull();
    const events = await current.engine.listEvents({ sessionId });
    expect(
      events.filter(
        ({ payload }) =>
          payload.kind === "command.receipt.recorded" && payload.receipt.commandId === commandId,
      ),
    ).toHaveLength(1);
    await current.host.reconcile({
      sessionId,
      attachmentId: (await current.host.projection({ sessionId })).projection.liveExecutor!.id,
    });
    expect(
      (await current.host.projection({ sessionId })).projection.attention.active.some(
        ({ detail }) => detail?.includes("terminal receipt"),
      ),
    ).toBe(false);
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
    expect(events.map(({ payload }) => payload)).toContainEqual(
      expect.objectContaining({
        kind: "interaction.cancelled",
        interactionId: interaction.id,
        reason: "abandoned",
      }),
    );
    expect(events.map(({ payload }) => payload)).toContainEqual(
      expect.objectContaining({
        kind: "interaction.opened",
        interaction: expect.objectContaining({ title: QUESTION }),
      }),
    );
    await assertNoAnswers(current, sessionId);
    assertFailedAskResult(f);
    // A second launch must read the cancellation, not reopen the card.
    const relaunched = await f.restart(current);
    expect(await f.boot(relaunched)).toEqual({ closed: 0, errors: [] });
    assertFailedAskResult(f);
    await assertDeliveredOnce(f, relaunched, sessionId);
    await assertNoAnswers(relaunched, sessionId);
    const results = f.script.requests
      .at(-1)!
      .filter((message) => message.role === "toolResult" && message.toolName === "ask_user");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: true });
    expect(JSON.stringify(results[0])).toContain("No answer was obtained");
    expect(JSON.stringify(results[0])).not.toContain("Chose:");
  });

  it("keeps conflicting settled history blocking when the same recovery also interrupts an open turn", async () => {
    const f = fixture();
    f.replies.unshift({ text: "A settled reply before the pending question." });
    const { sessionId, attachmentId, interaction } = await start(f, true);
    let corrupted = 0;
    for (const entry of readdirSync(f.sessionDataDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(entry.parentPath, entry.name);
      const lines = readFileSync(path, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => {
          const transaction = JSON.parse(line);
          for (const record of Array.isArray(transaction) ? transaction : [transaction]) {
            if (record.type === "custom" && record.data?.kind === "message-settled") {
              record.data.message.entryId = "missing-settled-entry";
              corrupted += 1;
            }
          }
          return JSON.stringify(transaction);
        });
      writeFileSync(path, `${lines.join("\n")}\n`);
    }
    expect(corrupted).toBe(1);
    const current = await f.restart(f, true);
    expect(await f.boot(current)).toEqual({ closed: 0, errors: [] });
    const diagnostic = {
      id: `pi:attention:${attachmentId}:partial-turn`,
      kind: "partial_turn_interrupted",
      detail:
        "Pi recovery history disagreed about a settled assistant message; the incomplete turn was withheld.",
    };
    const recovered = (await current.host.projection({ sessionId })).projection;
    expect(recovered.turnActive).toBe(false);
    expect(recovered.interactions.active).toEqual([]);
    expect(recovered.attention.active).toContainEqual(expect.objectContaining(diagnostic));
    const events = await current.engine.listEvents({ sessionId });
    expect(events.map(({ payload }) => payload)).toContainEqual(
      expect.objectContaining({ kind: "turn.interrupted" }),
    );
    expect(events.map(({ payload }) => payload)).toContainEqual(
      expect.objectContaining({
        kind: "interaction.cancelled",
        interactionId: interaction.id,
        reason: "abandoned",
      }),
    );
    assertFailedAskResult(f);
    await queue(current, sessionId);
    const blocked = (await current.host.projection({ sessionId })).projection;
    expect(blocked.queue).toHaveLength(1);
    expect(blocked.queue![0]!.state).toBe("queued");
    expect(blocked.attention.active).toContainEqual(expect.objectContaining(diagnostic));
    expect(blocked.attention.active).toContainEqual(
      expect.objectContaining({
        kind: "adapter_unrecoverable",
        detail: expect.stringContaining("partial_turn_interrupted"),
      }),
    );
    expect(f.script.requests).toHaveLength(2);
    await assertNoAnswers(current, sessionId);
    // Repeated attachment/queue recovery must not downgrade the diagnostic either.
    const relaunched = await f.restart(current);
    expect(await f.boot(relaunched)).toEqual({ closed: 0, errors: [] });
    await relaunched.host.recoverFollowUps();
    const stillBlocked = (await relaunched.host.projection({ sessionId })).projection;
    expect(stillBlocked.queue).toHaveLength(1);
    expect(stillBlocked.attention.active).toContainEqual(expect.objectContaining(diagnostic));
    expect(f.script.requests).toHaveLength(2);
    assertFailedAskResult(f);
    await assertNoAnswers(relaunched, sessionId);
  });

  it("abandons every prompt of a persisted questions ask without inventing answers", async () => {
    const f = fixture();
    const { sessionId, interaction } = await start(f);
    // A multi-question card is existing durable vocabulary. Seed that history
    // rather than make this regression depend on today's ask_user schema: an
    // older/newer writer's card must recover on the same path as a flat ask.
    const prompts: SessionInteractionPrompt[] = [
      {
        id: "implementation",
        label: QUESTION,
        detail: null,
        options: OPTIONS.map((option) => ({
          id: option.id,
          label: option.label,
          description: null,
        })),
        multiple: false,
        custom: true,
      },
      {
        id: "verification",
        label: "Which verification should run?",
        detail: null,
        options: [{ id: "focused", label: "Focused tests", description: null }],
        multiple: false,
        custom: true,
      },
    ];
    const row = f.database.db
      .prepare(
        "SELECT id, payload FROM session_events WHERE session_id = ? AND json_extract(payload, '$.kind') = 'interaction.opened'",
      )
      .get(sessionId) as { id: string; payload: string };
    const persistedInteraction = JSON.parse(row.payload);
    persistedInteraction.interaction.prompts = prompts;
    for (const entry of readdirSync(f.sessionDataDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(entry.parentPath, entry.name);
      const lines = readFileSync(path, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => {
          const transaction = JSON.parse(line);
          for (const record of Array.isArray(transaction) ? transaction : [transaction]) {
            for (const block of record.message?.content ?? []) {
              if (block.type === "toolCall" && block.name === "ask_user") {
                block.arguments = {
                  questions: prompts.map((prompt) => ({
                    id: prompt.id,
                    question: prompt.label,
                    options: prompt.options,
                  })),
                };
              }
            }
          }
          return JSON.stringify(transaction);
        });
      writeFileSync(path, `${lines.join("\n")}\n`);
    }
    f.database.db
      .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
      .run(JSON.stringify(persistedInteraction), row.id);
    f.database.db
      .prepare("DELETE FROM session_projection_checkpoints WHERE session_id = ?")
      .run(sessionId);
    await queue(f, sessionId);
    const current = await f.restart(f, true);
    expect(await f.boot(current)).toEqual({ closed: 0, errors: [] });
    const events = await current.engine.listEvents({ sessionId });
    expect(events.map(({ payload }) => payload)).toContainEqual(
      expect.objectContaining({
        kind: "interaction.opened",
        interaction: expect.objectContaining({ prompts }),
      }),
    );
    expect(events.map(({ payload }) => payload)).toContainEqual(
      expect.objectContaining({
        kind: "interaction.cancelled",
        interactionId: interaction.id,
        reason: "abandoned",
      }),
    );
    assertFailedAskResult(f);
    const relaunched = await f.restart(current);
    await f.boot(relaunched);
    assertFailedAskResult(f);
    await assertDeliveredOnce(f, relaunched, sessionId);
    await assertNoAnswers(relaunched, sessionId);
  });

  it("a cancelled ask plus only the obsolete boot warning admits the next queued message", async () => {
    const f = fixture();
    const { sessionId, interaction, attachmentId } = await start(f);
    await f.host.cancelInteraction({
      sessionId,
      interactionId: interaction.id,
      reason: "withdrawn",
    });
    await expect
      .poll(async () => (await f.host.projection({ sessionId })).projection.turnActive)
      .toBe(false);
    const current = await f.restart(f);
    await raise(
      current,
      sessionId,
      "partial_turn_interrupted",
      `${attachmentId}:boot-recovery`,
      attachmentId,
    );
    await current.engine.observe({
      id: `closed-${clock++}`,
      sessionId,
      attachmentId,
      occurredAt: clock++,
      provenance,
      kind: "attachment.closed",
      outcome: "interrupted",
    });
    await queue(current, sessionId);
    await assertDeliveredOnce(f, current, sessionId);
    await assertNoAnswers(current, sessionId);
    const relaunched = await f.restart(current);
    const events = await relaunched.engine.listEvents({ sessionId });
    expect(events.map(({ payload }) => payload)).toContainEqual(
      expect.objectContaining({
        kind: "interaction.cancelled",
        interactionId: interaction.id,
        reason: "withdrawn",
      }),
    );
  });

  it("keeps a failed attach visible and retryable without dropping or duplicating the message", async () => {
    const f = fixture();
    const { sessionId, interaction } = await start(f);
    await f.host.cancelInteraction({
      sessionId,
      interactionId: interaction.id,
      reason: "withdrawn",
    });
    await expect
      .poll(async () => (await f.host.projection({ sessionId })).projection.turnActive)
      .toBe(false);
    const current = await f.restart(f);
    // A closed interrupted binding needs a fresh context-replay attach.
    const attachmentId = (await current.host.projection({ sessionId })).projection.liveExecutor!.id;
    const released = await current.host.command({
      commandId: "release-recovered",
      sessionId,
      command: { kind: "adapter.release", attachmentId },
    });
    expect(released.receipt?.status, JSON.stringify(released.receipt)).toBe("accepted");
    current.control.attachFailure = new Error("Scripted attach unavailable");
    await queue(current, sessionId);
    const projection = (await current.host.projection({ sessionId })).projection;
    expect(projection.queue).toHaveLength(1);
    expect(projection.queue![0]!.message.parts).toEqual([
      { type: "text", text: "Continue after restart" },
    ]);
    expect(projection.attention.active).toContainEqual(
      expect.objectContaining({
        kind: "adapter_unrecoverable",
        detail: expect.stringContaining("Scripted attach unavailable"),
      }),
    );
    expect(f.script.requests).toHaveLength(2);
    current.control.attachFailure = null;
    // Successful explicit attachment is the existing recovery action and
    // clears genuine attach failure Attention; queue recovery then sends once.
    const attached = await current.host.command({
      commandId: "retry-attach",
      sessionId,
      command: { kind: "adapter.attach", continuity: "context_replay" },
    });
    expect(attached.receipt?.status, JSON.stringify(attached.receipt)).toBe("accepted");
    await assertDeliveredOnce(f, current, sessionId);
  });

  it.each([
    "auth_required",
    "permission_required",
    "configuration_invalid",
    "adapter_unrecoverable",
    "partial_turn_interrupted",
  ] as const)(
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
      expect(projection.attention.active).toContainEqual(
        expect.objectContaining({ id: "blocker", kind }),
      );
      expect(projection.attention.active).toContainEqual(
        expect.objectContaining({
          id: expect.stringContaining("message-delivery:"),
          kind: "adapter_unrecoverable",
          detail: expect.stringContaining(kind),
        }),
      );
      expect(f.script.requests).toHaveLength(1);
      await assertNoAnswers(current, sessionId);
    },
  );

  it.each(["attach", "admission"] as const)(
    "bounds a stuck %s with a durable named delivery failure",
    async (stage) => {
      const f = fixture();
      const { sessionId, interaction, attachmentId } = await start(f);
      await f.host.cancelInteraction({
        sessionId,
        interactionId: interaction.id,
        reason: "withdrawn",
      });
      await expect
        .poll(async () => (await f.host.projection({ sessionId })).projection.turnActive)
        .toBe(false);
      const current = await f.restart(f);
      if (stage === "attach") {
        await current.engine.observe({
          id: `closed-${clock++}`,
          sessionId,
          attachmentId,
          occurredAt: clock++,
          provenance,
          kind: "attachment.closed",
          outcome: "interrupted",
        });
      }
      const gate = Promise.withResolvers<void>();
      if (stage === "attach") current.control.attachGate = gate.promise;
      else current.control.admissionGate = gate.promise;
      try {
        await queue(current, sessionId);
        const projection = (await current.host.projection({ sessionId })).projection;
        expect(projection.queue).toHaveLength(1);
        expect(projection.attention.active).toContainEqual(
          expect.objectContaining({
            id: expect.stringContaining("message-delivery:"),
            kind: "adapter_unrecoverable",
            // The stalled stage, not a slow real rebuild before it, is what timed out.
            detail: expect.stringContaining(
              `queue_admission_timeout: ${stage === "attach" ? "executor attach" : "message admission"} did not finish`,
            ),
          }),
        );
        expect(f.script.requests).toHaveLength(2);
      } finally {
        // End the scripted transport without delivering late. This is fixture
        // cleanup, not a timeout that ever applies to the user's parked ask.
        gate.reject(new Error("Stalled fixture transport ended"));
        current.control.attachGate = null;
        current.control.admissionGate = null;
        current.control.stalled = false;
      }
      const relaunched = await f.restart(current);
      const projection = (await relaunched.host.projection({ sessionId })).projection;
      expect(projection.queue).toHaveLength(1);
      expect(projection.attention.active).toContainEqual(
        expect.objectContaining({
          id: expect.stringContaining("message-delivery:"),
          detail: expect.stringContaining("queue_admission_timeout"),
        }),
      );
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

const userTexts = (messages: readonly { role: string }[], text: string) =>
  messages.filter((message) => message.role === "user" && JSON.stringify(message).includes(text));

// The same production path, continued: a relaunch judges each turn it
// recovered and continues the safe ones through the retry door (VC-450).
describe("restart resume through the durable Pi binding (VC-450)", () => {
  async function resume(current: Launch, recovered: BootRecoveredTurns) {
    await resumeRecoveredTurns(
      {
        projection: async (sessionId) => (await current.host.projection({ sessionId })).projection,
        ticketSessions: async () => [],
        resumeBoundary: (input) => current.host.resumeBoundary(input),
        pendingTurnStarts: () => current.host.pendingTurnStarts(),
        command: (request) => current.host.command(request),
        shouldStop: () => false,
        now: () => clock,
      },
      recovered,
    );
  }

  it("continues a turn lost while the model was answering, without sending the message again", async () => {
    const f = fixture();
    const stalled = Promise.withResolvers<void>();
    f.replies.splice(
      0,
      f.replies.length,
      {
        wait: (signal) =>
          new Promise<void>((resolve) => {
            stalled.resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          }),
      },
      { text: "Picked up where the lost process stopped." },
    );
    const { sessionId } = await f.host.command({
      commandId: `create-${clock++}`,
      command: {
        kind: "session.create",
        projectId: "project",
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: "Restart resume",
      },
    });
    await f.engine.getOrRecordSessionInput({
      sessionId,
      input: { kind: "tool-surface", tools: ["read", "edit", "write", "execute", "ask_user"] },
      provenance,
    });
    await f.host.command({
      sessionId,
      commandId: `attach-${clock++}`,
      command: { kind: "adapter.attach", continuity: "fresh" },
    });
    await f.host.command({
      sessionId,
      commandId: `submit-${clock++}`,
      command: {
        kind: "message.submit",
        settle: "opened",
        message: { id: "m", role: "user", parts: [{ type: "text", text: "Build the thing" }] },
      },
    });
    await stalled.promise;

    const current = await f.restart(f, true);
    let recovered: BootRecoveredTurns | undefined;
    expect(await f.boot(current, (turns) => (recovered = turns))).toEqual({
      closed: 0,
      errors: [],
    });
    const interrupted = (await current.host.projection({ sessionId })).projection;
    expect(interrupted.lastTurnOutcome).toBe("interrupted");
    expect(interrupted.attention.active).toContainEqual(
      expect.objectContaining({ detail: RECOVERED_TURN_INTERRUPTED_DETAIL }),
    );
    expect(recovered?.turns).toEqual([{ sessionId, attachmentId: interrupted.liveExecutor!.id }]);
    await resume(current, recovered!);

    const projection = (await current.host.projection({ sessionId })).projection;
    expect(projection.lastTurnOutcome).toBe("completed");
    expect(projection.attention.active).toEqual([]);
    const resumed = projection.commands.at(-1)!;
    expect(resumed).toMatchObject({
      id: restartResumeCommandId(interrupted.liveExecutor!.id, interrupted.latestTurnId!),
      intent: { kind: "executor.retry" },
    });
    // The resumed request carries the person's message once, as context.
    const last = f.script.requests.at(-1)!;
    expect(userTexts(last, "Build the thing")).toHaveLength(1);
    expect(
      projection.commands.filter(({ intent }) => intent.kind === "message.submit"),
    ).toHaveLength(1);
  });

  it("leaves a turn lost inside a tool for the person, whose Resume then continues it", async () => {
    const f = fixture();
    const { sessionId } = await start(f);
    const current = await f.restart(f, true);
    let recovered: BootRecoveredTurns | undefined;
    await f.boot(current, (turns) => (recovered = turns));
    const requestsBefore = f.script.requests.length;
    await resume(current, recovered!);
    // Nothing ran: the abandoned question is the person's to answer.
    expect(f.script.requests).toHaveLength(requestsBefore);
    const waiting = (await current.host.projection({ sessionId })).projection;
    expect(waiting.lastTurnOutcome).toBe("interrupted");

    const retried = await current.host.command({
      sessionId,
      commandId: `resume-${clock++}`,
      command: { kind: "executor.retry" },
    });
    expect(retried.receipt?.status, JSON.stringify(retried.receipt)).toBe("accepted");
    expect(f.script.requests).toHaveLength(requestsBefore + 1);
    const answered = (await current.host.projection({ sessionId })).projection;
    expect(answered.lastTurnOutcome).toBe("completed");
    expect(
      answered.attention.active.filter(({ kind }) => kind === "partial_turn_interrupted"),
    ).toEqual([]);
  });
});
