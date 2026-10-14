import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { piExecutionEnv } from "@volli/agent-runtime";
import {
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
afterEach(async () => {
  await runtime?.close();
  await shells?.close();
  db?.cleanup();
  runtime = undefined;
  shells = undefined;
  db = undefined;
});

// Only the provider is scripted. The adapter, executor, codec, child, shell port,
// SQLite ledger and sidecar are the same ones production uses.
describe("Pi foreground bash handoff (VC-757)", () => {
  it("returns the handoff to the model, continues the turn, reattaches and replays it", async () => {
    db = openTestDb();
    const directory = join(dirname(db.dbPath), "workspace");
    mkdirSync(directory);
    insertProject(db.db, testProject({ id: "project", path: directory }));
    const notices: BackgroundShellNotice[] = [];
    shells = new BackgroundShellHost({
      publishState() {},
      publishRemoved() {},
      onNotice: (notice) => notices.push(notice),
      exitNoticeGraceMs: 20,
      killGraceMs: 30,
      settleMs: 5,
    });
    const shellHost = shells;
    let captured = "";
    const script = scriptedProvider([
      {
        tool: {
          name: "bash",
          args: { command: "echo before; sleep 0.4; echo after", timeout: 0.2 },
        },
      },
      { text: "The turn continued." },
      { text: "The moved command replayed." },
    ]);
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
              { command: input.command, cwd: input.cwd, env: input.env, title: null },
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
        executor: adapter,
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
    const pending = runtime.command({
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
    await vi.waitFor(() => expect(captured).toContain("before"));
    const moved = shellHost.moveForeground(sessionId, "scripted-call-1");
    expect((await pending).receipt?.status).toBe("accepted");
    const toolResult = script.requests[1]!.find((message) => message.role === "toolResult");
    expect(JSON.stringify(toolResult)).toContain(
      `Moved command to background shell ${moved.shellId}`,
    );
    expect(JSON.stringify(toolResult)).toContain("before");
    expect(JSON.stringify(toolResult)).not.toContain("Command timed out");
    expect((await runtime.snapshot({ sessionId })).projection.lastTurnOutcome).toBe("completed");
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(notices[0]).toMatchObject({ kind: "exited", code: 0, tail: "before\nafter\n" });
    expect(shellHost.read({ sessionId }, moved.shellId, 64_000).output).toBe("before\nafter\n");
    const native = (await runtime.snapshot({ sessionId })).projection.liveExecutor?.native;
    await runtime.close();
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
    expect((await runtime.snapshot({ sessionId })).projection.liveExecutor?.native).toEqual(native);
    expect(JSON.stringify(script.requests[2])).toContain(
      `Moved command to background shell ${moved.shellId}`,
    );
    expect(JSON.stringify(script.requests[2])).toContain("The turn continued.");
    expect(notices).toHaveLength(1);
  });
});
