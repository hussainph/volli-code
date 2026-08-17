import type { PromptResource, SessionRuntimeSpec } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { promptBaseline, PROMPT_BASELINE_CHARS_PER_TOKEN } from "./prompt-baseline";
import type { PromptBaselineInput } from "./prompt-baseline";
import { composeBriefBlock, composeSystemPrompt, systemPromptSections } from "./prompt";

const INDEX: PromptResource = {
  name: "skills index",
  text: "- svg (.agents/skills/svg/SKILL.md): draws vectors",
};

function input(overrides: Partial<PromptBaselineInput> = {}): PromptBaselineInput {
  return {
    role: "project",
    workspacePath: "/code/volli",
    tools: { tools: ["read", "edit", "write", "execute"] },
    brief: { text: "A project-scoped chat Session." },
    promptResources: [INDEX],
    ...overrides,
  };
}

/** The full spec `composeSystemPrompt` takes, carrying the same prompt-relevant fields. */
function spec(baseline: PromptBaselineInput): SessionRuntimeSpec {
  return {
    identity: {
      role: "project",
      sessionId: "session-1",
      rootThreadId: "thread-1",
      attachmentId: "attachment-1",
      projectId: "project-1",
      ticketId: null,
    },
    workspacePath: baseline.workspacePath,
    venue: "local",
    model: { providerId: "anthropic", modelId: "claude-haiku-4-5", reasoningLevel: "medium" },
    brief: baseline.brief,
    tools: baseline.tools,
    ...(baseline.promptResources === undefined
      ? {}
      : { promptResources: baseline.promptResources }),
    observer: async () => {},
  };
}

describe("promptBaseline", () => {
  it("prices the exact string composeSystemPrompt assembles — separators included", () => {
    const measured = promptBaseline(input());
    const composed = composeSystemPrompt(spec(input()));
    expect(measured.system.chars).toBe(composed.length);
    expect(measured.system.tokens).toBe(
      Math.ceil(composed.length / PROMPT_BASELINE_CHARS_PER_TOKEN),
    );
  });

  it("names every section the composer renders, in delivery order, then the brief", () => {
    const measured = promptBaseline(input());
    expect(measured.sections.map((section) => section.id)).toEqual([
      "operating",
      "role",
      "authority",
      "workspace",
      "resources-header",
      "resource:skills index",
      "brief",
    ]);
  });

  it("prices the brief as its delimited block — the bytes the first message opens with", () => {
    const measured = promptBaseline(input());
    const block = composeBriefBlock("project", { text: "A project-scoped chat Session." });
    expect(measured.brief.chars).toBe(block.length);
    expect(measured.sections.at(-1)).toEqual({
      id: "brief",
      chars: block.length,
      tokens: Math.ceil(block.length / PROMPT_BASELINE_CHARS_PER_TOKEN),
    });
  });

  it("totals to system plus brief and nothing invented", () => {
    const measured = promptBaseline(input());
    expect(measured.total.chars).toBe(measured.system.chars + measured.brief.chars);
    expect(measured.total.tokens).toBe(measured.system.tokens + measured.brief.tokens);
  });

  it("drops the resource sections when a Session carries no resources", () => {
    const bare = promptBaseline(input({ promptResources: undefined }));
    expect(bare.sections.map((section) => section.id)).toEqual([
      "operating",
      "role",
      "authority",
      "workspace",
      "brief",
    ]);
  });

  it("cannot drift from the composer: each section's text is the composed prompt's", () => {
    const sections = systemPromptSections(input());
    expect(composeSystemPrompt(spec(input()))).toBe(
      sections.map((section) => section.text).join("\n\n"),
    );
  });
});
