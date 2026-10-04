import { describe, expect, it } from "vite-plus/test";

import { resolveWorktreeIdentity } from "./identity";

describe("resolveWorktreeIdentity", () => {
  const base = {
    home: "/home/dev",
    projectPath: "/code/volli-code",
    projectId: "abcd1234-ef56-7890-1234-567890abcdef",
    displayId: "VC-12",
    title: "MCP server",
    persistedPath: null,
    persistedBranch: null,
  };

  it("builds ~/.volli/worktrees/<project-dirname>-<short-id>/<DISPLAY-ID>-<slug>/", () => {
    const identity = resolveWorktreeIdentity(base);
    expect(identity.path).toBe("/home/dev/.volli/worktrees/volli-code-abcd1234/VC-12-mcp-server");
    expect(identity.branch).toBe("volli/VC-12-mcp-server");
  });

  it("uses the first 8 chars of the project UUID as the short id", () => {
    const identity = resolveWorktreeIdentity({ ...base, projectId: "deadbeef-0000-1111" });
    expect(identity.path).toContain("/volli-code-deadbeef/");
  });

  it("drops the trailing separator when the title slug is empty", () => {
    const identity = resolveWorktreeIdentity({ ...base, title: "!!!" });
    expect(identity.path).toBe("/home/dev/.volli/worktrees/volli-code-abcd1234/VC-12");
    expect(identity.branch).toBe("volli/VC-12");
  });

  it("handles a trailing slash on the project path without an empty dirname", () => {
    const identity = resolveWorktreeIdentity({ ...base, projectPath: "/code/volli-code/" });
    expect(identity.path).toContain("/volli-code-abcd1234/");
  });

  it("prefers persisted path and branch verbatim — a live worktree is never renamed", () => {
    const identity = resolveWorktreeIdentity({
      ...base,
      title: "A completely different title now",
      persistedPath: "/home/dev/.volli/worktrees/volli-code-abcd1234/VC-12-original",
      persistedBranch: "volli/VC-12-original",
    });
    expect(identity.path).toBe("/home/dev/.volli/worktrees/volli-code-abcd1234/VC-12-original");
    expect(identity.branch).toBe("volli/VC-12-original");
  });
});
