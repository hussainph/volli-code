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
    expect(AGENT_CAPABILITY_CHANGES).toHaveLength(1);
    expect(AGENT_CAPABILITY_CHANGES[0]).toMatchObject({
      baseline: "8e8a17c0",
      added: expect.arrayContaining([
        expect.stringContaining("help concepts"),
        expect.stringContaining("dry-run"),
      ]),
    });
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
      "does not authenticate",
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
