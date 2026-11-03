import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { BaseBranchChip } from "./composer-branch";

const loading = { status: "loading" } as const;

it("names the base branch it shows and truncates a long one with its full title", () => {
  const html = renderToStaticMarkup(
    <BaseBranchChip state={loading} value="fix/worktree-identity-drift" onChange={() => {}} />,
  );
  expect(html).toContain('aria-label="Base branch: fix/worktree-identity-drift"');
  expect(html).toContain('class="min-w-0 truncate" title="fix/worktree-identity-drift"');
});

it("replaces the branch glyph with a spinner while reading an unknown base", () => {
  const html = renderToStaticMarkup(
    <BaseBranchChip state={loading} value={null} onChange={() => {}} />,
  );
  expect(html).toContain('aria-label="Base branch: Reading branches"');
  expect(html).toContain('role="presentation"');
  expect(html).toContain('title="Reading"');
  expect(html).not.toContain('title="…"');
});
