import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { WorktreeDiffThumbnail, WorktreeStateStrip } from "./ticket-repository-summary";

describe("the repository ledger", () => {
  it("draws its diff thumbnail from the actual file and line totals", () => {
    const html = renderToStaticMarkup(
      <WorktreeDiffThumbnail
        diff={{
          files: [{ path: "README.md", insertions: 12, deletions: 3, untracked: false }],
          insertions: 12,
          deletions: 3,
        }}
      />,
    );
    expect(html).toContain("1 changed file");
    expect(html).toContain("+12");
    expect(html).toContain("−3");
    expect(html).toContain("width:80%");
    expect(html).toContain("width:20%");
  });

  it("keeps a clean reading distinct from an unread worktree", () => {
    const html = renderToStaticMarkup(
      <WorktreeDiffThumbnail diff={{ files: [], insertions: 0, deletions: 0 }} />,
    );
    expect(html).toContain("No changes");
    expect(html).not.toContain("bg-positive");
  });

  it("keeps all three ledger facts on one coherent surface", () => {
    const html = renderToStaticMarkup(
      <WorktreeStateStrip
        status={{
          uncommitted: false,
          sequencerActive: false,
          unmergedPaths: 0,
          aheadOfBase: 3,
          behindBase: 0,
          unpushed: 0,
        }}
      />,
    );
    expect(html).toContain("Working: Clean; Local: 3 commits; Remote: Up to date");
  });
});
