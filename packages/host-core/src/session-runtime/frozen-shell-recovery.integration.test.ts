import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type RuntimeShellRecord, type SessionToolId } from "@volli/shared";
import {
  createSessionEngine,
  createSessionRuntime,
  sessionRootThreadId,
  type NativeAttachmentSpec,
} from "@volli/session-engine";
import {
  scriptedProvider,
  type ScriptedReply,
} from "../../../agent-runtime/test-fixtures/scripted-provider";
import { insertProject } from "../db/projects-repo";
import { openRawDb, openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { createPiNativeAdapter, type DesktopShellPort } from "./pi-adapter";
import { createFileTranscriptArtifactStore } from "./transcript-artifacts";

let db: TestDb;
let clock = 1_000;
const hosts: ReturnType<typeof createSessionRuntime>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  db.cleanup();
});

const PRE_SHELL_SURFACE: readonly SessionToolId[] = ["read", "edit", "write", "execute"];
const PRE_VC495_SURFACE: readonly SessionToolId[] = [
  ...PRE_SHELL_SURFACE,
  "shell_start",
  "shell_output",
  "shell_kill",
];
const PROVIDER_CODING_NAMES = ["read", "edit", "write", "bash"];

function fixture(replies: ScriptedReply[]) {
  db = openTestDb();
  const directory = join(dirname(db.dbPath), "workspace");
  const sessionDataDir = join(dirname(db.dbPath), "pi");
  mkdirSync(directory);
  insertProject(db.db, testProject({ id: "project-1", path: directory }));
  const script = scriptedProvider(replies);
  const venue = { id: "local", kind: "local" as const };
  const artifacts = createFileTranscriptArtifactStore(join(dirname(db.dbPath), "transcripts"));

  function launch() {
    const engine = createSessionEngine({
      ledger: createSqliteSessionLedger(db.db),
      clock: { now: () => clock++ },
      ids: { next: (kind) => `${kind}-${clock++}` },
    });
    const attachSpecs: NativeAttachmentSpec[] = [];
    const shell: RuntimeShellRecord = {
      shellId: "sh-rebound",
      command: "pnpm dev",
      title: "legacy dev",
      state: "running",
      code: null,
      signal: null,
      startedAt: clock,
      exitedAt: null,
    };
    // New host/port per launch: no live binding or shell capability is reused.
    const port = {
      start: vi.fn<DesktopShellPort["start"]>(async () => ({
        shell,
        pid: 4242,
        output: "server started\n",
        shells: [shell],
      })),
      output: vi.fn<DesktopShellPort["output"]>(async () => ({
        shell,
        output: "rebound output\n",
        truncated: false,
        tailBytes: 32,
        shells: [shell],
      })),
      kill: vi.fn<DesktopShellPort["kill"]>(async () => ({
        shell: { ...shell, state: "exited", signal: "SIGTERM", exitedAt: clock++ },
        shells: [],
      })),
      dispose: vi.fn(),
    } satisfies DesktopShellPort;
    const resolveShellPort = vi.fn(() => port);
    const adapter = createPiNativeAdapter({
      sessionDataDir,
      models: script.models,
      usageLimits: {
        fetch: async () => {
          throw new Error("fixture has no network");
        },
      },
      now: () => clock++,
      resolveShellPort,
      resolveRuntimeContext: async (sessionId) => {
        // Same durable input the desktop reads; not today's tool bundle or an
        // in-memory list supplied again to a new initial attach.
        const events = await engine.listEvents({ sessionId });
        const input = events.find(
          ({ payload }) =>
            payload.kind === "session.input.recorded" && payload.input.kind === "tool-surface",
        )?.payload;
        if (input?.kind !== "session.input.recorded" || input.input.kind !== "tool-surface") {
          throw new Error("Session has no recorded tool surface");
        }
        return {
          role: "project",
          projectId: "project-1",
          ticketId: null,
          rootThreadId: sessionRootThreadId(sessionId),
          brief: "Frozen shell recovery task",
          model: { providerId: "scripted-fixture", modelId: "scripted", reasoningLevel: "off" },
          toolSurface: input.input.tools,
          promptResources: [],
        };
      },
    });
    const host = createSessionRuntime({
      engine,
      executor: {
        ...adapter,
        attach: (spec, sink) => {
          attachSpecs.push(spec);
          return adapter.attach(spec, sink);
        },
      },
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
    return { engine, host, attachSpecs, port, resolveShellPort };
  }

  async function restart(prior: ReturnType<typeof launch>) {
    // close() frees process-local bindings without closing the durable
    // attachment. Reopening SQLite and constructing every host anew forces
    // message delivery down SessionRuntime.#rehydrateBinding/native_resume.
    await prior.host.close();
    hosts.splice(hosts.indexOf(prior.host), 1);
    db.db.close();
    db.db = openRawDb(db.dbPath);
    db.db.pragma("foreign_keys = ON");
    return launch();
  }
  return { ...launch(), launch, restart, directory, sessionDataDir, script };
}

async function start(f: ReturnType<typeof fixture>, surface: readonly SessionToolId[]) {
  const { sessionId } = await f.host.command({
    commandId: `create-${clock++}`,
    command: {
      kind: "session.create",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Frozen shell recovery",
    },
  });
  await f.engine.getOrRecordSessionInput({
    sessionId,
    input: { kind: "tool-surface", tools: surface },
    provenance: { source: { kind: "system", id: "pi-runtime", detail: null }, venue: null },
  });
  const attached = await f.host.command({
    commandId: `attach-${clock++}`,
    sessionId,
    command: { kind: "adapter.attach", continuity: "fresh" },
  });
  expect(attached.receipt?.status, JSON.stringify(attached)).toBe("accepted");
  return sessionId;
}

async function submit(
  host: ReturnType<typeof createSessionRuntime>,
  sessionId: string,
  text: string,
) {
  const result = await host.command({
    commandId: `submit-${clock++}`,
    sessionId,
    command: {
      kind: "message.submit",
      message: { id: `message-${clock++}`, role: "user", parts: [{ type: "text", text }] },
    },
  });
  expect(result.receipt?.status, JSON.stringify(result)).toBe("accepted");
}

function providerTools(request: ReturnType<typeof scriptedProvider>["requests"][number]) {
  const systems = request.filter((message) => message.role === "system");
  // These small, uncompacted turns must have one declaration and no tool
  // deltas. Read the actual provider request, not sessionToolIds(spec).
  expect(systems.flatMap((message) => message.toolsRemoved ?? [])).toEqual([]);
  expect(systems.slice(1).flatMap((message) => message.toolsAdded ?? [])).toEqual([]);
  return systems[0]?.toolsAdded ?? [];
}

// The provider and shell process port are scripted; Pi tools/schema validation,
// sidecar persistence, adapter binding, SessionRuntime recovery and SQLite are real.
describe("frozen shell surface recovery (VC-495)", () => {
  it.each([
    { label: "pre-shell", surface: PRE_SHELL_SURFACE, hasShell: false },
    { label: "pre-VC495 shell trio", surface: PRE_VC495_SURFACE, hasShell: true },
  ])(
    "resumes a $label Session through its persisted native binding",
    async ({ surface, hasShell }) => {
      const replies: ScriptedReply[] = [{ text: "established before restart" }];
      const f = fixture(replies);
      const sessionId = await start(f, surface);
      await submit(f.host, sessionId, "before restart");
      const initial = (await f.host.snapshot({ sessionId })).projection;
      const attachment = initial.liveExecutor!;
      const native = attachment.native!;
      expect(f.attachSpecs).toHaveLength(1);
      expect(f.attachSpecs[0]).toMatchObject({ continuity: "fresh", native: null });
      expect(native).toMatchObject({
        id: expect.any(String),
        detail: {
          kind: "volli.native-binding.v1",
          directory: f.directory,
          locator: { runtime: "pi", sessionId: native.id, sessionFilePath: expect.any(String) },
        },
      });
      if (
        native.detail === null ||
        typeof native.detail !== "object" ||
        Array.isArray(native.detail) ||
        !("locator" in native.detail)
      ) {
        throw new Error("Native binding envelope is missing");
      }
      const locator = native.detail.locator;
      const sidecars = readdirSync(f.sessionDataDir, { recursive: true });
      const restarted = await f.restart(f);
      expect(restarted.attachSpecs).toEqual([]);
      expect(f.port.dispose).toHaveBeenCalledOnce();

      if (hasShell) {
        replies.push(
          // The exact pre-VC495 call shape: no notifyOn or notifyOnRegex.
          {
            tool: {
              name: "shell_start",
              args: { command: "pnpm dev", cwd: f.directory, title: "legacy dev" },
            },
          },
          { tool: { name: "shell_output", args: { shellId: "sh-rebound", tail: 32 } } },
          { tool: { name: "shell_kill", args: { shellId: "sh-rebound" } } },
          { text: "rebound shell complete" },
        );
      } else {
        replies.push(
          {
            tool: {
              name: "write",
              args: { path: "after-resume.txt", content: "old tools still execute" },
            },
          },
          { text: "pre-shell surface complete" },
        );
      }
      await submit(restarted.host, sessionId, "after restart");

      // No adapter.attach command was sent after restart: the first message
      // rebuilt the old open attachment from its stored locator, using Pi's
      // existing JSONL conversation rather than creating another sidecar.
      expect(restarted.attachSpecs).toHaveLength(1);
      expect(restarted.attachSpecs[0]).toMatchObject({
        sessionId,
        attachmentId: attachment.id,
        directory: f.directory,
        continuity: "native_resume",
        native: { id: native.id, detail: locator },
      });
      expect(restarted.attachSpecs[0]).not.toHaveProperty("pinnedAuthority");
      expect(readdirSync(f.sessionDataDir, { recursive: true })).toEqual(sidecars);
      const recovered = (await restarted.host.snapshot({ sessionId })).projection;
      expect(recovered.attachments).toHaveLength(1);
      expect(recovered.liveExecutor?.native).toEqual(native);
      const events = await restarted.engine.listEvents({ sessionId });
      expect(events.filter(({ payload }) => payload.kind === "attachment.opened")).toHaveLength(1);
      expect(
        events.filter(({ payload }) => payload.kind === "session.input.recorded"),
      ).toHaveLength(1);
      const expectedNames = [
        ...PROVIDER_CODING_NAMES,
        ...(hasShell ? ["shell_start", "shell_output", "shell_kill"] : []),
      ];
      for (const request of f.script.requests) {
        expect(providerTools(request).map((tool) => tool.name)).toEqual(expectedNames);
      }
      const resumedRequest = f.script.requests[1]!;
      expect(JSON.stringify(resumedRequest)).toContain("before restart");
      expect(JSON.stringify(resumedRequest)).toContain("established before restart");

      expect(restarted.resolveShellPort).toHaveBeenCalledExactlyOnceWith({
        projectId: "project-1",
        ticketId: null,
        sessionId,
        attachmentId: attachment.id,
        workspacePath: f.directory,
      });
      expect(f.port.start).not.toHaveBeenCalled();
      expect(f.port.output).not.toHaveBeenCalled();
      expect(f.port.kill).not.toHaveBeenCalled();
      if (hasShell) {
        const startTool = providerTools(resumedRequest).find(({ name }) => name === "shell_start")!;
        expect(startTool.parameters).toMatchObject({ required: ["command"] });
        expect(restarted.port.start).toHaveBeenCalledExactlyOnceWith({
          command: "pnpm dev",
          cwd: f.directory,
          title: "legacy dev",
          signal: expect.any(AbortSignal),
        });
        expect(restarted.port.output).toHaveBeenCalledExactlyOnceWith({
          shellId: "sh-rebound",
          tail: 32,
          signal: expect.any(AbortSignal),
        });
        expect(restarted.port.kill).toHaveBeenCalledExactlyOnceWith({
          shellId: "sh-rebound",
          signal: expect.any(AbortSignal),
        });
        const results = f.script.requests
          .at(-1)!
          .filter((message) => message.role === "toolResult");
        expect(results.map(({ toolName }) => toolName)).toEqual([
          "shell_start",
          "shell_output",
          "shell_kill",
        ]);
        expect(results.every((message) => !message.isError)).toBe(true);
        expect(JSON.stringify(results)).toContain("rebound output");
        expect(JSON.stringify(results)).toContain("SIGTERM");
      } else {
        expect(restarted.port.start).not.toHaveBeenCalled();
        expect(restarted.port.output).not.toHaveBeenCalled();
        expect(restarted.port.kill).not.toHaveBeenCalled();
        expect(readFileSync(join(f.directory, "after-resume.txt"), "utf8")).toBe(
          "old tools still execute",
        );
      }
    },
  );
});
