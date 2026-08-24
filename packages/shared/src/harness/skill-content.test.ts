import { describe, expect, it } from "vite-plus/test";

import { AGENT_CONCEPT_SECTIONS, ERROR_RECOVERY } from "../agent-product";
import { AGENT_ERROR_CODES } from "../agent-surface";
import { VERB_REGISTRY } from "../verb-registry";
import type { VerbEffects, VerbEntry } from "../verb-registry";
import { parseHarnessManifest } from "./manifest";
import {
  VOLLI_CHANGES,
  VOLLI_CLI_REFERENCE,
  VOLLI_COMMAND_DOC,
  VOLLI_CONCEPTS,
  VOLLI_FENCED_INSTRUCTIONS,
  VOLLI_PATH_PROFILE_BLOCK,
  VOLLI_PLUGIN_DOC,
  VOLLI_SKILL,
} from "./skill-content";
import { HARNESS_EVENTS } from "./types";

describe("injected content is inert outside Volli (VC-42 F18)", () => {
  // These land in GLOBAL files (~/.codex/AGENTS.md, ~/AGENTS.md, shared skill
  // dirs) that every session of that harness reads — almost all of them outside
  // Volli. Each one must gate itself on the Volli env vars and say what NOT to
  // do when they are absent, or a plain Codex/Claude session burns its context
  // running `volli identify` and `volli app launch` against nothing.
  const gated: Record<string, string> = {
    VOLLI_FENCED_INSTRUCTIONS,
    VOLLI_SKILL,
    VOLLI_COMMAND_DOC,
  };

  for (const [name, content] of Object.entries(gated)) {
    it(`${name} names the env-var gate and the stand-down instruction`, () => {
      expect(content).toContain("VOLLI_SESSION");
      expect(content).toContain("VOLLI_SOCKET");
      // The negative instruction has to be explicit: "applies only when…" alone
      // still reads as an invitation to try the command and see.
      expect(content).toMatch(/do not run|never run/);
    });
  }
});

describe("VOLLI_PATH_PROFILE_BLOCK", () => {
  it("is a zsh-safe fragment that prepends ~/.local/bin without expanding $HOME early", () => {
    expect(VOLLI_PATH_PROFILE_BLOCK).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(VOLLI_PATH_PROFILE_BLOCK).not.toContain("<!--");
  });
});

describe("managed Volli product guidance", () => {
  it("projects every canonical concept section into the local concepts file", () => {
    for (const section of AGENT_CONCEPT_SECTIONS) {
      expect(VOLLI_CONCEPTS).toContain(`## ${section.heading}`);
      for (const paragraph of section.paragraphs) expect(VOLLI_CONCEPTS).toContain(paragraph);
      for (const bullet of section.bullets ?? []) expect(VOLLI_CONCEPTS).toContain(bullet);
    }
    expect(VOLLI_CHANGES).toContain("Capability baseline: `8e8a17c0`");
  });

  it("projects every registry effect and recovery policy into cli.md", () => {
    const effectVerbs = (VERB_REGISTRY as readonly VerbEntry[]).filter(
      (verb): verb is VerbEntry & { effects: VerbEffects } =>
        verb.listed && verb.effects !== undefined,
    );
    for (const entry of effectVerbs) {
      expect(VOLLI_CLI_REFERENCE).toContain(`### \`${entry.key}\``);
      for (const write of entry.effects.durableWrites) {
        expect(VOLLI_CLI_REFERENCE).toContain(write.summary);
      }
      for (const effect of [...entry.effects.humanVisible, ...entry.effects.nonEffects]) {
        expect(VOLLI_CLI_REFERENCE).toContain(effect);
      }
    }
    for (const code of AGENT_ERROR_CODES) {
      expect(VOLLI_CLI_REFERENCE).toContain(`### \`${code}\``);
      expect(VOLLI_CLI_REFERENCE).toContain(ERROR_RECOVERY[code].why);
    }
  });
});

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
      "claude-settings-json",
      "codex-config-override",
      "config-dir-env",
      "opencode-plugin",
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
