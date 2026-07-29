import { describe, expect, it } from "vite-plus/test";

import { parseHarnessManifest } from "./manifest";
import { VOLLI_CLI_REFERENCE, VOLLI_PLUGIN_DOC } from "./skill-content";
import { HARNESS_EVENTS } from "./types";

describe("VOLLI_CLI_REFERENCE", () => {
  it("reinforces the worktree orientation contract and the read-only worktree commands", () => {
    // Agents must never infer their location: cwd is the worktree, and
    // VOLLI_PROJECT_DIR (the main checkout) is reference-only (worktree-support §8).
    expect(VOLLI_CLI_REFERENCE).toContain("VOLLI_PROJECT_DIR");
    expect(VOLLI_CLI_REFERENCE).toContain("reference-only");
    expect(VOLLI_CLI_REFERENCE).toContain("volli worktree status");
    expect(VOLLI_CLI_REFERENCE).toContain("volli worktree diff");
  });
});

describe("VOLLI_PLUGIN_DOC", () => {
  it("documents every field a manifest needs, by the name the parser reads", () => {
    for (const field of [
      "manifestVersion",
      "slug",
      "label",
      "command",
      "promptFlag",
      "surfaces",
      "injection",
      "sessionId",
      "resume",
      "events",
      "launchSettings",
    ]) {
      expect(VOLLI_PLUGIN_DOC).toContain(field);
    }
  });

  it("documents the whole event union and every injection kind", () => {
    for (const event of HARNESS_EVENTS) expect(VOLLI_PLUGIN_DOC).toContain(event);
    for (const kind of [
      "argv-settings-json",
      "argv-config-override",
      "config-dir-env",
      "plugin-config-env",
    ]) {
      expect(VOLLI_PLUGIN_DOC).toContain(kind);
    }
  });

  it("states the trust rules, including that a claimed event earns nothing on its own", () => {
    expect(VOLLI_PLUGIN_DOC).toContain("~/.agents/harnesses/");
    expect(VOLLI_PLUGIN_DOC.toLowerCase()).toContain("verified");
  });

  it("carries a worked example the parser actually accepts", () => {
    const example = VOLLI_PLUGIN_DOC.match(/```json\n([\s\S]*?)```/);
    expect(example).not.toBeNull();
    const parsed = parseHarnessManifest(JSON.parse(example?.[1] ?? "null"));
    expect(parsed.ok ? [] : parsed.errors).toEqual([]);
  });
});
