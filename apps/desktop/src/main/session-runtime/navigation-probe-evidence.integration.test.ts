/**
 * VC-1150: the navigation probe's host-evidence reader against the REAL
 * writer path. Writer/codec shape proof only — NOT Browser/CDP timing proof.
 *
 * Real: the probe's own Code Mode program in QuickJS, Pi, the Pi adapter and
 * nested-call activity observation, the Session observation translator, the
 * SQLite ledger, the file transcript artifact store (gzip + digest names), and
 * the probe's read-only SELECT run against that ledger. Scripted: only the
 * model's replies (the existing fixture, whose tool calls carry non-empty
 * `scripted-call-N` ids). Stand-in: the Browser port, at its runtime boundary,
 * answering in the exported `RuntimeBrowserPort` shapes; it records no trace,
 * so trace correlation is not covered here (browser/trace-steps.ts is).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createSqliteSessionLedger, openTestDb, testProject } from "@volli/host-core/testing";
import {
  createFileTranscriptArtifactStore,
  createPiNativeAdapter,
} from "@volli/host-core/session-runtime";
import { insertProject } from "@volli/host-core/db";
import {
  createSessionExecutorSlot,
  createSessionEngine,
  createSessionRuntime,
  sessionRootThreadId,
} from "@volli/session-engine";
import {
  codeModeSurfaceFor,
  type RuntimeBrowserPort,
  type RuntimeBrowserSnapshot,
  type SessionToolId,
} from "@volli/shared";
import { scriptedOpusProvider } from "../../../../../packages/agent-runtime/test-fixtures/code-mode-images-provider";
import {
  nestedSpanTiming,
  readTranscriptArtifact,
  settledSpans,
  transcriptReferences,
  transcriptReferenceSql,
} from "../../../e2e/volli-drive/lib/navigation-host-evidence.mjs";
import {
  navigationToolProgram,
  parseNavigationMetrics,
} from "../../../e2e/volli-drive/lib/navigation-picture-collector.mjs";

const MODEL = {
  providerId: "anthropic",
  modelId: "claude-opus-5-5",
  reasoningLevel: "off",
} as const;
const TAB = "55916e7a-fa6a-4ae1-8323-13b1052b5edc";
const FIXTURE_URL = "http://127.0.0.1:54947/";
const PNG = readFileSync(
  new URL("../../../../../packages/host-core/src/mcp/fixtures/paper-canvas.png", import.meta.url),
);
// Canonical order (sessionToolIds: coding tools, then NON_CODING_TOOL_IDS),
// which the adapter holds a frozen surface to.
const TOOLS: SessionToolId[] = [
  "read",
  "edit",
  "write",
  "execute",
  "browser_tabs",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "browser_screenshot",
  "browser_console",
  "codemode",
];

/** A Browser port at the runtime boundary, in the exported answer shapes. */
function fixturePort(sessionId: () => string): RuntimeBrowserPort & { turnEnded: () => void } {
  let clicked = 0;
  const page = () => ({
    tabId: TAB,
    url: FIXTURE_URL,
    title: `vc278 phase=compiling clicked=${clicked} nodes=903`,
    ownerSessionId: sessionId(),
    error: null,
  });
  const snapshot = (): RuntimeBrowserSnapshot => ({
    ...page(),
    snapshotText: '- button "Press me" [ref=e1]',
    generation: 1,
    truncated: false,
    empty: false,
    picture: null,
  });
  return {
    tabs: async () => ({
      tabs: [{ ...page(), createdBy: "session", heldBy: null }],
    }),
    navigate: async () => ({ ...snapshot(), picture: "nav-picture" }),
    snapshot: async () => snapshot(),
    act: async () => {
      clicked = 1;
      return {
        ...snapshot(),
        target: { ref: "e1", name: "Press me" },
        changed: { url: false, generation: false, tree: true },
      };
    },
    screenshot: async () => ({
      ...page(),
      base64Png: PNG.toString("base64"),
      picture: "shot-picture",
      width: PNG.readUInt32BE(16),
      height: PNG.readUInt32BE(20),
    }),
    console: async () => {
      throw new Error("The navigation program never reads the console");
    },
    turnEnded: () => undefined,
  };
}

