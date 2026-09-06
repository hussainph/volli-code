// @vitest-environment jsdom
/** The Automation editor's dialog-only layout contracts (VC-222). */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  NO_AUTOMATION_TRIGGER,
  SKILL_POLICY_DEFAULT,
  type Automation,
  type SkillReference,
} from "@volli/shared";

import { AutomationEditorPanel } from "./automation-editor";
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

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "automation-1",
    projectId: "p1",
    name: "Review sweep",
    instructions: "/review",
    trigger: NO_AUTOMATION_TRIGGER,
    runtime: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

async function mountEditor(record: Automation | null = null): Promise<void> {
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
  useAutomationsStore.setState({ editor: { projectId: "p1", automation: record } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <AutomationEditorPanel
        projectId="p1"
        automation={record}
        history={<div data-slot="run-history">Recent runs</div>}
      />,
    );
  });
}

function buttonContaining(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (found === undefined) throw new Error(`no button containing ${label}`);
  return found;
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

describe("the page editor hierarchy", () => {
  it("keeps one clear save action and moves record settings into the inspector", async () => {
    await mountEditor();

    expect(buttonContaining("Create automation").dataset.size).toBe("sm");
    expect(document.querySelector('[data-slot="automation-editor"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Ownership"]')).not.toBeNull();
    expect(document.querySelector('[role="radiogroup"][aria-label="Trigger"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Runtime model"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Name"]')?.classList.contains("text-heading")).toBe(
      true,
    );
  });
});

describe("the schedule time field", () => {
  it("uses a content-sized themed trigger and editable numeric parts", async () => {
    await mountEditor();
    await act(async () => {
      buttonContaining("On a schedule").click();
    });

    const trigger = document.querySelector('[aria-label="Time"]') as HTMLButtonElement;
    expect(trigger.textContent).toBe("09:00");
    expect(trigger.classList.contains("min-w-20")).toBe(true);
    expect(trigger.classList.contains("tabular-nums")).toBe(true);
    expect(document.querySelector('input[type="time"]')).toBeNull();

    await act(async () => {
      trigger.click();
    });
    const hour = document.querySelector('[aria-label="Hour"]') as HTMLInputElement;
    const minute = document.querySelector('[aria-label="Minute"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(hour, "17");
      hour.dispatchEvent(new Event("input", { bubbles: true }));
      setter?.call(minute, "45");
      minute.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(trigger.textContent).toBe("17:45");
    expect(hour.classList.contains("tabular-nums")).toBe(true);
    expect(minute.classList.contains("tabular-nums")).toBe(true);
  });

  it("keeps a two-digit draft intact while the second key is typed", async () => {
    await mountEditor();
    await act(async () => {
      buttonContaining("On a schedule").click();
    });
    await act(async () => {
      (document.querySelector('[aria-label="Time"]') as HTMLButtonElement).click();
    });

    const hour = document.querySelector('[aria-label="Hour"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      hour.focus();
      setter?.call(hour, "1");
      hour.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(hour.value).toBe("1");

    await act(async () => {
      setter?.call(hour, "17");
      hour.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(hour.value).toBe("17");
    expect(document.querySelector('[aria-label="Time"]')?.textContent).toContain("17:00");
  });

  it("gives hourly minutes the same themed numeric treatment", async () => {
    await mountEditor(
      automation({
        trigger: {
          kind: "schedule",
          schedule: { preset: "hourly", minute: 0, timeZone: "Europe/London" },
        },
      }),
    );

    const minute = document.querySelector(
      '[aria-label="Minutes past the hour"]',
    ) as HTMLInputElement;
    expect(minute.inputMode).toBe("numeric");
    expect(minute.classList.contains("tabular-nums")).toBe(true);
  });
});

describe("schedule wording", () => {
  it("gives Weekly one visible day choice beside its time", async () => {
    await mountEditor(
      automation({
        trigger: {
          kind: "schedule",
          schedule: {
            preset: "weekly",
            weekday: "monday",
            hour: 9,
            minute: 0,
            timeZone: "Europe/London",
          },
        },
      }),
    );

    const schedule = document.querySelector('[aria-label="Schedule"]');
    const weekday = document.querySelector('[aria-label="Day of the week"]');
    expect(schedule?.textContent).toContain("Weekly");
    expect(weekday?.textContent).toContain("Monday");
    expect(document.querySelector('[aria-label="Time"]')?.textContent).toContain("09:00");
    // The weekday is one compact dropdown, not another seven-segment strip.
    expect(document.querySelector('[aria-label="Day of the week"] [aria-pressed]')).toBeNull();
  });

  it("spells the hourly offset as minutes past the hour", async () => {
    await mountEditor(
      automation({
        trigger: {
          kind: "schedule",
          schedule: { preset: "hourly", minute: 0, timeZone: "Europe/London" },
        },
      }),
    );

    const minute = document.querySelector(
      '[aria-label="Minutes past the hour"]',
    ) as HTMLInputElement;
    expect(minute.value).toBe("00");
    expect(minute.parentElement?.textContent).toContain("Minutes past the hour");
  });
});

describe("the Instructions picker", () => {
  it("keeps a long Skill row inside the dialog's shrinkable grid item", async () => {
    await mountEditor();
    await typeInstructions("/");

    const editor = document.querySelector('[data-slot="automation-editor"]');
    const stack = document.querySelector('[data-slot="composer-picker-stack"]');
    const overlay = document.querySelector('[data-slot="composer-picker-overlay"]');
    const picker = document.querySelector('[data-slot="composer-picker"]');

    expect(picker?.textContent).toContain(LONG_SKILL.name);
    expect(editor?.contains(picker)).toBe(true);
    expect(stack?.classList.contains("relative")).toBe(true);
    expect(stack?.classList.contains("min-w-0")).toBe(true);
    expect(overlay?.classList.contains("absolute")).toBe(true);
    // Floating suggestions do not take a flow slot before the Run history.
    expect(document.querySelector('[data-slot="run-history"]')?.textContent).toBe("Recent runs");
  });
});
