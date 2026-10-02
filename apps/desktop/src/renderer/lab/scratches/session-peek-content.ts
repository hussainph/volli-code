import type { SessionInteractionPrompt } from "@volli/shared";

/** Lab-only stress cases. Lengths are JS string lengths, matching the title budget. */
export type TextCase = "normal" | "long" | "extreme" | "unbroken";
export type SummaryState = "ready" | "loading" | "unavailable";

export interface PeekCopy {
  sessionTitle: string;
  ticketTitle: string | null;
  lastActivity: string;
  question: { prompts: readonly SessionInteractionPrompt[] } | null;
}

export const TEXT_BUDGETS = {
  long: { session: 96, ticket: 180, summary: 320, question: 280 },
  extreme: { session: 240, ticket: 500, summary: 1200, question: 640 },
  unbroken: { session: 256, ticket: 512, summary: 2048, question: 512 },
} as const;

function fill(text: string, length: number): string {
  return `${text} `.repeat(Math.ceil(length / (text.length + 1))).slice(0, length);
}

export function stressCopy<T extends PeekCopy>(fixture: T, mode: TextCase): T {
  if (mode === "normal") return fixture;
  const budget = TEXT_BUDGETS[mode];
  const value = (text: string, length: number) =>
    mode === "unbroken" ? "x".repeat(length) : fill(text, length);
  return {
    ...fixture,
    sessionTitle: value(fixture.sessionTitle, budget.session),
    ticketTitle: fixture.ticketTitle === null ? null : value(fixture.ticketTitle, budget.ticket),
    lastActivity: value(fixture.lastActivity, budget.summary),
    question:
      fixture.question === null
        ? null
        : {
            ...fixture.question,
            prompts: fixture.question.prompts.map((prompt) => ({
              ...prompt,
              label: value(prompt.label, budget.question),
            })),
          },
  };
}

/** Do not assume generated titles are the longest things a person can rename. */
export const CONTENT_LIMITS_NOTE =
  "Generated session titles use a 48-character budget before the ellipsis. No shared upper bound was established for manual session or ticket titles. Summary lengths here are stress fixtures, not a backend contract.";
