// @vitest-environment jsdom
import {
  AUTHOR_MODEL_ONLY_MODE,
  resolveSkillMode,
  SKILL_POLICY_DEFAULT,
  type Project,
  type SkillReference,
} from "@volli/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const skills: SkillReference[] = [
  {
    name: "tdd",
    description: "Red, green, refactor",
    body: "Write the failing test first.",
    authorPolicy: SKILL_POLICY_DEFAULT,
    effectivePolicy: SKILL_POLICY_DEFAULT,
    policyDiagnostic: null,
    root: ".agents/skills/tdd",
  },
  {
    name: "quiet-helper",
    description: "Asked-for only",
    body: "Only when summoned.",
    authorPolicy: { modelDiscoverable: false, userInvokable: true },
    effectivePolicy: { modelDiscoverable: false, userInvokable: true },
    policyDiagnostic: null,
    root: ".agents/skills/quiet-helper",
  },
  {
    name: "house-style",
    description: "Background knowledge",
    body: "Apply this automatically.",
    authorPolicy: { modelDiscoverable: true, userInvokable: false },
    effectivePolicy: { modelDiscoverable: true, userInvokable: false },
    policyDiagnostic: null,
    root: ".agents/skills/house-style",
  },
  {
    name: "a-skill-whose-name-is-far-too-long-for-its-twenty-percent-column",
    description:
      "A description long enough that the table can only ever show its first few words before the cell clips it.",
    body: "## Steps\n\nRead every line of this before acting.",
    authorPolicy: SKILL_POLICY_DEFAULT,
    effectivePolicy: SKILL_POLICY_DEFAULT,
    policyDiagnostic: null,
    root: "/Users/me/.agents/skills/a-skill-whose-name-is-far-too-long-for-its-twenty-percent-column",
  },
];

vi.mock("@renderer/components/settings/use-agent-index", () => ({
  useAgentIndex: () => ({
    state: {
      status: "ready" as const,
      data: { templates: [], skills },
    },
    reload: () => {},
  }),
}));

import { TooltipProvider } from "@renderer/components/ui/tooltip";

import { offerableModes, ruled, SkillsPane } from "./skills-pane";

const project: Project = {
  id: "p1",
  name: "Volli Code",
  path: "/repo/volli",
  ticketPrefix: "VC",
  baseBranch: "trunk",
  setupCommand: "pnpm install",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  // The regression this suite exists for: `tdd` is ruled OFF, and its row must
  // still render — this pane is the only surface that can turn it back on.
  skillModes: { tdd: "off" },
};

