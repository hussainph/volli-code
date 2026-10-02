import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_AUTHORITY_POLICY, readScope, type AuthorityPolicy } from "@volli/shared";
import {
  createSessionEngine,
  createSessionRuntime,
  sessionRootThreadId,
} from "@volli/session-engine";
import { readHostNotice, projectTranscriptRows } from "@volli/session-presentation";
import {
  protectionScript,
  type ScriptedReply,
} from "../../../../../packages/agent-runtime/test-fixtures/protection-script";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { createFileTranscriptArtifactStore } from "./transcript-artifacts";
import { createPiNativeAdapter } from "./pi-adapter";
import { createProtection } from "../protection/host";
import { commandApproval } from "../protection/commands";
import {
  listApprovals,
  listDecisions,
  countApprovedRequests,
  findCoveringApproval,
} from "../db/authority-approvals-repo";
import { insertProject } from "../db/projects-repo";
import { openRawDb, openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { createRunAttentionWatch } from "../automations/run-attention";
import type { NotificationRequest } from "../notifications/dispatch";

let db: TestDb;
const hosts: ReturnType<typeof createSessionRuntime>[] = [];
let clock = 1_000;
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  db.cleanup();
});

function fixture(
  replies: ScriptedReply[],
  policy: AuthorityPolicy = { ...DEFAULT_AUTHORITY_POLICY, enforcement: "enforce" },
) {
  db = openTestDb();
  insertProject(db.db, testProject({ id: "project-a" }));
  insertProject(db.db, testProject({ id: "project-b" }));
  const directory = join(dirname(db.dbPath), "workspace");
  const outside = join(dirname(db.dbPath), "outside", "docs");
  mkdirSync(directory);
  mkdirSync(outside, { recursive: true });
  const script = protectionScript(replies);
  const artifacts = createFileTranscriptArtifactStore(join(dirname(db.dbPath), "transcripts"));
  const errors: unknown[] = [];
  function launch() {
    const engine = createSessionEngine({
      ledger: createSqliteSessionLedger(db.db),
      clock: { now: () => clock++ },
      ids: { next: (kind) => `${kind}-${clock++}` },
    });
    const adapter = createPiNativeAdapter({
      sessionDataDir: join(dirname(db.dbPath), "pi"),
      models: script.models,
      usageLimits: {
        fetch: async () => {
          throw new Error("fixture has no network");
        },
      },
      now: () => clock++,
      resolveRuntimeContext: async (sessionId) => {
        const session = (await engine.getSession({ sessionId }))!.session;
        return {
          ...(session.role === "subagent"
            ? { role: "subagent" as const, parentSessionId: session.parentSessionId! }
            : { role: "project" as const }),
          location: "main-checkout",
          projectId: session.projectId,
          ticketId: null,
          rootThreadId: sessionRootThreadId(sessionId),
          brief: "Integration task",
          priorAuthorityDenials: 0,
          authorityPolicy: policy,
          model: { providerId: "protection-fixture", modelId: "scripted", reasoningLevel: "off" },
          toolSurface: ["read", "write", "execute"],
          promptResources: [],
          protection: createProtection({
            db: db.db,
            now: () => clock++,
            projectId: session.projectId,
            sessionId,
            inheritedFrom: session.parentSessionId === null ? [] : [session.parentSessionId],
            sessionTitle: session.title,
            ticketDisplayId: null,
            onError: (error) => errors.push(error),
          }),
        };
      },
    });
    const venue = { id: "local", kind: "local" as const };
    const host = createSessionRuntime({
      engine,
      executor: adapter,
      artifacts,
      locations: {
        resolve: async () => ({ directory, venue }),
        prepare: async () => ({ directory, venue }),
        reaffirm: async () => undefined,
      },
      clock: { now: () => clock++ },
      ids: { next: (kind) => `rt-${kind}-${clock++}` },
    });
    hosts.push(host);
    return { engine, host };
  }
  return {
    ...launch(),
    launch,
    directory,
    outside,
    script,
    errors,
    setPolicy: (next: AuthorityPolicy) => {
      policy = next;
    },
  };
}

