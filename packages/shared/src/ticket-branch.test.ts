import { describe, it, expect } from "vite-plus/test";
import {
  classifyTicketWorktreeCheckout,
  isValidBranchName,
  slugify,
  ticketBranchDisplayId,
  ticketBranchName,
} from "./ticket-branch";

describe("slugify", () => {
  it("slugifies a basic title", () => {
    expect(slugify("MCP server")).toBe("mcp-server");
  });

  it("collapses punctuation and multiple spaces into single hyphens", () => {
    expect(slugify("Add  --  MCP,   server!!!")).toBe("add-mcp-server");
  });

  it("returns empty string for an all-punctuation title", () => {
    expect(slugify("!!!  @@@ ###")).toBe("");
  });

  it("truncates to 48 chars without leaving a trailing hyphen", () => {
    // 25 single-char words collapse to 25 'a's joined by hyphens (49 chars);
    // slicing to 48 lands on a hyphen, which must be stripped.
    const input = Array(25).fill("a").join(" ");
    const expected = Array(24).fill("a").join("-");
    const result = slugify(input);
    expect(result).toBe(expected);
    expect(result.length).toBeLessThanOrEqual(48);
    expect(result.endsWith("-")).toBe(false);
  });

  it("slugifies a title that is one long run of hyphens in milliseconds", () => {
    // The flagged `/^-+|-+$/g` (CodeQL js/polynomial-redos) only ever saw a
    // collapsed slug, so it was never slow in practice — which is exactly what
    // could rot. This pins the promise the trim now makes on its own: cost
    // follows the title's length, never the shape of what is in it.
    const started = performance.now();
    expect(slugify("-".repeat(100_000))).toBe("");
    expect(slugify(`${"-".repeat(100_000)}tail`)).toBe("tail");
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("ticketBranchName", () => {
  it("builds a branch from ticket id and title", () => {
    expect(ticketBranchName("VC-12", "MCP server")).toBe("volli/VC-12-mcp-server");
  });

  it("preserves the ticket id case", () => {
    expect(ticketBranchName("VC-99", "Fix bug")).toBe("volli/VC-99-fix-bug");
  });

  it("omits the separator when the title is empty", () => {
    expect(ticketBranchName("VC-7", "")).toBe("volli/VC-7");
  });

  it("omits the separator when the title has no slug characters", () => {
    expect(ticketBranchName("VC-3", "!!! @@@ ###")).toBe("volli/VC-3");
  });
});

describe("ticketBranchDisplayId", () => {
  it.each([
    ["volli/VC-12-mcp-server", "VC-12"],
    ["volli/VC-12", "VC-12"],
    ["volli/VC-2-3-things", "VC-2"],
    ["volli/A1B2C-7-x", "A1B2C-7"],
    // Round-trips whatever `ticketBranchName` builds, slug or none.
    [ticketBranchName("VC-297", "Automation editor history shows every automation"), "VC-297"],
    [ticketBranchName("VC-3", "!!!"), "VC-3"],
  ])("reads %s as %s", (branch, displayId) => {
    expect(ticketBranchDisplayId(branch)).toBe(displayId);
  });

  it.each([
    ["main"],
    ["fix/browser-tab-smoke-popup-flake"],
    ["volli/"],
    ["volli/VC"],
    ["volli/VC-"],
    ["volli/VC-12x-slug"],
    ["volli/vc-12-lowercase-prefix"],
    ["volli/1VC-12-digit-first"],
    ["volli/ABCDEF-1-prefix-too-long"],
    ["feature/volli/VC-12-nested"],
    ["refs/heads/volli/VC-12-full-ref"],
  ])("reads %s as no ticket", (branch) => {
    expect(ticketBranchDisplayId(branch)).toBeNull();
  });
});

describe("classifyTicketWorktreeCheckout", () => {
  const expectedBranch = "volli/VC-297-automation-editor-history-shows-every-automation";
  const classify = (checkedOutBranch: string | null) =>
    classifyTicketWorktreeCheckout({ displayId: "VC-297", expectedBranch, checkedOutBranch });

  it("is expected when the worktree is on the ticket's own branch", () => {
    expect(classify(expectedBranch)).toEqual({ kind: "expected" });
  });

  it("adopts another branch of the same ticket (an agent's narrower branch)", () => {
    expect(classify("volli/VC-297-scoped-history-reads")).toEqual({
      kind: "adopt",
      branch: "volli/VC-297-scoped-history-reads",
    });
  });

  it("adopts the old-slug branch a retitle drifted away from", () => {
    expect(classify("volli/VC-297-automation-history")).toEqual({
      kind: "adopt",
      branch: "volli/VC-297-automation-history",
    });
    expect(classify("volli/VC-297")).toEqual({ kind: "adopt", branch: "volli/VC-297" });
  });

  it("adopts a same-ticket branch even when the recorded branch is outside the convention", () => {
    expect(
      classifyTicketWorktreeCheckout({
        displayId: "VC-12",
        expectedBranch: "feature/user-named",
        checkedOutBranch: "volli/VC-12-agent-branch",
      }),
    ).toEqual({ kind: "adopt", branch: "volli/VC-12-agent-branch" });
  });

  it.each([
    ["another ticket's branch", "volli/VC-298-something-else"],
    ["a ticket whose number only starts the same", "volli/VC-2970-lookalike"],
    ["the same number under another prefix", "volli/VD-297-other-project"],
    ["a branch outside the convention", "fix/browser-tab-smoke-popup-flake"],
    ["the main branch", "main"],
  ])("refuses %s as foreign", (_label, branch) => {
    expect(classify(branch)).toEqual({ kind: "foreign", branch });
  });

  it("refuses a detached HEAD — there is no branch to record", () => {
    expect(classify(null)).toEqual({ kind: "detached" });
  });
});

describe("isValidBranchName", () => {
  it.each([["volli/VC-12-mcp-server"], ["main"], ["feature/thing"], ["release-1.2.3"], ["a"]])(
    "accepts the valid ref %s",
    (name) => {
      expect(isValidBranchName(name)).toBe(true);
    },
  );

  it.each([
    ["", "empty"],
    ["@", "the single @"],
    ["-leading", "a leading dash"],
    ["/leading", "a leading slash"],
    ["trailing/", "a trailing slash"],
    ["trailing.", "a trailing dot"],
    ["a..b", "a double dot"],
    ["a@{b", "an @{ sequence"],
    ["foo.lock", "a .lock suffix"],
    ["foo.lock/bar", "a .lock component"],
    ["has space", "a space"],
    ["ctrl\x01char", "a control character"],
    [`del${String.fromCharCode(0x7f)}char`, "a DEL character"],
    ["tilde~x", "a reserved ~"],
    ["caret^x", "a reserved ^"],
    ["colon:x", "a reserved :"],
    ["q?x", "a reserved ?"],
    ["star*x", "a reserved *"],
    ["brk[x", "a reserved ["],
    ["back\\x", "a reserved backslash"],
  ])("rejects %s (%s)", (name) => {
    expect(isValidBranchName(name)).toBe(false);
  });
});
