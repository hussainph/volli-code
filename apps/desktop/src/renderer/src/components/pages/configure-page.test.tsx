import type { Project } from "@volli/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ConfigureGeneralSection, ConfigurePage } from "./configure-page";

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

describe("ConfigureGeneralSection", () => {
  it("shows the project's pinned base branch and setup command in editable fields", () => {
    const html = renderToStaticMarkup(
      <ConfigureGeneralSection
        project={project}
        onSaveBaseBranch={async () => true}
        onSaveSetupCommand={async () => true}
      />,
    );

    expect(html).toContain("Default base branch");
    expect(html).toContain('value="trunk"');
    expect(html).toContain("Setup command");
    expect(html).toContain('value="pnpm install"');
    expect(html).toContain("Save");
    // The project name titles the section.
    expect(html).toContain("Volli Code");
  });
});

describe("ConfigurePage", () => {
  it("renders a graceful empty state when no project is selected", () => {
    // The projects-store singleton starts with no selection, so the page
    // resolves to null and shows the empty state instead of the shell.
    const html = renderToStaticMarkup(<ConfigurePage />);

    expect(html).toContain("Nothing to configure");
    expect(html).not.toContain("Default base branch");
  });
});
