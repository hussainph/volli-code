/**
 * The dispatch's half of the Verb Registry's handler binding (VC-161).
 *
 * `VerbEntry.handler` declares WHERE a verb's one binding lives — `main`
 * answers over the agent socket, `cli` answers locally in the `volli` process
 * and never opens one. Nothing reads that field: `agent-commands.ts` is a
 * single `execute` closure with a sequential `if (request.cmd === …)` chain
 * over shared local state, and decomposing it into a dispatch table is a named
 * non-goal of this ticket. So the declaration is CHECKED against the chain
 * instead of driving it, in both directions.
 *
 * Types already hold one of those directions. `request.cmd` is the closed
 * `AgentCommand` union, which the registry now derives, so a branch cannot
 * name a verb the socket does not project — `request.cmd === "app.launch"`
 * does not compile. What types do NOT hold is the other direction: the chain
 * ends by NARROWING `request.cmd` rather than exhausting it, so deleting a
 * branch still compiles and quietly turns a declared verb into an
 * `UNSUPPORTED_COMMAND` at runtime. That gap is the whole reason the registry
 * can declare a binding main does not honour, and it is what this file pins.
 *
 * Reading the dispatch as source text is the price of leaving it whole. The
 * scan is deliberately narrow — it matches the branch shape and nothing else,
 * so it would be confused by a COMMENT that quotes one; do not write that
 * comment. When the chain is finally decomposed, the table it becomes is what
 * replaces this scan.
 *
 * It lives beside `agent-commands.test.ts` rather than inside it because that
 * file opens a database per test and tears one down in a file-wide
 * `afterEach`; these assertions read a file and touch nothing.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { AGENT_COMMANDS, VERB_REGISTRY } from "@volli/shared";

const DISPATCH_SOURCE = readFileSync(new URL("./agent-commands.ts", import.meta.url), "utf8")
  // Prettier breaks a long condition across lines, so whether a branch is one
  // line or four depends only on how long its verb names are. Flatten first.
  .replace(/\s+/g, " ");

/**
 * The verbs each branch of the dispatch chain answers, one array per branch.
 *
 * Only conditions built purely of `request.cmd === "…"` terms count, because
 * that is what a dispatch branch IS. `execute` opens with two conditions that
 * also read `request.cmd` and are not branches — the ternary that skips the
 * all-projects snapshot on the hook hot path, and the `!==` chain that skips
 * the `VOLLI_SESSION` lookup — and neither has this shape.
 */
function dispatchBranches(source: string): readonly (readonly string[])[] {
  const branch = /if \(\s*((?:request\.cmd === "[a-z][a-z.]*"(?: \|\| )?)+)\s*\) \{/g;
  return [...source.matchAll(branch)].map((match) =>
    [...match[1]!.matchAll(/"([a-z][a-z.]*)"/g)].map((literal) => literal[1]!),
  );
}

/**
 * The verb the chain falls THROUGH to. The last one gets no `if` of its own:
 * the chain rejects everything that is not it and then runs straight on, so
 * its name is legible only out of that rejection — which is also the socket's
 * honest answer for a command main does not handle.
 */
function fallThroughVerb(source: string): string | null {
  const rejection =
    /if \(\s*request\.cmd !== "([a-z][a-z.]*)"\s*\) \{ return failure\("UNSUPPORTED_COMMAND"/g;
  const matches = [...source.matchAll(rejection)];
  return matches.length === 1 ? matches[0]![1]! : null;
}

describe("dispatch parity with the Verb Registry (VC-161)", () => {
  const branches = dispatchBranches(DISPATCH_SOURCE);
  const fallThrough = fallThroughVerb(DISPATCH_SOURCE);
  /** Every verb main answers: the branch conditions, plus the fall-through. */
  const answered = [...branches.flat(), ...(fallThrough === null ? [] : [fallThrough])];

  it("ends in one rejection, which is also the last verb's branch", () => {
    expect(fallThrough).toBe("ticket.create");
    expect([...AGENT_COMMANDS]).toContain(fallThrough);
  });

  it("has a branch for every verb the registry binds to main", () => {
    const bound = VERB_REGISTRY.filter(
      (entry) => entry.handler === "main" && entry.accessModes.includes("cli"),
    ).map((entry) => entry.key);
    expect(bound).toEqual([...AGENT_COMMANDS]);
    expect(bound.filter((key) => !answered.includes(key))).toEqual([]);
  });

  it("answers no verb the registry does not project onto the socket", () => {
    const socket = new Set<string>(AGENT_COMMANDS);
    expect(answered.filter((key) => !socket.has(key))).toEqual([]);
    expect(new Set(answered).size).toBe(answered.length);
  });

  it("never answers a verb whose binding lives in the CLI process", () => {
    // `app launch` and `help` are on the CLI surface but never on the socket:
    // `packages/cli` answers both locally, so a branch here for either would
    // mean two implementations of one verb — the thing the registry exists to
    // make impossible.
    const local = new Set<string>(
      VERB_REGISTRY.filter((entry) => entry.handler === "cli").map((entry) => entry.key),
    );
    expect([...local]).toEqual(["app.launch", "help"]);
    expect(answered.filter((key) => local.has(key))).toEqual([]);
  });

  it("lets two entries share one binding, as the session signals do", () => {
    // One handler binding per verb does not mean one BRANCH per verb:
    // `session.done` and `session.blocked` are the same write under a
    // different signal, so they share theirs. Parity is by key, not by site.
    expect(branches.filter((keys) => keys.length !== 1)).toEqual([
      ["session.done", "session.blocked"],
    ]);
  });
});
