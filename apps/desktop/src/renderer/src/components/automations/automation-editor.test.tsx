// @vitest-environment jsdom
/** The Automation editor's dialog-only layout contracts (VC-222). */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_CODE_MODE_POLICY,
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  NO_AUTOMATION_TRIGGER,
  SKILL_POLICY_DEFAULT,
  type Automation,
  type ModelAccessState,
  type ModelSelection,
  type SkillReference,
} from "@volli/shared";

import { AutomationEditorPanel } from "./automation-editor";
import { startAutomationAuthoring } from "./automation-authoring";
import { adoptLaunch } from "@renderer/stores/launch";
import { LOCAL_LAUNCH } from "@volli/shared";

vi.mock("./automation-authoring", () => ({ startAutomationAuthoring: vi.fn(async () => null) }));
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { clearEditorDraft, loadEditorDraft, saveEditorDraft } from "./editor-draft";
import { useAutomationsStore } from "@renderer/stores/automations";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";

let root: Root | null = null;
let container: HTMLElement | null = null;
const originalUpdate = useAutomationsStore.getState().update;

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

function providerHelp(): Element | null {
  return document.body.querySelector('[data-slot="tooltip-content"]');
}

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

/** The real catalogue context, including a model the Runtime picker cannot offer. */
function catalogueClient(state: ModelAccessState = "available", hidden = false): ModelAccessClient {
  return {
    inspect: async () => ({
      observedAt: 1,
      providers: [
        {
          id: "anthropic",
          label: "Anthropic",
          state,
          accountLabel: null,
          billingSource: "subscription",
          recovery: null,
          signIn: [],
          hasStoredCredential: state === "available",
        },
      ],
      models: [
        {
          providerId: "anthropic",
          modelId: "claude-opus",
          label: "Claude Opus 4.5",
          state,
          reasoningLevels: ["medium", "high", "xhigh"],
          acceptsImageInput: true,
        },
      ],
    }),
    defaults: async () => EMPTY_MODEL_ACCESS_DEFAULTS,
    setDefault: async () => EMPTY_MODEL_ACCESS_DEFAULTS,
    hiddenModels: async () => (hidden ? [{ providerId: "anthropic", modelId: "claude-opus" }] : []),
    setHiddenModels: async (refs) => refs,
    compactionPolicy: async () => DEFAULT_COMPACTION_POLICY,
    setCompactionPolicy: async (policy) => policy,
    codeModePolicy: async () => DEFAULT_CODE_MODE_POLICY,
    setCodeModePolicy: async (policy) => policy,
    pickerView: async () => "all" as const,
    setPickerView: async (view) => view,
    beginSignIn: async () => {
      throw new Error("not under test");
    },
    signOut: async () => undefined,
  };
}

async function mountEditor(
  record: Automation | null = null,
  client?: ModelAccessClient,
): Promise<void> {
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
  const editor = (
    <TooltipProvider>
      <AutomationEditorPanel
        projectId="p1"
        automation={record}
        history={<div data-slot="run-history">Recent runs</div>}
      />
    </TooltipProvider>
  );
  await act(async () => {
    root?.render(
      client === undefined ? (
        editor
      ) : (
        <ModelAccessProvider client={client}>{editor}</ModelAccessProvider>
      ),
    );
  });
}

function buttonContaining(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.includes(label) || candidate.getAttribute("aria-label") === label,
  );
  if (found === undefined) throw new Error(`no button containing ${label}`);
  return found;
}

async function typeInstructions(value: string): Promise<void> {
  if (!document.querySelector('[aria-label="Instructions"]')) await edit("instructions");
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
  // Tests that observe the save payload replace this action; never let a
  // neighbour inherit the stub instead of the store's real command door.
  useAutomationsStore.setState({ editor: null, update: originalUpdate, enabledIds: [] });
  // The draft cache is module-level and shared across tests; a leftover slot
  // would seed the next mount's fields and turn these tests order-dependent.
  clearEditorDraft("p1");
  clearEditorDraft("p1", undefined, "automation-1");
  vi.unstubAllGlobals();
  adoptLaunch(LOCAL_LAUNCH);
});

