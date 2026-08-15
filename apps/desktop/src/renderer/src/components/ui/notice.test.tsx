import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Notice } from "./notice";

describe("Notice", () => {
  it("announces the message and never the actions", () => {
    // The failure this rule exists for: a live region containing buttons gets
    // the buttons re-announced with the status text on every polite update.
    const html = renderToStaticMarkup(
      <Notice announce title="Updates paused" actions={<button type="button">Retry</button>} />,
    );

    const start = html.indexOf('role="status"');
    expect(start).toBeGreaterThan(-1);
    const liveRegion = html.slice(start, html.indexOf("</div>", start));
    expect(liveRegion).toContain("Updates paused");
    expect(liveRegion).not.toContain("<button");
  });

  it("stays silent unless a site asks to announce", () => {
    const html = renderToStaticMarkup(<Notice title="Showing the first 1 MiB." />);

    expect(html).not.toContain("aria-live");
    expect(html).not.toContain('role="status"');
  });

  it("tints the block only for a fault", () => {
    const error = renderToStaticMarkup(<Notice tone="error" title="Worktree setup failed." />);
    const positive = renderToStaticMarkup(<Notice tone="positive" title="No changes vs base" />);

    expect(error).toContain("bg-destructive/10");
    expect(error).toContain("text-destructive");
    expect(positive).toContain("bg-muted/30");
    expect(positive).not.toContain("bg-destructive/10");
  });

  it("lifts a title out of the block's ink only when a detail sits under it", () => {
    const alone = renderToStaticMarkup(<Notice title="Changed elsewhere." />);
    const withDetail = renderToStaticMarkup(
      <Notice title="No changes vs base" detail="The branch is up to date." />,
    );
    const fault = renderToStaticMarkup(
      <Notice tone="error" title="Read failed" detail="missing on disk" />,
    );

    expect(alone).not.toContain("text-foreground");
    expect(withDetail).toContain("font-medium text-foreground");
    // On a fault the block's own ink IS the message.
    expect(fault).not.toContain("text-foreground");
  });

  it("holds a truncating notice to one line and keeps the full text on hover", () => {
    const html = renderToStaticMarkup(
      <Notice truncate title="Updates paused" hoverTitle="fatal: not a git repository" />,
    );

    expect(html).toContain("truncate");
    expect(html).toContain('title="fatal: not a git repository"');
  });

  it("fills the mark on a fault and leaves a quiet one outline", () => {
    const error = renderToStaticMarkup(
      <Notice tone="error" icon={WarningIcon} title="Updates paused" />,
    );
    const neutral = renderToStaticMarkup(<Notice icon={WarningIcon} title="Autosave paused." />);

    expect(error).not.toBe(neutral);
    expect(error).toContain("<svg");
    expect(neutral).toContain("<svg");
  });
});
