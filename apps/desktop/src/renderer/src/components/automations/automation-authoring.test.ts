import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { NO_AUTOMATION_TRIGGER } from "@volli/shared";

import { bootChatSession, type ChatBoot } from "@renderer/components/sessions/session-create";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useWorkspaceStore } from "@renderer/stores/workspace";
import {
  automationAuthoringPrompt,
  startAutomationAuthoring,
  type AutomationAuthoringContext,
} from "./automation-authoring";

vi.mock("@renderer/components/sessions/session-create", () => ({ bootChatSession: vi.fn() }));

const DRAFT: AutomationAuthoringContext = {
  name: "Review",
  instructions: "Check the change against the ticket, then report findings.",
  trigger: NO_AUTOMATION_TRIGGER,
  runtime: { kind: "tier", tier: "deep" },
  skillSlugs: ["code-review"],
};

afterEach(() => vi.restoreAllMocks());

describe("automation authoring assistance", () => {
  it("carries the exact current draft and catalogue, with review-only intent", () => {
    const prompt = automationAuthoringPrompt(DRAFT);
    expect(prompt).toContain(JSON.stringify(DRAFT, null, 2));
    expect(prompt).toContain("Preserve my approach");
    expect(prompt).toContain("failure/stop conditions");
    expect(prompt).toContain("Do not run automations");
    expect(prompt).toContain("Do not invent tools");
    expect(prompt).toContain("review and copy");
    expect(prompt).toContain("Do not assume listing a skill activates it");
  });

  it("lands a durable Board chat before queueing the authoring turn", async () => {
    const open = vi
      .spyOn(useChatSessionsStore.getState(), "openChatTab")
      .mockImplementation(() => {});
    const enqueue = vi
      .spyOn(useChatSessionsStore.getState(), "enqueue")
      .mockImplementation(() => {});
    const home = vi.spyOn(useWorkspaceStore.getState(), "openHome").mockImplementation(() => {});
    vi.mocked(bootChatSession).mockImplementation(async (_scope, options: ChatBoot) => {
      expect(enqueue).not.toHaveBeenCalled();
      expect(options.title).toBe("Draft automation");
      expect(options.land("s1")).toBe(true);
      return "s1";
    });

    expect(await startAutomationAuthoring("p1", DRAFT)).toBe("s1");
    expect(bootChatSession).toHaveBeenCalledWith(
      { kind: "project", projectId: "p1" },
      expect.objectContaining({ title: "Draft automation" }),
    );
    expect(open).toHaveBeenCalledWith("p1", "s1");
    expect(enqueue).toHaveBeenCalledWith("s1", {
      id: expect.any(String),
      text: automationAuthoringPrompt(DRAFT),
    });
    expect(home).toHaveBeenCalledWith("p1", "chat:s1");
  });

  it("does not navigate or queue after a failed or guarded create", async () => {
    vi.mocked(bootChatSession).mockResolvedValue(null);
    const enqueue = vi
      .spyOn(useChatSessionsStore.getState(), "enqueue")
      .mockImplementation(() => {});
    const home = vi.spyOn(useWorkspaceStore.getState(), "openHome").mockImplementation(() => {});
    expect(await startAutomationAuthoring("p1", DRAFT)).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    expect(home).not.toHaveBeenCalled();
  });
});
