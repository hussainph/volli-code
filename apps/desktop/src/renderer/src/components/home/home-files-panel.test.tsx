import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { Project } from "@volli/shared";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { HomeFilesList, HomeFilesPanel } from "./home-files-panel";

const noop = (_path: string): void => {};

function render(cwd: string, entries: Array<{ name: string; kind: "file" | "dir" }>): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <HomeFilesList
        cwd={cwd}
        entries={entries}
        onPreviewFile={noop}
        onPinFile={noop}
        onOpenDirectory={noop}
      />
    </TooltipProvider>,
  );
}

const project: Project = {
  id: "project-1",
  name: "Volli Code",
  path: "/code/volli-code",
  ticketPrefix: "VC",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

describe("HomeFilesPanel", () => {
  it("mounts as the Project Files navigator while its root listing loads", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <HomeFilesPanel project={project} onPreviewFile={noop} onPinFile={noop} />
      </TooltipProvider>,
    );

    expect(html).toContain('data-testid="home-files-panel"');
    expect(html).toContain("Project files");
    expect(html).toContain("Volli Code");
    expect(html).toContain('aria-label="Loading files"');
  });
});

describe("HomeFilesList", () => {
  it("uses the ticket rail's flat navigator pattern for Main-checkout entries", () => {
    const html = render("apps/desktop", [
      { name: "src", kind: "dir" },
      { name: "package.json", kind: "file" },
    ]);

    expect(html).toContain("src/");
    expect(html).toContain("package.json");
    expect(html).toContain("apps/desktop");
    expect(html.match(/<ul/g)?.length).toBe(1);
  });

  it("keeps directories navigational and files openable", () => {
    const html = render("", [
      { name: "src", kind: "dir" },
      { name: "README.md", kind: "file" },
    ]);

    expect(html).not.toContain('aria-label="Open src in tab"');
    expect(html).toContain('aria-label="Open README.md in tab"');
  });

  it("shows the shared empty hint for an empty folder", () => {
    expect(render("empty", [])).toContain("Nothing here yet");
  });
});
