/**
 * The todo list a Session keeps, and the two things every reader of it needs
 * (VC-6).
 *
 * `todo_write` is the model's own checklist: each call replaces the whole list,
 * so a Session's plan is never assembled from increments and there is no such
 * thing as half a list. This module holds the vocabulary and nothing else — the
 * tool that writes it lives in `@volli/agent-runtime`, the latest-wins fold over
 * durable history lives in `@volli/session-engine`, and the Activity Island's
 * projection of it lives in `@volli/session-presentation`. All three read the
 * same shape from here rather than each re-deciding what a todo is.
 *
 * NOT called `plan`, and the collision is close enough to be worth naming:
 * `agent-plan.ts` is the dry-run preview of a WRITE, which shares no meaning
 * with a checklist. Codex renamed its own `update_plan` to `todo_write` for the
 * same reason (openai/codex#10124), and Claude Code calls its version
 * `TodoWrite`. The durable ACTIVITY KIND stays spelled `plan`
 * (`session-activity.ts`), because that name is already in shipped history and
 * churning it would buy nothing.
 */

/**
 * What a todo can be, and the whole vocabulary of it.
 *
 * Per item rather than a count of completed prefixes, because that is what
 * every comparable tool does and what the model will do whatever the schema
 * says: it finishes items out of order and it abandons them. `cancelled` is the
 * one that has no obvious drawing and is kept anyway — a dropped step that
 * silently vanished from the list would read as work that was done.
 */
export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

/** One line of the model's checklist. */
export interface TodoItem {
  /** The step, in the model's own words. */
  content: string;
  status: TodoStatus;
}

/** A whole list, as one `todo_write` call replaced it. */
export type SessionTodoList = readonly TodoItem[];

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (TODO_STATUSES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a `todo_write` call's arguments back as a list.
 *
 * Total over untrusted input, because both callers hand it something they did
 * not build: the runtime hands it a model's arguments, and the durable fold
 * hands it a normalized activity payload that a shipped build wrote and this
 * one only has to survive. Neither may throw and neither may invent.
 *
 * `null` and `[]` are kept apart on purpose. `null` is "this was not a todo
 * list"; `[]` is "the model cleared its list", which is a thing it did and a
 * thing the island must draw as an absent plan rather than as the old one.
 *
 * A row with no words is dropped rather than kept as a blank line, and a status
 * outside {@link TODO_STATUSES} becomes `pending` rather than losing the row —
 * a model inventing `blocked` still told us about a step it has not finished.
 */
export function parseTodoList(value: unknown): SessionTodoList | null {
  const todos = isRecord(value) ? value["todos"] : null;
  if (!Array.isArray(todos)) return null;
  const items: TodoItem[] = [];
  for (const row of todos) {
    if (!isRecord(row)) continue;
    const content = typeof row["content"] === "string" ? row["content"].trim() : "";
    if (content.length === 0) continue;
    const status = row["status"];
    items.push({ content, status: isTodoStatus(status) ? status : "pending" });
  }
  return items;
}

/** How many of a list are finished — the count the island's `n/n` pill prints. */
export function todoListCompleted(list: SessionTodoList): number {
  return list.filter((todo) => todo.status === "completed").length;
}

const TODO_MARKDOWN: Record<TodoStatus, { box: string; note: string }> = {
  pending: { box: " ", note: "" },
  in_progress: { box: " ", note: " (in progress)" },
  completed: { box: "x", note: "" },
  // `[~]` is not GitHub-flavoured anything; it renders as literal text, which is
  // the point — a cancelled row must not draw as an unfinished one, and the
  // parenthetical carries the meaning for a reader whose renderer shows a box.
  cancelled: { box: "~", note: " (cancelled)" },
};

/**
 * The list as a ticket comment shows it (VC-6).
 *
 * A GitHub task list, because the ticket record is Markdown and a person
 * scanning a closed ticket wants the shape of the work at a glance rather than
 * a JSON blob. Order is the model's own; nothing here sorts, because the order
 * a plan was written in is part of what it said.
 */
export function todoListMarkdown(list: SessionTodoList): string {
  return list
    .map((todo) => {
      const { box, note } = TODO_MARKDOWN[todo.status];
      return `- [${box}] ${todo.content}${note}`;
    })
    .join("\n");
}
