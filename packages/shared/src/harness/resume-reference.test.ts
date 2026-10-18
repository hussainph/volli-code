import { describe, expect, it } from "vite-plus/test";

import { buildResumeCommand, shellSingleQuote } from "../harness-command";
import { FIRST_CLASS_HARNESS_IDS } from "../ticket";
import { harnessAdapters } from "./core";
import { harnessResumeReference } from "./resume-reference";

const reference = harnessResumeReference();
describe("harnessResumeReference", () => {
  it("lists every built-in harness, once, in registry order", () => {
    expect(reference.map((row) => row.harnessId)).toEqual(
      harnessAdapters.map((adapter) => adapter.id),
    );
    expect(reference.map((row) => row.harnessId).toSorted()).toEqual(
      [...FIRST_CLASS_HARNESS_IDS].toSorted(),
    );
  });

  it("shows exactly the command lines the resume builder produces", () => {
    const id = "0b0e3a5c-1d2f-4e6a-8b9c-0d1e2f3a4b5c";
    for (const adapter of harnessAdapters) {
      const row = reference.find((candidate) => candidate.harnessId === adapter.id)!;
      expect(row.byId?.replaceAll("<id>", shellSingleQuote(id))).toBe(
        buildResumeCommand(adapter, id, null),
      );
      expect(row.latest).toBe(buildResumeCommand(adapter, null, null));
    }
  });

  // The rendered table, pinned. A change to any built-in's resume data fails
  // here first, so whoever made it sees the docs page it rewrites.
  it("renders the built-ins' resume table", () => {
    expect(reference).toEqual([
      {
        harnessId: "claude-code",
        label: "Claude Code",
        byId: "claude --resume <id>",
        latest: "claude --continue",
        freshLaunch: "claude --session-id <uuid>",
        sessionIdSource: "argv",
        minimumVersion: null,
      },
      {
        harnessId: "codex",
        label: "Codex",
        byId: "codex resume <id>",
        latest: "codex resume --last",
        freshLaunch: "codex",
        sessionIdSource: "none",
        minimumVersion: null,
      },
      {
        harnessId: "cursor",
        label: "Cursor",
        byId: "cursor-agent --resume <id>",
        latest: "cursor-agent --continue",
        freshLaunch: "cursor-agent --new-session-id <uuid>",
        sessionIdSource: "argv",
        minimumVersion: null,
      },
      {
        harnessId: "opencode",
        label: "OpenCode",
        byId: "opencode --session <id>",
        latest: "opencode --continue",
        freshLaunch: "opencode",
        sessionIdSource: "reported",
        minimumVersion: null,
      },
    ]);
  });
});
