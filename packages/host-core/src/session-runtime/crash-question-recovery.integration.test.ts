import { afterEach, describe, expect, it } from "vite-plus/test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createSessionEngine,
  createSessionRuntime,
  sessionRootThreadId,
} from "@volli/session-engine";
import type { SessionInteractionPrompt } from "@volli/shared";
import {
  scriptedProvider,
  type ScriptedReply,
} from "../../../agent-runtime/test-fixtures/scripted-provider";
import { insertProject } from "../db/projects-repo";
import { openRawDb, openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { closeStaleAttachments } from "./boot-recovery";
import { createPiNativeAdapter } from "./pi-adapter";
import { createFileTranscriptArtifactStore } from "./transcript-artifacts";

let db: TestDb;
let clock = 1_000;
const hosts: ReturnType<typeof createSessionRuntime>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  db.cleanup();
});

const prompts: SessionInteractionPrompt[] = [
  {
    id: "scope",
    label: "Which scope?",
    detail: null,
    options: [{ id: "small", label: "Small", description: null }],
    multiple: false,
    custom: true,
  },
  {
    id: "timing",
    label: "When should it ship?",
    detail: null,
    options: [],
    multiple: false,
    custom: true,
  },
];

function fixture(shape: "flat" | "questions") {
  db = openTestDb();
  const directory = join(dirname(db.dbPath), "workspace");
  const sessionDataDir = join(dirname(db.dbPath), "pi");
  mkdirSync(directory);
  insertProject(db.db, testProject({ id: "project-1", path: directory }));
  const venue = { id: "local", kind: "local" as const };
  const artifacts = createFileTranscriptArtifactStore(join(dirname(db.dbPath), "transcripts"));

  function launch(replies: ScriptedReply[]) {
    const script = scriptedProvider(replies);
    const asked = Promise.withResolvers<void>();
    const engine = createSessionEngine({
      ledger: createSqliteSessionLedger(db.db),
      clock: { now: () => clock++ },
      ids: { next: (kind) => `${kind}-${clock++}` },
    });
    const adapter = createPiNativeAdapter({
      sessionDataDir,
      models: script.models,
      now: () => clock++,
      usageLimits: {
        fetch: async () => {
          throw new Error("fixture has no network");
        },
      },
      resolveRuntimeContext: async (sessionId) => ({
        role: "project",
        projectId: "project-1",
        ticketId: null,
        rootThreadId: sessionRootThreadId(sessionId),
        brief: "Crash recovery task",
        model: { providerId: "scripted-fixture", modelId: "scripted", reasoningLevel: "off" },
        toolSurface: ["read", "ask_user"],
        promptResources: [],
      }),
    });
    const host = createSessionRuntime({
      engine,
      executor: {
        ...adapter,
        attach: (spec, sink) =>
          adapter.attach(spec, {
            emit: async (observation) => {
              // Exercise a persisted multi-prompt card independently of which
              // ask_user schema this build declares for newly born Sessions.
              if (
                shape === "questions" &&
                observation.kind === "interaction" &&
                observation.state === "opened"
              ) {
                observation = {
                  ...observation,
                  interaction: { ...observation.interaction, prompts },
                };
              }
              await sink.emit(observation);
              if (observation.kind === "interaction" && observation.state === "opened")
                asked.resolve();
            },
          }),
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
    return { engine, host, script, asked };
  }
  return { launch, directory, sessionDataDir };
}

// Provider responses are scripted; Pi, its sidecar, the adapter, Session Engine,
// event codec and SQLite are real. Restore the pre-loss ledger/sidecar after
// releasing the live fixture so graceful teardown cannot supply crash evidence.
describe("crash-recovered model questions (VC-753)", () => {
  it.each(["flat", "questions"] as const)(
    "abandons a %s ask durably without an invented answer",
    async (shape) => {
      const f = fixture(shape);
      const first = f.launch([
        {
          tool: {
            name: "ask_user",
            args: { question: "Which scope?", options: [{ id: "small", label: "Small" }] },
          },
        },
      ]);
      const created = await first.host.command({
        commandId: "create",
        command: {
          kind: "session.create",
          projectId: "project-1",
          ticketId: null,
          role: "project",
          parentSessionId: null,
          title: "Recover question",
        },
      });
      const sessionId = created.sessionId;
      await first.engine.getOrRecordSessionInput({
        sessionId,
        input: { kind: "tool-surface", tools: ["read", "ask_user"] },
        provenance: { source: { kind: "system", id: "pi-runtime", detail: null }, venue: null },
      });
      await first.host.command({
        commandId: "attach",
        sessionId,
        command: { kind: "adapter.attach", continuity: "fresh" },
      });
      const submit = await first.host.command({
        commandId: "first-message",
        sessionId,
        command: {
          kind: "message.submit",
          settle: "opened",
          message: {
            id: "first-message",
            role: "user",
            parts: [{ type: "text", text: "Plan this." }],
          },
        },
      });
      expect(submit.receipt?.status).toBe("accepted");
      await first.asked.promise;
      const initial = (await first.host.snapshot({ sessionId })).projection;
      expect(initial.interactions.active).toHaveLength(1);
      expect(initial.turnActive).toBe(true);
      const sidecarPath = (
        initial.liveExecutor!.native!.detail as { locator: { sessionFilePath: string } }
      ).locator.sessionFilePath;
      let sidecar = readFileSync(sidecarPath, "utf8");
      if (shape === "questions") {
        // The persisted call's arguments need not match today's flat schema: a
        // continuation must retain old multi-question text without re-executing it.
        sidecar = sidecar
          .split("\n")
          .map((line) => {
            if (!line) return line;
            const parsed = JSON.parse(line);
            for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
              for (const block of entry.message?.content ?? []) {
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
            return JSON.stringify(parsed);
          })
          .join("\n");
      }
      const backup = join(dirname(db.dbPath), "before-crash.db");
      await db.db.backup(backup);
      await first.host.close();
      hosts.splice(hosts.indexOf(first.host), 1);
      db.db.close();
      copyFileSync(backup, db.dbPath);
      writeFileSync(sidecarPath, sidecar);
      db.db = openRawDb(db.dbPath);
      db.db.pragma("foreign_keys = ON");

      const recovered = f.launch([{ text: "Continued without an answer." }]);
      const errors: unknown[] = [];
      await closeStaleAttachments({
        engine: recovered.engine,
        reconcile: (input) => recovered.host.reconcile(input),
        projectIds: ["project-1"],
        newId: () => `boot-${clock++}`,
        now: () => clock++,
        onError: (_attachmentId, error) => errors.push(error),
      });
      // Replaying the first accepted receipt must not falsely close the binding.
      expect(errors).toEqual([]);
      const afterBoot = (await recovered.host.snapshot({ sessionId })).projection;
      expect(afterBoot.interactions.active).toEqual([]);
      expect(afterBoot.liveExecutor).not.toBeNull();
      const events = await recovered.engine.listEvents({ sessionId });
      expect(events.map(({ payload }) => payload)).toContainEqual(
        expect.objectContaining({
          kind: "interaction.cancelled",
          interactionId: initial.interactions.active[0]!.id,
          reason: "abandoned",
        }),
      );
      expect(events.filter(({ payload }) => payload.kind === "interaction.resolved")).toEqual([]);
      const pending = events.find(({ payload }) => payload.kind === "interaction.opened")?.payload;
      expect(pending).toMatchObject({
        kind: "interaction.opened",
        interaction: { title: "Which scope?" },
      });
      if (shape === "questions") expect(pending).toMatchObject({ interaction: { prompts } });

      // A second launch sees the cancellation and the same one failed result.
      await recovered.host.close();
      hosts.splice(hosts.indexOf(recovered.host), 1);
      db.db.close();
      db.db = openRawDb(db.dbPath);
      db.db.pragma("foreign_keys = ON");
      const relaunched = f.launch([{ text: "Continued without an answer." }]);
      expect(
        (await relaunched.host.snapshot({ sessionId })).projection.interactions.active,
      ).toEqual([]);
      await relaunched.host.reconcile({ sessionId, attachmentId: initial.liveExecutor!.id });
      const next = await relaunched.host.command({
        commandId: "next-message",
        sessionId,
        command: {
          kind: "message.submit",
          message: {
            id: "next-message",
            role: "user",
            parts: [{ type: "text", text: "Continue without that decision." }],
          },
        },
      });
      expect(next.receipt?.status, JSON.stringify(next)).toBe("accepted");
      expect(relaunched.script.requests).toHaveLength(1);
      const messages = relaunched.script.requests[0]!;
      expect(JSON.stringify(messages)).toContain("Which scope?");
      if (shape === "questions") expect(JSON.stringify(messages)).toContain("When should it ship?");
      const results = messages.filter(
        (message) => message.role === "toolResult" && message.toolName === "ask_user",
      );
      expect(results).toEqual([
        expect.objectContaining({
          isError: true,
          content: [
            {
              type: "text",
              text: "The question was abandoned when the runtime restarted. No answer was obtained.",
            },
          ],
        }),
      ]);
      expect(JSON.stringify(results)).not.toContain("Chose:");
      const accepted = (await relaunched.engine.listEvents({ sessionId })).filter(
        ({ payload }) =>
          payload.kind === "command.receipt.recorded" &&
          payload.receipt.commandId === "first-message",
      );
      expect(accepted).toHaveLength(1);
    },
  );
});