async function start(
  f: ReturnType<typeof fixture>,
  projectId = "project-a",
  parentSessionId: string | null = null,
) {
  const created = await f.host.command({
    commandId: `create-${clock++}`,
    command: {
      kind: "session.create",
      projectId,
      ticketId: null,
      role: parentSessionId === null ? "project" : "subagent",
      parentSessionId,
      title: "Protected task",
    },
  });
  const attached = await f.host.command({
    commandId: `attach-${clock++}`,
    sessionId: created.sessionId,
    command: { kind: "adapter.attach", continuity: "fresh" },
  });
  expect(attached.receipt?.status, JSON.stringify(attached)).toBe("accepted");
  return created.sessionId;
}
function submit(f: ReturnType<typeof fixture>, sessionId: string) {
  return f.host.command({
    commandId: `submit-${clock++}`,
    sessionId,
    command: {
      kind: "message.submit",
      message: {
        id: `message-${clock++}`,
        role: "user",
        parts: [{ type: "text", text: "Perform the task" }],
      },
    },
  });
}
async function card(f: ReturnType<typeof fixture>, sessionId: string) {
  let active: Awaited<ReturnType<typeof f.host.snapshot>>["projection"]["interactions"]["active"] =
    [];
  await expect
    .poll(async () => {
      active = (await f.host.snapshot({ sessionId })).projection.interactions.active;
      return active.length;
    })
    .toBe(1);
  return active[0];
}
function answer(
  f: ReturnType<typeof fixture>,
  sessionId: string,
  interactionId: string,
  option: string,
  commandId = `answer-${clock++}`,
) {
  return f.host.command({
    commandId,
    sessionId,
    command: {
      kind: "interaction.resolve",
      interactionId,
      resolution: { optionIds: [option], response: null },
    },
  });
}

