import { LOCAL_RUNNER } from "@volli/shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { piExecutionEnv } from "@volli/agent-runtime";
import {
  createSessionExecutorSlot,
  createSessionEngine,
  createSessionRuntime,
  sessionRootThreadId,
} from "@volli/session-engine";
import { scriptedProvider } from "../../../../agent-runtime/test-fixtures/scripted-provider";
import { openVolliDb } from "../database-file";
import { createSqliteSessionLedger } from "../../session-control/sqlite-ledger";
import { BackgroundShellHost } from "../../shell/background-shell-host";
import { createAgentShellPort } from "../../shell/agent-port";
import { createPiNativeAdapter } from "../../session-runtime/pi-adapter";
import {
  createFileTranscriptArtifactStore,
  sessionTranscriptsRoot,
} from "../../session-runtime/transcript-artifacts";

/** A supported production birth: handoff requires all three existing shell tools. */
export const MOVED_BASH_TOOLS = [
  "read",
  "edit",
  "write",
  "execute",
  "shell_start",
  "shell_output",
  "shell_kill",
] as const;

export interface MovedPiBash {
  /** The background shell the moved call became, as the head build named it. */
  shellId: string;
  /** The head's Pi recovery sidecar: a real Pi session file, holding the moved receipt. */
  sessionFilePath: string;
  /** The directory that owns every attachment's Pi sidecar. */
  sessionDataDir: string;
}

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Runs a real bash call on HEAD and moves it to the background while the
 * child is still running, so the receipt the model sees is the moved one. The
 * build under test is this one: its Pi adapter, foreground executor, background
 * shell host, SQLite ledger and sidecar, with a real `/bin/bash` child. Only the
 * provider is scripted.
 *
 * The runtime is closed, but the Session's Pi attachment stays open in the
 * ledger, as it does after a relaunch, so N-1 must cold-rehydrate the same
 * sidecar rather than start a substitute conversation. The moved process has
 * printed its last line by then, and the host's shutdown kills anything still
 * running.
 */
