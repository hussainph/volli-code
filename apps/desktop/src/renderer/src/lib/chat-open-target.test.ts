import { describe, expect, it } from "vite-plus/test";

import { resolveChatOpenTarget } from "./chat-open-target";

const projectPath = "/Users/dev/code/app";
const worktrees = [
  { ticketId: "t-12", worktreePath: "/Users/dev/.volli/worktrees/app-abc/VC-12-fix" },
  { ticketId: "t-40", worktreePath: "/Users/dev/.volli/worktrees/app-abc/VC-40-ui" },
];

describe("resolveChatOpenTarget", () => {
  // ---- relative paths: the scope's venue decides -----------------------------

  it("keeps a relative path in the project venue for a project chat", () => {
    expect(
      resolveChatOpenTarget({
        path: "src/x.ts",
        projectPath,
        worktrees,
        scope: { kind: "project" },
      }),
    ).toEqual({ kind: "project-file", relPath: "src/x.ts" });
  });

  it("keeps a relative path in the ticket venue for a ticket chat", () => {
    expect(
      resolveChatOpenTarget({
        path: "src/x.ts",
        projectPath,
        worktrees,
        scope: { kind: "ticket", ticketId: "t-12" },
      }),
    ).toEqual({ kind: "ticket-file", ticketId: "t-12", relPath: "src/x.ts" });
  });

  it("strips a single leading ./ from a venue-relative path", () => {
    expect(
      resolveChatOpenTarget({
        path: "./src/x.ts",
        projectPath,
        worktrees,
        scope: { kind: "project" },
      }),
    ).toEqual({ kind: "project-file", relPath: "src/x.ts" });
  });

  it.each([["."], ["./"]])("treats the bare venue root %j as outside (a directory)", (path) => {
    expect(
      resolveChatOpenTarget({ path, projectPath, worktrees, scope: { kind: "project" } }),
    ).toEqual({ kind: "outside", path });
  });

  // ---- absolute paths: containment decides -----------------------------------

  it("maps an absolute path under a ticket worktree to that ticket's file", () => {
    expect(
      resolveChatOpenTarget({
        path: "/Users/dev/.volli/worktrees/app-abc/VC-40-ui/src/nav.tsx",
        projectPath,
        worktrees,
        scope: { kind: "project" },
      }),
    ).toEqual({ kind: "ticket-file", ticketId: "t-40", relPath: "src/nav.tsx" });
  });

  it("routes a worktree-absolute path to ITS ticket even from another ticket's chat", () => {
    expect(
      resolveChatOpenTarget({
        path: "/Users/dev/.volli/worktrees/app-abc/VC-12-fix/src/a.ts",
        projectPath,
        worktrees,
        scope: { kind: "ticket", ticketId: "t-40" },
      }),
    ).toEqual({ kind: "ticket-file", ticketId: "t-12", relPath: "src/a.ts" });
  });

  it("maps a main-checkout-absolute path to the project for a project chat", () => {
    expect(
      resolveChatOpenTarget({
        path: `${projectPath}/docs/DESIGN.md`,
        projectPath,
        worktrees,
        scope: { kind: "project" },
      }),
    ).toEqual({ kind: "project-file", relPath: "docs/DESIGN.md" });
  });

  it("maps a main-checkout-absolute path to the scope ticket for a ticket chat", () => {
    // Same semantics as the relative spelling: in a ticket workspace, a repo
    // path means the worktree's copy.
    expect(
      resolveChatOpenTarget({
        path: `${projectPath}/docs/DESIGN.md`,
        projectPath,
        worktrees,
        scope: { kind: "ticket", ticketId: "t-12" },
      }),
    ).toEqual({ kind: "ticket-file", ticketId: "t-12", relPath: "docs/DESIGN.md" });
  });

  it("does not let a sibling root claim the path (/repo vs /repo-old)", () => {
    expect(
      resolveChatOpenTarget({
        path: "/Users/dev/code/app-old/src/x.ts",
        projectPath,
        worktrees,
        scope: { kind: "project" },
      }),
    ).toEqual({ kind: "outside", path: "/Users/dev/code/app-old/src/x.ts" });
  });

  it.each([
    ["the worktree root itself", "/Users/dev/.volli/worktrees/app-abc/VC-12-fix"],
    ["the project root itself", projectPath],
  ])("treats %s as outside (a directory, not a file)", (_label, path) => {
    expect(
      resolveChatOpenTarget({ path, projectPath, worktrees, scope: { kind: "project" } }),
    ).toEqual({ kind: "outside", path });
  });

  it("reports an absolute path no root contains as outside", () => {
    expect(
      resolveChatOpenTarget({
        path: "/etc/hosts",
        projectPath,
        worktrees,
        scope: { kind: "ticket", ticketId: "t-12" },
      }),
    ).toEqual({ kind: "outside", path: "/etc/hosts" });
  });

  it("resolves absolute paths with no known worktrees against the project alone", () => {
    expect(
      resolveChatOpenTarget({
        path: `${projectPath}/src/x.ts`,
        projectPath,
        worktrees: [],
        scope: { kind: "project" },
      }),
    ).toEqual({ kind: "project-file", relPath: "src/x.ts" });
  });
});
