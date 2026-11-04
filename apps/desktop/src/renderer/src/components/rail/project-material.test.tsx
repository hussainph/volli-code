// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import type { Project } from "@volli/shared";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { UpdateButton } from "@renderer/components/sidebar/update-button";
import { useUpdateStore } from "@renderer/stores/update";
import { useProjectsStore } from "@renderer/stores/projects";
import { AddProjectTile } from "./add-project-tile";
import { ProjectTile } from "./project-tile";

const project: Project = {
  id: "material-test",
  name: "Voltaic",
  path: "/project",
  ticketPrefix: "VLT",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};
const originalProject = useProjectsStore.getState().selectedProjectId;
const originalUpdate = useUpdateStore.getState().state;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  useProjectsStore.setState({ selectedProjectId: originalProject });
  useUpdateStore.setState({ state: originalUpdate });
  vi.unstubAllGlobals();
});
function renderToMarkup(node: ReactNode): string {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(node));
  const html = container.innerHTML;
  act(() => root.unmount());
  return html;
}

describe("shell control material", () => {
  it("gives Add project a resting hairline and quiet hover/press lift", () => {
    const html = renderToMarkup(
      <TooltipProvider>
        <AddProjectTile />
      </TooltipProvider>,
    );
    expect(html).toContain("border-border-strong");
    expect(html).toContain("control-material");
    expect(html).toContain("shadow-control hover:shadow-control-hover");
    expect(html).toContain("active:shadow-control-pressed");
  });
  it.each([false, true])(
    "lifts project tiles and keeps selection to one hairline: %s",
    (selected) => {
      useProjectsStore.setState({ selectedProjectId: selected ? project.id : null });
      const html = renderToMarkup(
        <TooltipProvider>
          <DndContext>
            <SortableContext items={[project.id]}>
              <ProjectTile project={project} index={0} dimmed={false} />
            </SortableContext>
          </DndContext>
        </TooltipProvider>,
      );
      expect(html).toContain("control-lighting shadow-control hover:shadow-control-hover");
      expect(html.includes("ring-1 ring-foreground/70 ring-offset-2")).toBe(selected);
      expect(html).not.toContain("ring-foreground/90");
      expect(html).not.toContain("ring-offset-[3px]");
    },
  );
  it("uses the raised outline primitive for the updater", () => {
    useUpdateStore.setState({
      state: {
        supported: true,
        phase: "idle",
        currentVersion: "0.24.0",
        targetVersion: null,
        percent: null,
        error: null,
        lastCheck: null,
      },
    });
    const html = renderToMarkup(
      <TooltipProvider>
        <UpdateButton />
      </TooltipProvider>,
    );
    expect(html).toContain('data-variant="outline"');
    expect(html).toContain("control-material");
    expect(html).toContain("shadow-control hover:");
  });
});
