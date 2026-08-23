import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WorkspaceDependenciesNotice } from "./workspace-dependencies-offer";

describe("WorkspaceDependenciesNotice", () => {
  it("states the workspace fact once, neutrally, with its own remedy attached", () => {
    const html = renderToStaticMarkup(
      <WorkspaceDependenciesNotice
        installCommand="pnpm install"
        running={false}
        onRun={() => undefined}
        onConfigureSetup={() => undefined}
        onIgnore={() => undefined}
      />,
    );

    expect(html).toContain("Dependencies aren&#x27;t installed yet");
    expect(html).toContain("Run pnpm install");
    expect(html).toContain("Set a setup command");
    expect(html).toContain("Ignore");
    // The whole point of the ticket: no error tone, and none of the retired
    // banner's vocabulary. Nothing here says anything is not ready.
    expect(html).not.toContain("bg-destructive/10");
    expect(html).not.toContain("aren&#x27;t ready");
    expect(html).not.toContain("volli doctor");
  });

  it("says what it is doing and refuses a second press while it runs", () => {
    const html = renderToStaticMarkup(
      <WorkspaceDependenciesNotice
        installCommand="yarn install"
        running
        onRun={() => undefined}
        onConfigureSetup={() => undefined}
        onIgnore={() => undefined}
      />,
    );

    expect(html).toContain("Running yarn install…");
    // One per action: nothing here can be pressed twice into the same shell.
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });
});
