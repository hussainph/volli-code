import type { FileChangedEvent } from "../../../ipc/contract";
import { describe, expect, it } from "vite-plus/test";

import { matchesFileChangeIdentity } from "./file-change-identity";

describe("matchesFileChangeIdentity", () => {
  it("requires project, nullable ticket, relative path, and resolved source to all match", () => {
    const identity = {
      projectId: "project-1",
      ticketId: "ticket-1",
      relPath: "src/app.ts",
      source: "worktree",
    } as const;
    const event: FileChangedEvent = { ...identity, revision: 2 };

    expect(matchesFileChangeIdentity(event, identity)).toBe(true);
    expect(matchesFileChangeIdentity({ ...event, projectId: "project-2" }, identity)).toBe(false);
    expect(matchesFileChangeIdentity({ ...event, ticketId: "ticket-2" }, identity)).toBe(false);
    expect(matchesFileChangeIdentity({ ...event, ticketId: null }, identity)).toBe(false);
    expect(matchesFileChangeIdentity({ ...event, relPath: "src/other.ts" }, identity)).toBe(false);
    expect(matchesFileChangeIdentity({ ...event, source: "main" }, identity)).toBe(false);
  });
});
