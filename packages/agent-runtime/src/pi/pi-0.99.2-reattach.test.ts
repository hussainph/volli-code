/** Reopen synthetic sidecars written by the patched Pi 0.99.2 build through the Pi 1.0 runtime. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  fauxProvider,
  type AssistantMessage,
  type Message,
  type Models,
} from "@earendil-works/pi-ai";
import type {
  RuntimeAttachmentHandle,
  RuntimeObservation,
  SessionRuntimeSpec,
} from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toAnthropicMessages } from "./provider-compaction";
import { createPiAgentRuntime } from "./runtime";

type CompactedFixture = "portable-compaction" | "native-compaction";
const portableSummary = "Portable 0.99.2 summary: preserve the saved task.";
const nativeSummary = "Synthetic native 0.99.2 checkpoint: preserve the saved task.";
const retainedText = "Retained tail: continue the saved task with héllo 日本語 🙂.";
const replyText = "Continued on Pi 1.0.";
const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let root: string;
let handles: RuntimeAttachmentHandle[];
const network = vi.fn(() => {
  throw new Error("Synthetic fixture tests must not make network requests.");
});

beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), ".pi-0992-reattach-"));
  handles = [];
  network.mockClear();
  vi.stubGlobal("fetch", network);
});

afterEach(async () => {
  for (const handle of handles) await handle.close();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

function copiedFixture(name: "sidecar" | "malformed-compaction" | CompactedFixture) {
  const fixture = readFileSync(
    new URL(`./fixtures/pi-0.99.2-${name}.jsonl`, import.meta.url),
    "utf8",
  );
  const header = JSON.parse(fixture.split("\n")[0]!) as { id: string; cwd: string };
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
  const inode = statSync(sessionFilePath).ino;
  const seen: Message[][] = [];
  const payloads: unknown[] = [];
  const observations: RuntimeObservation[] = [];
  const modelId = name === "native-compaction" ? "claude-opus-4-6" : "claude-sonnet-4-5";
  const stream: StreamFn = async (model, context, options) => {
    seen.push(structuredClone(context.messages));
    const payload = { messages: toAnthropicMessages(context.messages, model) };
    payloads.push((await options?.onPayload?.(payload, model)) ?? payload);
    const reply: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: replyText }],
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
    models: [{ id: modelId, reasoning: true }],
  });
  models.setProvider({
    ...faux.provider,
    // A native checkpoint must match the model AND its resolved public API route.
    getModels: () =>
      faux.provider
        .getModels()
        .map((model) => Object.assign({}, model, { baseUrl: "https://api.anthropic.com" })),
    streamSimple: stream as typeof faux.provider.streamSimple,
  });
  const syntheticAuth: Models = new Proxy(models, {
    get(target, property) {
      // No real credential/profile read. The fake stream and blocked fetch never use this key.
      if (property === "getAuth")
        return async () => ({ auth: { apiKey: "synthetic-fixture-key" }, source: "fixture" });
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  const runtime = createPiAgentRuntime({ sessionDataDir, models: syntheticAuth });
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
    model: { providerId: "anthropic", modelId, reasoningLevel: "off" },
    brief: { text: "Continue the saved conversation." },
    tools: { tools: [] },
    recovery: { runtime: "pi", sessionId: header.id, sessionFilePath },
    observer: async (observation) => {
      observations.push(observation);
    },
  };
  return {
    copied,
    seen,
    payloads,
    observations,
    async start() {
      const handle = await runtime.startSession(spec);
      handles.push(handle);
      expect(handle.recovery).toEqual(spec.recovery);
      return handle;
    },
    appendedTo(prefix: string) {
      const written = readFileSync(sessionFilePath, "utf8");
      expect(written.startsWith(prefix)).toBe(true);
      expect(written.slice(prefix.length)).toContain(replyText);
      expect(statSync(sessionFilePath).ino).toBe(inode);
      return written;
    },
  };
}

function failures(observations: readonly RuntimeObservation[]) {
  return observations.filter(
    (observation) => observation.kind === "compaction" && observation.state === "failed",
  );
}

function noAttention(observations: readonly RuntimeObservation[]) {
  expect(
    observations.filter(
      (observation) => observation.kind === "attention" && observation.state !== "cleared",
    ),
  ).toEqual([]);
}

function noOldHistory(request: unknown) {
  const text = JSON.stringify(request);
  expect(text).not.toContain("Before Pi 1.0");
  expect(text).not.toContain("Saved by 0.99.2");
  expect(text).not.toContain("Sibling branch only");
}

function conversation(messages: readonly Message[]) {
  return messages.filter((message) => message.role !== "system");
}

describe("copied Pi 0.99.2 compactions", () => {
  it.each(["portable-compaction", "native-compaction"] as const)(
    "preserves the old runtime's summary and retained tail for %s, including a second restart",
    async (name) => {
      const fixture = copiedFixture(name);
      // Captured from an actual old harness continuation, independently of the new reader.
      const oldContext = JSON.parse(
        readFileSync(new URL(`./fixtures/pi-0.99.2-${name}.context.json`, import.meta.url), "utf8"),
      ) as Message[];
      expect(oldContext).toHaveLength(3);
      expect(oldContext[0]).toMatchObject({
        role: "user",
        content: [
          {
            type: "text",
            text: expect.stringContaining(
              name === "portable-compaction" ? portableSummary : nativeSummary,
            ),
          },
        ],
      });
      expect(oldContext[1]).toMatchObject({ role: "user", content: retainedText });
      expect(oldContext[2]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Retained answer from 0.99.2." }],
      });

      // Existing product policy clears retained replies' OLD-prefix usage in live context,
      // not their durable content/bill. All other old-runtime request fields remain exact.
      const expectedContext = structuredClone(oldContext);
      for (const message of expectedContext) {
        if (message.role === "assistant") message.usage = structuredClone(zeroUsage);
      }
      const first = await fixture.start();
      expect(failures((await first.reconcile(null)).observations)).toEqual([]);
      await first.submitUserMessage("Continue after the upgrade.");
      expect(fixture.seen).toHaveLength(1);
      const firstRequest = conversation(fixture.seen[0]!);
      expect(firstRequest).toHaveLength(4);
      expect(firstRequest.slice(0, 3)).toEqual(expectedContext);
      expect(firstRequest[3]).toMatchObject({
        role: "user",
        content: "Continue after the upgrade.",
      });
      noOldHistory(firstRequest);
      noOldHistory(fixture.payloads[0]);
      expect(failures((await first.reconcile(null)).observations)).toEqual([]);
      await first.close();
      const written = fixture.appendedTo(fixture.copied);

      const restarted = await fixture.start();
      await restarted.submitUserMessage("Continue after another restart.");
      expect(fixture.seen).toHaveLength(2);
      const secondRequest = conversation(fixture.seen[1]!);
      expect(secondRequest).toHaveLength(6);
      expect(secondRequest.slice(0, 3)).toEqual(expectedContext);
      expect(secondRequest[3]).toEqual(firstRequest[3]);
      expect(secondRequest[4]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: replyText }],
      });
      expect(secondRequest[5]).toMatchObject({
        role: "user",
        content: "Continue after another restart.",
      });
      noOldHistory(secondRequest);
      noOldHistory(fixture.payloads[1]);
      const replay = await restarted.reconcile(null);
      expect(failures(replay.observations)).toEqual([]);
      noAttention(replay.observations);
      await restarted.close();
      fixture.appendedTo(written);

      if (name === "native-compaction") {
        // Not just a readable details blob: the product replays it as a native block.
        for (const payload of fixture.payloads) {
          const messages = (payload as { messages: unknown[] }).messages;
          expect(messages[0]).toEqual({
            role: "assistant",
            content: [{ type: "compaction", content: nativeSummary }],
          });
          expect(JSON.stringify(messages).match(/"type":"compaction"/gu)).toHaveLength(1);
          expect(JSON.stringify(payload)).not.toContain("<summary>");
          expect(JSON.stringify(payload)).toContain(retainedText);
          expect(JSON.stringify(payload)).toContain("Retained answer from 0.99.2.");
        }
      } else {
        for (const payload of fixture.payloads) {
          expect(JSON.stringify(payload)).toContain(portableSummary);
          expect(JSON.stringify(payload)).toContain(retainedText);
          expect(JSON.stringify(payload)).toContain("Retained answer from 0.99.2.");
        }
      }
      expect(failures(fixture.observations)).toEqual([]);
      noAttention(fixture.observations);
      expect(network).not.toHaveBeenCalled();
    },
  );

  it("reports a malformed checkpoint once and restores the complete pre-compaction main history", async () => {
    const fixture = copiedFixture("malformed-compaction");
    const oldHistory = JSON.parse(
      readFileSync(
        new URL("./fixtures/pi-0.99.2-malformed-compaction.history.context.json", import.meta.url),
        "utf8",
      ),
    ) as Message[];
    expect(oldHistory).toHaveLength(4);
    expect(oldHistory[0]).toMatchObject({
      role: "user",
      content: "Before Pi 1.0: héllo 日本語 🙂",
    });
    expect(oldHistory[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Saved by 0.99.2" }],
    });
    expect(oldHistory[2]).toMatchObject({ role: "user", content: retainedText });
    expect(oldHistory[3]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Retained answer from 0.99.2." }],
    });
    const first = await fixture.start();
    const notices = failures((await first.reconcile(null)).observations);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "compaction",
      state: "failed",
      reason: "checkpoint",
      message: expect.stringContaining("original history"),
    });
    await first.submitUserMessage("Continue after the upgrade.");
    expect(fixture.seen).toHaveLength(1);
    const request = conversation(fixture.seen[0]!);
    expect(request).toHaveLength(5);
    expect(request.slice(0, 4)).toEqual(oldHistory);
    expect(request[4]).toMatchObject({ role: "user", content: "Continue after the upgrade." });
    expect(JSON.stringify(request)).not.toContain("Sibling branch only");
    expect(JSON.stringify(request)).not.toContain("Before the upgrade");
    await first.close();
    const written = fixture.appendedTo(fixture.copied);

    const restarted = await fixture.start();
    // Same durable receipt, not a new failure appended on each restart.
    expect(failures((await restarted.reconcile(null)).observations)).toEqual(notices);
    await restarted.submitUserMessage("Continue after checkpoint recovery.");
    expect(fixture.seen).toHaveLength(2);
    const resumed = conversation(fixture.seen[1]!);
    expect(resumed).toHaveLength(7);
    expect(resumed.slice(0, 5)).toEqual(request);
    expect(resumed[5]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: replyText }],
    });
    expect(resumed[6]).toMatchObject({
      role: "user",
      content: "Continue after checkpoint recovery.",
    });
    expect(JSON.stringify(resumed)).not.toContain("Sibling branch only");
    expect(JSON.stringify(resumed)).not.toContain("Before the upgrade");
    const replay = await restarted.reconcile(null);
    expect(failures(replay.observations)).toEqual(notices);
    noAttention(replay.observations);
    await restarted.close();
    fixture.appendedTo(written);
    noAttention(fixture.observations);
    expect(network).not.toHaveBeenCalled();
  });

  it("does not mistake the original storage-only fixture's fallback for a valid compaction", async () => {
    // Preserve these original bytes: its opaque checkpoint AND synthetic settlement
    // marker are malformed to the product, though valid unknown data for storage.
    const fixture = copiedFixture("sidecar");
    const handle = await fixture.start();
    const replay = await handle.reconcile(null);
    expect(failures(replay.observations)).toEqual([
      expect.objectContaining({
        kind: "compaction",
        state: "failed",
        reason: "checkpoint",
        message: expect.stringContaining("original history"),
      }),
    ]);
    expect(
      replay.observations
        .filter((observation) => observation.kind === "attention" && observation.state === "raised")
        .map((observation) => (observation.kind === "attention" ? observation.reason : null))
        .toSorted(),
    ).toEqual(["partial-turn", "runtime-failure"]);
    await handle.submitUserMessage("Continue after the upgrade.");
    expect(fixture.seen).toHaveLength(1);
    const request = conversation(fixture.seen[0]!);
    expect(request).toHaveLength(2);
    expect(request[0]).toMatchObject({ role: "user", content: "Before Pi 1.0: héllo 日本語 🙂" });
    expect(request[1]).toMatchObject({ role: "user", content: "Continue after the upgrade." });
    expect(JSON.stringify(request)).not.toContain("Saved by 0.99.2");
    expect(JSON.stringify(request)).not.toContain("Sibling branch only");
    expect(JSON.stringify(request)).not.toContain("Before the upgrade");
    expect(JSON.stringify(request)).not.toContain("Retained tail");
    await handle.close();
    fixture.appendedTo(fixture.copied);
    expect(network).not.toHaveBeenCalled();
  });
});