export async function movedPiBash(input: {
  root: string;
  dbPath: string;
  sessionId: string;
  projectId: string;
  ticketId: string;
  workspace: string;
}): Promise<MovedPiBash> {
  const { root, dbPath, sessionId, projectId, ticketId, workspace } = input;
  const sessionDataDir = join(root, "pi");
  const script = scriptedProvider([
    // The child outlives its first output, so the move lands on a running process.
    // The deadline is generous so that it cannot win the race against the move.
    { tool: { name: "bash", args: { command: "echo before; sleep 1; echo after", timeout: 5 } } },
    { text: "The turn continued." },
  ]);
  const shells = new BackgroundShellHost({
    publishState() {},
    publishRemoved() {},
    exitNoticeGraceMs: 20,
    killGraceMs: 30,
    settleMs: 5,
  });
  let captured = "";
  let runtime: ReturnType<typeof createSessionRuntime> | undefined;
  const db = openVolliDb(dbPath);
  try {
    let clock = 1_791_100_300_000;
    const engine = createSessionEngine({
      ledger: createSqliteSessionLedger(db),
      clock: { now: () => clock++ },
      ids: { next: (kind) => `moved-${kind}-${clock++}` },
    });
    const adapter = createPiNativeAdapter({
      sessionDataDir,
      models: script.models,
      now: () => clock++,
      usageLimits: {
        fetch: async () => {
          throw new Error("Fixture has no network");
        },
      },
      resolveRuntimeContext: async () => ({
        role: "ticket",
        projectId,
        ticketId,
        rootThreadId: sessionRootThreadId(sessionId),
        brief: "VC-757 moved bash fixture",
        model: { providerId: "scripted-fixture", modelId: "scripted", reasoningLevel: "off" },
        toolSurface: [...MOVED_BASH_TOOLS],
        promptResources: [],
      }),
      resolveShellPort: (scope) =>
        createAgentShellPort({
          host: shells,
          scope,
          session: scope,
          workspacePath: workspace,
          identity: { sessionId: scope.sessionId, ticketDisplayId: null },
          pathPrefixes: [],
        }),
      executionEnvFactory: (workspacePath, identity) =>
        piExecutionEnv(workspacePath, {
          identity: { sessionId: identity.sessionId, ticketDisplayId: null },
          foregroundExecutor: (call) =>
            shells.runForeground(
              { sessionId, attachmentId: identity.attachmentId, projectId, ticketId },
              {
                command: call.command,
                shellConfig: call.shellConfig,
                cwd: call.cwd,
                env: call.env,
                title: null,
              },
              {
                toolCallId: call.toolCallId,
                timeout: call.timeout,
                signal: call.signal,
                onChunk: (chunk) => {
                  captured += Buffer.from(chunk).toString("utf8");
                  call.onOutput(chunk);
                },
                onReady: call.onReady,
              },
            ),
        }),
    });
    runtime = createSessionRuntime({
      engine,
      executors: createSessionExecutorSlot(adapter),
      artifacts: createFileTranscriptArtifactStore(sessionTranscriptsRoot(root)),
      locations: {
        resolve: async () => ({ directory: workspace, venue: LOCAL_RUNNER }),
        prepare: async () => ({ directory: workspace, venue: LOCAL_RUNNER }),
        reaffirm: async () => undefined,
      },
      clock: { now: () => clock++ },
      ids: { next: (kind) => `moved-runtime-${kind}-${clock++}` },
    });
    await engine.getOrRecordSessionInput({
      sessionId,
      input: { kind: "tool-surface", tools: [...MOVED_BASH_TOOLS] },
      provenance: { source: { kind: "system", id: "fixture", detail: null }, venue: null },
    });
    const attached = await runtime.command({
      commandId: "moved-attach",
      sessionId,
      command: { kind: "adapter.attach", continuity: "fresh" },
    });
    if (attached.receipt?.status !== "accepted") throw new Error(JSON.stringify(attached));
    const pending = runtime.command({
      commandId: "moved-submit",
      sessionId,
      command: {
        kind: "message.submit",
        message: {
          id: "moved-user",
          role: "user",
          parts: [{ type: "text", text: "Run a command." }],
        },
      },
    });
    // Awaited below; a failure before then must surface as the wait's error, not as an unhandled rejection.
    pending.catch(() => undefined);
    await until(
      () => shells.foregroundAvailable(sessionId, "scripted-call-1"),
      "the bash call to start",
    );
    // Wait for the actual child bytes, not a spawn-only fake.
    await until(() => captured.includes("before"), "the bash child to print");
    const moved = shells.moveForeground(sessionId, "scripted-call-1");
    const submitted = await pending;
    if (submitted.receipt?.status !== "accepted") throw new Error(JSON.stringify(submitted));

    // The move was a real handoff: the process kept running and finished.
    await until(
      () => shells.read({ sessionId }, moved.shellId, 64_000).output.includes("after"),
      "the moved shell to finish",
    );

    const snapshot = await runtime.snapshot({ sessionId });
    if (snapshot.projection.lastTurnOutcome !== "completed") {
      throw new Error(`Moved turn did not complete: ${snapshot.projection.lastTurnOutcome}`);
    }
    const binding = snapshot.projection.liveExecutor?.native?.detail as
      | { locator: { sessionFilePath: string } }
      | null
      | undefined;
    const sessionFilePath = binding?.locator.sessionFilePath;
    if (sessionFilePath === undefined) throw new Error("Head attachment has no Pi sidecar");
    const sidecar = readFileSync(sessionFilePath, "utf8");
    if (!sidecar.includes(`Moved command to background shell ${moved.shellId}`)) {
      throw new Error("Head sidecar does not hold the moved receipt");
    }
    return { shellId: moved.shellId, sessionFilePath, sessionDataDir };
  } finally {
    await runtime?.close();
    await shells.close();
    db.close();
  }
}