describe("the page editor hierarchy", () => {
  it("stacks the editor at narrow container widths without shrinking rows over history", async () => {
    await mountEditor();
    const editor = document.querySelector('[data-slot="automation-editor"]')!;
    expect(editor.classList.contains("overflow-y-auto")).toBe(true);
    expect(editor.querySelector("aside")).toBeNull();
    expect(editor.querySelector(".max-w-content")).not.toBeNull();
    expect(editor.querySelectorAll('[data-slot="pref-section-title"]').length).toBe(3);
  });

  it("cloud authoring offers only this project, never All projects", async () => {
    adoptLaunch({ store: "cloud", userId: "u", backendUrl: "http://127.0.0.1:1" });
    await mountEditor();
    const ownership = document.querySelector('[aria-label="Scope"]') as HTMLButtonElement;
    await act(async () =>
      ownership.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    expect(document.body.textContent).toContain("This project");
    expect(document.body.textContent).not.toContain("All projects");
  });
  it("keeps one clear save action and moves record settings into the inspector", async () => {
    await mountEditor();

    expect(buttonContaining("Create").dataset.size).toBe("sm");
    expect(document.querySelector('[data-slot="automation-editor"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Scope"]')).not.toBeNull();
    expect(document.querySelector('[role="tablist"][aria-label="Trigger"]')).not.toBeNull();
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

    await typeName("Renamed sweep");
    await act(async () => {
      buttonContaining("Save name").click();
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: { kind: "tier", tier: "fast" } }),
    );
  });
});

