// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_CODE_MODE_POLICY,
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type DirEntry,
  type ModelAccessSnapshot,
  type Project,
} from "@volli/shared";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";

import { SessionsPane } from "./sessions-pane";

const PROJECT: Project = {
  id: "p1",
  name: "Project",
  path: "/tmp/project",
  ticketPrefix: "T",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};

const CATALOG: ModelAccessSnapshot = { observedAt: 1, providers: [], models: [] };

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
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

function client(inspect: ModelAccessClient["inspect"]): ModelAccessClient {
  return {
    inspect,
    defaults: async () => EMPTY_MODEL_ACCESS_DEFAULTS,
    setDefault: async () => EMPTY_MODEL_ACCESS_DEFAULTS,
    hiddenModels: async () => [],
    setHiddenModels: async (hidden) => hidden,
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

async function renderPane(
  inspect: ModelAccessClient["inspect"],
  project: Project = PROJECT,
): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <ModelAccessProvider client={client(inspect)}>
          <SessionsPane project={project} />
        </ModelAccessProvider>
      </TooltipProvider>,
    );
  });
}

function tryAgainButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Try again",
  );
}

describe("SessionsPane's model catalog", () => {
  it("draws the selected project model with its catalogue name and mark", async () => {
    const selection = {
      providerId: "anthropic",
      modelId: "claude-opus-4-1",
      reasoningLevel: "high" as const,
    };
    const inspect = vi.fn<ModelAccessClient["inspect"]>().mockResolvedValue({
      ...CATALOG,
      models: [
        {
          ...selection,
          label: "Claude Opus 4.1",
          state: "available",
          reasoningLevels: ["high"],
          acceptsImageInput: true,
        },
      ],
    });
    await renderPane(inspect, { ...PROJECT, sessionModel: selection });
    const trigger = document.getElementById("project-session-model");
    expect(trigger?.textContent).toContain("Claude Opus 4.1");
    expect(trigger?.textContent).not.toContain("claude-opus-4-1");
    const caption = trigger?.querySelector('[data-slot="model-name"]');
    expect(caption).toBeDefined();
    expect(caption).not.toBeNull();
    expect(caption?.parentElement?.querySelector(":scope > svg[aria-hidden] path")).not.toBeNull();
  });

  it("groups same-name models by provider and saves the chosen provider's IDs", async () => {
    const providers: ModelAccessSnapshot["providers"] = [
      { id: "openai", label: "OpenAI API" },
      { id: "openai-codex", label: "OpenAI Codex" },
    ].map((provider) => ({
      id: provider.id,
      label: provider.label,
      state: "available",
      accountLabel: null,
      billingSource: "unknown",
      recovery: null,
      signIn: [],
      hasStoredCredential: true,
    }));
    const selection = { providerId: "openai", modelId: "gpt-5", reasoningLevel: "high" as const };
    const inspect = vi.fn<ModelAccessClient["inspect"]>().mockResolvedValue({
      ...CATALOG,
      providers,
      models: providers.map((provider) => ({
        providerId: provider.id,
        modelId: selection.modelId,
        label: "GPT-5",
        state: "available",
        reasoningLevels: ["high"],
        acceptsImageInput: true,
      })),
    });
    const setSessionDefaults = vi.fn(async () => ({ ok: true, project: PROJECT }));
    vi.stubGlobal("api", { projects: { setSessionDefaults } });
    await renderPane(inspect, { ...PROJECT, sessionModel: selection });
    const trigger = document.getElementById("project-session-model");
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });

    const groups = [...document.querySelectorAll('[data-slot="select-group"]')];
    expect(groups).toHaveLength(2);
    for (const provider of providers) {
      const group = groups.find(
        (candidate) =>
          candidate.querySelector('[data-slot="select-label"]')?.textContent === provider.label,
      );
      expect(group).toBeDefined();
      const label = group?.querySelector('[data-slot="select-label"]');
      expect(group?.getAttribute("aria-labelledby")).toBe(label?.id);
      const caption = group?.querySelector('[data-slot="model-name"]');
      expect(caption?.textContent).toContain("GPT-5");
      expect(
        caption?.parentElement?.querySelector(":scope > svg[aria-hidden] path"),
      ).not.toBeNull();
    }
    const codexGroup = groups.find(
      (group) => group.querySelector('[data-slot="select-label"]')?.textContent === "OpenAI Codex",
    );
    const option = codexGroup?.querySelector<HTMLElement>('[data-slot="select-item"]');
    expect(option).toBeDefined();
    expect(option).not.toBeNull();
    await act(async () => option?.click());
    expect(setSessionDefaults).toHaveBeenCalledExactlyOnceWith({
      id: PROJECT.id,
      model: { ...selection, providerId: "openai-codex" },
    });
  });

  it("forces exactly one refresh when Try again is pressed", async () => {
    // The refresh bumps the shared revision, which re-runs this pane's effect;
    // a pane that reads that re-run as another retry would refresh forever.
    const inspect = vi
      .fn<ModelAccessClient["inspect"]>()
      .mockRejectedValueOnce(new Error("main is not up"))
      .mockResolvedValue(CATALOG);
    await renderPane(inspect);
    expect(inspect.mock.calls).toEqual([[{ refresh: false }]]);

    const retry = tryAgainButton();
    expect(retry).toBeDefined();
    await act(async () => retry?.click());

    expect(inspect.mock.calls).toEqual([[{ refresh: false }], [{ refresh: true }]]);
  });
});

