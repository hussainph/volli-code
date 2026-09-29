import { describe, expect, it } from "vite-plus/test";
import { stressCopy, TEXT_BUDGETS, type PeekCopy } from "./session-peek-content";

const fixture: PeekCopy = {
  sessionTitle: "Fix CI retries",
  ticketTitle: "Flaky CI on Linux runners",
  lastActivity: "Reproduced the connection-reset failure in two CI jobs.",
  question: {
    prompts: [
      {
        id: "retry",
        label: "Should I retry the failing jobs?",
        detail: null,
        options: [{ id: "retry", label: "Retry", description: null }],
        multiple: false,
        custom: false,
      },
    ],
  },
};

describe("peek content stress fixtures", () => {
  it("preserves normal content and never changes answer options", () => {
    expect(stressCopy(fixture, "normal")).toBe(fixture);
    expect(stressCopy(fixture, "extreme").question?.prompts[0]?.options).toBe(
      fixture.question?.prompts[0]?.options,
    );
  });
  for (const mode of ["long", "extreme", "unbroken"] as const) {
    it(`generates exact ${mode} lengths`, () => {
      const copy = stressCopy(fixture, mode);
      const budget = TEXT_BUDGETS[mode];
      expect(copy.sessionTitle).toHaveLength(budget.session);
      expect(copy.ticketTitle).toHaveLength(budget.ticket);
      expect(copy.lastActivity).toHaveLength(budget.summary);
      expect(copy.question?.prompts[0]?.label).toHaveLength(budget.question);
      if (mode === "unbroken") expect(copy.lastActivity).not.toMatch(/\s/);
    });
  }
  it("does not invent a ticket or a question", () => {
    const copy = stressCopy({ ...fixture, ticketTitle: null, question: null }, "extreme");
    expect(copy.ticketTitle).toBeNull();
    expect(copy.question).toBeNull();
  });
});
