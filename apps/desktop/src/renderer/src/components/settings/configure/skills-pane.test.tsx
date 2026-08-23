import type { Project, SkillReference } from "@volli/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const skills: SkillReference[] = [
  {
    name: "tdd",
    description: "Red, green, refactor",
    body: "Write the failing test first.",
    userInvokeOnly: false,
    root: ".agents/skills/tdd",
  },
  {
    name: "quiet-helper",
    description: "Asked-for only",
    body: "Only when summoned.",
    userInvokeOnly: true,
    root: ".agents/skills/quiet-helper",
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

import { offerableModes, SkillsPane } from "./skills-pane";

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

  it("offers Auto only where a rule can deliver it", () => {
    // `parseSkillModes` drops `auto` (it is the absence of a rule), so for a
    // frontmatter user-invoke-only skill "Auto" would snap straight back to
    // Manual. The picker must not offer a state it cannot set.
    expect(offerableModes(skills[0]!)).toEqual(["auto", "manual", "off"]);
    expect(offerableModes(skills[1]!)).toEqual(["manual", "off"]);
  });
});