describe("the Runtime model selector's provider help", () => {
  it("keeps pointer-focused rows quiet and reveals a typeahead-selected provider immediately", async () => {
    vi.useFakeTimers();
    try {
      const client = catalogueClient();
      const inspect = client.inspect;
      client.inspect = async (options) => {
        const snapshot = await inspect(options);
        return {
          ...snapshot,
          providers: [
            ...snapshot.providers,
            { ...snapshot.providers[0]!, id: "openai", label: "OpenAI" },
          ],
          models: [
            ...snapshot.models,
            {
              ...snapshot.models[0]!,
              providerId: "openai",
              modelId: "gpt-4.1-mini",
              label: "GPT-4.1 mini",
            },
          ],
        };
      };
      const pin: ModelSelection = {
        providerId: "anthropic",
        modelId: "claude-opus",
        reasoningLevel: "high",
      };
      await mountEditor(automation({ runtime: pin }), client);
      await edit("runtime");
      const draftBefore = loadEditorDraft("p1", undefined, "automation-1");
      const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Runtime model"]')!;
      await act(async () => trigger.focus());
      await act(async () =>
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
      );
      await act(async () => {
        vi.advanceTimersByTime(0);
      });
      const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
      const claude = options.find(
        (option) =>
          option.querySelector('[data-slot="model-name"]')?.textContent === "Claude Opus 4.5",
      )!;
      const gpt = options.find(
        (option) =>
          option.querySelector('[data-slot="model-name"]')?.textContent === "GPT-4.1 mini",
      )!;
      const pointerFocus = () =>
        claude.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }),
        );
      await act(async () => {
        pointerFocus();
      });
      expect(document.activeElement).toBe(claude);
      expect(providerHelp()).toBeNull();
      expect(claude.textContent).not.toContain("Anthropic");
      expect(gpt.textContent).not.toContain("OpenAI");
      const mark = claude.querySelector<HTMLElement>('[data-slot="help-tag"]')!;
      expect(mark.hasAttribute("tabindex")).toBe(false);
      await act(async () =>
        mark.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }),
        ),
      );
      await act(async () => {
        vi.advanceTimersByTime(1499);
      });
      expect(providerHelp()).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(providerHelp()?.textContent).toBe("Claude Opus 4.5 · Anthropic");
      await act(async () =>
        mark.dispatchEvent(
          new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
        ),
      );
      expect(providerHelp()).toBeNull();
      await act(async () => {
        pointerFocus();
      });
      expect(document.activeElement).toBe(claude);
      // Modifier shortcuts are not Radix's character typeahead.
      await act(async () =>
        claude.dispatchEvent(
          new KeyboardEvent("keydown", { key: "g", ctrlKey: true, bubbles: true }),
        ),
      );
      await act(async () => {
        vi.advanceTimersByTime(0);
      });
      expect(document.activeElement).toBe(claude);
      expect(providerHelp()).toBeNull();
      await act(async () =>
        claude.dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true })),
      );
      await act(async () => {
        vi.advanceTimersByTime(0);
      });
      expect(document.activeElement).toBe(gpt);
      expect(providerHelp()?.textContent).toBe("GPT-4.1 mini · OpenAI");
      expect(gpt.querySelector('[data-slot="help-tag"]')?.hasAttribute("tabindex")).toBe(false);
      // Typeahead reads an option; it does not change the saved Runtime.
      expect(loadEditorDraft("p1", undefined, "automation-1")).toEqual(draftBefore);
      expect(useAutomationsStore.getState().editor?.automation?.runtime).toEqual(pin);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the unavailable Runtime selection's display name", () => {
  it.each(["unavailable", "authentication-required", "hidden"] as const)(
    "names a %s pin from the full catalogue and saves its original ids and effort",
    async (availability) => {
      const pin: ModelSelection = {
        providerId: "anthropic",
        modelId: "claude-opus",
        reasoningLevel: "xhigh",
      };
      const update = vi.fn(async () => null);
      useAutomationsStore.setState({ update });
      const client = catalogueClient(
        availability === "hidden" ? "available" : availability,
        availability === "hidden",
      );
      const inspect = vi.spyOn(client, "inspect");
      await mountEditor(automation({ runtime: pin }), client);

      await edit("runtime");
      const trigger = document.querySelector('[aria-label="Runtime model"]') as HTMLButtonElement;
      const caption = trigger.querySelector('[data-slot="model-name"]');
      expect(caption?.textContent).toBe("Claude Opus 4.5");
      expect(caption!.parentElement?.querySelector("svg[aria-hidden] path")).not.toBeNull();
      expect(
        caption!.parentElement?.querySelector('[role="img"]')?.getAttribute("aria-label"),
      ).toBe("Anthropic");
      expect(trigger.textContent).not.toContain("Anthropic");
      expect(trigger.textContent).not.toContain("claude-opus");
      // The picker has no offerable selection, but display identity can still
      // read it. Both consumers use the actual provider's one held inspection.
      expect(document.querySelector('[aria-label="Reasoning effort"]')).toBeNull();
      expect(inspect).toHaveBeenCalledExactlyOnceWith({ refresh: false });

      trigger.focus();
      await act(async () => {
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
      const selectedOption = document.querySelector('[role="option"][data-state="checked"]');
      expect(selectedOption?.querySelector('[data-slot="model-name"]')?.textContent).toBe(
        "Claude Opus 4.5",
      );
      expect(selectedOption!.querySelector("svg[aria-hidden] path")).not.toBeNull();
      expect(selectedOption!.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
        "Anthropic",
      );
      await act(async () => {
        selectedOption!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });

      // Changing another field must not turn a pretty label into a new pin,
      // clear the unavailable selection, or clamp its previously saved effort.
      await typeName("Renamed sweep");
      expect(loadEditorDraft("p1", undefined, "automation-1")?.runtime).toEqual(pin);
      await act(async () => buttonContaining("Save name").click());
      expect(update).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          automationId: "automation-1",
          name: "Renamed sweep",
          runtime: pin,
        }),
      );
    },
  );

  it("keeps an unknown account's wire ids even when another account lists the same model id", async () => {
    const pin: ModelSelection = {
      providerId: "other-account",
      modelId: "claude-opus",
      reasoningLevel: "high",
    };
    const update = vi.fn(async () => null);
    useAutomationsStore.setState({ update });
    await mountEditor(automation({ runtime: pin }), catalogueClient());

    await edit("runtime");
    const trigger = document.querySelector('[aria-label="Runtime model"]');
    expect(trigger?.querySelector('[data-slot="model-name"]')?.textContent).toBe("claude-opus");
    expect(trigger?.textContent).not.toContain("Claude Opus 4.5");
    expect(trigger?.textContent).not.toContain("other-account");
    expect(trigger?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "other-account",
    );
    await typeName("Keep the unknown pin");
    expect(loadEditorDraft("p1", undefined, "automation-1")?.runtime).toEqual(pin);
    await act(async () => buttonContaining("Save name").click());
    expect(update).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ automationId: "automation-1", runtime: pin }),
    );
  });
});

