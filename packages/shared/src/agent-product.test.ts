import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_CAPABILITY_BASELINE,
  AGENT_CAPABILITY_CHANGES,
  AGENT_CONCEPT_SECTIONS,
  AGENT_ERROR_CODES,
  ERROR_RECOVERY,
  HELP_TOPIC_NAMES,
  makeAgentError,
} from "./index";

describe("agent product guidance", () => {
  it("starts the capability record at the ratified implementation baseline", () => {
    expect(AGENT_CAPABILITY_BASELINE).toBe("8e8a17c0");
    // The OLDEST entry is the one pinned to the baseline. The record is
    // newest-first, so this reads from the end rather than from index 0 — an
    // entry added later must not be able to move what the baseline claims.
    expect(AGENT_CAPABILITY_CHANGES.at(-1)).toMatchObject({
      baseline: "8e8a17c0",
      build: "VC-91",
      added: expect.arrayContaining([
        expect.stringContaining("help concepts"),
        expect.stringContaining("dry-run"),
      ]),
    });
  });

  it("keeps the capability record in its historic build order", () => {
    // The heading `volli help changes` renders is `<build> (after <baseline>)`,
    // so a record whose chain is broken prints a lineage that never happened.
    const builds = AGENT_CAPABILITY_CHANGES.map((change) => change.build);
    expect(new Set(builds).size).toBe(builds.length);
    for (const [index, change] of AGENT_CAPABILITY_CHANGES.entries()) {
      const older = AGENT_CAPABILITY_CHANGES[index + 1];
      if (older !== undefined) expect(change.baseline).toBe(older.build);
    }

    // Continuity alone cannot distinguish a self-consistent but invented
    // order. Keep the known VC-91 → VC-162 → VC-85 → VC-163 build spine in
    // its actual order and with each actual predecessor.
    const historicBuilds = ["VC-163", "VC-85", "VC-162", "VC-91"];
    const historicRecord = AGENT_CAPABILITY_CHANGES.filter((change) =>
      historicBuilds.includes(change.build),
    );
    expect(historicRecord.map(({ build, baseline }) => ({ build, baseline }))).toEqual([
      { build: "VC-163", baseline: "VC-85" },
      { build: "VC-85", baseline: "VC-162" },
      { build: "VC-162", baseline: "VC-91" },
      { build: "VC-91", baseline: AGENT_CAPABILITY_BASELINE },
    ]);
  });

  it("records the Role-scoped tool surface as an agent-facing capability (VC-162)", () => {
    // VC-91's own entry promised this one by name ("ready for session.start
    // when VC-162 supplies its tool seam"), so the record owes a reader the
    // moment that promise was kept.
    const entry = AGENT_CAPABILITY_CHANGES.find((change) => change.build === "VC-162");
    expect(entry).toBeDefined();
    const stated = [...entry!.added, ...entry!.changed].join("\n");
    // The wire name is what an agent will actually be offered, and the tier is
    // the thing most likely to be misread while both doors are open.
    expect(stated).toContain("session_start");
    expect(stated).toContain("coordination");
  });

  it("records all four VC-85 coordination capabilities", () => {
    const entry = AGENT_CAPABILITY_CHANGES.find((change) => change.build === "VC-85");

    expect(entry).toBeDefined();
    const stated = [...entry!.added, ...entry!.changed, ...entry!.fixed];
    expect(stated).toHaveLength(4);
    expect(stated.join("\n")).toContain("ticket signal");
    expect(stated.join("\n")).toContain("ticket_await");
    expect(stated.join("\n")).toContain("lossless");
    expect(stated.join("\n")).toContain("--events 0 and --comments 0");
  });

  it("ships concepts and changes as canonical local help topics", () => {
    expect(HELP_TOPIC_NAMES).toEqual([
      "concepts",
      "changes",
      "exit-codes",
      "addressing",
      "json",
      "orchestration",
    ]);
    const concepts = AGENT_CONCEPT_SECTIONS.map((section) =>
      [section.heading, ...section.paragraphs, ...(section.bullets ?? [])].join("\n"),
    ).join("\n");
    for (const truth of [
      "durable identity",
      "Create & start",
      "Main checkout",
      "VOLLI_SESSION",
      // VC-163 replaced "does not authenticate" with the seam that does, and
      // with the honest bound on it. Both are pinned: a concepts page that
      // claimed authentication without naming what it cannot stop would invite
      // putting dangerous verbs behind it.
      "per-attachment token",
      "unauthenticated Actor",
      "hostile process running as the signed-in macOS user",
      "Agent CLI",
      "Agent Tool Surface",
      "Verb Tier",
      "attended",
    ]) {
      expect(concepts).toContain(truth);
    }
  });

  it("gives every stable error code one canonical recovery policy", () => {
    expect(Object.keys(ERROR_RECOVERY).toSorted()).toEqual([...AGENT_ERROR_CODES].toSorted());
    for (const code of AGENT_ERROR_CODES) {
      expect(ERROR_RECOVERY[code].why.length).toBeGreaterThan(0);
      const next = ERROR_RECOVERY[code].next;
      expect(next === null || next.length > 0).toBe(true);
    }
  });

  it("builds structured teaching errors without changing their stable code", () => {
    expect(makeAgentError("APP_UNREACHABLE", "The local socket refused the connection.")).toEqual({
      code: "APP_UNREACHABLE",
      message: "The local socket refused the connection.",
      reason: "The local socket refused the connection.",
      next: "Run `volli app launch`, wait for readiness, then retry the same command once.",
    });
    expect(makeAgentError("MUTATION_FAILED", "SQLite did not report an outcome.")).toMatchObject({
      code: "MUTATION_FAILED",
      reason:
        "SQLite did not report an outcome. Volli lacks enough durable outcome evidence to name a safe retry.",
      next: null,
    });
  });
});
