import {
  skillPromptResource,
  skillsIndexResource,
  type PromptResource,
  type RuntimeWorkspaceEnvironment,
  type SkillReference,
  SKILL_POLICY_DEFAULT,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  promptBaseline,
  PROMPT_BASELINE_CHARS_PER_TOKEN,
  TOOL_SURFACE_REMINDER_ID,
  WORKSPACE_ENVIRONMENT_REMINDER_ID,
} from "./prompt-baseline";
import type { PromptBaselineInput } from "./prompt-baseline";
import {
  composeBriefBlock,
  composeSystemPrompt,
  composeToolSurfaceBlock,
  composeTurnReminderBlock,
  systemPromptSections,
} from "./prompt";

const INDEX: PromptResource = {
  name: "skills index",
  text: "- svg (.agents/skills/svg/SKILL.md): draws vectors",
};

function skill(name: string): SkillReference {
  return {
    name,
    description: `${name} description`,
    body: `# ${name}\n\nDo ${name}.`,
    authorPolicy: SKILL_POLICY_DEFAULT,
    effectivePolicy: SKILL_POLICY_DEFAULT,
    policyDiagnostic: null,
    root: `.agents/skills/${name}`,
  };
}

function input(overrides: Partial<PromptBaselineInput> = {}): PromptBaselineInput {
  return {
    role: "project",
    // A Project Session's real bundle, verb half included (VC-162) — the
    // baseline exists to price what a fresh Session is actually sent.
    tools: { tools: ["read", "edit", "write", "execute"], verbs: ["session.start"] },
    brief: { text: "A project-scoped chat Session." },
    promptResources: [INDEX],
    ...overrides,
  };
}

describe("promptBaseline", () => {
  it("prices the exact string composeSystemPrompt assembles — separators included", () => {
    const measured = promptBaseline(input());
    const composed = composeSystemPrompt(input());
    expect(measured.system.chars).toBe(composed.length);
    expect(measured.system.tokens).toBe(
      Math.ceil(composed.length / PROMPT_BASELINE_CHARS_PER_TOKEN),
    );
  });

  it("names every section the composer renders, in delivery order, then the message blocks", () => {
    const measured = promptBaseline(input());
    expect(measured.sections.map((section) => section.id)).toEqual([
      "operating",
      "role",
      "authority",
      "workspace",
      "resources-header",
      "resource:skills index",
      "brief",
      TOOL_SURFACE_REMINDER_ID,
    ]);
  });

  it("prices the brief as its delimited block — the bytes the first message opens with", () => {
    const measured = promptBaseline(input());
    const block = composeBriefBlock("project", { text: "A project-scoped chat Session." });
    expect(measured.brief.chars).toBe(block.length);
    expect(measured.sections.find((section) => section.id === "brief")).toEqual({
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
      measured.system.chars +
        measured.brief.chars +
        measured.reminder.chars +
        measured.toolSurface.chars,
    );
    expect(measured.total.tokens).toBe(
      measured.system.tokens +
        measured.brief.tokens +
        measured.reminder.tokens +
        measured.toolSurface.tokens,
    );
  });

  it("prices the Role bundle block, for a Session that holds nothing too", () => {
    // The block is unconditional (VC-162), so unlike the workspace reminder it
    // never measures zero: a Ticket Session is told it holds no verbs, and
    // being told costs bytes that have to appear in the breakdown.
    const ticket = promptBaseline(input({ role: "ticket", tools: { tools: ["read"] } }));
    expect(ticket.toolSurface.chars).toBe(
      composeToolSurfaceBlock("ticket", { tools: ["read"] }).length,
    );
    expect(ticket.toolSurface.chars).toBeGreaterThan(0);
    expect(ticket.sections.at(-1)?.id).toBe(TOOL_SURFACE_REMINDER_ID);
  });

  it("drops the resource sections when a Session carries no resources", () => {
    const bare = promptBaseline(input({ promptResources: undefined }));
    expect(bare.sections.map((section) => section.id)).toEqual([
      "operating",
      "role",
      "authority",
      "workspace",
      "brief",
      TOOL_SURFACE_REMINDER_ID,
    ]);
  });

  it("cannot drift from the composer: each section's text is the composed prompt's", () => {
    const sections = systemPromptSections(input());
    expect(composeSystemPrompt(input())).toBe(sections.map((section) => section.text).join("\n\n"));
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
      withReminder.system.chars +
        withReminder.brief.chars +
        withReminder.reminder.chars +
        withReminder.toolSurface.chars,
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
      // Session authority policy is outside the prompt; Role + bundle remain.
      ["authority", "role-static", "prefix"],
      ["workspace", "role-static", "prefix"],
      ["resources-header", "project-static", "prefix"],
      // The single largest section, and shared by every Session in the project.
      ["resource:skills index", "project-static", "prefix"],
      ["brief", "session-static", "message"],
      // Session-static and NOT role-static, which is why it is a message block
      // rather than a prompt layer (VC-162): grants make bundle membership vary
      // between two Sessions of the same Role, and a prefix section that did
      // that would split their Cache Prefix.
      [TOOL_SURFACE_REMINDER_ID, "session-static", "message"],
    ]);
  });

  it("classes the production named-skill + filtered-index shape conservatively", () => {
    const named = skill("svg");
    const listed = skill("tdd");
    const index = skillsIndexResource([named, listed], [named.name]);
    if (index === null) throw new Error("expected the remaining skill in the index");
    const resources = [skillPromptResource(named), index];
    // Production orders named bodies first, then builds an index with those
    // names removed. That makes this Session's index bytes session-specific.
    expect(resources.map((resource) => resource.name)).toEqual(["svg", "skills index"]);
    expect(index.text).not.toContain("svg");
    expect(index.text).toContain("tdd");

    const measured = promptBaseline(input({ promptResources: resources }));
    const classOf = (id: string) =>
      measured.sections.find((section) => section.id === id)?.cacheClass;
    expect(classOf("operating")).toBe("session-static");
    expect(classOf("resources-header")).toBe("session-static");
    expect(classOf("resource:svg")).toBe("session-static");
    expect(classOf("resource:skills index")).toBe("session-static");
  });

  it("under-claims an empty resource shape whose project supply is unknown", () => {
    const measured = promptBaseline(input({ promptResources: undefined }));
    expect(measured.sections.find((section) => section.id === "operating")?.cacheClass).toBe(
      "session-static",
    );
  });

  it("keeps Session authority policy outside the priced prompt boundary", () => {
    const authority = promptBaseline(input()).sections.find(
      (section) => section.id === "authority",
    );
    expect(authority?.cacheClass).toBe("role-static");
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
    ).toEqual(["brief", TOOL_SURFACE_REMINDER_ID, WORKSPACE_ENVIRONMENT_REMINDER_ID]);
  });
});
