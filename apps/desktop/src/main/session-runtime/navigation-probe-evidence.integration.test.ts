/**
 * VC-1150: the navigation probe's host-evidence reader against the REAL
 * writer path. Writer/codec shape proof only — NOT Browser/CDP timing proof.
 *
 * Real: the probe's own Code Mode program in QuickJS, Pi, the Pi adapter and
 * nested-call activity observation, the Session observation translator, the
 * SQLite ledger, the file transcript artifact store (gzip + digest names), and
 * the probe's read-only SELECT run against that ledger. Scripted: only the
 * model's replies (the existing fixture, whose tool calls carry non-empty
 * `scripted-call-N` ids). The Browser port is the REAL agent port
 * (`browserAgentPort`, whose `traced.*` wrappers write every trace step) into a
 * real `BrowserTraceStore`. Stand-ins: only the engine under it — a backend
 * holding one tab and a scripted CDP transport — and a SIMULATED second
 * navigation bump (cf. chromium-backend `frameStartedNavigating`) that moves
 * the tab past the navigate answer's generation once the screenshot is kept,
 * so the snapshot and the click run at a generation the navigation never
 * reported.
 */
import { randomUUID } from "node:crypto";
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
  browserAgentPort,
  BrowserTraceStore,
  type BrowserBackend,
  type CdpTransport,
} from "@volli/host-core/browser";
// Internal to host-core (no entry exports it); the agent port's own queues.
import { BrowserAgentCoordinator } from "../../../../../packages/host-core/src/browser/agent-coordinator";
import {
  createSessionExecutorSlot,
  createSessionEngine,
  createSessionRuntime,
  sessionRootThreadId,
} from "@volli/session-engine";
import { codeModeSurfaceFor, type BrowserTabState, type SessionToolId } from "@volli/shared";
import { scriptedOpusProvider } from "../../../../../packages/agent-runtime/test-fixtures/code-mode-images-provider";
import {
  navigationTiming,
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
  "browser_acquire",
  "browser_release",
  "browser_find",
  "codemode",
];

/** The one-button page every AX read answers with. */
const PAGE_TREE = {
  nodes: [
    {
      nodeId: "1",
      ignored: false,
      role: { value: "RootWebArea" },
      name: { value: "Fixture" },
      childIds: ["2"],
    },
    {
      nodeId: "2",
      ignored: false,
      role: { value: "button" },
      name: { value: "Press me" },
      backendDOMNodeId: 77,
      childIds: [],
    },
  ],
};

/** A backend door the navigation program never reaches. */
const unused = (): never => {
  throw new Error("The navigation program never reaches this backend door");
};

/**
 * The engine under the real agent port: one headless Session tab and a
 * scripted CDP wire. Everything the trace records is decided by the port.
 */