type RootEntry = "file" | "link" | "dir";

/**
 * A repo root as the host would serve it. The listing marks symlinks the way
 * `volli:list-directory` does, and `files.read` answers the way host-core's
 * `readFile` does — refusing any symlink outright and reporting a missing file
 * — so a pane that offered to preview something unreadable fails here too.
 */
function stubRepo(repo: Readonly<Record<string, RootEntry>>, binary: readonly string[] = []) {
  const api = {
    fs: {
      listDirectory: vi.fn(async () => ({
        ok: true as const,
        entries: [
          { name: "src", kind: "dir" as const },
          ...Object.entries(repo).map(([name, entry]): DirEntry => {
            const listed: DirEntry = { name, kind: entry === "dir" ? "dir" : "file" };
            if (entry === "link") listed.link = true;
            return listed;
          }),
        ],
      })),
      revealInFinder: vi.fn(async () => ({ ok: true as const })),
    },
    files: {
      read: vi.fn(async ({ relPath }: { relPath: string }) => {
        const entry = repo[relPath];
        if (entry === "link") return { ok: false as const, error: "Path is a symlink" };
        if (entry !== "file") return { ok: false as const, error: "File was not found" };
        return {
          ok: true as const,
          source: "main" as const,
          kind: "markdown" as const,
          size: 10,
          mtime: 1,
          content: binary.includes(relPath)
            ? { type: "binary" as const }
            : { type: "text" as const, text: `# ${relPath} rules`, truncated: false },
        };
      }),
    },
  };
  vi.stubGlobal("api", api);
  return api;
}

