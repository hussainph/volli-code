import {
  commandScope,
  gitScope,
  writeScope,
  type ApprovalDecision,
  type ApprovalScope,
  type PolicyViolation,
  type RuntimeApprovalHit,
  type RuntimeApprovals,
  type RuntimeAskChoice,
  type RuntimeAskRequest,
} from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";
import type { AuthorityVerdict } from "../authority/gate";
import { AuthorityEscalation } from "./escalation";

const FALLBACK = { consecutiveDenials: 3, sessionDenials: 20 };
const WRITE = writeScope("/Users/me/code/docs/guides/a.md");

function denial(
  violations: readonly PolicyViolation[],
  extra: Partial<Extract<AuthorityVerdict, { outcome: "deny" }>> = {},
): AuthorityVerdict {
  return {
    outcome: "deny",
    cause: violations[0].rule,
    reason: violations[0].reason,
    violations,
    ...extra,
  };
}

const OUTSIDE: PolicyViolation = {
  rule: "path.outside-workspace",
  reason: "outside the workspace",
  scopes: [WRITE],
};

function approvals(
  hits: ReadonlyMap<string, RuntimeApprovalHit> = new Map(),
): RuntimeApprovals & { decisions: ApprovalDecision[] } {
  const decisions: ApprovalDecision[] = [];
  return {
    decisions,
    covers: (scope: ApprovalScope) => hits.get(scope.target) ?? null,
    decided: (decision) => void decisions.push(decision),
  };
}

function machine(
  port: RuntimeApprovals,
  ask?: (request: RuntimeAskRequest, signal: AbortSignal) => Promise<RuntimeAskChoice>,
) {
  return new AuthorityEscalation({
    fallback: FALLBACK,
    approvals: port,
    ...(ask === undefined ? {} : { ask }),
  });
}

function resolve(escalation: AuthorityEscalation, verdict: AuthorityVerdict, signal?: AbortSignal) {
  return escalation.resolve({
    verdict,
    tool: "write",
    toolCallId: "call-1",
    asked: "write /Users/me/code/docs/guides/a.md",
    turnId: "turn-1",
    ...(signal ? { signal } : {}),
  });
}

