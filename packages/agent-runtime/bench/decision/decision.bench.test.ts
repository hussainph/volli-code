/**
 * The VC-478 decision benchmark, offline: every arm driven against the
 * network-free fixture provider, so the harness itself is proven without a
 * credential, a server or a cent. The numbers here measure the harness, not a
 * model — `decision.live.test.ts` is the run whose table goes in the PR.
 *
 *   pnpm -C packages/agent-runtime run bench -- bench/decision
 */

import { createModels } from "@earendil-works/pi-ai";
import type { SessionUsage } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { createDecisionService } from "../../src/decision/service";
import {
  FIXTURE_MODEL,
  FIXTURE_PROVIDER,
  fakeLlamaServer,
  fixtureModels,
} from "../../src/decision/fixture.test-support";
import { piDecisionClassifier } from "../../src/pi/classifier";
import { decisionTable } from "./report";
import { chatPrompt, runClassify } from "./runner";
import { decisionTasks } from "./tasks";

describe("the decision benchmark harness", () => {
  it("builds deterministic tasks with a known answer for every question", () => {
    const [browser, triage, control] = decisionTasks({ browser: 14, triage: 20, control: 4 });
    expect(browser!.items).toHaveLength(14);
    expect(new Set(browser!.items.map((item) => item.expected["state"])).size).toBe(7);
    expect(triage!.items).toHaveLength(20);
    expect(control!.items.map((item) => item.expected["correct"])).toEqual([
      true,
      false,
      true,
      false,
    ]);
    // Same seed, same bytes: every arm and trial sees identical inputs.
    expect(JSON.stringify(decisionTasks({ browser: 14, triage: 20, control: 4 }))).toBe(
      JSON.stringify([browser, triage, control]),
    );
    expect(chatPrompt(browser!, browser!.items[0]!)).toMatch(
      /Reply as \{"state": "<choice>", "blocked": true\|false\}/,
    );
  });

  it("runs the classify arm through the real decision service, cloud and local", async () => {
    const [browser] = decisionTasks({ browser: 7, triage: 0, control: 0 });
    const usage: SessionUsage[] = [];
    const cloud = createDecisionService({
      resolveSetting: () => ({
        kind: "cloud",
        providerId: FIXTURE_PROVIDER,
        modelId: FIXTURE_MODEL,
        optIn: { acceptedAt: 1, purposes: ["agent.classify"] },
      }),
      classifier: piDecisionClassifier(fixtureModels()),
      recordUsage: (fact) => void usage.push(fact.usage),
    });
    const cloudRun = await runClassify(browser!, {
      port: cloud,
      model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`,
      concurrency: 4,
      usage,
    });
    expect(cloudRun).toMatchObject({ decisions: 7, failed: 0, asked: 14 });
    expect(cloudRun.latencies).toHaveLength(7);
    expect(cloudRun.inputTokens).toBe(7 * 420);

    const local = createDecisionService({
      resolveSetting: () => ({
        kind: "local",
        server: "llama-cpp",
        baseUrl: "http://127.0.0.1:8080",
        modelId: "fixture",
      }),
      classifier: piDecisionClassifier(createModels(), { fetch: fakeLlamaServer(0.2, []) }),
      recordUsage: (fact) => void usage.push(fact.usage),
    });
    const localRun = await runClassify(browser!, {
      port: local,
      model: "local-llama-cpp/fixture",
      concurrency: 4,
      usage,
    });
    expect(localRun).toMatchObject({ failed: 0, costUsd: 0 });

    const report = decisionTable([cloudRun, localRun]);
    expect(report).toContain("| browser | classify | fixture/jev-fixture");
    expect(report).toContain("n/a");
  });

  it("does not need a chat model to build the comparison's chat prompt", () => {
    // The chat arm needs a live provider; its prompt is pure and pinned here.
    const [, triage] = decisionTasks({ browser: 0, triage: 5, control: 0 });
    const prompt = chatPrompt(triage!, triage!.items[0]!);
    expect(prompt).toContain('"message"');
    expect(prompt).toContain("billing:");
  });
});
