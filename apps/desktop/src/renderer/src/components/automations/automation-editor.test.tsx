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
import { startAutomationAuthoring } from "./automation-authoring";

vi.mock("./automation-authoring", () => ({ startAutomationAuthoring: vi.fn(async () => null) }));
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { clearEditorDraft, loadEditorDraft, saveEditorDraft } from "./editor-draft";
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
      automations: {
        create: vi.fn(async ({ name }: { name: string }) => ({
          ok: true,
          automation: automation({ id: "automation-2", name }),
        })),
        update: vi.fn(async () => ({ ok: true, automation: automation() })),
      },
      appState: {
        set: vi.fn(async () => ({ ok: true, receipt: {} })),
      },
    },
  });
  useAutomationsStore.setState({ editor: { projectId: "p1", automation: record } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <AutomationEditorPanel
          projectId="p1"
          automation={record}
          history={<div data-slot="run-history">Recent runs</div>}
        />
      </TooltipProvider>,
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
  // The draft cache is module-level and shared across tests; a leftover slot
  // would seed the next mount's fields and turn these tests order-dependent.
  clearEditorDraft("p1");
  clearEditorDraft("p1", undefined, "automation-1");
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

describe("a tier Runtime", () => {
  it("survives a reopen and rides the save whole", async () => {
    // The editor used to hold a `ModelSelection | null`, so opening an
    // Automation that names a tier reset the control to inherit and the next
    // save rewrote the record to a policy nobody chose (VC-259).
    const update = vi.fn(async () => null);
    useAutomationsStore.setState({ update });
    await mountEditor(automation({ runtime: { kind: "tier", tier: "fast" } }));

    await act(async () => {
      buttonContaining("Save changes").click();
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: { kind: "tier", tier: "fast" } }),
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

function typeName(value: string): Promise<void> {
  const box = document.querySelector('[aria-label="Name"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  return act(async () => {
    setter?.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function seededDraft(): Parameters<typeof saveEditorDraft>[1] {
  return {
    name: "Nightly sweep",
    instructions: "/review the board",
    ownership: "project",
    triggerChoice: "schedule",
    columns: [],
    schedule: { preset: "daily", hour: 21, minute: 0, timeZone: "Europe/London" },
    runtime: null,
  };
}

describe("automation editor drafts (VC-329)", () => {
  it("hands the current idea and skill catalogue to a drafting chat without saving a record", async () => {
    await mountEditor();
    expect(buttonContaining("Draft in chat").disabled).toBe(true);
    await typeName("Review idea");
    await typeInstructions("Use the user's review approach and report findings");
    await act(async () => buttonContaining("Draft in chat").click());
    expect(startAutomationAuthoring).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        name: "Review idea",
        instructions: "Use the user's review approach and report findings",
        skillSlugs: [LONG_SKILL.name],
      }),
    );
    expect(window.api.automations.create).not.toHaveBeenCalled();
    expect(loadEditorDraft("p1")?.name).toBe("Review idea");
  });

  it("writes every field change into the draft cache", async () => {
    await mountEditor();
    await typeName("Nightly sweep");
    await typeInstructions("/review the board");

    expect(loadEditorDraft("p1")).toMatchObject({
      name: "Nightly sweep",
      instructions: "/review the board",
    });
  });

  it("restores a stored draft on mount, visibly, with a discard", async () => {
    saveEditorDraft("p1", seededDraft());
    await mountEditor();

    const name = document.querySelector('[aria-label="Name"]') as HTMLInputElement;
    const instructions = document.querySelector(
      '[aria-label="Instructions"]',
    ) as HTMLTextAreaElement;
    expect(name.value).toBe("Nightly sweep");
    expect(instructions.value).toBe("/review the board");
    expect(buttonContaining("On a schedule").getAttribute("aria-checked")).toBe("true");
    expect((document.querySelector('[aria-label="Time"]') as HTMLButtonElement).textContent).toBe(
      "21:00",
    );
    // Visible, not silent: the restored state says so, and offers the discard.
    const banner = document.querySelector('[data-slot="draft-resumed"]');
    expect(banner?.textContent).toContain("Draft restored");
    await act(async () => {
      buttonContaining("Discard draft").click();
    });
    expect(loadEditorDraft("p1")).toBeNull();
    expect((document.querySelector('[aria-label="Name"]') as HTMLInputElement).value).toBe("");
    expect(document.querySelector('[data-slot="draft-resumed"]')).toBeNull();
  });

  it("clears the draft once the create succeeds", async () => {
    saveEditorDraft("p1", seededDraft());
    await mountEditor();
    expect(loadEditorDraft("p1")).not.toBeNull();

    await act(async () => {
      buttonContaining("Create automation").click();
    });

    expect(loadEditorDraft("p1")).toBeNull();
  });

  it("restores unsaved edits over a refreshed record and discards back to the record", async () => {
    saveEditorDraft(
      "p1",
      { ...seededDraft(), name: "Unsaved", triggerChoice: "none", runtime: null },
      undefined,
      "automation-1",
    );
    await mountEditor(automation({ name: "Saved", runtime: { kind: "tier", tier: "fast" } }));
    expect((document.querySelector('[aria-label="Name"]') as HTMLInputElement).value).toBe(
      "Unsaved",
    );
    expect(document.querySelector('[aria-label="Runtime model"]')?.textContent).toContain(
      "Project default",
    );
    await act(async () => buttonContaining("Discard draft").click());
    expect((document.querySelector('[aria-label="Name"]') as HTMLInputElement).value).toBe("Saved");
    expect(loadEditorDraft("p1", undefined, "automation-1")).toBeNull();
  });

  it("caches existing edits without writing the saved Automation", async () => {
    await mountEditor(automation());
    await typeInstructions("Unsaved review instructions");
    expect(loadEditorDraft("p1", undefined, "automation-1")?.instructions).toBe(
      "Unsaved review instructions",
    );
    expect(loadEditorDraft("p1")).toBeNull();
    expect(window.api.automations.update).not.toHaveBeenCalled();
  });

  it("keeps the new-automation draft separate from an existing record", async () => {
    saveEditorDraft("p1", seededDraft());
    await mountEditor(automation({ name: "Existing" }));

    const name = document.querySelector('[aria-label="Name"]') as HTMLInputElement;
    expect(name.value).toBe("Existing");
    expect(document.querySelector('[data-slot="draft-resumed"]')).toBeNull();
    // A saved record uses its own slot; the new-automation draft is untouched.
    expect(loadEditorDraft("p1")).toEqual(seededDraft());
  });
});
