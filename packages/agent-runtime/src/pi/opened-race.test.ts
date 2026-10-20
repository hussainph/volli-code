import { describe, expect, it, vi } from "vite-plus/test";
import {
  createAssistantMessageEventStream,
  createModels,
  fauxProvider,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { silentEndsFixture } from "../../../host-core/src/testing/silent-ends";

// Only the provider is scripted. Host admission, queue draining, the native
// adapter, SQLite receipts, sidecar persistence and Pi are the actual path.
describe("opened delivery through host queue admission (VC-758)", () => {
  it("holds retry behind the queued message's pre-prompt rewrite and durable opening", async () => {
    const summarizing = Promise.withResolvers<void>();
    const releaseSummary = Promise.withResolvers<void>();
    const queuedReplyStreaming = Promise.withResolvers<void>();
    const releaseQueuedReply = Promise.withResolvers<void>();
    const requests: Message[][] = [];
    let autoCompaction = false;
    const stream: StreamFn = (model, context) => {
      requests.push([...context.messages]);
      const call = requests.length;
      const output = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        timestamp: call,
        stopReason: "stop",
        usage: {
          input: 200_000,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 200_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      void (async () => {
        if (call === 3) {
          summarizing.resolve();
          await releaseSummary.promise;
        }
        if (call === 4) {
          queuedReplyStreaming.resolve();
          await releaseQueuedReply.promise;
        }
        output.push({ type: "start", partial: message });
        if (call === 2 || call === 3) {
          message.stopReason = call === 2 ? "aborted" : "error";
          message.errorMessage = call === 2 ? "Aborted" : "summary unavailable";
          output.push({ type: "error", reason: message.stopReason, error: message });
        } else {
          message.content.push({ type: "text", text: "answer" });
          output.push({ type: "done", reason: "stop", message });
        }
        output.end(message);
      })();
      return output;
    };
    const faux = fauxProvider({
      api: "anthropic-messages",
      provider: "scripted-fixture",
      models: [{ id: "scripted" }],
    });
    const models = createModels();
    models.setProvider({
      ...faux.provider,
      streamSimple: stream as typeof faux.provider.streamSimple,
    });
    const f = await silentEndsFixture({
      provider: { models, requests },
      adapter: { compactionPolicy: () => ({ autoCompaction }) },
    });
    try {
      await f.attach();
      await f.submit("seed");
      await f.runtime.command({
        commandId: "aborted",
        sessionId: f.sessionId,
        command: {
          kind: "message.submit",
          delivery: "steer",
          message: {
            id: "aborted",
            role: "user",
            parts: [{ type: "text", text: "retained-paste ".repeat(6_000) }],
          },
        },
      });
      expect((await f.projection()).attention.active).toEqual([]);
      autoCompaction = true;
      await f.submit("QUEUED-MESSAGE", "queue", true);
      await summarizing.promise;
      const retrying = f.runtime.command({
        commandId: "retry-command",
        sessionId: f.sessionId,
        command: { kind: "executor.retry" },
      });
      expect(requests).toHaveLength(3);
      autoCompaction = false;
      releaseSummary.resolve();
      await queuedReplyStreaming.promise;
      const retried = await retrying;
      expect(retried.receipt).toMatchObject({ status: "rejected", code: "PI_BUSY" });
      await vi.waitFor(async () => {
        const receipts = (await f.events()).flatMap(({ payload }) =>
          payload.kind === "command.receipt.recorded" &&
          payload.receipt.commandId.startsWith("follow-up:")
            ? [payload.receipt]
            : [],
        );
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({ status: "accepted", acceptedAt: expect.any(Number) });
      });
      expect(JSON.stringify(requests[3])).toContain("QUEUED-MESSAGE");
      releaseQueuedReply.resolve();
    } finally {
      releaseSummary.resolve();
      releaseQueuedReply.resolve();
      await f.close();
    }
  });
});
