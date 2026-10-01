import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createSessionRuntime,
  createInMemoryTranscriptArtifactStore,
  sessionRootThreadId,
} from "@volli/session-engine";
import {
  DEFAULT_AUTHORITY_POLICY,
  sessionAwaitsUser,
  scrubSessionInteraction,
} from "@volli/shared";
import { piExecutionEnv, refusingCredentialReads } from "@volli/agent-runtime";
import { secretFixtureProvider } from "../../../../../packages/agent-runtime/src/pi/fixtures/secret-provider";
import { createPiRuntimeHost } from "../session-runtime/pi-adapter";
import { createDesktopSessionEngine } from "../session-control";
import { openTestDb, testProject } from "../db/test-helpers";
import { insertProject } from "../db/projects-repo";
import { BackgroundShellHost } from "../shell/background-shell-host";
import { createAgentShellPort } from "../shell/agent-port";
import { SecretStore } from "./store";
import { SecretService } from "./service";
import { registerSecretIpc } from "./ipc";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, fn),
  },
}));
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  handlers.clear();
});
const sentinel = "person-secret-VC481-sentinel-1234";
const marker = "‹secret:STRIPE_API_KEY›";

function toolResult(seen: Parameters<typeof secretFixtureProvider>[1], name: string) {
  const result = seen
    .at(-1)
    ?.find((message) => message.role === "toolResult" && message.toolName === name);
  if (result?.role !== "toolResult") throw new Error(`Pi did not observe a ${name} result`);
  expect(result.isError, JSON.stringify(result)).toBe(false);
  return result;
}

function scan(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? scan(join(dir, entry.name))
      : [readFileSync(join(dir, entry.name), "utf8")],
  );
}

