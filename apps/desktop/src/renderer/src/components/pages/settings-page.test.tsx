import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProjectAutomationSettings } from "./settings-page";

describe("SettingsPage", () => {
  it("shows the selected project's pinned base branch in one editable field", () => {
    const html = renderToStaticMarkup(
      <ProjectAutomationSettings
        project={{
          id: "p1",
          name: "Volli Code",
          path: "/repo/volli",
          ticketPrefix: "VC",
          baseBranch: "trunk",
          colorIndex: 0,
          sortOrder: 0,
          createdAt: 0,
          updatedAt: 0,
        }}
        onSave={async () => true}
      />,
    );

    expect(html).toContain("Default base branch");
    expect(html).toContain('value="trunk"');
    expect(html).toContain("Save");
  });
});