describe("AuthorityEscalation in protection mode", () => {
  it("allows an allowed call without recording anything", async () => {
    const port = approvals();
    expect(await resolve(machine(port), { outcome: "allow" })).toEqual({ outcome: "allow" });
    expect(port.decisions).toEqual([]);
  });

  it("asks on the first approvable refusal, with what a remember answer would store", async () => {
    const ask = vi.fn(async () => "allow" as RuntimeAskChoice);
    const port = approvals();
    const outcome = await resolve(machine(port, ask), denial([OUTSIDE], { stages: ["a", "b"] }));
    expect(outcome).toEqual({ outcome: "allow" });
    expect(ask).toHaveBeenCalledTimes(1);
    const request = (ask.mock.calls[0] as unknown as [RuntimeAskRequest])[0];
    expect(request).toMatchObject({
      cause: "path.outside-workspace",
      trip: "approval",
      overridable: true,
      approval: {
        asked: "write /Users/me/code/docs/guides/a.md",
        stages: ["a", "b"],
        reason: "outside the workspace",
        scopes: [WRITE],
      },
    });
    expect(port.decisions).toEqual([
      expect.objectContaining({ authoriser: "user:once", rule: "path.outside-workspace" }),
    ]);
  });

  it.each([
    ["allow-session", "user:session"],
    ["allow-project", "user:project"],
  ] as const)("records %s as %s and lets the call run", async (choice, authoriser) => {
    const port = approvals();
    expect(
      await resolve(
        machine(port, async () => choice),
        denial([OUTSIDE]),
      ),
    ).toEqual({
      outcome: "allow",
    });
    expect(port.decisions[0].authoriser).toBe(authoriser);
  });

  it("allows deterministically on a ledger hit and never asks", async () => {
    const ask = vi.fn(async () => "refuse" as RuntimeAskChoice);
    const port = approvals(
      new Map([[WRITE.target, { approvalId: "row-1", summary: "Write to x" }]]),
    );
    expect(await resolve(machine(port, ask), denial([OUTSIDE]))).toEqual({ outcome: "allow" });
    expect(ask).not.toHaveBeenCalled();
    expect(port.decisions).toEqual([
      expect.objectContaining({
        authoriser: "policy:ledger",
        approvalId: "row-1",
        summary: "Write to x",
      }),
    ]);
  });

  it("asks only about the scopes the ledger does not cover", async () => {
    const other = writeScope("/Users/me/code/other/x/y/b.md");
    const ask = vi.fn(async () => "allow" as RuntimeAskChoice);
    const port = approvals(
      new Map([[WRITE.target, { approvalId: "row-1", summary: "Write to x" }]]),
    );
    await resolve(machine(port, ask), denial([{ ...OUTSIDE, scopes: [WRITE, other] }]));
    const request = (ask.mock.calls[0] as unknown as [RuntimeAskRequest])[0];
    expect(request.approval?.scopes).toEqual([other]);
    expect(port.decisions.map((decision) => decision.authoriser)).toEqual([
      "user:once",
      "policy:ledger",
    ]);
  });

  it("asks once per approvable rule, clearing each in turn", async () => {
    const git: PolicyViolation = {
      rule: "command.git-escapes-workspace",
      reason: "git elsewhere",
      scopes: [gitScope("git push -C /x")],
    };
    const ask = vi.fn(async () => "allow" as RuntimeAskChoice);
    expect(await resolve(machine(approvals(), ask), denial([OUTSIDE, git]))).toEqual({
      outcome: "allow",
    });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("asks for a refusal that can only be allowed once, offering nothing to remember", async () => {
    const once: PolicyViolation = { ...OUTSIDE, scopes: null };
    const ask = vi.fn(async () => "allow" as RuntimeAskChoice);
    await resolve(machine(approvals(), ask), denial([once]));
    const request = (ask.mock.calls[0] as unknown as [RuntimeAskRequest])[0];
    expect(request.approval?.scopes).toEqual([]);
    expect(request.approval?.stages).toBeUndefined();
  });

  it("denies, says so to the model, and carries on without interrupting", async () => {
    const port = approvals();
    const outcome = await resolve(
      machine(port, async () => "refuse"),
      denial([OUTSIDE]),
    );
    expect(outcome).toMatchObject({
      outcome: "deny",
      cause: "path.outside-workspace",
      record: true,
      interrupt: false,
    });
    expect(port.decisions[0].authoriser).toBe("user:deny");
  });

  it("hands the model a steer in the person's words", async () => {
    const outcome = await resolve(
      machine(approvals(), async () => ({ kind: "steer", message: "use /tmp" })),
      denial([OUTSIDE]),
    );
    expect(outcome).toMatchObject({
      outcome: "deny",
      reason: 'The person denied this and said: "use /tmp"',
      interrupt: false,
    });
  });

  it("stops the turn on a stop", async () => {
    const outcome = await resolve(
      machine(approvals(), async () => "stop"),
      denial([OUTSIDE]),
    );
    expect(outcome).toMatchObject({ outcome: "deny", interrupt: true, record: true });
  });

  it("explains a never-allowed refusal and asks nobody", async () => {
    const ask = vi.fn(async () => "allow" as RuntimeAskChoice);
    const port = approvals();
    const hard: PolicyViolation = {
      rule: "path.credentials",
      reason: "reads ~/.ssh",
      scopes: null,
    };
    const outcome = await resolve(machine(port, ask), denial([OUTSIDE, hard]));
    expect(ask).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ outcome: "deny", cause: "path.credentials", record: true });
    expect(outcome.outcome === "deny" && outcome.reason).toContain(
      "Never allowed: reading credentials",
    );
    expect(outcome.outcome === "deny" && outcome.reason).toContain("reads ~/.ssh");
    expect(port.decisions).toEqual([
      expect.objectContaining({
        authoriser: "rule:hard",
        summary: "Never allowed: reading credentials",
      }),
    ]);
  });

  it("never lets an approvable ledger hit carry a never-allowed rule through", async () => {
    const hard: PolicyViolation = { rule: "command.persistence", reason: "cron", scopes: null };
    const port = approvals(new Map([[WRITE.target, { approvalId: "row-1", summary: "x" }]]));
    const outcome = await resolve(machine(port), denial([OUTSIDE, hard]));
    expect(outcome).toMatchObject({ outcome: "deny", cause: "command.persistence" });
  });

  it("treats a refusal with no enumerated violations as unreadable and never asks", async () => {
    const ask = vi.fn(async () => "allow" as RuntimeAskChoice);
    const outcome = await resolve(machine(approvals(), ask), {
      outcome: "deny",
      cause: "call.unreadable",
      reason: "could not be read",
    });
    expect(ask).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ outcome: "deny", cause: "call.unreadable" });
  });

  it("does not ask about a refusal the Session's own walls repeat", async () => {
    const ask = vi.fn(async () => "allow" as RuntimeAskChoice);
    const port = approvals();
    const outcome = await resolve(machine(port, ask), denial([OUTSIDE], { walled: true }));
    expect(ask).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ outcome: "deny", reason: "outside the workspace" });
    expect(port.decisions[0].authoriser).toBe("rule:hard");
  });

  it("refuses when there is nobody to ask, rather than allowing silently", async () => {
    const port = approvals();
    const outcome = await resolve(machine(port), denial([OUTSIDE]));
    expect(outcome).toMatchObject({ outcome: "deny", record: true });
    expect(port.decisions[0].authoriser).toBe("user:deny");
  });

  it("keeps the refusal, recorded, when the host cannot obtain an answer", async () => {
    const outcome = await resolve(
      machine(approvals(), () => Promise.reject(new Error("no window"))),
      denial([OUTSIDE]),
    );
    expect(outcome).toMatchObject({ outcome: "deny", record: true, interrupt: false });
  });

  it("decides nothing when the question is abandoned", async () => {
    const controller = new AbortController();
    const port = approvals();
    const pending = resolve(
      machine(port, () => new Promise(() => undefined)),
      denial([OUTSIDE]),
      controller.signal,
    );
    controller.abort();
    expect(await pending).toMatchObject({ outcome: "deny", record: false });
    expect(port.decisions).toEqual([]);
  });

  it("falls back to the call's name when the host did not describe it", async () => {
    const ask = vi.fn(async () => "allow" as RuntimeAskChoice);
    await machine(approvals(), ask).resolve({
      verdict: denial([{ ...OUTSIDE, scopes: [commandScope("x")] }]),
      tool: "execute",
      toolCallId: "c",
      turnId: null,
    });
    const request = (ask.mock.calls[0] as unknown as [RuntimeAskRequest])[0];
    expect(request.approval?.asked).toBe("execute");
  });
});
