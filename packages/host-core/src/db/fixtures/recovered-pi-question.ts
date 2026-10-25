import { LOCAL_RUNNER } from "@volli/shared";
import { copyFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSessionEngine,
  createSessionRuntime,
  sessionRootThreadId,
} from "@volli/session-engine";
import { scriptedProvider } from "../../../../agent-runtime/test-fixtures/scripted-provider";
import { openVolliDb } from "../database-file";
import { createSqliteSessionLedger } from "../../session-control/sqlite-ledger";
import { closeStaleAttachments } from "../../session-runtime/boot-recovery";
import { createPiNativeAdapter } from "../../session-runtime/pi-adapter";
import {
  createFileTranscriptArtifactStore,
  sessionTranscriptsRoot,
} from "../../session-runtime/transcript-artifacts";

const questions = [
  { question: "Which scope should survive?", choices: ["Keep it", "Replace it"] },
  { question: "When should it ship?", choices: [] },
];

/** Only the provider is scripted. Restore pre-close bytes so teardown cannot supply crash facts. */
export async function recoveredPiQuestion(input: {
  root: string;
  dbPath: string;
  sessionId: string;
  projectId: string;
  shape: "flat" | "questions";
}) {
  const { root, dbPath, sessionId, projectId, shape } = input;
  const directory = join(root, "repo");
  const sessionDataDir = join(root, "pi");
  let db = openVolliDb(dbPath);
  let clock = 1_791_100_100_000;
  let host: ReturnType<typeof createSessionRuntime> | undefined;
  const artifacts = createFileTranscriptArtifactStore(sessionTranscriptsRoot(root));
  function launch(ask: boolean) {
    const script = scriptedProvider(
      ask
        ? [
            {
              tool: {
                name: "ask_user",
                args:
                  shape === "questions"
                    ? { questions }
                    : {
                        question: questions[0]!.question,
                        options: [
                          { id: "keep", label: "Keep it" },
                          { id: "replace", label: "Replace it" },
                        ],
                      },
              },
            },
          ]
        : [],
    );
    const asked = Promise.withResolvers<void>();
    const engine = createSessionEngine({
      ledger: createSqliteSessionLedger(db),
      clock: { now: () => clock++ },
      ids: { next: (kind) => `head-pi-${kind}-${clock++}` },
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
        ticketId: "ticket-head",
        rootThreadId: sessionRootThreadId(sessionId),
        brief: "N−1 recovered question fixture",
        model: { providerId: "scripted-fixture", modelId: "scripted", reasoningLevel: "off" },
        toolSurface: ["read", "ask_user"],
        ...(shape === "questions" ? { askUserQuestions: true as const } : {}),
        promptResources: [],
      }),
    });
    host = createSessionRuntime({
      engine,
      executor: {
        ...adapter,
        attach: (spec, sink) =>
          adapter.attach(spec, {
            emit: async (observation) => {
              await sink.emit(observation);
              if (observation.kind === "interaction" && observation.state === "opened")
                asked.resolve();
            },
          }),
      },
      artifacts,
      // Deliberately leave the retained queue to N−1's host; this fixture sends
      // the explicit next message, including on releases predating that queue.
      locations: {
        resolve: async () => ({ directory, venue: LOCAL_RUNNER }),
        prepare: async () => ({ directory, venue: LOCAL_RUNNER }),
        reaffirm: async () => undefined,
      },
      clock: { now: () => clock++ },
      ids: { next: (kind) => `head-host-${kind}-${clock++}` },
    });
    return { engine, runtime: host, asked, script };
  }
  try {
    const first = launch(true);
    await first.engine.getOrRecordSessionInput({
      sessionId,
      input: {
        kind: "tool-surface",
        tools: ["read", "ask_user"],
        ...(shape === "questions" ? { askUserQuestions: true as const } : {}),
      },
      provenance: { source: { kind: "system", id: "fixture", detail: null }, venue: null },
    });
    const attached = await first.runtime.command({
      commandId: "head-question-attach",
      sessionId,
      command: { kind: "adapter.attach", continuity: "fresh" },
    });
    if (attached.receipt?.status !== "accepted") throw new Error(JSON.stringify(attached));
    const submitted = await first.runtime.command({
      commandId: "head-question-message",
      sessionId,
      command: {
        kind: "message.submit",
        settle: "opened",
        message: {
          id: "head-question-message",
          role: "user",
          parts: [{ type: "text", text: "Ask before proceeding." }],
        },
      },
    });
    if (submitted.receipt?.status !== "accepted") throw new Error(JSON.stringify(submitted));
    let askTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        first.asked.promise,
        new Promise<never>((_resolve, reject) => {
          askTimer = setTimeout(() => reject(new Error("Pi ask did not park")), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(askTimer);
    }
    const initial = (await first.runtime.snapshot({ sessionId })).projection;
    if (initial.interactions.active.length !== 1 || !initial.turnActive)
      throw new Error("No live pending question before crash");
    const sidecarPath = (
      initial.liveExecutor!.native!.detail as { locator: { sessionFilePath: string } }
    ).locator.sessionFilePath;
    const sidecars = new Map<string, Buffer>();
    for (const entry of readdirSync(sessionDataDir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name);
        sidecars.set(path, readFileSync(path));
      }
    }
    const backup = join(root, "before-question-crash.db");
    await db.backup(backup);
    await first.runtime.close();
    host = undefined;
    db.close();
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    copyFileSync(backup, dbPath);
    for (const [path, bytes] of sidecars) writeFileSync(path, bytes);
    db = openVolliDb(dbPath);
    const recovered = launch(false);
    const errors: unknown[] = [];
    await closeStaleAttachments({
      engine: recovered.engine,
      reconcile: (request) => recovered.runtime.reconcile(request),
      projectIds: [projectId],
      newId: () => `head-boot-${clock++}`,
      now: () => clock++,
      onError: (_id, error) => errors.push(error),
    });
    if (errors.length)
      throw new Error(`HEAD boot recovery failed: ${errors.map(String).join(", ")}`);
    if (recovered.script.requests.length)
      throw new Error("Recovery invented a provider continuation");
    // Leave the durable binding open: N−1 must cold-rehydrate this very Pi
    // identity and repaired sidecar, not start a fresh substitute conversation.
    return { question: initial.interactions.active[0]!, sidecarPath, sessionDataDir };
  } finally {
    await host?.close();
    db.close();
  }
}
