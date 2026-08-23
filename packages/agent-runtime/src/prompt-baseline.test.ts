import type {
  PromptResource,
  RuntimeWorkspaceEnvironment,
  SessionRuntimeSpec,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  promptBaseline,
  PROMPT_BASELINE_CHARS_PER_TOKEN,
  WORKSPACE_ENVIRONMENT_REMINDER_ID,
} from "./prompt-baseline";
import type { PromptBaselineInput } from "./prompt-baseline";
import {
  composeBriefBlock,
  composeSystemPrompt,
  composeTurnReminderBlock,
  systemPromptSections,
} from "./prompt";

const INDEX: PromptResource = {
  name: "skills index",
  text: "- svg (.agents/skills/svg/SKILL.md): draws vectors",
};

function input(overrides: Partial<PromptBaselineInput> = {}): PromptBaselineInput {
  return {
    role: "project",
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
    // Not a baseline input any more (VC-164): the workspace path is no longer
    // a prompt byte, so it cannot change what the baseline prices. The spec
    // still carries it because that is where a Session actually runs.
    workspacePath: "/code/volli",
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
      cacheClass: "session-static",
      placement: "message",
    });
  });

  it("totals to system plus the message-side blocks and nothing invented", () => {
    const measured = promptBaseline(input());
    expect(measured.reminder).toEqual({ chars: 0, tokens: 0 });
    expect(measured.total.chars).toBe(
      measured.system.chars + measured.brief.chars + measured.reminder.chars,
    );
    expect(measured.total.tokens).toBe(
      measured.system.tokens + measured.brief.tokens + measured.reminder.tokens,
    );
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

describe("promptBaseline — the Turn Reminder as a priced section (VC-164)", () => {
  const ABSENT: RuntimeWorkspaceEnvironment = {
    dependencies: "absent",
    installCommand: "pnpm install",
  };

  it("prices the reminder as the exact bytes the first message carries", () => {
    const measured = promptBaseline(input({ workspaceEnvironment: ABSENT }));
    const block = composeTurnReminderBlock(ABSENT);
    if (block === null) throw new Error("expected a reminder for absent dependencies");
    expect(measured.reminder.chars).toBe(block.length);
    expect(measured.sections.at(-1)).toEqual({
      id: WORKSPACE_ENVIRONMENT_REMINDER_ID,
      chars: block.length,
      tokens: Math.ceil(block.length / PROMPT_BASELINE_CHARS_PER_TOKEN),
      cacheClass: "session-static",
      placement: "message",
    });
  });

  it("carries the reminder into the total — the bytes the prompt shed are still sent", () => {
    const withReminder = promptBaseline(input({ workspaceEnvironment: ABSENT }));
    const without = promptBaseline(input());
    // The prompt is untouched by it; the total is not. That difference is the
    // whole reason the reminder had to be priced somewhere.
    expect(withReminder.system).toEqual(without.system);
    expect(withReminder.total.chars).toBe(without.total.chars + withReminder.reminder.chars);
    expect(withReminder.total.chars).toBe(
      withReminder.system.chars + withReminder.brief.chars + withReminder.reminder.chars,
    );
  });

  it("a healthy workspace is a measured zero, not a missing measurement", () => {
    for (const environment of [
      undefined,
      { dependencies: "installed", installCommand: "pnpm install" },
      { dependencies: null, installCommand: null },
      // Absent dependencies with no command to name: the composer stays silent
      // rather than guessing one, so there is nothing to price.
      { dependencies: "absent", installCommand: null },
    ] satisfies (RuntimeWorkspaceEnvironment | undefined)[]) {
      const measured = promptBaseline(input({ workspaceEnvironment: environment }));
      expect(measured.reminder).toEqual({ chars: 0, tokens: 0 });
      expect(measured.sections.map((section) => section.id)).not.toContain(
        WORKSPACE_ENVIRONMENT_REMINDER_ID,
      );
    }
  });
});

describe("promptBaseline — cache class per section (VC-164)", () => {
  it("classes every section it prices — nothing priced without saying how often", () => {
    const measured = promptBaseline(
      input({ workspaceEnvironment: { dependencies: "absent", installCommand: "pnpm install" } }),
    );
    expect(measured.sections.length).toBeGreaterThan(0);
    for (const section of measured.sections) {
      expect(["role-static", "project-static", "session-static", "per-turn"]).toContain(
        section.cacheClass,
      );
      expect(["prefix", "message"]).toContain(section.placement);
    }
  });

  it("claims a class per section of a fresh project Session", () => {
    const measured = promptBaseline(input());
    expect(
      measured.sections.map((section) => [section.id, section.cacheClass, section.placement]),
    ).toEqual([
      // Forks on whether any RESOURCE section exists, which is the project's index.
      ["operating", "project-static", "prefix"],
      ["role", "role-static", "prefix"],
      // No Authority Snapshot: Role, the tool bundle, and nothing per-Session.
      ["authority", "role-static", "prefix"],
      ["workspace", "role-static", "prefix"],
      ["resources-header", "project-static", "prefix"],
      // The single largest section, and shared by every Session in the project.
      ["resource:skills index", "project-static", "prefix"],
      ["brief", "session-static", "message"],
    ]);
  });

  it("a skill this Session named is session-static, where the project's index is not", () => {
    const measured = promptBaseline(
      input({ promptResources: [INDEX, { name: "svg", text: "draw a vector" }] }),
    );
    const classOf = (id: string) =>
      measured.sections.find((section) => section.id === id)?.cacheClass;
    expect(classOf("resource:skills index")).toBe("project-static");
    expect(classOf("resource:svg")).toBe("session-static");
  });

  it("an Authority Snapshot takes the authority layer out of the shared prefix", () => {
    const measured = promptBaseline(
      input({
        authority: {
          mode: "auto",
          location: "worktree",
          tools: ["read", "edit", "write", "execute"],
          rulePackId: "builtin",
          rulePackHash: "hash",
          classifierModel: null,
          fallback: { consecutiveDenials: 3, sessionDenials: 15 },
        },
      }),
    );
    expect(measured.sections.find((section) => section.id === "authority")?.cacheClass).toBe(
      "session-static",
    );
  });

  it("a fresh Session buys nothing per turn, and nothing per Session in its prefix", () => {
    const measured = promptBaseline(
      input({ workspaceEnvironment: { dependencies: "absent", installCommand: "pnpm install" } }),
    );
    // The finding, asserted rather than described: after lane A's split there is
    // no per-turn byte anywhere in what a fresh Session is sent, and every byte
    // ahead of the cache breakpoint is shared with some other Session. A Session
    // that NAMES a skill puts session-scoped bytes back in the prefix — the
    // resource-set test above — which is a price the reader should see, not a
    // property this default has.
    expect(measured.sections.filter((section) => section.cacheClass === "per-turn")).toEqual([]);
    expect(
      measured.sections
        .filter((section) => section.placement === "prefix")
        .filter((section) => section.cacheClass === "session-static"),
    ).toEqual([]);
    // The volatile facts are all on the message side, where a change invalidates
    // no prefix.
    expect(
      measured.sections
        .filter((section) => section.placement === "message")
        .map((section) => section.id),
    ).toEqual(["brief", WORKSPACE_ENVIRONMENT_REMINDER_ID]);
  });
});
