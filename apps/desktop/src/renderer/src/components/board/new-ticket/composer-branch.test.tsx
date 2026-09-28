import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { ComposerBranchRow, type ComposerBranchRowProps } from "./composer-branch";

const props: ComposerBranchRowProps = {
  state: { status: "loading" },
  baseBranch: "fix/worktree-identity-drift",
  onBaseBranchChange: () => {},
  usesWorktree: true,
  onUsesWorktreeChange: () => {},
};

it("keeps the destination visible when the base branch is wider than Options", () => {
  const html = renderToStaticMarkup(<ComposerBranchRow {...props} />);
  expect(html).toContain('class="flex w-full min-w-0 items-center gap-1"');
  expect(html).toMatch(
    /min-w-0 flex-1 justify-start" aria-label="Base branch: fix\/worktree-identity-drift"/,
  );
  expect(html).toContain('class="min-w-0 truncate" title="fix/worktree-identity-drift"');
  expect(html).toContain('aria-label="Working destination: new worktree"');
});

it("only shows the destination when working in the project checkout", () => {
  const html = renderToStaticMarkup(<ComposerBranchRow {...props} usesWorktree={false} />);
  expect(html).not.toContain('aria-label="Base branch:');
  expect(html).toContain('aria-label="Working destination: project checkout"');
});
