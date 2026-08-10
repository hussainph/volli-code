/**
 * Manual live smoke: one real turn against a real provider.
 *
 * This is the only test that spends money and the only one that touches the
 * configured Pi provider credentials. It never runs by default — CI does not
 * run it, and `pnpm test` does not discover it.
 *
 *   PI_LIVE_SMOKE=1 pnpm -C packages/agent-runtime run smoke
 *   PI_SMOKE_MODEL=anthropic/claude-haiku-4-5   # optional, provider/model
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_RULE_PACK_HASH,
  BUILTIN_RULE_PACK_ID,
  type RuntimeObservation,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import { createPiAgentRuntime } from "../src";

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";

describe.skipIf(process.env.PI_LIVE_SMOKE !== "1")("live Pi turn", () => {
  it("reads a worktree file and reports its token", async () => {
    const [providerId = "", modelId = ""] = (process.env.PI_SMOKE_MODEL ?? DEFAULT_MODEL).split(
      "/",
    );
    const token = `volli-${randomUUID()}`;

    const root = mkdtempSync(join(tmpdir(), "volli-live-smoke-"));
    const worktreePath = join(root, "worktree");
    const sessionDataDir = join(root, "sessions");
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(sessionDataDir, { recursive: true });
    writeFileSync(join(worktreePath, "TOKEN.txt"), `${token}\n`);

    const observations: RuntimeObservation[] = [];
    const runtime = createPiAgentRuntime({ sessionDataDir });

    const handle = await runtime.startSession({
      identity: {
        role: "ticket",
        sessionId: "smoke-session",
        rootThreadId: "smoke-thread",
        attachmentId: "smoke-attachment",
        projectId: "smoke-project",
        ticketId: "smoke-ticket",
      },
      workspacePath: worktreePath,
      venue: "local",
      model: { providerId, modelId, reasoningLevel: "off" },
      authority: {
        mode: "auto",
        location: "worktree",
        tools: ["read"],
        rulePackId: BUILTIN_RULE_PACK_ID,
        rulePackHash: BUILTIN_RULE_PACK_HASH,
        classifierModel: null,
        fallback: { consecutiveDenials: 3, sessionDenials: 20 },
      },
      brief: { text: "Smoke test: TOKEN.txt holds a single opaque token." },
      tools: { tools: ["read"] },
      observer: async (observation) => {
        observations.push(observation);
      },
    });

    try {
      const outcome = await handle.submitUserMessage(
        "Read TOKEN.txt in the worktree and reply with the token verbatim and nothing else.",
      );
      expect(outcome).toEqual({ kind: "delivered", delivery: "prompt" });

      const settled = observations.flatMap((observation) =>
        observation.kind === "message-settled" ? [observation.message] : [],
      );
      const last = settled.at(-1);
      expect(settled.map((message) => message.text).join("\n")).toContain(token);

      console.log(
        `[live smoke] model=${last?.model?.providerId}/${last?.model?.modelId} ` +
          `input=${last?.usage?.inputTokens} output=${last?.usage?.outputTokens} ` +
          `cost=$${settled.reduce((total, message) => total + (message.usage?.costUsd ?? 0), 0)}`,
      );
    } finally {
      await handle.close();
    }
  });
});
