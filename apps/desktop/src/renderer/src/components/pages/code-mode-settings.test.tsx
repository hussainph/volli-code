// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CODE_MODE_MODEL_DEFAULTS,
  DEFAULT_CODE_MODE_POLICY,
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type CodeModePolicy,
  type ModelAccessSnapshot,
} from "@volli/shared";
import { toast } from "sonner";

import { builtInDefaultsSentence } from "./code-mode-settings";
import { ModelAccessSettings } from "./model-access-settings";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

function provider(id: string, label: string): ModelAccessSnapshot["providers"][number] {
  return {
    id,
    label,
    state: "available",
    accountLabel: null,
    billingSource: "unknown",
    recovery: null,
    signIn: [],
    hasStoredCredential: true,
  };
}

function model(
  providerId: string,
  modelId: string,
  label: string,
): ModelAccessSnapshot["models"][number] {
  return {
    providerId,
    modelId,
    label,
    state: "available",
    reasoningLevels: ["low", "high"],
    acceptsImageInput: false,
  };
}

const SNAPSHOT: ModelAccessSnapshot = {
  observedAt: 1,
  providers: [provider("anthropic", "Anthropic"), provider("openai-codex", "OpenAI Codex")],
  models: [
    model("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
    model("anthropic", "claude-opus-4-5", "Claude Opus 4.5"),
    model("openai-codex", "gpt-5.5", "GPT-5.5"),
    model("openai-codex", "gpt-5.5-mini", "GPT-5.5 Mini"),
  ],
};

/** Curated out of every picker, so never offered as a pin either. */
const HIDDEN = [{ providerId: "openai-codex", modelId: "gpt-5.5-mini" }];

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Radix Select measures and scrolls its list; jsdom has neither.
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
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/**
 * The real pane over a client whose Code Mode policy behaves like main's: a
 * write is what the next read answers. `codeModePolicy` and
 * `setCodeModePolicy` are spies a test may re-stub to fail.
 */
function clientWith(initial: CodeModePolicy) {
  let stored = initial;
  const codeModePolicy = vi.fn<ModelAccessClient["codeModePolicy"]>(async () => stored);
  const setCodeModePolicy = vi.fn<ModelAccessClient["setCodeModePolicy"]>(async (policy) => {
    stored = policy;
    return policy;
  });
  const client: ModelAccessClient = {
    inspect: async () => SNAPSHOT,
    defaults: async () => EMPTY_MODEL_ACCESS_DEFAULTS,
    setDefault: async () => EMPTY_MODEL_ACCESS_DEFAULTS,
    hiddenModels: async () => HIDDEN,
    setHiddenModels: async (hidden) => hidden,
    compactionPolicy: async () => DEFAULT_COMPACTION_POLICY,
    setCompactionPolicy: async (policy) => policy,
    codeModePolicy,
    setCodeModePolicy,
    pickerView: async () => "all" as const,
    setPickerView: async (view) => view,
    beginSignIn: async () => {
      throw new Error("not under test");
    },
    signOut: async () => undefined,
  };
  return { client, codeModePolicy, setCodeModePolicy };
}

async function renderPane(client: ModelAccessClient): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ModelAccessProvider client={client}>
        <TooltipProvider>
          <ModelAccessSettings />
        </TooltipProvider>
      </ModelAccessProvider>,
    );
  });
}

function the<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`nothing matches ${selector}`);
  return element;
}

const codeModeSwitch = () => the<HTMLButtonElement>('[data-testid="code-mode-switch"]');
const pinPicker = () => the<HTMLButtonElement>('[aria-label="Pin a model"]');
const pinMode = (key: string) => the<HTMLButtonElement>(`[data-testid="code-mode-pin-${key}"]`);