describe("the schedule time field", () => {
  it("uses a content-sized themed trigger and editable numeric parts", async () => {
    await mountEditor();
    await act(async () => {
      buttonContaining("Schedule").click();
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
    await edit("trigger");
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
      buttonContaining("Schedule").click();
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

    await edit("trigger");
    const minute = document.querySelector('[aria-label="Minute"]') as HTMLInputElement;
    expect(minute.inputMode).toBe("numeric");
    expect(minute.classList.contains("tabular-nums")).toBe(true);
  });
});

describe("schedule wording", () => {
  it("does not describe the local scheduler's asleep policy in a cloud schedule", async () => {
    adoptLaunch({ store: "cloud", userId: "u", backendUrl: "http://127.0.0.1:1" });
    await mountEditor(
      automation({
        trigger: {
          kind: "schedule",
          schedule: { preset: "hourly", minute: 0, timeZone: "Europe/London" },
        },
      }),
    );
    await edit("trigger");
    expect(document.querySelector('[aria-label="Frequency"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Schedule policy"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Mac is asleep");
  });
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

    await edit("trigger");
    const schedule = document.querySelector('[aria-label="Frequency"]');
    const weekday = document.querySelector('[aria-label="Day"]');
    expect(schedule?.textContent).toContain("Weekly");
    expect(weekday?.textContent).toContain("Monday");
    expect(document.querySelector('[aria-label="Time"]')?.textContent).toContain("09:00");
    // The weekday is one compact dropdown, not another seven-segment strip.
    expect(document.querySelector('[aria-label="Day"] [aria-pressed]')).toBeNull();
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

    await edit("trigger");
    const minute = document.querySelector('[aria-label="Minute"]') as HTMLInputElement;
    expect(minute.value).toBe("00");
    expect(minute.closest('[data-slot="pref-row"]')?.textContent).toContain("Minute");
  });
});

const KUWAIT_NINE_THIRTY = automation({
  trigger: {
    kind: "schedule",
    schedule: { preset: "daily", hour: 9, minute: 30, timeZone: "Asia/Kuwait" },
  },
});

function preview() {
  return [...document.querySelectorAll('[data-slot="pref-row"]')].find((row) =>
    row.textContent?.startsWith("Next runs"),
  )?.textContent;
}
function nextLine(): HTMLElement | undefined {
  return [...document.querySelectorAll("p")].find((p) => p.textContent?.startsWith("Next · "));
}

describe("the next-run line (VC-298)", () => {
  it("names the next occurrence while this machine fires it, and clears it when switched off", async () => {
    useAutomationsStore.setState({ enabledIds: ["automation-1"] });
    await mountEditor(KUWAIT_NINE_THIRTY);

    expect(nextLine()).toBeDefined();
    // Policy is disclosed, not a standing paragraph under the controls.
    expect(document.body.textContent).not.toContain("min late");
    const policy = document.querySelector<HTMLButtonElement>(
      '[aria-label="Trigger more actions"]',
    )!;
    expect(policy.dataset.variant).toBe("ghost");
    await act(async () =>
      policy.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((b) => b.textContent?.includes("Schedule policy"))
        ?.click(),
    );
    expect(document.body.textContent).toContain("Up to 2 min late");
    expect(document.body.textContent).toContain(
      "Skipped when Volli is closed or this Mac is asleep",
    );
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(document.body.textContent).not.toContain("min late");

    await act(async () => {
      useAutomationsStore.setState({ enabledIds: [] });
    });
    expect(nextLine()).toBeUndefined();
  });

  it("follows the time being edited before it is saved", async () => {
    useAutomationsStore.setState({ enabledIds: ["automation-1"] });
    await mountEditor(KUWAIT_NINE_THIRTY);
    const before = nextLine()?.textContent;

    await edit("trigger");
    const beforePreview = preview();
    await act(async () => {
      buttonContaining("09:30").click();
    });
    const hour = document.querySelector('[aria-label="Hour"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(hour, "17");
      hour.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // 17:30 is a different time of day from 09:30 whatever the clock says now.
    expect(nextLine()?.textContent).toBe(before);
    expect(preview()).not.toBe(beforePreview);
  });

  it("says nothing about a next run for a record never switched on here", async () => {
    await mountEditor(KUWAIT_NINE_THIRTY);
    expect(nextLine()).toBeUndefined();
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
    expect(document.querySelector('[data-slot="composer-picker-stack"]')).not.toBeNull();
  });
});

async function edit(group: string) {
  const button = document.querySelector<HTMLButtonElement>(`[aria-label="Edit ${group}"]`);
  if (button) await act(async () => button.click());
}

async function typeName(value: string): Promise<void> {
  if (!document.querySelector('[aria-label="Name"]')) {
    const cancel = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Cancel",
    );
    if (cancel) await act(async () => cancel.click());
    await act(async () => document.querySelector<HTMLButtonElement>("h2 button")?.click());
  }
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

  it("keeps an ownership-only choice as a draft", async () => {
    await mountEditor();
    const ownership = document.querySelector('[aria-label="Scope"]') as HTMLButtonElement;
    ownership.focus();
    await act(async () => {
      ownership.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    const globalOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes("All projects"),
    );
    expect(globalOption).toBeDefined();
    await act(async () => {
      globalOption?.focus();
    });
    await act(async () => {
      globalOption?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(loadEditorDraft("p1")?.ownership).toBe("global");
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
    expect(buttonContaining("Schedule").getAttribute("aria-selected")).toBe("true");
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

  // VC-405. The state used to be a bordered bar at the top of the form, so the
  // first keystroke pushed Instructions down and the typist read the jump as a
  // glitch. It belongs in the title row, whose height the name and the buttons
  // already set, with its discard beside it.
  it("states the draft in the title row rather than above the form", async () => {
    saveEditorDraft("p1", seededDraft());
    await mountEditor();

    const indicator = document.querySelector('[data-slot="draft-resumed"]');
    expect(indicator).not.toBeNull();
    // Resolved, not optional-chained: `indicator?.closest(...)` yields undefined
    // when the indicator escapes the header, and `expect(undefined).not.toBeNull()`
    // passes — so every assertion below would report on a header that is not there.
    const header = indicator!.closest("header");
    expect(header).not.toBeNull();
    const name = header!.querySelector('[aria-label="Name"]');
    expect(name).not.toBeNull();
    // Actions wrap instead of shrinking the name field to zero on narrow windows.
    expect(header!.classList.contains("flex-wrap")).toBe(true);
    expect(name!.classList.contains("min-w-0")).toBe(true);
    expect(header!.contains(buttonContaining("Discard draft"))).toBe(true);
    expect(
      document
        .querySelector('[data-slot="automation-editor"]')!
        .contains(buttonContaining("Create")),
    ).toBe(true);

    // Draft state stays above the scrolling form. The instructions field keeps
    // its accessible name without a redundant heading above it.
    const form = document.querySelector("fieldset");
    expect(form).not.toBeNull();
    expect(form!.querySelector('[data-slot^="draft-"]')).toBeNull();
    expect(form!.querySelectorAll("h2")).toHaveLength(3);
    expect(form!.querySelector('[aria-label="Instructions"]')).not.toBeNull();
  });

  // VC-405's actual complaint is the JUMP, not the placement. The title row is
  // only steady if the slot is already holding its width open before the first
  // keystroke: the name input is the row's one elastic member, so a slot that
  // arrived on `dirty` would take its width straight out of the field under the
  // cursor. jsdom has no layout engine, so the width cannot be measured here.
  // What can be pinned is the thing that makes the width stable — the very same
  // node, carrying the same label, is in the row before and after the keystroke.
  it("holds the draft slot open before the first keystroke so the row cannot reflow", async () => {
    await mountEditor();

    const idle = document.querySelector('[data-slot="draft-idle"]');
    expect(idle).not.toBeNull();
    expect(idle!.closest("header")).not.toBeNull();
    // It reserves the exact label it will show, so the width does not change.
    expect(idle!.textContent).toContain("Draft saved");
    // Invisible and inert while there is no draft: opacity keeps the width,
    // where `hidden` or a conditional would surrender it.
    expect(idle!.className).toContain("opacity-0");
    expect(idle!.getAttribute("aria-hidden")).toBe("true");
    expect(buttonContaining("Discard draft").disabled).toBe(true);

    await typeName("Nightly sweep");

    const saved = document.querySelector('[data-slot="draft-saved"]');
    expect(saved).not.toBeNull();
    // THE ANTI-JUMP ASSERTION: the same DOM node, not a replacement. Nothing was
    // inserted into the row, so nothing could have been pushed aside.
    expect(saved).toBe(idle);
    expect(saved!.className).not.toContain("opacity-0");
    expect(saved!.getAttribute("aria-hidden")).toBe("false");
    expect(buttonContaining("Discard draft").disabled).toBe(false);
  });

  // VC-405. `role="status"` used to wrap the discard button along with the
  // sentence, which puts a control inside a live region and re-reads it on every
  // status change; `chat/activity-island-ui.tsx` records the same lesson.
  it("announces the draft through a live region that carries text and no control", async () => {
    await mountEditor();

    const header = document.querySelector("header");
    expect(header).not.toBeNull();
    const region = header!.querySelector('[role="status"]');
    expect(region).not.toBeNull();
    expect(region!.querySelector("button")).toBeNull();
    // Mounted while clean and silent. A live region that arrives with its text
    // already in it announces nothing; this one is watched before it speaks.
    expect(region!.textContent).toBe("");

    await typeName("Nightly sweep");
    expect(region!.textContent).toBe("Draft saved");
  });

  it("names a restored draft apart from one it just saved", async () => {
    saveEditorDraft("p1", seededDraft());
    await mountEditor();

    expect(document.querySelector('[data-slot="draft-saved"]')).toBeNull();
    const restored = document.querySelector('[data-slot="draft-resumed"]');
    expect(restored).not.toBeNull();
    expect(restored!.textContent).toContain("Draft restored");
    expect(document.querySelector('header [role="status"]')?.textContent).toBe("Draft restored");

    // Discarding returns the row to its clean, inert, width-holding state rather
    // than removing the slot from the row.
    await act(async () => buttonContaining("Discard draft").click());
    expect(document.querySelector('[data-slot="draft-resumed"]')).toBeNull();
    const idle = document.querySelector('[data-slot="draft-idle"]');
    expect(idle).not.toBeNull();
    expect(idle!.closest("header")).not.toBeNull();
    expect(buttonContaining("Discard draft").disabled).toBe(true);
    expect(document.querySelector('header [role="status"]')?.textContent).toBe("");
  });

  it("clears the draft once the create succeeds", async () => {
    saveEditorDraft("p1", seededDraft());
    await mountEditor();
    expect(loadEditorDraft("p1")).not.toBeNull();

    await act(async () => {
      buttonContaining("Create").click();
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
    expect(loadEditorDraft("p1", undefined, "automation-1")?.runtime).toBeNull();
    await act(async () => buttonContaining("Discard draft").click());
    expect(document.querySelector("h2 button")?.textContent).toBe("Saved");
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

    expect(document.querySelector("h2 button")?.textContent).toBe("Existing");
    expect(document.querySelector('[data-slot="draft-resumed"]')).toBeNull();
    // A saved record uses its own slot; the new-automation draft is untouched.
    expect(loadEditorDraft("p1")).toEqual(seededDraft());
  });
});

describe("reading groups and explicit transactions", () => {
  it("keeps saved fields read-only until Edit and never saves on blur", async () => {
    const update = vi.fn(async () => null);
    useAutomationsStore.setState({ update });
    await mountEditor(automation());
    expect(document.querySelector('[aria-label="Name"]')).toBeNull();
    expect(document.querySelector('[aria-label="Instructions"]')).toBeNull();
    expect(document.querySelector('[aria-label="Scope"]')).toBeNull();
    await typeName("Unsaved");
    await act(async () =>
      (document.querySelector('[aria-label="Name"]') as HTMLInputElement).blur(),
    );
    expect(update).not.toHaveBeenCalled();
    expect(loadEditorDraft("p1", undefined, "automation-1")?.name).toBe("Unsaved");
  });

  it("merges only the active group into the latest saved projection", async () => {
    const update = vi.fn(async () => null);
    useAutomationsStore.setState({ update });
    await mountEditor(automation());
    await edit("instructions");
    await typeInstructions("New instructions");
    useAutomationsStore.setState({
      byProject: {
        p1: [automation({ name: "Renamed elsewhere", runtime: { kind: "tier", tier: "deep" } })],
      },
    });
    await act(async () => buttonContaining("Save instructions").click());
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Renamed elsewhere",
        instructions: "New instructions",
        runtime: { kind: "tier", tier: "deep" },
      }),
    );
    useAutomationsStore.setState({ byProject: {} });
  });

  it("rejects zero columns without converting the draft to None", async () => {
    const update = vi.fn(async () => null);
    useAutomationsStore.setState({ update });
    await mountEditor(automation({ trigger: { kind: "columns", columns: ["doing"] } }));
    await edit("trigger");
    await act(async () =>
      (
        document.querySelector('[role="checkbox"][aria-label="Doing"]') as HTMLButtonElement
      ).click(),
    );
    await act(async () => buttonContaining("Save trigger").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Select a column");
    expect(loadEditorDraft("p1", undefined, "automation-1")?.triggerChoice).toBe("columns");
    expect(update).not.toHaveBeenCalled();
  });

  it("validates the creation fields on attempted submit", async () => {
    await mountEditor();
    await act(async () => buttonContaining("Create").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Name required");
    await typeName("New");
    await act(async () => buttonContaining("Create").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Instructions required");
  });

  it("holds one command id across a refused transport retry", async () => {
    const update = vi.fn(async () => "Transport unavailable");
    useAutomationsStore.setState({ update });
    await mountEditor(automation());
    await typeName("Renamed");
    await act(async () => buttonContaining("Save name").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t save Renamed",
    );
    await act(async () => buttonContaining("Save name").click());
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0]).toEqual(update.mock.calls[1]);
  });

  it("does not erase typing newer than an in-flight accepted save", async () => {
    let resolve!: (refusal: string | null) => void;
    const update = vi.fn(
      () =>
        new Promise<string | null>((done) => {
          resolve = done;
        }),
    );
    useAutomationsStore.setState({ update });
    await mountEditor(automation());
    await typeName("Submitted");
    await act(async () => buttonContaining("Save name").click());
    // Synthetic late input models an already queued event while the control is locked.
    await typeName("Newer draft");
    await act(async () => resolve(null));
    expect(loadEditorDraft("p1", undefined, "automation-1")?.name).toBe("Newer draft");
    expect((document.querySelector('[aria-label="Name"]') as HTMLInputElement).value).toBe(
      "Newer draft",
    );
  });
});

it("Cancel reverts only its group, not an unrelated restored draft", async () => {
  saveEditorDraft(
    "p1",
    {
      ...seededDraft(),
      name: "Unsaved name",
      instructions: "Other unsaved words",
      triggerChoice: "none",
    },
    undefined,
    "automation-1",
  );
  await mountEditor(automation());
  await act(async () => buttonContaining("Cancel").click());
  expect(loadEditorDraft("p1", undefined, "automation-1")?.name).toBe("Review sweep");
  expect(loadEditorDraft("p1", undefined, "automation-1")?.instructions).toBe(
    "Other unsaved words",
  );
  await edit("instructions");
  expect((document.querySelector('[aria-label="Instructions"]') as HTMLTextAreaElement).value).toBe(
    "Other unsaved words",
  );
});

it("associates the selected Trigger segment with its real conditional panel", async () => {
  await mountEditor();
  const selected = document.querySelector('[role="tab"][aria-selected="true"]')!;
  expect(document.getElementById(selected.getAttribute("aria-controls")!)).not.toBeNull();
  await act(async () => buttonContaining("Schedule").click());
  const scheduled = document.querySelector('[role="tab"][aria-selected="true"]')!;
  const panel = document.getElementById(scheduled.getAttribute("aria-controls")!)!;
  expect(panel.querySelector('[aria-label="Frequency"]')).not.toBeNull();
  expect(panel.getAttribute("aria-labelledby")).toBe(scheduled.id);
});
