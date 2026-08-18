import type { Project } from "@volli/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProjectAppearanceSettings } from "./project-appearance-settings";

const project: Project = {
  id: "p1",
  name: "Voltaic",
  path: "/repo/voltaic",
  ticketPrefix: "VLT",
  baseBranch: "main",
  setupCommand: null,
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};

/**
 * Only the un-scoped pane is renderable here, and that is a property of the
 * host rather than a gap: zustand answers a server render from
 * `getInitialState`, so a store seeded with `setState` is invisible to
 * `renderToStaticMarkup` and every branch below the scope guard would be the
 * same branch. The tri-state logic is covered in `canvas-editor-model.test.ts`
 * and the editor those branches mount in `canvas-editor.test.tsx`, both of which
 * take their state as arguments.
 */
describe("Configure → Appearance", () => {
  it("offers a Retry rather than a permanent Loading when the scope read has not landed", () => {
    // The effect fires once per project and the store toasts a failed read
    // rather than retrying, so without this button a lost read leaves the pane
    // on "Loading…" for as long as it stays open, with nothing to press.
    const html = renderToStaticMarkup(<ProjectAppearanceSettings project={project} />);

    expect(html).toContain("Loading project appearance");
    expect(html).toContain("Retry");
    expect(html).toContain("Voltaic");
  });
});
