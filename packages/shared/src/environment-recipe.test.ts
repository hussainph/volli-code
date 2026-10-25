import { describe, expect, it } from "vite-plus/test";

import { environmentFixTicket, WORKTREE_SETUP_ANSWERS } from "./environment-recipe";

const run = {
  source: "repo" as const,
  summary: "`.agents/setup` exited with code 1: pnpm: not found",
  exitCode: 1,
  endedAt: 1,
  tail: "installing\npnpm: not found\n",
};

describe("environmentFixTicket", () => {
  it("files a ticket that names the failing ticket, the reason, the contract and the output", () => {
    const ticket = environmentFixTicket("VC-12", run);

    expect(ticket.title).toBe("Fix the environment setup");
    expect(ticket.labels).toEqual(["environment"]);
    expect(ticket.body).toContain("for VC-12 failed: `.agents/setup` exited with code 1");
    expect(ticket.body).toContain("Make the repository's `.agents/setup` succeed");
    expect(ticket.body).toContain("answer VC-12's setup with Retry setup.");
    expect(ticket.body).toContain("```text\ninstalling\npnpm: not found\n```");
  });

  it("names the stored command when that is what ran, and leaves out an empty output", () => {
    const ticket = environmentFixTicket("VC-3", { ...run, source: "legacyCommand", tail: "  \n" });

    expect(ticket.body).toContain("the project's stored setup command");
    expect(ticket.body).not.toContain("Output:");
  });

  it("fences output that itself contains a fence, and keeps only its end", () => {
    const tail = `${"x".repeat(5_000)}\n\`\`\`\`\nend`;
    const ticket = environmentFixTicket("VC-1", { ...run, tail });

    expect(ticket.body).toContain("`````text\n");
    expect(ticket.body.endsWith("end\n`````")).toBe(true);
    expect(ticket.body).not.toContain("x".repeat(4_001));
  });
});

describe("WORKTREE_SETUP_ANSWERS", () => {
  it("lists both answers", () => {
    expect(WORKTREE_SETUP_ANSWERS).toEqual(["retry", "start-anyway"]);
  });
});
