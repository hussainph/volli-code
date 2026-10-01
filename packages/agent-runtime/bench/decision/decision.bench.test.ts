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
import { chatPrompt, runClassify, scoreBatchLabels } from "./runner";
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

  it("scores a chat-batch reply by item index, an array reply positionally", () => {
    const [, triage] = decisionTasks({ browser: 0, triage: 4, control: 0 });
    const want = triage!.items.map((item) => item.expected["category"]);
    expect(want).toHaveLength(4);
    // Object reply, the shape the prompt asks for: every item scored by its
    // own index, all correct.
    expect(
      scoreBatchLabels(
        triage!,
        Object.fromEntries(want.map((category, index) => [String(index), category])),
      ),
    ).toEqual({ correct: 4, failed: 0 });
    // A wrong label at 0 and a missing index at 1 fail alone: the later
    // labels are still read from their own indices, not shifted. The wrong
    // label is an incorrect answer, not a failure; only the missing index
    // failed.
    expect(
      scoreBatchLabels(triage!, { "0": "not-a-category", "2": want[2], "3": want[3] }),
    ).toEqual({
      correct: 2,
      failed: 1,
    });
    // Array reply, the older shape: still accepted, scored positionally.
    expect(scoreBatchLabels(triage!, want)).toEqual({ correct: 4, failed: 0 });
    // A short array fails the items it leaves unlabelled.
    expect(scoreBatchLabels(triage!, [want[0]])).toEqual({ correct: 1, failed: 3 });
    // No labels at all: every item failed, none scored.
    expect(scoreBatchLabels(triage!, undefined)).toEqual({ correct: 0, failed: 4 });
  });

  it("records no latency for a decision that failed, and no valid trials when all of them did", async () => {
    const [browser] = decisionTasks({ browser: 7, triage: 0, control: 0 });
    const failing = createDecisionService({
      resolveSetting: () => ({
        kind: "cloud",
        providerId: FIXTURE_PROVIDER,
        modelId: FIXTURE_MODEL,
        optIn: { acceptedAt: 1, purposes: ["agent.classify"] },
      }),
      classifier: piDecisionClassifier(fixtureModels({ answer: () => ({ stopReason: "error" }) })),
    });
    const run = await runClassify(browser!, {
      port: failing,
      model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`,
      concurrency: 4,
      usage: [],
    });
    // Every decision came back a miss: all failed, none is a latency.
    expect(run).toMatchObject({ decisions: 7, failed: 7, correct: 0 });
    expect(run.latencies).toHaveLength(0);
    // And the report says so: the medians are emptied to "—", and the row
    // reads 1 trial, 0 valid.
    const row = decisionTable([run])
      .split("\n")
      .find((line) => line.includes("| classify |"));
    const cells = row!
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);
    expect(cells[6]).toBe("—"); // p50/decision
    expect(cells[7]).toBe("—"); // wall
    expect(cells.at(-2)).toBe("1"); // trials
    expect(cells.at(-1)).toBe("0"); // valid trials
  });
});
