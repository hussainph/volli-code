// @vitest-environment jsdom
/** The Automation editor's dialog-only layout contracts (VC-222). */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SKILL_POLICY_DEFAULT, type SkillReference } from "@volli/shared";

import { AutomationEditorDialog } from "./automation-editor";
import { useAutomationsStore } from "@renderer/stores/automations";

let root: Root | null = null;
let container: HTMLElement | null = null;

const LONG_SKILL: SkillReference = {
  name: "review-every-single-boundary-in-this-extraordinarily-long-automation-skill-name",
  description:
    "Inspect every renderer, preload, main-process, and durable storage boundary before reporting a result.",
  body: "# Boundary review",
  authorPolicy: SKILL_POLICY_DEFAULT,
  effectivePolicy: SKILL_POLICY_DEFAULT,
  policyDiagnostic: null,
  root: ".agents/skills/review-every-boundary",
};

async function mountEditor(): Promise<void> {
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      files: {
        promptTemplates: vi.fn(async () => ({
          ok: true,
          templates: [],
          skills: [LONG_SKILL],
        })),
        index: vi.fn(async () => ({ ok: true, files: [] })),
      },
    },
  });
  useAutomationsStore.setState({ editor: { projectId: "p1", automation: null } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<AutomationEditorDialog />);
  });
}

async function typeInstructions(value: string): Promise<void> {
  const box = document.querySelector('[aria-label="Instructions"]') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(box, value);
    box.setSelectionRange(value.length, value.length);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  useAutomationsStore.setState({ editor: null });
  vi.unstubAllGlobals();
});

describe("the Instructions picker", () => {
  it("keeps a long Skill row inside the dialog's shrinkable grid item", async () => {
    await mountEditor();
    await typeInstructions("/");

    const dialog = document.querySelector('[data-slot="dialog-content"]');
    const body = document.querySelector('[data-slot="automation-editor-body"]');
    const picker = document.querySelector('[data-slot="composer-picker"]');

    expect(picker?.textContent).toContain(LONG_SKILL.name);
    expect(dialog?.contains(picker)).toBe(true);
    // This is the load-bearing width rule: DialogContent is a grid, and
    // `min-w-0` lets this item shrink below the picker's intrinsic row width.
    expect(body?.classList.contains("min-w-0")).toBe(true);
  });
});
