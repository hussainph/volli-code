import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { piExecutionEnv } from "@volli/agent-runtime";
import {
  createSessionExecutorSlot,
  createSessionEngine,
  createSessionRuntime,
  sessionRootThreadId,
} from "@volli/session-engine";
import { scriptedProvider } from "../../../agent-runtime/test-fixtures/scripted-provider";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { insertProject } from "../db/projects-repo";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { BackgroundShellHost, type BackgroundShellNotice } from "../shell/background-shell-host";
import { createAgentShellPort } from "../shell/agent-port";
import { createPiNativeAdapter } from "./pi-adapter";
import { createFileTranscriptArtifactStore } from "./transcript-artifacts";

let db: TestDb | undefined;
let runtime: ReturnType<typeof createSessionRuntime> | undefined;
let shells: BackgroundShellHost | undefined;
const processGroups: number[] = [];
afterEach(async () => {
  await runtime?.close();
  await shells?.close();
  for (const pid of processGroups.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* Already reaped. */
    }
  }
  db?.cleanup();
  runtime = undefined;
  shells = undefined;
  db = undefined;
});

async function startFixture(steps: Parameters<typeof scriptedProvider>[0], killGraceMs?: number) {
  db = openTestDb();
  const directory = join(dirname(db.dbPath), "workspace");
  mkdirSync(directory);
  insertProject(db.db, testProject({ id: "project", path: directory }));
  const notices: BackgroundShellNotice[] = [];
  const pids: number[] = [];
  const exits: string[] = [];
  shells = new BackgroundShellHost({
    publishState() {},
    publishRemoved() {},
    onNotice: (notice) => notices.push(notice),
    exitNoticeGraceMs: 20,
    killGraceMs,
    ledger: {
      recordSpawn: (spawn) => {
        pids.push(spawn.pid);
        processGroups.push(spawn.pid);
        return `row-${pids.length}`;
      },
      markExited: (id) => exits.push(id),
    },
    settleMs: 5,
  });
  const shellHost = shells;
  let captured = "";
  const script = scriptedProvider(steps);
  let clock = 1_000;
  const engine = createSessionEngine({
    ledger: createSqliteSessionLedger(db.db),
    clock: { now: () => clock++ },
    ids: { next: (kind) => `${kind}-${clock++}` },
  });
  const surface = [
    "read",
    "edit",
    "write",
    "execute",
    "shell_start",
    "shell_output",
    "shell_kill",
  ] as const;
  const adapter = createPiNativeAdapter({
    sessionDataDir: join(dirname(db.dbPath), "pi"),
    models: script.models,
    usageLimits: {
      fetch: async () => {
        throw new Error("no network in fixture");
      },
    },
    resolveRuntimeContext: async (sessionId) => ({
      role: "project",
      projectId: "project",
      ticketId: null,
      rootThreadId: sessionRootThreadId(sessionId),
      brief: "Foreground handoff fixture",
      model: { providerId: "scripted-fixture", modelId: "scripted", reasoningLevel: "off" },
      toolSurface: surface,
      promptResources: [],
    }),
    executionEnvFactory: (workspace, identity) =>
      piExecutionEnv(workspace, {
        identity: { sessionId: identity.sessionId, ticketDisplayId: null },
        foregroundExecutor: (input) =>
          shellHost.runForeground(
            {
              sessionId: identity.sessionId,
              attachmentId: identity.attachmentId,
              projectId: "project",
              ticketId: null,
            },
            {
              command: input.command,
              shellConfig: input.shellConfig,
              cwd: input.cwd,
              env: input.env,
              title: null,
            },
            {
              toolCallId: input.toolCallId,
              timeout: input.timeout,
              signal: input.signal,
              onChunk: (chunk) => {
                captured += Buffer.from(chunk).toString("utf8");
                input.onOutput(chunk);
              },
              onReady: input.onReady,
            },
          ),
      }),
    resolveShellPort: (scope) =>
      createAgentShellPort({
        host: shellHost,
        scope,
        session: scope,
        workspacePath: directory,
        identity: { sessionId: scope.sessionId, ticketDisplayId: null },
        pathPrefixes: [],
      }),
  });
  const createRuntime = () =>
    createSessionRuntime({
      engine,
      executors: createSessionExecutorSlot(adapter),
      artifacts: createFileTranscriptArtifactStore(join(dirname(db!.dbPath), "transcripts")),
      locations: {
        resolve: async () => ({ directory, venue: { id: "local", kind: "local" } }),
        prepare: async () => ({ directory, venue: { id: "local", kind: "local" } }),
        reaffirm: async () => undefined,
      },
      clock: { now: () => clock++ },
      ids: { next: (kind) => `runtime-${kind}-${clock++}` },
    });
  runtime = createRuntime();
  const { sessionId } = await runtime.command({
    commandId: "create",
    command: {
      kind: "session.create",
      projectId: "project",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Move bash",
    },
  });
  await engine.getOrRecordSessionInput({
    sessionId,
    input: { kind: "tool-surface", tools: surface },
    provenance: { source: { kind: "system", id: "fixture", detail: null }, venue: null },
  });
  expect(
    (
      await runtime.command({
        commandId: "attach",
        sessionId,
        command: { kind: "adapter.attach", continuity: "fresh" },
      })
    ).receipt?.status,
  ).toBe("accepted");
  return {
    script,
    shellHost,
    notices,
    pids,
    exits,
    createRuntime,
    sessionId,
    get captured() {
      return captured;
    },
  };
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("person Stop waited on kill grace")), 1_500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Only the provider is scripted. The adapter, executor, codec, child, shell port,
// SQLite ledger and sidecar are the same ones production uses.
describe("Pi foreground bash handoff (VC-757)", () => {
  it.each(["session.stop", "executor.interrupt"] as const)(
    "%s ends the real turn promptly while a SIGTERM-ignoring child is killed asynchronously",
    async (kind) => {
      // No shortened kill grace: prove the production five-second lifecycle.
      // Both the group leader and a real descendant ignore SIGTERM.
      const fixture = await startFixture([
        {
          tool: {
            name: "bash",
            args: {
              command: `trap '' TERM; '${process.execPath}' -e 'process.on("SIGTERM", () => {}); console.log("child:" + process.pid); setInterval(() => {}, 1000)' & wait`,
            },
          },
        },
      ]);
      const { sessionId, shellHost, pids, exits, notices } = fixture;
      const pending = runtime!.command({
        commandId: "submit",
        sessionId,
        command: {
          kind: "message.submit",
          message: { id: "user", role: "user", parts: [{ type: "text", text: "Run a command." }] },
        },
      });
      await vi.waitFor(() => expect(fixture.captured).toContain("child:"));
      const childPid = Number(/child:(\d+)/.exec(fixture.captured)![1]);
      expect(shellHost.foregroundAvailable(sessionId, "scripted-call-1")).toBe(true);
      const started = Date.now();
      const stopped = await promptly(
        runtime!.command({
          commandId: "person-stop",
          sessionId,
          command: { kind },
        }),
      );
      await promptly(pending);
      const projection = (await runtime!.snapshot({ sessionId })).projection;
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(stopped.receipt?.status).toBe(kind === "session.stop" ? "completed" : "accepted");
      expect(projection.turnActive).toBe(false);
      expect(projection.lastTurnOutcome).toBe("interrupted");
      if (kind === "session.stop") {
        expect(projection.stopped?.by).toEqual({ kind: "user" });
        expect(projection.liveExecutor).toBeNull();
      }
      // The turn and (for session.stop) attachment already ended, but the
      // host still owns the group, ledger and full SIGTERM -> SIGKILL grace.
      expect(groupAlive(pids[0]!)).toBe(true);
      expect(() => process.kill(childPid, 0)).not.toThrow();
      expect(shellHost.liveCwds()).toHaveLength(1);
      expect(exits).toEqual([]);
      await vi.waitFor(() => expect(groupAlive(pids[0]!)).toBe(false), { timeout: 7_000 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
      expect(() => process.kill(childPid, 0)).toThrow();
      expect(exits).toEqual(["row-1"]);
      expect(shellHost.liveCwds()).toEqual([]);
      expect(notices).toEqual([]);
    },
    10_000,
  );

  it("returns the handoff to the model, continues the turn, reattaches and replays it", async () => {
    const fixture = await startFixture(
      [
        {
          tool: {
            name: "bash",
            args: { command: "echo before; sleep 0.4; echo after", timeout: 0.2 },
          },
        },
        { text: "The turn continued." },
        { text: "The moved command replayed." },
      ],
      30,
    );
    const { script, shellHost, notices, createRuntime, sessionId } = fixture;
    const pending = runtime!.command({
      commandId: "submit",
      sessionId,
      command: {
        kind: "message.submit",
        message: { id: "user", role: "user", parts: [{ type: "text", text: "Run a command." }] },
      },
    });
    await vi.waitFor(() =>
      expect(shellHost.foregroundAvailable(sessionId, "scripted-call-1")).toBe(true),
    );
    // Wait for the actual child bytes, not a spawn-only fake.
    await vi.waitFor(() => expect(fixture.captured).toContain("before"));
    const moved = shellHost.moveForeground(sessionId, "scripted-call-1");
    expect((await pending).receipt?.status).toBe("accepted");
    const toolResult = script.requests[1]!.find((message) => message.role === "toolResult");
    expect(JSON.stringify(toolResult)).toContain(
      `Moved command to background shell ${moved.shellId}`,
    );
    expect(JSON.stringify(toolResult)).toContain("before");
    expect(JSON.stringify(toolResult)).not.toContain("Command timed out");
    expect((await runtime!.snapshot({ sessionId })).projection.lastTurnOutcome).toBe("completed");
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(notices[0]).toMatchObject({ kind: "exited", code: 0, tail: "before\nafter\n" });
    expect(shellHost.read({ sessionId }, moved.shellId, 64_000).output).toBe("before\nafter\n");
    const native = (await runtime!.snapshot({ sessionId })).projection.liveExecutor?.native;
    await runtime!.close();
    runtime = createRuntime();
    expect(
      (
        await runtime.command({
          commandId: "replay",
          sessionId,
          command: {
            kind: "message.submit",
            message: {
              id: "user-replay",
              role: "user",
              parts: [{ type: "text", text: "Read the earlier result." }],
            },
          },
        })
      ).receipt?.status,
    ).toBe("accepted");
    expect((await runtime!.snapshot({ sessionId })).projection.liveExecutor?.native).toEqual(
      native,
    );
    expect(JSON.stringify(script.requests[2])).toContain(
      `Moved command to background shell ${moved.shellId}`,
    );
    expect(JSON.stringify(script.requests[2])).toContain("The turn continued.");
    expect(notices).toHaveLength(1);
  });
});
