import type { Project } from "@volli/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@renderer/components/settings/use-agent-index", () => ({
  useAgentIndex: () => ({
    state: {
      status: "ready" as const,
      data: {
        templates: [
          {
            name: "review",
            description: "Review a file",
            content: "Review $1.",
            source: "project" as const,
          },
          {
            name: "ship",
            description: "Open a pull request",
            content: "Ship it.",
            source: "personal" as const,
          },
        ],
        skills: [],
      },
    },
    reload: () => {},
  }),
}));

import { CommandsPane } from "./commands-pane";

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
};

describe("Configure → Commands", () => {
  it("puts each command's source in a column with one source filter", () => {
    const html = renderToStaticMarkup(<CommandsPane project={project} />);

    expect(html).toContain(">Source<");
    expect(html).toContain(">This project<");
    expect(html).toContain(">Personal<");
    expect(html.match(/aria-label="Filter by source"/g)).toHaveLength(1);
  });
});