describe("Configure → Skills", () => {
  it("keeps an off-ruled skill on the table — off must not be a one-way door", () => {
    // The provider normally lives on `PrefShell`; a bare pane render supplies
    // its own so `RowAction`'s tooltip can mount.
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SkillsPane project={project} />
      </TooltipProvider>,
    );

    expect(html).toContain("tdd");
    expect(html).toContain('data-testid="skill-mode-tdd"');
  });

  it("offers all three modes to every skill, author default or not", () => {
    // Storage keeps an explicit `auto` now (VC-181), so promoting an
    // author-manual skill into this project's index is an override the pane
    // can actually deliver — and therefore one it may offer.
    expect(offerableModes(skills[0]!)).toEqual(["auto", "manual", "off"]);
    expect(offerableModes(skills[1]!)).toEqual(["auto", "manual", "off"]);
    expect(offerableModes(skills[2]!)).toEqual(["auto", "manual", "off"]);
  });

  it("reads author model-only exactly until a Project mode overrides it", () => {
    const background = skills[2]!;
    expect(resolveSkillMode({}, background)).toBe(AUTHOR_MODEL_ONLY_MODE);
    expect(resolveSkillMode({ "house-style": "auto" }, background)).toBe("auto");
  });

  it("previews a skill's full name, description and body without touching its mode", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    const setSkillModes = vi.fn();
    vi.stubGlobal("api", { projects: { setSkillModes } });
    const long = skills[3]!;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <TooltipProvider>
            <SkillsPane project={project} />
          </TooltipProvider>,
        ),
      );
      // The table clips the name, so the cell is the shared ValueReveal: a
      // focus stop naming it whole, never a hover-only native title.
      const name = container.querySelector<HTMLButtonElement>(
        `button[data-slot="value-reveal"][aria-label="Skill · ${long.name}"]`,
      );
      expect(name?.textContent).toBe(long.name);
      expect(name?.className).toContain("truncate");
      expect(container.querySelector(`[title="${long.name}"]`)).toBeNull();
      // The actions column is measured for its two glyph actions, the cell's
      // gap between them and its insets — not a fixed guess.
      const open = [...container.querySelectorAll("col")].find((col) =>
        col.style.width.includes("--spacing-control-default"),
      );
      expect(open?.style.width).toBe(
        "calc(2 * var(--spacing-control-default) + 6 * var(--spacing))",
      );

      const preview = container.querySelector<HTMLButtonElement>(
        `button[aria-label="Preview ${long.name}"]`,
      );
      await act(async () => preview?.click());

      const dialog = document.querySelector('[data-testid="content-preview-dialog"]');
      expect(dialog?.querySelector("h2")?.textContent).toBe(long.name);
      expect(dialog?.textContent).toContain(long.description);
      expect(dialog?.textContent).toContain(`Global · ${long.root}`);
      expect(dialog?.querySelector(".typeset h2")?.textContent).toBe("Steps");
      expect(dialog?.textContent).toContain("Read every line of this before acting.");
      expect(setSkillModes).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
    // A full client mount of the table (a Select and two tooltip actions per
    // row) and then the dialog's rendered markdown: no loop, but more than the
    // default 5s budget on a machine shared with other test runs.
  }, 20_000);

  it("filters global and project skills in one pane without changing their rules", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <TooltipProvider>
            <SkillsPane project={project} />
          </TooltipProvider>,
        ),
      );
      const scope = host.querySelector('[aria-label="Skill scope"]')!;
      const pick = (name: string) =>
        Array.from(scope.querySelectorAll("button")).find((button) => button.textContent === name)!;
      await act(async () => pick("Global").click());
      expect(pick("Global").getAttribute("aria-pressed")).toBe("true");
      expect(host.querySelector("tbody")?.textContent).toContain(skills[3]!.name);
      expect(host.querySelector("tbody")?.textContent).not.toContain(skills[0]!.name);
      await act(async () => pick("This project").click());
      expect(host.querySelector("tbody")?.textContent).toContain(skills[0]!.name);
      expect(host.querySelector("tbody")?.textContent).not.toContain(skills[3]!.name);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  describe("ruled", () => {
    const tdd = skills[0]!;
    const quiet = skills[1]!;
    const background = skills[2]!;

    it("deletes a rule that merely restates the skill's own default", () => {
      expect(ruled({ tdd: "off" }, [tdd], "auto")).toEqual({});
      expect(ruled({ "quiet-helper": "off" }, [quiet], "manual")).toEqual({});
    });

    it("stores an auto rule when auto IS a departure for that skill", () => {
      // The write half of the round trip the old code could not complete.
      expect(ruled({}, [quiet], "auto")).toEqual({ "quiet-helper": "auto" });
      // The author-only fourth combination matches no Project mode: selecting
      // Auto deliberately reopens the user route too.
      expect(ruled({}, [background], "auto")).toEqual({ "house-style": "auto" });
    });

    it("can clear a Project override back to the author-only fourth combination", () => {
      expect(
        ruled({ "house-style": "auto", other: "off" }, [background], AUTHOR_MODEL_ONLY_MODE),
      ).toEqual({ other: "off" });
    });

    it("stores a departure and leaves other skills' rules alone", () => {
      expect(ruled({ other: "off" }, [tdd], "manual")).toEqual({ other: "off", tdd: "manual" });
    });

    it("applies one bulk answer per skill, minimizing each independently", () => {
      // "Set all to Manual" is a departure for `tdd` and a restatement for
      // `quiet-helper`, so the map gains one entry, not two.
      expect(ruled({}, [tdd, quiet], "manual")).toEqual({ tdd: "manual" });
    });
  });
});

it("wraps scope controls and exposes Auto's token estimate on keyboard focus", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <SkillsPane project={project} />
        </TooltipProvider>,
      ),
    );
    const summary = container.querySelector<HTMLButtonElement>(
      '[aria-label="Auto token estimate"]',
    )!;
    expect(summary.textContent).toBe("Auto");
    expect(summary.parentElement?.className).toContain("flex-wrap");
    expect(container.textContent).not.toContain("tokens per turn");
    expect(
      container.querySelector('[data-slot="pref-section-title"]')?.parentElement?.className,
    ).toContain("sr-only");
    await act(async () => summary.focus());
    await vi.waitFor(() =>
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("tokens per turn"),
    );
    expect(container.querySelector('[aria-label="Skill scope"]')?.textContent).toContain(
      "This project",
    );
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

const policyNavigation = { openProject: vi.fn(), selectPolicyProject: vi.fn() };
it("names and selects the project whose activation policy the shared inventory edits", async () => {
  const { SettingsNavigation } = await import("../settings-navigation");
  const { useProjectsStore } = await import("@renderer/stores/projects");
  const previous = useProjectsStore.getState().projects;
  const second = { ...project, id: "p2", name: "Second project" };
  useProjectsStore.setState({ projects: [project, second] });
  policyNavigation.selectPolicyProject.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <SettingsNavigation.Provider value={policyNavigation}>
          <TooltipProvider>
            <SkillsPane project={project} policyProjectPicker />
          </TooltipProvider>
        </SettingsNavigation.Provider>,
      ),
    );
    expect(container.textContent).toContain("Activation project");
    const picker = container.querySelector<HTMLButtonElement>(
      '[aria-label="Skill activation project"]',
    )!;
    expect(picker.textContent).toBe(project.name);
    await act(async () =>
      picker.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (node) => node.textContent === second.name,
    )!;
    await act(async () => {
      option.focus();
      option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(policyNavigation.selectPolicyProject).toHaveBeenCalledWith(second.id);
  } finally {
    act(() => root.unmount());
    container.remove();
    useProjectsStore.setState({ projects: previous });
    vi.unstubAllGlobals();
  }
});
