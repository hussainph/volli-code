import type { Project, SkillReference } from "@volli/shared";
// The desktop owns jsdom for renderer tests, but does not ship its ambient types.
// @ts-expect-error — this test only uses the typed-at-runtime JSDOM constructor.
import { JSDOM } from "jsdom";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useProjectsStore } from "@renderer/stores/projects";
import { promptSupplyKey, usePromptTemplates } from "./use-prompt-templates";

function project(skillModes: Project["skillModes"]): Project {
  return {
    id: "project-1",
    name: "Project",
    path: "/project",
    ticketPrefix: "PRJ",
    colorIndex: 0,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    skillModes,
  };
}

const WAIT_WHAT: SkillReference = {
  name: "wait-what",
  description: "Re-pitch the last message",
  body: "Give me a little context.",
  authorPolicy: { modelDiscoverable: false, userInvokable: true },
  effectivePolicy: { modelDiscoverable: false, userInvokable: true },
  policyDiagnostic: null,
  root: "/home/.agents/skills/wait-what",
};

let root: Root | null = null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  useProjectsStore.setState({ projects: [], selectedProjectId: null });
  // Let React's scheduled root work finish before the DOM globals disappear.
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("promptSupplyKey", () => {
  it("changes when a project's skill policy changes", () => {
    const before = promptSupplyKey("project-1", { "wait-what": "off" });
    const after = promptSupplyKey("project-1", { "wait-what": "manual" });

    expect(after).not.toBe(before);
  });

  it("is stable for equivalent rules and unrelated Project row changes", () => {
    expect(promptSupplyKey("project-1", { tdd: "manual", logos: "off" })).toBe(
      promptSupplyKey("project-1", { logos: "off", tdd: "manual" }),
    );
    expect(promptSupplyKey("project-1", undefined)).toBe(promptSupplyKey("project-1", {}));
  });

  it("keeps projects distinct and represents no selected project as no read", () => {
    expect(promptSupplyKey("project-1", {})).not.toBe(promptSupplyKey("project-2", {}));
    expect(promptSupplyKey(null, { "wait-what": "manual" })).toBeNull();
  });
});

describe("usePromptTemplates", () => {
  it("never exposes an old-policy response while its replacement read is in flight", async () => {
    const dom = new JSDOM("<div id=app></div>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("navigator", dom.window.navigator);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const oldRead = deferred<{
      ok: true;
      templates: [];
      skills: SkillReference[];
    }>();
    const replacement = deferred<{ ok: true; templates: []; skills: [] }>();
    const promptTemplates = vi
      .fn()
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(replacement.promise);
    Object.defineProperty(dom.window, "api", {
      configurable: true,
      value: { files: { promptTemplates } },
    });
    useProjectsStore.setState({ projects: [project({ "wait-what": "manual" })] });

    let offered: readonly string[] = [];
    function Probe() {
      offered = usePromptTemplates("project-1").skills.map((skill) => skill.name);
      return null;
    }

    const container = dom.window.document.querySelector("#app");
    if (container === null) throw new Error("missing test container");
    root = createRoot(container);
    await act(async () => {
      root?.render(<Probe />);
    });

    await act(async () => {
      useProjectsStore.getState().adoptProject(project({ "wait-what": "off" }));
    });
    expect(offered).toEqual([]);

    // The superseded read lands with a row the current Off policy forbids. Its
    // answer is ignored rather than flashing while the replacement is pending.
    await act(async () => oldRead.resolve({ ok: true, templates: [], skills: [WAIT_WHAT] }));
    expect(offered).toEqual([]);

    await act(async () => replacement.resolve({ ok: true, templates: [], skills: [] }));
    expect(offered).toEqual([]);
    expect(promptTemplates).toHaveBeenCalledTimes(2);
  });

  it("re-reads an already-mounted composer's supply when an Off skill becomes Manual", async () => {
    const dom = new JSDOM("<div id=app></div>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("navigator", dom.window.navigator);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const promptTemplates = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, templates: [], skills: [] })
      .mockResolvedValueOnce({ ok: true, templates: [], skills: [WAIT_WHAT] });
    Object.defineProperty(dom.window, "api", {
      configurable: true,
      value: { files: { promptTemplates } },
    });
    useProjectsStore.setState({ projects: [project({ "wait-what": "off" })] });

    let offered: readonly string[] = [];
    function Probe() {
      offered = usePromptTemplates("project-1").skills.map((skill) => skill.name);
      return null;
    }

    const container = dom.window.document.querySelector("#app");
    if (container === null) throw new Error("missing test container");
    root = createRoot(container);
    await act(async () => {
      root?.render(<Probe />);
    });
    expect(offered).toEqual([]);
    expect(promptTemplates).toHaveBeenCalledTimes(1);

    await act(async () => {
      useProjectsStore.getState().adoptProject(project({ "wait-what": "manual" }));
    });

    expect(promptTemplates).toHaveBeenCalledTimes(2);
    expect(offered).toEqual(["wait-what"]);
  });
});
