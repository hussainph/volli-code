// @vitest-environment jsdom
/**
 * The approval card Protection raises (VC-480), driven the way a person drives
 * it: a click or a digit answers, nothing is preselected, "Deny and steer" opens
 * a field in place, and the card says only what Volli wrote about the call.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  askOffer,
  writeScope,
  type ApprovalDetail,
  type RendererSessionInteraction,
  type SessionInteractionResolution,
} from "@volli/shared";

import { InteractionCard } from "./interaction-ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SCOPE = writeScope("/Users/me/code/docs/guides/a.md");

function card(detail: Partial<ApprovalDetail> = {}, scopes = [SCOPE]): RendererSessionInteraction {
  const offer = askOffer({
    cause: "path.outside-workspace",
    tool: "write",
    toolCallId: "call-1",
    turnId: null,
    reason: "outside",
    trip: "approval",
    overridable: true,
    approval: { asked: "write  /Users/me/code/docs/guides/a.md", scopes },
  });
  return {
    id: "ask:call-1",
    attachmentId: "attach-1",
    kind: "permission",
    title: "Allow writing outside this workspace?",
    detail: null,
    approval: {
      asked: "write  /Users/me/code/docs/guides/a.md",
      because: "this file is outside the Session's workspace, and protection is on.",
      reason: "/x is outside this Session's writable roots",
      stages: [],
      held: null,
      ...detail,
    },
    options: offer.options,
    multiple: false,
    native: { id: null, detail: null },
  };
}

let mounted: { root: Root; host: HTMLElement } | null = null;

afterEach(() => {
  if (mounted === null) return;
  const { root, host } = mounted;
  mounted = null;
  act(() => root.unmount());
  host.remove();
});

function mount(element: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  act(() => root.render(element));
  return host;
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(text),
  );
  if (found === undefined) throw new Error(`no button containing ${text}`);
  return found;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe("ApprovalCard", () => {
  it("keeps a model-authored ask_user with a steer option an ordinary question when Protection is off", async () => {
    const onResolve = vi.fn();
    const interaction = {
      ...card(),
      id: "ask-user:model-1",
      kind: "question" as const,
      approval: undefined,
      title: "Where next?",
      detail: "Model question",
      options: [{ id: "steer", label: "Steer north", description: null }],
    };
    const host = mount(<InteractionCard interaction={interaction} onResolve={onResolve} />);
    expect(host.querySelector("[data-slot='approval-card']")).toBeNull();
    expect(host.textContent).not.toContain("Stopped because");
    act(() => button(host, "Steer north").click());
    await settle();
    expect(onResolve).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Send answer");
  });

  it.each(["session", "project"])(
    "never remaps hidden %s actions onto another digit",
    async (hidden) => {
      const onResolve = vi.fn();
      const base = card();
      const host = mount(
        <InteractionCard
          interaction={{ ...base, options: base.options.filter((option) => option.id !== hidden) }}
          onResolve={onResolve}
        />,
      );
      const form = host.querySelector("form")!;
      act(() =>
        form.dispatchEvent(
          new KeyboardEvent("keydown", { key: hidden === "session" ? "2" : "3", bubbles: true }),
        ),
      );
      await settle();
      expect(onResolve).not.toHaveBeenCalled();
      act(() => form.dispatchEvent(new KeyboardEvent("keydown", { key: "4", bubbles: true })));
      await settle();
      expect(onResolve).toHaveBeenCalledWith({
        resolution: { optionIds: ["reject"], response: null },
        message: null,
      });
      expect(button(host, "Deny and steer").textContent).toMatch(/^5/u);
    },
  );

  it("keeps once=1, deny=4 and steer=5 when both remembered grants are unavailable", async () => {
    const resolutions: SessionInteractionResolution[] = [];
    const host = mount(
      <InteractionCard
        interaction={card({}, [])}
        onResolve={({ resolution }) => void resolutions.push(resolution)}
      />,
    );
    expect(button(host, "Allow once").textContent).toMatch(/^1/u);
    expect(button(host, "DenyThe").textContent).toMatch(/^4/u);
    expect(button(host, "Deny and steer").textContent).toMatch(/^5/u);
    const form = host.querySelector("form")!;
    act(() => {
      for (const key of ["2", "3", "0", "6", "1e0"]) {
        form.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      }
    });
    await settle();
    expect(resolutions).toEqual([]);
    act(() => form.dispatchEvent(new KeyboardEvent("keydown", { key: "5", bubbles: true })));
    expect(host.querySelector("textarea")).not.toBeNull();
    expect(resolutions).toEqual([]);
  });

  it("preserves delimiter characters in every typed metadata field", () => {
    const host = mount(
      <InteractionCard
        interaction={{
          ...card(),
          detail: null,
          approval: {
            asked: "printf 'a\u241eb'",
            because: "policy\u241ereason",
            reason: "rule\u241etext",
            stages: ["echo 'a\u241eb'", "tee /x"],
            held: 1,
          },
        }}
        onResolve={() => undefined}
      />,
    );
    expect(host.textContent).toContain("echo 'a\u241eb'");
    expect(host.textContent).toContain("Stopped because policy\u241ereason");
    act(() => button(host, "See details").click());
    expect(host.textContent).toContain("printf 'a\u241eb'");
    expect(host.textContent).toContain("rule\u241etext");
  });

  it("says what the agent wants and why it was stopped, in Volli's words, with nothing preselected", () => {
    const host = mount(<InteractionCard interaction={card()} onResolve={() => undefined} />);
    expect(host.textContent).toContain("Allow writing outside this workspace?");
    expect(host.textContent).toContain("write  /Users/me/code/docs/guides/a.md");
    expect(host.textContent).toContain(
      "Stopped because this file is outside the Session's workspace, and protection is on.",
    );
    for (const label of [
      "Allow once",
      "Allow for this Session",
      "Always allow in this project",
      "Deny",
      "Deny and steer",
    ]) {
      expect(host.textContent).toContain(label);
    }
    expect(host.textContent).toContain("Write to /Users/me/code/docs/guides for every Session");
    expect(host.querySelectorAll("[aria-pressed='true'],[aria-checked='true']")).toHaveLength(0);
  });

  it("answers with one click, sending exactly one option id", async () => {
    const resolutions: SessionInteractionResolution[] = [];
    const host = mount(
      <InteractionCard
        interaction={card()}
        onResolve={({ resolution }) => void resolutions.push(resolution)}
      />,
    );
    act(() => button(host, "Always allow in this project").click());
    await settle();
    expect(resolutions).toEqual([{ optionIds: ["project"], response: null }]);
  });

  it("answers with the digit on the row and takes no second answer", async () => {
    const resolutions: SessionInteractionResolution[] = [];
    const host = mount(
      <InteractionCard
        interaction={card()}
        onResolve={({ resolution }) => void resolutions.push(resolution)}
      />,
    );
    const form = host.querySelector("form")!;
    act(() => {
      form.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
      form.dispatchEvent(new KeyboardEvent("keydown", { key: "4", bubbles: true }));
    });
    await settle();
    expect(resolutions).toEqual([{ optionIds: ["session"], response: null }]);
  });

  it("opens a field for Deny and steer and sends the words with the steer option", async () => {
    const resolutions: SessionInteractionResolution[] = [];
    const host = mount(
      <InteractionCard
        interaction={card()}
        onResolve={({ resolution }) => void resolutions.push(resolution)}
      />,
    );
    act(() => button(host, "Deny and steer").click());
    expect(resolutions).toEqual([]);
    const field = host.querySelector("textarea")!;
    expect(field.getAttribute("placeholder")).toBe("Tell the agent what to do instead");
    const send = button(host, "Deny and send");
    expect(send.disabled).toBe(true);
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(field, "  write it to /tmp  ");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => button(host, "Deny and send").click());
    await settle();
    expect(resolutions).toEqual([{ optionIds: ["steer"], response: "write it to /tmp" }]);
  });

  it("does not take a digit typed into the steering field for an answer", () => {
    const onResolve = vi.fn();
    const host = mount(<InteractionCard interaction={card()} onResolve={onResolve} />);
    act(() => button(host, "Deny and steer").click());
    const field = host.querySelector("textarea")!;
    act(() => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("keeps See details closed until asked, then shows the full call and the rule's words", () => {
    const host = mount(<InteractionCard interaction={card()} onResolve={() => undefined} />);
    expect(host.textContent).not.toContain("The rule that stopped it");
    act(() => button(host, "See details").click());
    expect(host.textContent).toContain("The full call");
    expect(host.textContent).toContain("/x is outside this Session's writable roots");
    act(() => button(host, "Hide details").click());
    expect(host.textContent).not.toContain("The rule that stopped it");
  });

  it("shows all objections and affected stages before an aggregate approval is answered", () => {
    const interaction = card({
      stages: ["write /outside/a", "git reset --hard", "echo done"],
      held: 0,
      heldStages: [0, 1],
      because: "the write is outside the workspace. Also, git discards uncommitted changes.",
    });
    interaction.title = "Allow these actions?";
    const host = mount(<InteractionCard interaction={interaction} onResolve={() => undefined} />);
    expect(host.textContent).toContain("git discards uncommitted changes");
    expect([...host.querySelectorAll("ol li")].map((stage) => stage.textContent)).toEqual([
      "1write /outside/aheld",
      "2git reset --hardheld",
      "3echo done",
    ]);
  });

  it("shows a compound command whole with the held stage marked", () => {
    const host = mount(
      <InteractionCard
        interaction={card({ stages: ["mkdir -p out", "tee /x/y", "echo done"], held: 1 })}
        onResolve={() => undefined}
      />,
    );
    const stages = [...host.querySelectorAll("ol[aria-label='Command stages'] li")];
    expect(stages.map((stage) => stage.textContent)).toEqual([
      "1mkdir -p out",
      "2tee /x/yheld",
      "3echo done",
    ]);
  });

  it("offers no project-wide rule for a command it cannot read inside", () => {
    const interaction = card({}, [
      {
        operation: "command",
        target: "bash -c x",
        key: "bash -c x",
        summary: "Run exactly: bash -c x",
      },
    ]);
    const host = mount(<InteractionCard interaction={interaction} onResolve={() => undefined} />);
    expect(host.textContent).toContain("Allow for this Session");
    expect(host.textContent).not.toContain("Always allow in this project");
  });

  it("offers only once, deny and steer when nothing can be remembered, and can be withdrawn", async () => {
    const onWithdraw = vi.fn();
    const host = mount(
      <InteractionCard
        interaction={card({}, [])}
        onResolve={() => undefined}
        onWithdraw={onWithdraw}
      />,
    );
    expect(host.textContent).not.toContain("Allow for this Session");
    act(() => button(host, "Withdraw").click());
    await settle();
    expect(onWithdraw).toHaveBeenCalledOnce();
  });

  it("puts the card back, saying so, when the answer did not land", async () => {
    const host = mount(<InteractionCard interaction={card()} onResolve={async () => false} />);
    act(() => button(host, "Allow once").click());
    await settle();
    expect(host.querySelector("[role='alert']")?.textContent).toContain("Not delivered");
  });
});
