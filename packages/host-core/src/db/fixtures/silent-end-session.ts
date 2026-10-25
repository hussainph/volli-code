import { copyFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSessionExecutorSlot,
  createSessionEngine,
  createSessionRuntime,
  sessionRootThreadId,
} from "@volli/session-engine";
import { createPiAgentRuntime } from "@volli/agent-runtime";
import { LOCAL_RUNNER, type RuntimeAttachmentHandle, type SessionRuntimeSpec } from "@volli/shared";
import { scriptedProvider } from "../../../../agent-runtime/test-fixtures/scripted-provider";
import { openVolliDb } from "../database-file";
import { createSqliteSessionLedger } from "../../session-control/sqlite-ledger";
import { createPiNativeAdapter } from "../../session-runtime/pi-adapter";
import {
  createFileTranscriptArtifactStore,
  sessionTranscriptsRoot,
} from "../../session-runtime/transcript-artifacts";

export const SILENT_END_MESSAGE = "Head message before the silent end";
export const FATAL_DIAGNOSTIC = "The fixture runtime stopped unexpectedly";
export type SilentEndScenario = "fatal attachment" | "Stop racing finish";

/** Head writes the ledger, artifacts AND Pi sidecar; only provider output/fatal callback are injected. */
export async function silentEndSession(input: {
  root: string;
  dbPath: string;
  projectId: string;
  sessionId: string;
  scenario: SilentEndScenario;
}) {
  const { root, dbPath, projectId, sessionId, scenario } = input;
  const directory = join(root, "repo");
  const sessionDataDir = join(root, "silent-end-pi");
  const db = openVolliDb(dbPath);
  let clock = 1_791_100_200_000;
  const now = () => clock++;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const terminal = Promise.withResolvers<void>();
  let observe: SessionRuntimeSpec["observer"] | undefined;
  let handle: RuntimeAttachmentHandle | undefined;
  const script = scriptedProvider([
    {
      text: "Provider finished normally despite Stop",
      wait: async (signal) => {
        // Deliberately return a NORMAL finish after abort, not an aborted provider error.
        signal!.addEventListener("abort", () => release.resolve(), { once: true });
        entered.resolve();
        await release.promise;
      },
    },
  ]);
  const engine = createSessionEngine({
    ledger: createSqliteSessionLedger(db),
    clock: { now },
    ids: { next: (kind) => `silent-head-${kind}-${now()}` },
  });
  const adapter = createPiNativeAdapter({
    createRuntime: (options) => {
      const runtime = createPiAgentRuntime(options);
      return {
        ...runtime,
        startSession: async (spec) => {
          observe = spec.observer;
          handle = await runtime.startSession(spec);
          return handle;
        },
      };
    },
    sessionDataDir,
    models: script.models,
    now,
    readWorkspaceEnvironment: () => ({ dependencies: null, installCommand: null }),
    usageLimits: {
      fetch: async () => {
        throw new Error("Fixture has no network");
      },
    },
    resolveRuntimeContext: async () => ({
      role: "ticket",
      projectId,
      ticketId: "ticket-head",
      rootThreadId: sessionRootThreadId(sessionId),
      brief: "N−1 silent end fixture",
      model: { providerId: "scripted-fixture", modelId: "scripted", reasoningLevel: "off" },
      toolSurface: ["read"],
      promptResources: [],
    }),
  });
  const runtime = createSessionRuntime({
    engine,
    executors: createSessionExecutorSlot({
      ...adapter,
      attach: (spec, sink) =>
        adapter.attach(spec, {
          emit: async (observation) => {
            await sink.emit(observation);
            if (observation.kind === "turn" && observation.state !== "started") terminal.resolve();
          },
        }),
    }),
    artifacts: createFileTranscriptArtifactStore(sessionTranscriptsRoot(root)),
    locations: {
      resolve: async () => ({ directory, venue: LOCAL_RUNNER }),
      prepare: async () => ({ directory, venue: LOCAL_RUNNER }),
      reaffirm: async () => undefined,
    },
    clock: { now },
    ids: { next: (kind) => `silent-host-${kind}-${now()}` },
  });
  let saved: { backup: string; sidecars: Map<string, Buffer> } | undefined;
  try {
    const attached = await runtime.command({
      commandId: "silent-head-attach",
      sessionId,
      command: { kind: "adapter.attach", continuity: "fresh" },
    });
    if (attached.receipt?.status !== "accepted") throw new Error(JSON.stringify(attached));
    const submitted = await runtime.command({
      commandId: "silent-head-message",
      sessionId,
      command: {
        kind: "message.submit",
        settle: "opened",
        message: {
          id: "silent-head-message",
          role: "user",
          parts: [{ type: "text", text: SILENT_END_MESSAGE }],
        },
      },
    });
    if (submitted.receipt?.status !== "accepted") throw new Error(JSON.stringify(submitted));
    await entered.promise;
    const live = (await runtime.snapshot({ sessionId })).projection;
    if (!live.turnActive) throw new Error("Fixture did not enter a live turn");
    const sidecarPath = handle!.recovery!.sessionFilePath;
    if (scenario === "fatal attachment") {
      await observe!({
        kind: "attachment",
        state: "failed",
        failure: {
          reason: "unknown",
          message: FATAL_DIAGNOSTIC,
        },
      });
    } else {
      await runtime.command({
        commandId: "silent-head-stop",
        sessionId,
        command: { kind: "executor.interrupt" },
      });
      await terminal.promise;
    }
    const snapshot = await runtime.snapshot({ sessionId });
    const events = await engine.listEvents({ sessionId });
    const sidecar = readFileSync(sidecarPath, "utf8");
    // Capture BEFORE cleanup. A fatal callback retires the host binding but its
    // real Pi handle still needs draining; that drain must not supply fixture facts.
    const sidecars = new Map<string, Buffer>();
    for (const entry of readdirSync(sessionDataDir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name);
        sidecars.set(path, readFileSync(path));
      }
    }
    const backup = join(root, "before-silent-end-teardown.db");
    await db.backup(backup);
    saved = { backup, sidecars };
    return { snapshot, events, sidecar, sidecarPath, sessionDataDir };
  } finally {
    release.resolve();
    await runtime.close();
    await handle?.close();
    db.close();
    if (saved) {
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      copyFileSync(saved.backup, dbPath);
      for (const [path, bytes] of saved.sidecars) writeFileSync(path, bytes);
    }
  }
}