describe("secure credential through the real Pi / SQLite Session path", () => {
  it("injects execute and shells, redacts reads, and keeps values out of transcript, events, ledger, logs and IPC results", async () => {
    const root = mkdtempSync(join(process.cwd(), ".secret-integration-test-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    const ctx = openTestDb();
    cleanups.push(ctx.cleanup);
    const project = testProject({ id: "secret-project", path: worktree });
    insertProject(ctx.db, project);
    const service = new SecretService(
      new SecretStore(join(root, "session-secrets.enc"), {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error("unused");
        },
        decryptString: () => {
          throw new Error("unused");
        },
      }),
    );
    const sender = { mainFrame: {} };
    registerSecretIpc(service, (candidate) => candidate === sender);
    const invoke = (channel: string, ...args: unknown[]) =>
      handlers.get(channel)!({ sender, senderFrame: sender.mainFrame }, ...args);
    const seen: Parameters<typeof secretFixtureProvider>[1] = [];
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const ledgerSpawns: unknown[] = [];
    const shells = new BackgroundShellHost({
      publishState: () => {},
      publishRemoved: () => {},
      settleMs: 100,
      redactOutput: (text) => service.store.redact(text),
      ledger: {
        recordSpawn: (input) => {
          ledgerSpawns.push(input);
          return "spawn";
        },
        markExited: () => {},
      },
    });
    let submitted: unknown;
    const waitingSnapshots: unknown[] = [];
    const host = createPiRuntimeHost({
      sessionDataDir: join(root, "pi-sessions"),
      models: secretFixtureProvider(
        [
          {
            name: "request_secret",
            args: { name: "STRIPE_API_KEY", purpose: "Run the test script" },
          },
          {
            name: "bash",
            args: {
              command: `test "\${#STRIPE_API_KEY}" -eq ${sentinel.length} || exit 1; printf '%s\\n' "$STRIPE_API_KEY"; printf '%s' "$STRIPE_API_KEY" > receipt.txt`,
            },
          },
          { name: "read", args: { path: "receipt.txt" } },
          { name: "shell_start", args: { command: "printf '%s\\n' \"$STRIPE_API_KEY\"" } },
          { text: "done" },
        ],
        seen,
      ),
      executionEnvFactory: async (workspace, identity) =>
        refusingCredentialReads(
          await piExecutionEnv(workspace, {
            secretEnvironment: () => service.environment(identity.sessionId),
          }),
          workspace,
        ),
      resolveRuntimeContext: async (sessionId) => ({
        role: "project",
        location: "main-checkout",
        authorityPolicy: DEFAULT_AUTHORITY_POLICY,
        priorAuthorityDenials: 0,
        projectId: project.id,
        ticketId: null,
        rootThreadId: sessionRootThreadId(sessionId),
        brief: "Credential privacy fixture",
        model: { providerId: "anthropic", modelId: "claude-haiku-4-5", reasoningLevel: "off" },
        toolSurface: [
          "execute",
          "read",
          "shell_start",
          "shell_output",
          "shell_kill",
          "request_secret",
        ],
        promptResources: [],
      }),
      resolveShellPort: (scope) =>
        createAgentShellPort({
          host: shells,
          scope: { projectId: project.id, ticketId: null },
          session: scope,
          workspacePath: worktree,
          identity: { sessionId: scope.sessionId, ticketDisplayId: null },
          pathPrefixes: [],
          secretEnvironment: () => service.environment(scope.sessionId),
        }),
      resolveSecretPort: ({ sessionId, projectId, wait, allowInjection }) => {
        const port = service.port(
          {
            sessionId,
            projectId,
            sessionLabel: "Session fixture",
            projectLabel: project.name,
          },
          {
            ...wait,
            opened: async (metadata) => {
              await wait.opened(metadata);
              const projection = await engine.getSession({ sessionId });
              expect(projection).not.toBeNull();
              expect(sessionAwaitsUser(projection!)).toBe(true);
              expect(projection!.interactions.active).toHaveLength(1);
              expect(scrubSessionInteraction(projection!.interactions.active[0]!)).toMatchObject({
                title: "Credential requested",
                credential: metadata,
              });
              waitingSnapshots.push(projection);
            },
          },
          allowInjection,
        );
        return {
          ...port,
          request: async (input, signal) => {
            const waiting = port.request(input, signal);
            const list = service.list();
            if (!list.ok) throw new Error("No request metadata");
            submitted = await invoke("volli:secret-submit", {
              requestId: list.requests[0]!.id,
              value: sentinel,
              scope: "session",
            });
            return waiting;
          },
        };
      },
    });
    const engine = createDesktopSessionEngine(ctx.db);
    const runtime = createSessionRuntime({
      engine,
      clock: { now: Date.now },
      ids: { next: () => randomUUID() },
      executor: host.adapter,
      artifacts: createInMemoryTranscriptArtifactStore(),
      locations: {
        resolve: async () => ({ directory: worktree, venue: { id: "local", kind: "local" } }),
        prepare: async () => ({ directory: worktree, venue: { id: "local", kind: "local" } }),
        reaffirm: async () => undefined,
      },
    });
    let sessionId: string | undefined;
    try {
      const created = await runtime.command({
        commandId: "create",
        command: {
          kind: "session.create",
          projectId: project.id,
          ticketId: null,
          role: "project",
          parentSessionId: null,
          title: "Secret test",
        },
      });
      sessionId = created.sessionId;
      const attached = await runtime.command({
        commandId: "attach",
        sessionId,
        command: { kind: "adapter.attach", continuity: "fresh" },
      });
      expect(attached.receipt?.status, JSON.stringify(attached)).toBe("accepted");
      const sent = await runtime.command({
        commandId: "message",
        sessionId,
        command: {
          kind: "message.submit",
          message: { id: "message", role: "user", parts: [{ type: "text", text: "Run fixture" }] },
        },
      });
      expect(sent.receipt?.status, JSON.stringify(sent)).toBe("accepted");
      // A snapshot awaits the committed stream, not merely tool execution.
      const snapshot = await runtime.snapshot({ sessionId });
      const events = await engine.listEvents({ sessionId });
      const rows = ctx.db.prepare("SELECT * FROM session_events").all();
      const combined = JSON.stringify({
        seen,
        snapshot,
        events,
        rows,
        ledgerSpawns,
        submitted,
        waitingSnapshots,
        projection: invoke("volli:secrets-list"),
        logs: logs.map((log) => log.mock.calls),
      });
      expect(submitted).toEqual({ ok: true });
      expect(waitingSnapshots).toHaveLength(1);
      expect(snapshot.projection.interactions.active).toEqual([]);
      expect(sessionAwaitsUser(snapshot.projection)).toBe(false);
      expect(events.filter((event) => event.payload.kind === "interaction.opened")).toHaveLength(1);
      expect(events.filter((event) => event.payload.kind === "interaction.resolved")).toHaveLength(
        1,
      );
      expect(combined).not.toContain(sentinel);
      // Independently prove both coding tools ran successfully: a shell marker
      // cannot hide a missing execute binding or a failed read of a missing file.
      expect(readFileSync(join(worktree, "receipt.txt"), "utf8")).toBe(sentinel);
      expect(toolResult(seen, "bash").content).toEqual([{ type: "text", text: `${marker}\n` }]);
      expect(toolResult(seen, "read").content).toEqual([{ type: "text", text: marker }]);
      expect(JSON.stringify(seen)).toContain("signed in");
      expect(ledgerSpawns).toHaveLength(1);
      expect(scan(join(root, "pi-sessions")).join("\n")).not.toContain(sentinel);
      expect(shells.listAll()).not.toEqual([]);
      expect(shells.tailOf(shells.listAll()[0]!.shellId)?.output).toContain(
        "‹secret:STRIPE_API_KEY›",
      );
    } finally {
      await runtime.close();
      for (const log of logs) log.mockRestore();
    }
  });

  it.each([
    { label: "new project Session", role: "project", requestSecret: true },
    {
      label: "older frozen project surface without request_secret",
      role: "project",
      requestSecret: false,
    },
    {
      label: "child/subagent surface without request_secret",
      role: "subagent",
      requestSecret: false,
    },
  ] as const)(
    "redacts a parent's plaintext receipt for every $label",
    async ({ role, requestSecret }) => {
      const root = mkdtempSync(join(process.cwd(), ".secret-integration-test-"));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const worktree = join(root, "worktree");
      mkdirSync(worktree);
      const ctx = openTestDb();
      cleanups.push(ctx.cleanup);
      const project = testProject({ id: "secret-project", path: worktree });
      insertProject(ctx.db, project);
      const service = new SecretService(
        new SecretStore(join(root, "session-secrets.enc"), {
          isEncryptionAvailable: () => false,
          encryptString: () => {
            throw new Error("unused");
          },
          decryptString: () => {
            throw new Error("unused");
          },
        }),
      );
      const seen: Parameters<typeof secretFixtureProvider>[1] = [];
      let parentSessionId: string | undefined;
      const host = createPiRuntimeHost({
        sessionDataDir: join(root, "pi-sessions"),
        models: secretFixtureProvider(
          [
            { name: "request_secret", args: { name: "STRIPE_API_KEY" } },
            {
              name: "bash",
              args: {
                command: `test "\${#STRIPE_API_KEY}" -eq ${sentinel.length} || exit 1; printf '%s' "$STRIPE_API_KEY" > parent-receipt.txt; printf '%s\\n' "$STRIPE_API_KEY"`,
              },
            },
            { text: "parent done" },
            { name: "read", args: { path: "parent-receipt.txt" } },
            { text: "reader done" },
          ],
          seen,
        ),
        executionEnvFactory: async (workspace, identity) =>
          refusingCredentialReads(
            await piExecutionEnv(workspace, {
              secretEnvironment: () => service.environment(identity.sessionId),
            }),
            workspace,
          ),
        resolveRuntimeContext: async (sessionId) => {
          const common = {
            location: "main-checkout" as const,
            authorityPolicy: DEFAULT_AUTHORITY_POLICY,
            priorAuthorityDenials: 0,
            projectId: project.id,
            ticketId: null,
            rootThreadId: sessionRootThreadId(sessionId),
            brief: "Credential privacy fixture",
            model: {
              providerId: "anthropic",
              modelId: "claude-haiku-4-5",
              reasoningLevel: "off" as const,
            },
            toolSurface:
              sessionId === parentSessionId || requestSecret
                ? (["execute", "read", "request_secret"] as const)
                : (["execute", "read"] as const),
            promptResources: [],
          };
          return sessionId !== parentSessionId && role === "subagent"
            ? { ...common, role: "subagent", parentSessionId: parentSessionId! }
            : { ...common, role: "project" };
        },
        resolveSecretPort: ({ sessionId, projectId, wait, allowInjection }) => {
          const port = service.port(
            {
              sessionId,
              projectId,
              sessionLabel: "Session fixture",
              projectLabel: project.name,
            },
            wait,
            allowInjection,
          );
          return {
            ...port,
            request: async (input, signal) => {
              const waiting = port.request(input, signal);
              const list = service.list();
              if (!list.ok || list.requests.length !== 1) throw new Error("No request metadata");
              await service.submit(list.requests[0]!.id, sentinel, "session");
              return waiting;
            },
          };
        },
      });
      const engine = createDesktopSessionEngine(ctx.db);
      const runtime = createSessionRuntime({
        engine,
        clock: { now: Date.now },
        ids: { next: () => randomUUID() },
        executor: host.adapter,
        artifacts: createInMemoryTranscriptArtifactStore(),
        locations: {
          resolve: async () => ({ directory: worktree, venue: { id: "local", kind: "local" } }),
          prepare: async () => ({ directory: worktree, venue: { id: "local", kind: "local" } }),
          reaffirm: async () => undefined,
        },
      });
      const runTurn = async (sessionId: string) => {
        const attached = await runtime.command({
          commandId: `attach-${sessionId}`,
          sessionId,
          command: { kind: "adapter.attach", continuity: "fresh" },
        });
        expect(attached.receipt?.status, JSON.stringify(attached)).toBe("accepted");
        const sent = await runtime.command({
          commandId: `message-${sessionId}`,
          sessionId,
          command: {
            kind: "message.submit",
            message: {
              id: `message-${sessionId}`,
              role: "user",
              parts: [{ type: "text", text: "Run fixture" }],
            },
          },
        });
        expect(sent.receipt?.status, JSON.stringify(sent)).toBe("accepted");
        return runtime.snapshot({ sessionId });
      };
      try {
        const parent = await runtime.command({
          commandId: "create-parent",
          command: {
            kind: "session.create",
            projectId: project.id,
            ticketId: null,
            role: "project",
            parentSessionId: null,
            title: "Credential owner",
          },
        });
        parentSessionId = parent.sessionId;
        await runTurn(parentSessionId);
        // The parent really injected its Session-only credential into a command
        // and left plaintext in their shared workspace. A child need not inherit
        // that credential's environment to require output redaction.
        expect(readFileSync(join(worktree, "parent-receipt.txt"), "utf8")).toBe(sentinel);
        expect(toolResult(seen, "bash").content).toEqual([{ type: "text", text: `${marker}\n` }]);
        const reader = await runtime.command({
          commandId: "create-reader",
          command: {
            kind: "session.create",
            projectId: project.id,
            ticketId: null,
            role,
            parentSessionId: role === "subagent" ? parentSessionId : null,
            title: "Receipt reader",
          },
        });
        const snapshot = await runTurn(reader.sessionId);
        const read = toolResult(seen, "read");
        expect(service.environment(reader.sessionId)).not.toHaveProperty("STRIPE_API_KEY");
        const history = scan(join(root, "pi-sessions"));
        const readerHistory = history.filter((file) =>
          file.includes(`"volliSessionId":"${reader.sessionId}"`),
        );
        expect(readerHistory).toHaveLength(1);
        const events = await engine.listEvents({ sessionId: reader.sessionId });
        const rows = ctx.db.prepare("SELECT * FROM session_events").all();
        // Soft checks diagnose all three leak paths on the original adapter,
        // rather than stopping as soon as the provider observes the value.
        expect.soft(read.content).toEqual([{ type: "text", text: marker }]);
        expect.soft(JSON.stringify(seen).includes(sentinel), "Pi model context leaks").toBe(false);
        expect
          .soft(
            JSON.stringify({ snapshot, events, rows }).includes(sentinel),
            "SQLite history leaks",
          )
          .toBe(false);
        expect.soft(history.join("\n").includes(sentinel), "Pi saved history leaks").toBe(false);
        // Require the reader's own persisted result, not the parent's marker.
        expect
          .soft(
            readerHistory[0]!.includes(
              `"toolName":"read","content":[{"type":"text","text":"${marker}"}]`,
            ),
          )
          .toBe(true);
      } finally {
        await runtime.close();
      }
    },
  );
});