describe("navigation probe host evidence through the real writer path (VC-1150)", () => {
  it("reads the program's real nested spans from the ledger's referenced artifacts", async () => {
    const database = openTestDb();
    try {
      const root = dirname(database.dbPath);
      const workspace = join(root, "workspace");
      mkdirSync(workspace);
      insertProject(database.db, testProject({ id: "project-nav", path: workspace }));
      const script = scriptedOpusProvider([
        { tool: { name: "codemode", args: { code: navigationToolProgram(FIXTURE_URL) } } },
        { text: "Navigation picture commands complete" },
      ]);
      let clock = 1_000;
      let sessionId = "";
      const engine = createSessionEngine({
        ledger: createSqliteSessionLedger(database.db),
        clock: { now: () => clock++ },
        ids: { next: (kind) => `${kind}-${clock++}` },
      });
      const codeMode = codeModeSurfaceFor({ tools: TOOLS, mode: "both" });
      const adapter = createPiNativeAdapter({
        sessionDataDir: join(root, "pi"),
        models: script.models,
        usageLimits: {
          fetch: async () => {
            throw new Error("Fixture has no network");
          },
        },
        resolveRuntimeContext: async (id) => ({
          role: "project",
          projectId: "project-nav",
          ticketId: null,
          rootThreadId: sessionRootThreadId(id),
          brief: "Run the navigation picture program.",
          model: MODEL,
          toolSurface: TOOLS,
          mcpTools: [],
          codeMode,
          promptResources: [],
        }),
        resolveBrowserPort: () => fixturePort(() => sessionId),
      });
      const transcripts = join(root, "session-transcripts");
      const artifacts = createFileTranscriptArtifactStore(transcripts);
      const host = createSessionRuntime({
        engine,
        executors: createSessionExecutorSlot(adapter),
        artifacts,
        locations: {
          resolve: async () => ({ directory: workspace, venue: { id: "local", kind: "local" } }),
          prepare: async () => ({ directory: workspace, venue: { id: "local", kind: "local" } }),
          reaffirm: async () => undefined,
        },
        clock: { now: () => clock++ },
        ids: { next: (kind) => `rt-${kind}-${clock++}` },
      });
      try {
        const created = await host.command({
          commandId: `create-${clock++}`,
          command: {
            kind: "session.create",
            projectId: "project-nav",
            ticketId: null,
            role: "project",
            parentSessionId: null,
            title: "Navigation probe evidence",
          },
        });
        sessionId = created.sessionId;
        await engine.getOrRecordSessionInput({
          sessionId,
          input: { kind: "tool-surface", tools: TOOLS, mcpTools: [], codeMode },
          provenance: { source: { kind: "system", id: "pi-runtime", detail: null }, venue: null },
        });
        const attached = await host.command({
          commandId: `attach-${clock++}`,
          sessionId,
          command: { kind: "adapter.attach", continuity: "fresh" },
        });
        expect(attached.receipt?.status, JSON.stringify(attached)).toBe("accepted");
        const submitted = await host.command({
          commandId: `submit-${clock++}`,
          sessionId,
          command: {
            kind: "message.submit",
            message: {
              id: `message-${clock++}`,
              role: "user",
              parts: [{ type: "text", text: "Run navigation picture discriminator" }],
            },
          },
        });
        expect(submitted.receipt?.status, JSON.stringify(submitted)).toBe("accepted");

        // The program's own record, from the real Code Mode result.
        const toolResult = script.requests
          .at(-1)
          ?.find(
            (message) => message.role === "toolResult" && message.toolCallId === "scripted-call-1",
          );
        expect(toolResult?.role).toBe("toolResult");
        if (toolResult?.role !== "toolResult") throw new Error("no Code Mode result");
        expect(toolResult.isError).toBe(false);
        const text = toolResult.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("\n");
        const record = /NAVIGATION_METRICS:(\{[^\n}]+\})/.exec(text)?.[1];
        expect(record, "program record").toBeDefined();
        const metrics = parseNavigationMetrics(record!);
        expect(metrics.tabId).toBe(TAB);
        expect(metrics.clickedWhileCompiling).toBe(true);

        // The probe's exact SELECT on the real ledger, then its reader.
        const rows = database.db.prepare(transcriptReferenceSql(sessionId)).all();
        // The helper is plain JS; state the reference shape it validated.
        const references: { sequence: number; turnId: string | null; id: string; hex: string }[] =
          transcriptReferences(rows);
        for (const reference of references) {
          // The store's own naming: a compressed artifact at the digest.
          expect(reference.id).toBe(`sha256:${reference.hex}`);
        }
        const read = references.map((reference) =>
          readTranscriptArtifact(transcripts, reference, readFileSync),
        );
        const spans = settledSpans(read);
        const timing = nestedSpanTiming({ spans, metrics });

        // The real outer id is the scripted provider's non-empty call id, and
        // every nested call is `<outer>:<program digest>:<n>` under it.
        expect(timing.outerId).toBe("scripted-call-1");
        expect(timing.nested).toBe(6);
        const nested = [...spans.values()].filter((span) => span.id !== "scripted-call-1");
        expect(nested.map((span) => span.tool)).toEqual([
          "browser_navigate",
          "browser_tabs",
          "browser_screenshot",
          "browser_snapshot",
          "browser_act",
          "browser_tabs",
        ]);
        expect(nested.every((span) => /^scripted-call-1:[^:]+:\d+$/.test(span.id))).toBe(true);
        // Real normalized inputs carry the tab id the program passed.
        expect([timing.shot.tabId, timing.read.tabId, timing.act.tabId]).toEqual([TAB, TAB, TAB]);
        expect(timing.navigate.tabId).toBeNull();
        // Real host times: finite, ordered, and NOT the program's pinned epoch.
        for (const span of [timing.navigate, timing.shot, timing.read, timing.act, timing.tabs]) {
          expect(Number.isFinite(span.startedAt) && span.startedAt <= span.endedAt).toBe(true);
        }
        expect(timing.shot.endedAt).toBeLessThanOrEqual(timing.act.startedAt);
        expect(new Set([metrics.requestedAt, metrics.clickAnsweredAt]).size).toBe(1);
      } finally {
        await host.close();
      }
    } finally {
      database.cleanup();
    }
  }, 30_000);
});
