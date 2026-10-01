/**
 * The VC-478 decision benchmark, live: the numbers behind "a decision model
 * is much faster and cheaper than a chat model for a yes/no or one-of-N
 * decision".
 *
 * Each task's decisions are made three ways — a chat model per decision, a
 * chat model over the whole list (triage only), and the decision service per
 * decision — on real providers, through the developer's own Pi credentials.
 * Never runs by default: it spends real money and needs real models.
 *
 *   PI_LIVE_BENCH=1 pnpm -C packages/agent-runtime run bench:live -- bench/decision
 *
 *   PI_BENCH_CHAT_MODEL=anthropic/claude-haiku-4-5   # the "without classify" model
 *   PI_BENCH_CHAT_REASONING=low                      # optional thinking level
 *   PI_BENCH_CLASSIFIER=opencode/jev-1.13            # a cloud classifier, signed in
 *   PI_BENCH_LOCAL_URL=http://127.0.0.1:8080         # optional llama-server
 *   PI_BENCH_LOCAL_MODEL=default
 *   PI_BENCH_TRIALS=3  PI_BENCH_CONCURRENCY=4
 *   PI_BENCH_SIZES=28,200,20                         # browser, triage, control
 *
 * A classifier whose provider is not signed in is skipped with a line saying
 * which key to add, rather than failing the run; the chat arms still run.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionUsage } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { createDecisionService } from "../../src/decision/service";
import { decisionTargetReady, piDecisionClassifier } from "../../src/pi/classifier";
import { piOwnedModelAccess } from "../../src/pi/models";
import { decisionTable } from "./report";
import { runChat, runChatBatch, runClassify, type ArmRun, type ChatOptions } from "./runner";
import { DEFAULT_SIZES, decisionTasks } from "./tasks";

const LIVE = process.env.PI_LIVE_BENCH === "1";
const TRIALS = Number(process.env.PI_BENCH_TRIALS ?? 3);
const CONCURRENCY = Number(process.env.PI_BENCH_CONCURRENCY ?? 4);
const CHAT = process.env.PI_BENCH_CHAT_MODEL ?? "anthropic/claude-haiku-4-5";
const CLASSIFIER = process.env.PI_BENCH_CLASSIFIER ?? "opencode/jev-1.13";
const LOCAL_URL = process.env.PI_BENCH_LOCAL_URL;
const LOCAL_MODEL = process.env.PI_BENCH_LOCAL_MODEL ?? "default";
const REASONING = process.env.PI_BENCH_CHAT_REASONING as ChatOptions["reasoning"] | undefined;

function sizes() {
  const raw = process.env.PI_BENCH_SIZES?.split(",").map(Number);
  return raw?.length === 3
    ? { browser: raw[0]!, triage: raw[1]!, control: raw[2]! }
    : { ...DEFAULT_SIZES };
}

function split(ref: string): [string, string] {
  const slash = ref.indexOf("/");
  return [ref.slice(0, slash), ref.slice(slash + 1)];
}

describe.skipIf(!LIVE)("decision models, live (VC-478)", () => {
  it("measures chat against classify on every task", async () => {
    const access = piOwnedModelAccess();
    await access.catalogReady;
    const models = access.models;
    const [chatProvider, chatId] = split(CHAT);
    const chatModel = models.getModel(chatProvider, chatId);
    if (chatModel === undefined) throw new Error(`${CHAT} is not in the catalog.`);
    const chat: ChatOptions = {
      models,
      model: chatModel,
      concurrency: CONCURRENCY,
      ...(REASONING === undefined ? {} : { reasoning: REASONING }),
    };

    const usage: SessionUsage[] = [];
    const classifier = piDecisionClassifier(models);
    const [cloudProvider, cloudModel] = split(CLASSIFIER);
    const targets: Array<{ label: string; port: ReturnType<typeof createDecisionService> }> = [];
    const cloudReady = await decisionTargetReady(
      models,
      { where: "cloud", providerId: cloudProvider, modelId: cloudModel },
      AbortSignal.timeout(10_000),
    );
    if (cloudReady) {
      targets.push({
        label: CLASSIFIER,
        port: createDecisionService({
          resolveSetting: () => ({
            kind: "cloud",
            providerId: cloudProvider,
            modelId: cloudModel,
            optIn: { acceptedAt: Date.now(), purposes: ["agent.classify"] },
          }),
          classifier,
          recordUsage: (fact) => void usage.push(fact.usage),
        }),
      });
    } else {
      console.warn(
        `[bench] ${CLASSIFIER} is not reachable: sign in to ${cloudProvider} in Settings → Models → Accounts (or set PI_BENCH_CLASSIFIER). Its arm is skipped.`,
      );
    }
    if (LOCAL_URL !== undefined) {
      targets.push({
        label: `local-llama-cpp/${LOCAL_MODEL}`,
        port: createDecisionService({
          resolveSetting: () => ({
            kind: "local",
            server: "llama-cpp",
            baseUrl: LOCAL_URL,
            modelId: LOCAL_MODEL,
          }),
          classifier,
          recordUsage: (fact) => void usage.push(fact.usage),
        }),
      });
    }

    const runs: ArmRun[] = [];
    const tasks = decisionTasks(sizes());
    for (let trial = 0; trial < TRIALS; trial++) {
      for (const task of tasks) {
        runs.push(await runChat(task, chat));
        if (task.id === "triage") runs.push(await runChatBatch(task, chat));
        for (const target of targets) {
          runs.push(
            await runClassify(task, {
              port: target.port,
              model: target.label,
              concurrency: CONCURRENCY,
              usage,
              // The loop an agent writes once per run; billed to the classify arm.
              loop: chat,
            }),
          );
        }
      }
    }

    const report = decisionTable(runs);
    const directory = join(import.meta.dirname, "results");
    mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-");
    writeFileSync(
      join(directory, `${stamp}.json`),
      `${JSON.stringify({ chat: CHAT, classifier: CLASSIFIER, local: LOCAL_URL ?? null, trials: TRIALS, concurrency: CONCURRENCY, sizes: sizes(), runs }, null, 2)}\n`,
    );
    writeFileSync(join(directory, "latest.md"), `${report}\n`);
    console.log(`\n${report}\n`);
    expect(runs.length).toBeGreaterThan(0);
  });
});