function fixtureBackend(traces: BrowserTraceStore): BrowserBackend {
  const agentOperations = new BrowserAgentCoordinator();
  const tabs = new Map<string, BrowserTabState>();
  const holds = new Set<string>();
  let clicked = 0;
  let bumped = false;
  const view = (tabId: string): BrowserTabState => {
    const tab = tabs.get(tabId);
    if (tab === undefined) throw new Error("Unknown Browser Tab");
    return {
      ...tab,
      title: `vc278 phase=compiling clicked=${clicked} nodes=903`,
      heldBy: holds.has(tabId)
        ? {
            kind: "session",
            sessionId: tab.ownerSessionId ?? "",
            name: "Fixture",
            color: "#123456",
          }
        : null,
    };
  };
  const transport: CdpTransport = {
    send: async (method, params) => {
      if (method === "Accessibility.getFullAXTree") return PAGE_TREE;
      if (method === "DOM.getBoxModel")
        return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
      if (method === "Page.getLayoutMetrics") {
        return {
          cssVisualViewport: {
            clientWidth: PNG.readUInt32BE(16),
            clientHeight: PNG.readUInt32BE(20),
          },
        };
      }
      if (method === "Page.captureScreenshot") return { data: PNG.toString("base64") };
      if (
        method === "Input.dispatchMouseEvent" &&
        (params as { type?: string })?.type === "mouseReleased"
      ) {
        clicked = 1;
      }
      return {};
    },
  };
  return {
    agentOperations,
    list: (scope) =>
      [...tabs.keys()].filter((id) => tabs.get(id)?.projectId === scope.projectId).map(view),
    open: (input) => {
      tabs.set(TAB, {
        tabId: TAB,
        projectId: input.projectId,
        ticketId: input.ticketId,
        createdBy: input.createdBy,
        ownerSessionId: input.createdBy === "session" ? input.ownerSessionId : null,
        presentation: "headless",
        url: input.url,
        title: "",
        loading: false,
        error: null,
        canGoBack: false,
        canGoForward: false,
        generation: 1,
        heldBy: null,
      });
      return view(TAB);
    },
    navigate: unused,
    back: unused,
    forward: unused,
    reload: unused,
    consoleOf: () => ({ messages: [], truncated: false }),
    capturePicture: async () => "navigation-picture",
    keepScreenshot: () => {
      // SIMULATED second navigation bump, landing just after the screenshot
      // was kept. Not during the capture: the real port refuses a screenshot
      // whose tab moved mid-capture (browser.stale-ref, cdp-controller.ts),
      // and that refusal is what an earlier version of this fixture hit.
      const tab = tabs.get(TAB);
      if (!bumped && tab !== undefined) tabs.set(TAB, { ...tab, generation: tab.generation + 1 });
      bumped = true;
      return "screenshot-picture";
    },
    closeHeadlessOwnedBy: () => [],
    hold: (tabId) => {
      holds.add(tabId);
      return { kind: "held", tab: view(tabId) };
    },
    releaseHold: (tabId) => {
      holds.delete(tabId);
    },
    releaseAllHeldBy: () => {
      const released = [...holds];
      holds.clear();
      return released;
    },
    forgetSession: () => holds.clear(),
    recordTraceStep: (step) => traces.record(step),
    close: unused,
    setPresentation: unused,
    closeHeadlessForTicket: () => [],
    closeAll: () => undefined,
    transportFor: () => transport,
    waitForLoad: async () => undefined,
    setBounds: () => undefined,
    pictureOf: () => null,
    holdAwake: () => () => undefined,
    takeOver: unused,
    handBack: unused,
    askToLeave: () => null,
    isHeldBy: (tabId) => holds.has(tabId),
    heldBy: (tabId) => view(tabId).heldBy,
    onHoldChange: () => () => undefined,
    tracesOf: (sessionId) => traces.tracesOf(sessionId),
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
      const traces = new BrowserTraceStore({
        createId: randomUUID,
        now: Date.now,
        frameOf: () => null,
      });
      const backend = fixtureBackend(traces);
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
        resolveBrowserPort: (scope) =>
          browserAgentPort({
            backend,
            scope: { projectId: scope.projectId, ticketId: scope.ticketId },
            session: { sessionId: scope.sessionId, attachmentId: scope.attachmentId },
            cursorFor: undefined,
          }),
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

        // The REAL trace writer's steps for this tab, read as the probe reads
        // them (by the trace's tab; steps carry none), then correlated.
        const steps = traces
          .tracesOf(sessionId)
          .filter((trace) => trace.tabId === TAB)
          .flatMap((trace) => trace.steps)
          .map(({ action, generation, at, outcome }) => ({ action, generation, at, outcome }));
        expect(steps.map((step) => step.action)).toEqual(["open", "screenshot", "read", "click"]);
        // The writer's contract: a screenshot step has no generation.
        expect(steps.find((step) => step.action === "screenshot")?.generation).toBeNull();
        // The bump moved the tab past the navigate answer: the act's own
        // recorded request, not the navigation, is the click's generation.
        expect(metrics.generation).toBe(1);
        expect(timing.act.generation).toBe(2);
        expect(timing.act.kind).toBe("click");
        const hostTiming = navigationTiming({ timing, steps, metrics });
        expect(hostTiming.navigationGeneration).toBe(1);
        expect(hostTiming.actionGeneration).toBe(2);
        expect(hostTiming.screenshotMs).toBe(timing.shot.endedAt - timing.shot.startedAt);
        expect(hostTiming.screenshotTraceAt).toBeGreaterThanOrEqual(timing.shot.startedAt);
        expect(hostTiming.screenshotTraceAt).toBeLessThanOrEqual(timing.shot.endedAt);
      } finally {
        await host.close();
      }
    } finally {
      database.cleanup();
    }
  }, 30_000);
});