function row(name: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-testid="instruction-file-${name}"]`);
  if (found === null) throw new Error(`no row for ${name}`);
  return found;
}

function action(label: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

describe("SessionsPane's instruction files", () => {
  it("shows both files as not in a repo that has neither, with nothing to open", async () => {
    const api = stubRepo({});
    await renderPane(vi.fn().mockResolvedValue(CATALOG));

    expect(api.fs.listDirectory).toHaveBeenCalledWith(PROJECT.path);
    expect(row("AGENTS.md").textContent).toContain("not in this repo");
    expect(row("CLAUDE.md").textContent).toContain("not in this repo");
    expect(action("Preview AGENTS.md")).toBeNull();
    expect(action("Reveal AGENTS.md in Finder")).toBeNull();
    expect(action("Reveal CLAUDE.md in Finder")).toBeNull();
  });

  it("marks only the file a repo has, and Reveal targets that file", async () => {
    const api = stubRepo({ "CLAUDE.md": "file" });
    await renderPane(vi.fn().mockResolvedValue(CATALOG));

    expect(row("AGENTS.md").textContent).toContain("not in this repo");
    expect(row("CLAUDE.md").textContent).toContain("repo root");
    expect(action("Reveal AGENTS.md in Finder")).toBeNull();

    await act(async () => action("Reveal CLAUDE.md in Finder")?.click());
    expect(api.fs.revealInFinder).toHaveBeenCalledExactlyOnceWith(`${PROJECT.path}/CLAUDE.md`);
  });

  it("offers both files in a repo with both, and previews the one asked for", async () => {
    const api = stubRepo({ "AGENTS.md": "file", "CLAUDE.md": "file" });
    await renderPane(vi.fn().mockResolvedValue(CATALOG));

    expect(row("AGENTS.md").textContent).toContain("repo root");
    expect(row("CLAUDE.md").textContent).toContain("repo root");

    await act(async () => action("Preview AGENTS.md")?.click());

    expect(api.files.read).toHaveBeenCalledExactlyOnceWith({
      projectId: PROJECT.id,
      relPath: "AGENTS.md",
    });
    const dialog = document.querySelector('[data-testid="content-preview-dialog"]');
    expect(dialog?.querySelector("h2")?.textContent).toBe("AGENTS.md");
    expect(dialog?.querySelector(".typeset h1")?.textContent).toBe("AGENTS.md rules");
    // Read-only: the preview offers no control beyond closing it.
    expect([...(dialog?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
      "Close",
    ]);
  });

  it("says when the repo root could not be read, and checks again on request", async () => {
    const api = stubRepo({ "AGENTS.md": "file" });
    api.fs.listDirectory.mockResolvedValueOnce({
      ok: false,
      error: "Permission was denied",
    } as never);
    await renderPane(vi.fn().mockResolvedValue(CATALOG));

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Permission was denied",
    );
    await act(async () => action("Check the repo again")?.click());

    expect(api.fs.listDirectory).toHaveBeenCalledTimes(2);
    expect(row("AGENTS.md").textContent).toContain("repo root");
  });

  it("says when a previewed file could not be read, and reads it again on request", async () => {
    const api = stubRepo({ "AGENTS.md": "file" });
    api.files.read.mockResolvedValueOnce({ ok: false, error: "File was not found" } as never);
    await renderPane(vi.fn().mockResolvedValue(CATALOG));

    await act(async () => action("Preview AGENTS.md")?.click());

    const dialog = document.querySelector('[data-testid="content-preview-dialog"]');
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toContain("File was not found");

    // A read that failed transiently is worth retrying, and the retry lands.
    const retry = [...(dialog?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Try again",
    );
    await act(async () => retry?.click());
    expect(api.files.read).toHaveBeenCalledTimes(2);
    expect(dialog?.querySelector(".typeset h1")?.textContent).toBe("AGENTS.md rules");
  });

  it("treats CLAUDE.md symlinked to AGENTS.md as a link: Reveal only, never a failing Preview", async () => {
    const api = stubRepo({ "AGENTS.md": "file", "CLAUDE.md": "link" });
    await renderPane(vi.fn().mockResolvedValue(CATALOG));

    expect(row("CLAUDE.md").textContent).toContain("symlink at repo root");
    // The host refuses to read a symlink, so offering Preview would only ever
    // open an error with a Try again that cannot succeed.
    expect(action("Preview CLAUDE.md")).toBeNull();
    await act(async () => action("Reveal CLAUDE.md in Finder")?.click());
    expect(api.fs.revealInFinder).toHaveBeenCalledExactlyOnceWith(`${PROJECT.path}/CLAUDE.md`);

    // The file it points at stays fully readable through its own row.
    await act(async () => action("Preview AGENTS.md")?.click());
    const dialog = document.querySelector('[data-testid="content-preview-dialog"]');
    expect(dialog?.querySelector(".typeset h1")?.textContent).toBe("AGENTS.md rules");
  });

  it("calls a symlinked directory or a dangling link a link, and a real directory missing", async () => {
    stubRepo({ "AGENTS.md": "dir", "CLAUDE.md": "link" });
    await renderPane(vi.fn().mockResolvedValue(CATALOG));

    expect(row("AGENTS.md").textContent).toContain("not in this repo");
    expect(action("Reveal AGENTS.md in Finder")).toBeNull();
    expect(row("CLAUDE.md").textContent).toContain("symlink at repo root");
    expect(action("Preview CLAUDE.md")).toBeNull();
  });

  it("says a non-text file is not text, with no Try again that could never succeed", async () => {
    stubRepo({ "AGENTS.md": "file" }, ["AGENTS.md"]);
    await renderPane(vi.fn().mockResolvedValue(CATALOG));

    await act(async () => action("Preview AGENTS.md")?.click());

    const dialog = document.querySelector('[data-testid="content-preview-dialog"]');
    expect(dialog?.textContent).toContain("AGENTS.md is not a text file.");
    expect(dialog?.querySelector('[role="alert"]')).toBeNull();
    expect([...(dialog?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
      "Close",
    ]);
  });
});
