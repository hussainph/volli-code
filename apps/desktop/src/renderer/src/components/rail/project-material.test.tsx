// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { compile } from "tailwindcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import {
  DEFAULT_CANVAS,
  windowBackground,
  compositeHex,
  effectiveStopHexes,
  hexToOklch,
  tintCanvasNeutral,
  type Project,
} from "@volli/shared";
import { deriveCanvasPaint, type CanvasTokenName } from "@renderer/theme/canvas-paint";
import { Sidebar, SidebarProvider } from "@renderer/components/ui/sidebar";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { UpdateButton } from "@renderer/components/sidebar/update-button";
import { useUpdateStore } from "@renderer/stores/update";
import { useProjectsStore } from "@renderer/stores/projects";
import { AddProjectTile } from "./add-project-tile";
import { ProjectTile } from "./project-tile";
import { ProjectRail } from "./project-rail";

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
const originalProjects = useProjectsStore.getState().projects;
const originalUpdate = useUpdateStore.getState().state;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  useProjectsStore.setState({ selectedProjectId: originalProject, projects: originalProjects });
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
  it("scopes real project-rail washes to adaptive bare-canvas ink, not paper or filtered glass", async () => {
    useProjectsStore.setState({ projects: [project], selectedProjectId: project.id });
    const host = document.createElement("div");
    host.innerHTML = renderToMarkup(
      <SidebarProvider>
        <Sidebar collapsible="none" data-project-rail className="bg-transparent">
          <ProjectRail />
        </Sidebar>
      </SidebarProvider>,
    );
    const sidebar = host.querySelector('[data-project-rail][data-slot="sidebar"]')!;
    expect(sidebar.classList.contains("bg-transparent")).toBe(true);
    const rail = sidebar.querySelector(".app-region-drag")!;
    expect(rail.closest(".glass")).toBeNull();
    const overlays = rail.querySelectorAll('[class~="bg-wash-ink/10"]');
    expect(overlays).toHaveLength(2); // Real project tile and Add project.
    for (const overlay of overlays) {
      expect(overlay.closest(".app-region-drag")).toBe(rail);
      expect(overlay.classList.contains("group-hover/tile:opacity-100")).toBe(true);
      expect(overlay.classList.contains("opacity-0")).toBe(true);
    }

    const css = readFileSync(resolve(import.meta.dirname, "../../globals.css"), "utf8");
    // Bind the numeric model to the alias on the matching production scope,
    // rather than assuming navigation-glass paint from a class name.
    const scope = /\[data-slot="sidebar"\],\s*\.app-region-drag\s*\{([^}]+)\}/.exec(css)![1];
    const washToken = /--wash-ink:\s*var\((--[\w-]+)\)/.exec(scope)![1];
    expect(washToken).toBe("--canvas-ink");
    expect(scope).toContain("--foreground: var(--canvas-ink)");
    expect(css).toContain("--color-wash-ink: var(--wash-ink)");
    expect(css).toContain("--wash-ink: var(--glass-wash-ink)");
    const themeDeclaration = /--color-wash-ink:[^;]+;/.exec(css)![0];
    const utility = (
      await compile(`@theme inline { ${themeDeclaration} }\n@tailwind utilities;`)
    ).build(["bg-wash-ink/10"]);
    expect(utility).toContain(
      "background-color: color-mix(in oklab, var(--wash-ink) 10%, transparent)",
    );

    for (const mode of ["light", "dark"] as const) {
      const poles = new Set<boolean>();
      for (const seed of [
        "#000000",
        "#ffffff",
        "#f8f0d8",
        "#e6f6ff",
        "#f5eaff",
        "#101820",
        "#80817f",
      ]) {
        for (const vibrancy of [0, 0.6, 1]) {
          const canvas = { ...DEFAULT_CANVAS, vibrancy, stops: [{ hex: seed, x: 0.5, y: 0.5 }] };
          const { tokens: t, canvasTokens: c } = deriveCanvasPaint(canvas, mode);
          const wash = c[washToken as CanvasTokenName];
          const inkL = hexToOklch(c["--canvas-ink"]).L;
          poles.add(inkL > 0.5);
          // This existing ink already carries the canvas hue; no new tint
          // budget or generated token is needed to preserve the material trace.
          expect(hexToOklch(wash).C).toBeGreaterThan(0);
          expect(c["--wash-ink"]).toBe(tintCanvasNeutral(t["--foreground"], canvas, mode));
          for (const backing of [
            windowBackground(canvas, mode),
            ...effectiveStopHexes(canvas, mode),
          ]) {
            const hover = compositeHex(wash, 0.1, backing);
            expect(hover).toBe(compositeHex(c["--canvas-ink"], 0.1, backing));
            const baseL = hexToOklch(backing).L;
            // Preserve the former adaptive hover's direction at either pole;
            // arbitrary authored canvases do not imply a universal AA promise.
            expect((hexToOklch(hover).L - baseL) * (inkL - baseL)).toBeGreaterThan(0);
          }
        }
      }
      expect(poles).toEqual(new Set([false, true]));
    }
  });

  it("gives Add project the same quiet glass tile as its neighbours", () => {
    const html = renderToMarkup(
      <TooltipProvider>
        <AddProjectTile />
      </TooltipProvider>,
    );
    expect(html).toContain("glass-control");
    expect(html).toContain("rounded-full");
    expect(html).toContain('aria-label="Add project"');
    expect(html).toContain("focus-visible:ring-ring");
  });
  it.each([false, true])(
    "tints project tiles and places selection at the left edge: %s",
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
      expect(html).toContain("workspace-tile");
      expect(html).toContain("--tile-color:");
      expect(html.includes("workspace-tile-selected")).toBe(selected);
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
