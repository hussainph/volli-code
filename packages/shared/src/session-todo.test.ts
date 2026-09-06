import { describe, expect, it } from "vite-plus/test";

import { parseTodoList, todoListCompleted, todoListMarkdown } from "./session-todo";

describe("parseTodoList", () => {
  it("reads the whole list a todo_write call carried", () => {
    expect(
      parseTodoList({
        todos: [
          { content: "Read the ticket", status: "completed" },
          { content: "Write the tool", status: "in_progress" },
          { content: "Wire the island", status: "pending" },
        ],
      }),
    ).toEqual([
      { content: "Read the ticket", status: "completed" },
      { content: "Write the tool", status: "in_progress" },
      { content: "Wire the island", status: "pending" },
    ]);
  });

  it("is null for anything that is not a list of todos, so absent never poses as empty", () => {
    expect(parseTodoList(null)).toBeNull();
    expect(parseTodoList({ todos: "later" })).toBeNull();
    expect(parseTodoList({ question: "which one?" })).toBeNull();
  });

  it("keeps an emptied list, because clearing the plan is something the model did", () => {
    expect(parseTodoList({ todos: [] })).toEqual([]);
  });

  it("drops a row with no words and defaults a status this build has no name for", () => {
    expect(
      parseTodoList({
        todos: [
          { content: "  ", status: "completed" },
          { content: "Ship it", status: "blocked" },
          { status: "pending" },
          "Ship it twice",
        ],
      }),
    ).toEqual([{ content: "Ship it", status: "pending" }]);
  });
});

describe("todoListCompleted", () => {
  it("counts the finished rows, which is what the island's n/n pill prints", () => {
    expect(
      todoListCompleted([
        { content: "Read the ticket", status: "completed" },
        { content: "Write the tool", status: "in_progress" },
        { content: "Wire the island", status: "pending" },
      ]),
    ).toBe(1);
  });

  it("does not count a dropped step as progress", () => {
    // Otherwise a model could reach 100% by cancelling the work it did not do.
    expect(
      todoListCompleted([
        { content: "Read the ticket", status: "completed" },
        { content: "Revive the dock", status: "cancelled" },
      ]),
    ).toBe(1);
  });

  it("is zero for a list the model cleared", () => {
    expect(todoListCompleted([])).toBe(0);
  });
});

describe("todoListMarkdown", () => {
  it("writes the checklist a ticket comment shows", () => {
    expect(
      todoListMarkdown([
        { content: "Read the ticket", status: "completed" },
        { content: "Write the tool", status: "in_progress" },
        { content: "Wire the island", status: "pending" },
        { content: "Revive the dock", status: "cancelled" },
      ]),
    ).toBe(
      [
        "- [x] Read the ticket",
        "- [ ] Write the tool (in progress)",
        "- [ ] Wire the island",
        "- [~] Revive the dock (cancelled)",
      ].join("\n"),
    );
  });
});
