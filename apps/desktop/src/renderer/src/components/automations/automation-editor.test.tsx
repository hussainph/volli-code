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

  it("gives hourly minutes the same themed numeric treatment", async () => {
    await mountEditor();
    await act(async () => {
      buttonContaining("On a schedule").click();
    });
    await act(async () => {
      buttonContaining("Hourly").click();
    });

    const minute = document.querySelector(
      '[aria-label="Minutes past the hour"]',
    ) as HTMLInputElement;
    expect(minute.type).toBe("number");
    expect(minute.classList.contains("tabular-nums")).toBe(true);
  });
});

describe("schedule wording", () => {
  it("names each cadence plainly and gives Weekly one visible day choice", async () => {
    await mountEditor();
    await act(async () => {
      buttonContaining("On a schedule").click();
    });

    for (const cadence of ["Hourly", "Every day", "Mon–Fri", "Weekly"]) {
      expect(buttonContaining(cadence)).toBeTruthy();
    }
    await act(async () => {
      buttonContaining("Weekly").click();
    });

    const weekday = document.querySelector('[aria-label="Day of the week"]');
    const scheduleRow = document.querySelector('[aria-label="Schedule"]')?.parentElement;
    expect(weekday?.textContent).toContain("Monday");
    expect(scheduleRow?.parentElement?.textContent).toContain("onMondayat09:00");
    // The weekday is one compact dropdown, not another seven-segment strip.
    expect(document.querySelector('[aria-label="Day of the week"] [aria-pressed]')).toBeNull();
  });

  it("spells the hourly offset as minutes past the hour", async () => {
    await mountEditor();
    await act(async () => {
      buttonContaining("On a schedule").click();
    });
    await act(async () => {
      buttonContaining("Hourly").click();
    });

    const minute = document.querySelector(
      '[aria-label="Minutes past the hour"]',
    ) as HTMLInputElement;
    expect(minute.value).toBe("00");
    expect(minute.parentElement?.parentElement?.textContent).toContain(":past the hour");
  });
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