/** The pins table, by its caption: the Catalog below it is a table too. */
function pinTable(): HTMLTableElement {
  const table = [...document.querySelectorAll("table")].find(
    (candidate) => candidate.caption?.textContent === "Models with a pinned Code Mode",
  );
  if (table === undefined) throw new Error("no pins table");
  return table;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function openAdvanced(): Promise<void> {
  await click(the('[data-testid="code-mode-advanced"]'));
}

/** Opens a Radix Select from the keyboard and answers the visible options. */
async function openSelect(trigger: HTMLElement): Promise<HTMLElement[]> {
  trigger.focus();
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}

async function choose(trigger: HTMLElement, text: string): Promise<void> {
  const option = (await openSelect(trigger)).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (option === undefined) throw new Error(`no option reads ${text}`);
  await act(async () => option.focus());
  await act(async () => {
    option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

describe("Code Mode in the Models pane", () => {
  it("shows the stored switch, with the pins behind a collapsed Advanced that counts them", async () => {
    const { client, codeModePolicy } = clientWith({
      enabled: true,
      models: { "openai-codex/gpt-5.5": "both" },
    });
    await renderPane(client);

    expect(codeModePolicy).toHaveBeenCalled();
    expect(codeModeSwitch().getAttribute("aria-checked")).toBe("true");
    expect(codeModeSwitch().disabled).toBe(false);
    // The switch carries no paragraph (AGENTS.md, "let controls talk").
    expect(the('[data-testid="code-mode"]').textContent).toBe("Code Mode");
    // Collapsed by default, and the trigger says what it is hiding.
    expect(the('[data-testid="code-mode-advanced"]').textContent).toContain("1 pinned");
    expect(document.querySelector('[data-testid="code-mode-pin"]')).toBeNull();

    await openAdvanced();

    expect(document.querySelector('[data-testid="code-mode-pin"]')).not.toBeNull();
    expect(pinMode("openai-codex/gpt-5.5").textContent).toBe("Both");
    const cells = [...pinTable().querySelectorAll("tbody td")].map((cell) => cell.textContent);
    expect(cells[0]).toContain("GPT-5.5");
    // The built-in mode it overrides: GPT-5 defaults to Off.
    expect(cells[1]).toBe("Off");
  });

  it("saves the switch whole, keeping every pin", async () => {
    const { client, setCodeModePolicy } = clientWith({
      enabled: true,
      models: { "openai-codex/gpt-5.5": "both" },
    });
    await renderPane(client);

    await click(codeModeSwitch());

    expect(setCodeModePolicy).toHaveBeenCalledWith({
      enabled: false,
      models: { "openai-codex/gpt-5.5": "both" },
    });
    expect(codeModeSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("pins a model at its built-in mode, offering only unpinned models a picker shows", async () => {
    const { client, setCodeModePolicy } = clientWith({
      enabled: true,
      models: { "anthropic/claude-opus-4-5": "only" },
    });
    await renderPane(client);
    await openAdvanced();

    const offered = (await openSelect(pinPicker())).map((option) => option.textContent ?? "");
    expect(offered.some((text) => text.includes("Claude Sonnet 4.5"))).toBe(true);
    expect(offered.some((text) => text.includes("GPT-5.5"))).toBe(true);
    // Already pinned, and curated out of pickers: neither is offered.
    expect(offered.some((text) => text.includes("Claude Opus 4.5"))).toBe(false);
    expect(offered.some((text) => text.includes("GPT-5.5 Mini"))).toBe(false);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    await choose(pinPicker(), "Claude Sonnet 4.5");

    // Claude Sonnet's built-in mode is Both; the pin starts there.
    expect(setCodeModePolicy).toHaveBeenLastCalledWith({
      enabled: true,
      models: { "anthropic/claude-opus-4-5": "only", "anthropic/claude-sonnet-4-5": "both" },
    });
    expect(pinMode("anthropic/claude-sonnet-4-5").textContent).toBe("Both");
    expect(the('[data-testid="code-mode-advanced"]').textContent).toContain("2 pinned");
  });

  it("changes and removes a pin, saving the whole policy each time", async () => {
    const { client, setCodeModePolicy } = clientWith({
      enabled: true,
      models: { "anthropic/claude-opus-4-5": "only", "openai-codex/gpt-5.5": "both" },
    });
    await renderPane(client);
    await openAdvanced();

    await choose(pinMode("openai-codex/gpt-5.5"), "Only");

    expect(setCodeModePolicy).toHaveBeenLastCalledWith({
      enabled: true,
      models: { "anthropic/claude-opus-4-5": "only", "openai-codex/gpt-5.5": "only" },
    });
    expect(pinMode("openai-codex/gpt-5.5").textContent).toBe("Only");

    await click(the('[aria-label="Unpin Claude Opus 4.5"]'));

    expect(setCodeModePolicy).toHaveBeenLastCalledWith({
      enabled: true,
      models: { "openai-codex/gpt-5.5": "only" },
    });
    expect(document.querySelector('[data-testid="code-mode-pin-anthropic/claude-opus-4-5"]')).toBe(
      null,
    );
  });

  it("keeps the pins but locks them while Code Mode is off", async () => {
    const { client, setCodeModePolicy } = clientWith({
      enabled: false,
      models: { "openai-codex/gpt-5.5": "both" },
    });
    await renderPane(client);
    await openAdvanced();

    expect(codeModeSwitch().getAttribute("aria-checked")).toBe("false");
    expect(the('[data-testid="code-mode-off-note"]').textContent).toContain("Code Mode is off");
    expect(pinMode("openai-codex/gpt-5.5").disabled).toBe(true);
    expect(pinPicker().disabled).toBe(true);
    expect(the<HTMLButtonElement>('[aria-label="Unpin GPT-5.5"]').disabled).toBe(true);

    // Back on: the same pins, editable again, nothing rewritten but the switch.
    await click(codeModeSwitch());

    expect(setCodeModePolicy).toHaveBeenCalledWith({
      enabled: true,
      models: { "openai-codex/gpt-5.5": "both" },
    });
    expect(document.querySelector('[data-testid="code-mode-off-note"]')).toBeNull();
    expect(pinMode("openai-codex/gpt-5.5").disabled).toBe(false);
  });

  it("says so when it cannot load, and offers nothing it would have to guess", async () => {
    const { client, codeModePolicy } = clientWith(DEFAULT_CODE_MODE_POLICY);
    codeModePolicy.mockRejectedValue(new Error("database is locked"));
    await renderPane(client);

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load Code Mode settings: database is locked",
      expect.anything(),
    );
    expect(codeModeSwitch().disabled).toBe(true);
    // The catalogue above it still loaded: one failed read costs one section.
    expect(document.body.textContent).toContain("Claude Sonnet 4.5");
  });

  it("puts a failed save back to what main holds and says so", async () => {
    const { client, setCodeModePolicy } = clientWith({
      enabled: true,
      models: { "openai-codex/gpt-5.5": "both" },
    });
    setCodeModePolicy.mockRejectedValue(new Error("disk full"));
    await renderPane(client);
    await openAdvanced();

    await click(codeModeSwitch());

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't save Code Mode settings: disk full",
      expect.anything(),
    );
    expect(codeModeSwitch().getAttribute("aria-checked")).toBe("true");

    await click(the('[aria-label="Unpin GPT-5.5"]'));

    expect(pinMode("openai-codex/gpt-5.5").textContent).toBe("Both");
  });
});

describe("the built-in defaults hint", () => {
  it("names every family the shared table gives a mode, and the rest as Off", () => {
    const sentence = builtInDefaultsSentence();
    for (const row of CODE_MODE_MODEL_DEFAULTS.filter((candidate) => candidate.mode !== "off")) {
      expect(sentence).toContain(row.family);
    }
    expect(sentence).toMatch(/Off for every other model\.$/u);
  });
});