// The provider replies are scripted; normalization, gate, Pi hooks, execution, adapter, engine and SQLite are real.
describe("Protection real Pi/SQLite integration", () => {
  it("approves, executes, repeats without a card, renders the receipt live/reloaded, and asks after revoke", async () => {
    const replies: ScriptedReply[] = [];
    const f = fixture(replies);
    const path = join(f.outside, "a.txt");
    replies.push(
      { tool: { name: "write", args: { path, content: "first" } } },
      { text: "first complete" },
      { tool: { name: "write", args: { path, content: "second" } } },
      { text: "second complete" },
      { tool: { name: "write", args: { path, content: "third" } } },
      { text: "third denied" },
    );
    const sessionId = await start(f);
    const first = submit(f, sessionId);
    const initial = await card(f, sessionId);
    const commandId = "standing-approval-command";
    const [accepted, replay] = await Promise.all([
      answer(f, sessionId, initial.id, "session", commandId),
      answer(f, sessionId, initial.id, "session", commandId),
    ]);
    expect(accepted).toEqual(replay);
    expect(accepted.receipt?.status).toBe("accepted");
    await first;
    expect(readFileSync(path, "utf8")).toBe("first");
    await submit(f, sessionId);
    expect(readFileSync(path, "utf8")).toBe("second");
    const live = await f.host.snapshot({ sessionId });
    expect(live.projection.interactions.active).toEqual([]);
    expect(live.projection.interactions.resolved).toHaveLength(1);
    const notices = live.transcript.map(({ message }) => readHostNotice(message)).filter(Boolean);
    expect(notices).toContainEqual({
      kind: "approval-used",
      approvalId: listApprovals(db.db, "project-a")[0].id,
      summary: expect.any(String),
      asked: expect.stringContaining(path),
    });
    expect(
      projectTranscriptRows(
        live.transcript.map(({ message }) => [message]),
        [],
        [],
      ).some((row) => row.kind === "host-notice" && row.notice.kind === "approval-used"),
    ).toBe(true);
    const [row] = listApprovals(db.db, "project-a");
    expect(countApprovedRequests(db.db, "project-a")).toBe(1);
    commandApproval(
      db.db,
      { kind: "approval.revoke", commandId: "revoke-for-repeat", approvalId: row.id },
      () => clock++,
    );
    const third = submit(f, sessionId);
    const next = await card(f, sessionId);
    expect(next.id).not.toBe(initial.id);
    await answer(f, sessionId, next.id, "reject");
    await third;
    expect(readFileSync(path, "utf8")).toBe("second");
    expect(
      listDecisions(db.db, sessionId)
        .map((d) => d.authoriser)
        .toSorted(),
    ).toEqual(["policy:ledger", "user:deny", "user:session"]);
    // No executor is reattached to read a cold projection/artifact replay.
    await f.host.close();
    hosts.splice(hosts.indexOf(f.host), 1);
    db.db.close();
    db.db = openRawDb(db.dbPath);
    db.db.pragma("foreign_keys = ON");
    const cold = f.launch();
    const reloaded = await cold.host.snapshot({ sessionId });
    expect(
      reloaded.transcript.map(({ message }) => readHostNotice(message)).filter(Boolean),
    ).toEqual(notices);
    expect(reloaded.projection.interactions.active).toEqual([]);
    expect(
      (await answer({ ...f, ...cold }, sessionId, initial.id, "session", commandId)).receipt,
    ).toEqual(accepted.receipt);
  });

  it("pauses an unattended Run on the actual pending card and notifies the existing watcher once", async () => {
    const replies: ScriptedReply[] = [];
    const f = fixture(replies);
    const path = join(f.outside, "unattended.txt");
    replies.push(
      { tool: { name: "write", args: { path, content: "unattended" } } },
      { text: "denied" },
    );
    const sessionId = await start(f);
    const notifications: NotificationRequest[] = [];
    const watch = createRunAttentionWatch({
      attendanceOf: () => "unattended",
      notify: (request) => notifications.push(request),
    });
    watch.observeBirth(sessionId);
    let settled = false;
    const pending = submit(f, sessionId).then(() => {
      settled = true;
    });
    const active = await card(f, sessionId);
    const snapshot = await f.host.snapshot({ sessionId });
    watch.observe(snapshot.projection);
    watch.observe(snapshot.projection);
    expect(settled).toBe(false);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      title: "An Automation needs your approval",
      body: expect.stringContaining("paused until you answer"),
      target: { sessionId, interactionId: active.id },
    });
    await answer(f, sessionId, active.id, "reject");
    await pending;
    watch.observe((await f.host.snapshot({ sessionId })).projection);
    expect(notifications).toHaveLength(1);
  });

  it.each(["off", "observe"] as const)(
    "executes a recovered %s attachment without a gate despite a later On switch",
    async (enforcement) => {
      const replies: ScriptedReply[] = [];
      const f = fixture(replies, { ...DEFAULT_AUTHORITY_POLICY, enforcement });
      const path = join(f.outside, "off-file.txt");
      const commandPath = join(f.outside, "off-command.txt");
      replies.push(
        { text: "off attachment established" },
        { tool: { name: "write", args: { path, content: "recovered-file" } } },
        {
          tool: { name: "bash", args: { command: `printf recovered-command > '${commandPath}'` } },
        },
        { text: "recovered complete" },
      );
      const sessionId = await start(f);
      await submit(f, sessionId);

      const initial = (await f.host.snapshot({ sessionId })).projection;
      expect(initial.interactions.active).toEqual([]);
      expect(initial.liveExecutor!.authority?.enforcement ?? "off").toBe(enforcement);
      expect(initial.liveExecutor!.authority?.protection ?? false).toBe(false);
      await f.host.close();
      hosts.splice(hosts.indexOf(f.host), 1);
      db.db.close();
      db.db = openRawDb(db.dbPath);
      db.db.pragma("foreign_keys = ON");
      f.setPolicy({ ...DEFAULT_AUTHORITY_POLICY, enforcement: "enforce" });
      const restarted = { ...f, ...f.launch() };
      const resumed = await submit(restarted, sessionId);
      expect(resumed.receipt?.status, JSON.stringify(resumed)).toBe("accepted");
      expect(readFileSync(path, "utf8")).toBe("recovered-file");
      expect(readFileSync(commandPath, "utf8")).toBe("recovered-command");
      const recovered = (await restarted.host.snapshot({ sessionId })).projection;
      expect(recovered.liveExecutor!.authority).toEqual(initial.liveExecutor!.authority);
      expect(recovered.interactions.active).toEqual([]);
      expect(recovered.interactions.resolved).toEqual([]);
      expect(listApprovals(db.db, "project-a")).toEqual([]);
      expect(listDecisions(db.db, sessionId)).toEqual([]);
    },
  );

  it("Session grants do not authorize a sibling or another project, while a project grant serves only its project", async () => {
    const replies: ScriptedReply[] = [];
    const f = fixture(replies);
    const path = join(f.outside, "scope.txt");
    for (let n = 0; n < 5; n++)
      replies.push(
        { tool: { name: "write", args: { path, content: `value-${n}` } } },
        { text: "done" },
      );
    const parent = await start(f);
    const first = submit(f, parent);
    await answer(f, parent, (await card(f, parent)).id, "session");
    await first;
    const sibling = await start(f);
    const second = submit(f, sibling);
    await answer(f, sibling, (await card(f, sibling)).id, "project");
    await second;
    const sameProject = await start(f);
    await submit(f, sameProject);
    expect(readFileSync(path, "utf8")).toBe("value-2");
    const otherProject = await start(f, "project-b");
    const foreign = submit(f, otherProject);
    await answer(f, otherProject, (await card(f, otherProject)).id, "reject");
    await foreign;
    expect(readFileSync(path, "utf8")).toBe("value-2");
    expect(
      findCoveringApproval(
        db.db,
        { projectId: "project-b", sessionIds: [otherProject] },
        readScope(path),
      ),
    ).toBeNull();
    const child = await start(f, "project-a", parent);
    await submit(f, child);
    expect(readFileSync(path, "utf8")).toBe("value-4");
  });
});
