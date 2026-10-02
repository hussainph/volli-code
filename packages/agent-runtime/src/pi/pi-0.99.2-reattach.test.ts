/** Reopen a copied, genuine Pi 0.99.2 profile through the Pi 1.0 Agent Runtime and continue a turn. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  fauxProvider,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import type { RuntimeObservation, SessionRuntimeSpec } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import { createPiAgentRuntime } from "./runtime";

const fixture = readFileSync(
  new URL("./fixtures/pi-0.99.2-sidecar.jsonl", import.meta.url),
  "utf8",
);
const header = JSON.parse(fixture.split("\n")[0]!) as { id: string; cwd: string };

describe("a copied Pi 0.99.2 profile", () => {
  it("reattaches through the 1.0 runtime, replays the conversation, and appends to the same file", async () => {
    const root = mkdtempSync(join(process.cwd(), ".pi-0992-reattach-"));
    const workspacePath = join(root, "worktree");
    const sessionDataDir = join(root, "sessions");
    mkdirSync(workspacePath, { recursive: true });
    const directory = join(
      sessionDataDir,
      `--${workspacePath.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`,
    );
    mkdirSync(directory, { recursive: true });
    const sessionFilePath = join(directory, `2027-01-15T08-00-00-000Z_${header.id}.jsonl`);
    // Only the workspace location is relocated, as when copying a profile to another machine.
    const copied = fixture.replaceAll(header.cwd, workspacePath);
    writeFileSync(sessionFilePath, copied);
    const seen: Message[][] = [];
    const observations: RuntimeObservation[] = [];
    const stream: StreamFn = (model, context) => {
      seen.push(structuredClone(context.messages));
      const reply: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Continued on Pi 1.0." }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "stop",
        timestamp: 1800000000010,
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => {
        events.push({ type: "start", partial: reply });
        events.push({ type: "done", reason: "stop", message: reply });
        events.end(reply);
      });
      return events;
    };
    const models = createModels();
    const faux = fauxProvider({
      api: "anthropic-messages",
      provider: "anthropic",
      models: [{ id: "claude-sonnet-4-5", reasoning: true }],
    });
    models.setProvider({
      ...faux.provider,
      streamSimple: stream as typeof faux.provider.streamSimple,
    });
    const runtime = createPiAgentRuntime({ sessionDataDir, models });
    const spec: SessionRuntimeSpec = {
      identity: {
        role: "ticket",
        sessionId: "compat-session",
        rootThreadId: "compat-thread",
        attachmentId: "compat-attachment",
        projectId: "compat-project",
        ticketId: "compat-ticket",
      },
      workspacePath,
      venue: "local",
      model: { providerId: "anthropic", modelId: "claude-sonnet-4-5", reasoningLevel: "off" },
      brief: { text: "Continue the saved conversation." },
      tools: { tools: [] },
      recovery: { runtime: "pi", sessionId: header.id, sessionFilePath },
      observer: async (observation) => {
        observations.push(observation);
      },
    };
    try {
      const handle = await runtime.startSession(spec);
      expect(handle.recovery).toEqual(spec.recovery);
      await handle.submitUserMessage("Continue after the upgrade.");
      await handle.close();
      expect(seen).toHaveLength(1);
      const request = JSON.stringify(seen[0]);
      expect(request).toContain("Before Pi 1.0: héllo 日本語 🙂");
      expect(request).toContain("Continue after the upgrade.");
      expect(request).not.toContain("Sibling branch only");
      const written = readFileSync(sessionFilePath, "utf8");
      expect(written.startsWith(copied)).toBe(true);
      expect(written.slice(copied.length)).toContain("Continued on Pi 1.0.");
      expect(
        observations.filter(
          (observation) => observation.kind === "attention" && observation.state !== "cleared",
        ),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
