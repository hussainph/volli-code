import { describe, expect, test } from "vite-plus/test";

import { TICKET_EVENT_KINDS } from "../ticket-events";
import {
  BOARD_EVENT_KINDS,
  BOARD_EVENT_MIGRATED_KINDS,
  BOARD_EVENT_WRITE_KINDS,
  isBoardEventKind,
  isBoardEventWriteKind,
} from "./board-events";

describe("board event kinds", () => {
  test("keep every local ticket event kind except the path-bearing ones, which have replacements", () => {
    const retired = new Set(["worktree_changed", "worktree_scope_changed"]);
    for (const kind of TICKET_EVENT_KINDS) {
      if (retired.has(kind)) {
        expect(isBoardEventWriteKind(kind)).toBe(false);
      } else {
        expect(isBoardEventWriteKind(kind)).toBe(true);
      }
    }
    expect(isBoardEventWriteKind("working_copy_changed")).toBe(true);
    expect(isBoardEventWriteKind("checkout_mode_changed")).toBe(true);
  });

  test("migrated worktree_changed rows stay readable but are never written", () => {
    expect(BOARD_EVENT_MIGRATED_KINDS).toEqual(["worktree_changed"]);
    expect(isBoardEventKind("worktree_changed")).toBe(true);
    expect(isBoardEventWriteKind("worktree_changed")).toBe(false);
  });

  test("are unique, and readers drop what they do not know", () => {
    expect(new Set(BOARD_EVENT_KINDS).size).toBe(BOARD_EVENT_KINDS.length);
    expect(BOARD_EVENT_KINDS.length).toBe(BOARD_EVENT_WRITE_KINDS.length + 1);
    expect(isBoardEventKind("assigned")).toBe(true);
    expect(isBoardEventKind("teleported")).toBe(false);
    expect(isBoardEventKind(1)).toBe(false);
    expect(isBoardEventWriteKind(null)).toBe(false);
  });
});
