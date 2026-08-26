import {
  AUTHOR_MODEL_ONLY_MODE,
  resolveSkillMode,
  SKILL_POLICY_DEFAULT,
  type Project,
  type SkillReference,
} from "@volli/shared";
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
