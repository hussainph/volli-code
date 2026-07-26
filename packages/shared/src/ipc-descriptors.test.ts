import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_THEME } from "./theme/definition";
import {
  DATA_CHANNELS,
  DATA_IPC,
  FILE_CHANNELS,
  FILE_IPC,
  THEME_CHANNELS,
  THEME_IPC,
} from "./ipc-descriptors";

describe("DATA_IPC descriptor table", () => {
  describe("volli:data-bootstrap (no-arg request)", () => {
    const { guard } = DATA_IPC["volli:data-bootstrap"];

    it("accepts an empty args tuple", () => {
      expect(guard([])).toBe(true);
    });

    it("rejects stray arguments", () => {
      expect(guard(["junk"])).toBe(false);
    });
  });

  describe("volli:legacy-import", () => {
    const { guard, invalidError } = DATA_IPC["volli:legacy-import"];
    const valid = { projects: [], appState: { "volli:ui": "{}" }, rawBackup: { "volli:ui": "{}" } };

    it("accepts a valid payload", () => {
      expect(guard([valid])).toBe(true);
    });

    it("accepts empty appState/rawBackup records", () => {
      expect(guard([{ projects: [], appState: {}, rawBackup: {} }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
      expect(guard(["nope"])).toBe(false);
    });

    it("rejects projects that isn't an array", () => {
      expect(guard([{ ...valid, projects: {} }])).toBe(false);
    });

    it("rejects appState that isn't a string record", () => {
      expect(guard([{ ...valid, appState: { a: 1 } }])).toBe(false);
      expect(guard([{ ...valid, appState: [] }])).toBe(false);
      expect(guard([{ ...valid, appState: null }])).toBe(false);
    });

    it("rejects rawBackup that isn't a string record", () => {
      expect(guard([{ ...valid, rawBackup: { a: 1 } }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
      expect(guard([valid, valid])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid legacy import payload");
    });
  });

  describe("volli:project-create", () => {
    const { guard, invalidError } = DATA_IPC["volli:project-create"];
    const valid = { path: "/repo", name: "Repo" };

    it("accepts a valid payload", () => {
      expect(guard([valid])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string path", () => {
      expect(guard([{ ...valid, path: 1 }])).toBe(false);
    });

    it("rejects a non-string name", () => {
      expect(guard([{ ...valid, name: 1 }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
      expect(guard([valid, valid])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid project");
    });
  });

  describe("volli:project-update", () => {
    const { guard, invalidError } = DATA_IPC["volli:project-update"];
    const valid = { id: "p1", baseBranch: "main" };

    it("accepts a valid payload with a branch name", () => {
      expect(guard([valid])).toBe(true);
    });

    it("accepts a null baseBranch", () => {
      expect(guard([{ id: "p1", baseBranch: null }])).toBe(true);
    });

    it("accepts an explicit undefined/null/string setupCommand", () => {
      expect(guard([{ ...valid, setupCommand: undefined }])).toBe(true);
      expect(guard([{ ...valid, setupCommand: null }])).toBe(true);
      expect(guard([{ ...valid, setupCommand: "pnpm install" }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string id", () => {
      expect(guard([{ ...valid, id: 1 }])).toBe(false);
    });

    it("rejects an invalid branch name string", () => {
      expect(guard([{ id: "p1", baseBranch: "-bad" }])).toBe(false);
    });

    it("rejects a baseBranch of the wrong type", () => {
      expect(guard([{ id: "p1", baseBranch: 1 }])).toBe(false);
    });

    it("rejects a setupCommand of the wrong type", () => {
      expect(guard([{ ...valid, setupCommand: 1 }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid project base branch");
    });
  });

  describe("volli:project-remove", () => {
    const { guard, invalidError } = DATA_IPC["volli:project-remove"];

    it("accepts a single string id", () => {
      expect(guard(["p1"])).toBe(true);
    });

    it("rejects a non-string id", () => {
      expect(guard([1])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
      expect(guard(["p1", "extra"])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid project id");
    });
  });

  describe("volli:project-reorder", () => {
    const { guard, invalidError } = DATA_IPC["volli:project-reorder"];

    it("accepts a string array", () => {
      expect(guard([["p1", "p2"]])).toBe(true);
    });

    it("accepts an empty array", () => {
      expect(guard([[]])).toBe(true);
    });

    it("rejects a non-array", () => {
      expect(guard(["p1"])).toBe(false);
    });

    it("rejects an array with a non-string entry", () => {
      expect(guard([["p1", 2]])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid project order");
    });
  });

  describe("volli:ticket-create", () => {
    const { guard, invalidError } = DATA_IPC["volli:ticket-create"];
    const valid = { projectId: "p1", title: "Do the thing", status: "todo" };

    it("accepts the minimal valid payload", () => {
      expect(guard([valid])).toBe(true);
    });

    it("accepts every optional field populated", () => {
      expect(
        guard([
          {
            ...valid,
            priority: "high",
            body: "details",
            labels: ["a", "b"],
            usesWorktree: false,
            preferredHarnessId: "codex",
          },
        ]),
      ).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string projectId", () => {
      expect(guard([{ ...valid, projectId: 1 }])).toBe(false);
    });

    it("rejects a non-string title", () => {
      expect(guard([{ ...valid, title: 1 }])).toBe(false);
    });

    it("rejects a blank (whitespace-only) title", () => {
      expect(guard([{ ...valid, title: "   " }])).toBe(false);
    });

    it("rejects a status outside the ticket vocabulary", () => {
      expect(guard([{ ...valid, status: "in-review" }])).toBe(false);
    });

    it("rejects a priority outside the vocabulary when present", () => {
      expect(guard([{ ...valid, priority: "urgent" }])).toBe(false);
    });

    it("rejects a non-string body when present", () => {
      expect(guard([{ ...valid, body: 1 }])).toBe(false);
    });

    it("rejects labels that isn't a string array when present", () => {
      expect(guard([{ ...valid, labels: [1] }])).toBe(false);
    });

    it("rejects a non-boolean usesWorktree when present", () => {
      expect(guard([{ ...valid, usesWorktree: "yes" }])).toBe(false);
    });

    it("rejects a harness id outside the vocabulary when present", () => {
      expect(guard([{ ...valid, preferredHarnessId: "cursor" }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid ticket");
    });
  });

  describe("volli:ticket-move (single object request)", () => {
    const { guard, invalidError } = DATA_IPC["volli:ticket-move"];
    const valid = { projectId: "p1", ticketId: "t1", toStatus: "doing", toIndex: 0 };

    it("accepts a valid move payload", () => {
      expect(guard([valid])).toBe(true);
    });

    it("rejects a status outside the ticket vocabulary", () => {
      expect(guard([{ ...valid, toStatus: "review" }])).toBe(false);
    });

    it("rejects a fractional index", () => {
      expect(guard([{ ...valid, toIndex: 1.5 }])).toBe(false);
    });

    it("rejects a missing ticket id", () => {
      const { ticketId: _ticketId, ...rest } = valid;
      expect(guard([rest])).toBe(false);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
      expect(guard(["t1"])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
      expect(guard([valid, valid])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid ticket move");
    });
  });

  describe("volli:ticket-set-priority", () => {
    const { guard, invalidError } = DATA_IPC["volli:ticket-set-priority"];

    it("accepts a valid payload", () => {
      expect(guard([{ ticketId: "t1", priority: "low" }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string ticketId", () => {
      expect(guard([{ ticketId: 1, priority: "low" }])).toBe(false);
    });

    it("rejects a priority outside the vocabulary", () => {
      expect(guard([{ ticketId: "t1", priority: "urgent" }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid priority change");
    });
  });

  describe("volli:ticket-update", () => {
    const { guard, invalidError } = DATA_IPC["volli:ticket-update"];

    it("accepts a bare ticketId (every optional field omitted)", () => {
      expect(guard([{ ticketId: "t1" }])).toBe(true);
    });

    it("accepts every optional field populated", () => {
      expect(
        guard([
          {
            ticketId: "t1",
            title: "New",
            body: "text",
            worktreePath: "/wt",
            branch: "b",
            baseBranch: "main",
          },
        ]),
      ).toBe(true);
    });

    it("accepts null worktree-identity fields (explicit clear)", () => {
      expect(guard([{ ticketId: "t1", worktreePath: null, branch: null, baseBranch: null }])).toBe(
        true,
      );
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string ticketId", () => {
      expect(guard([{ ticketId: 1 }])).toBe(false);
    });

    it("rejects a non-string title when present", () => {
      expect(guard([{ ticketId: "t1", title: 1 }])).toBe(false);
    });

    it("rejects a non-string body when present", () => {
      expect(guard([{ ticketId: "t1", body: 1 }])).toBe(false);
    });

    it("rejects a worktreePath of the wrong type", () => {
      expect(guard([{ ticketId: "t1", worktreePath: 1 }])).toBe(false);
    });

    it("rejects a branch of the wrong type", () => {
      expect(guard([{ ticketId: "t1", branch: 1 }])).toBe(false);
    });

    it("rejects a baseBranch of the wrong type", () => {
      expect(guard([{ ticketId: "t1", baseBranch: 1 }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid ticket update");
    });
  });

  describe("volli:ticket-set-labels", () => {
    const { guard, invalidError } = DATA_IPC["volli:ticket-set-labels"];

    it("accepts a valid payload", () => {
      expect(guard([{ ticketId: "t1", labels: ["a", "b"] }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string ticketId", () => {
      expect(guard([{ ticketId: 1, labels: [] }])).toBe(false);
    });

    it("rejects labels that isn't a string array", () => {
      expect(guard([{ ticketId: "t1", labels: [1] }])).toBe(false);
      expect(guard([{ ticketId: "t1", labels: "a" }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid labels");
    });
  });

  describe("the ticketId-input channels (archive/unarchive/delete/events)", () => {
    const cases = [
      ["volli:ticket-archive", "Invalid ticket"],
      ["volli:ticket-unarchive", "Invalid ticket"],
      ["volli:ticket-delete", "Invalid ticket"],
      ["volli:ticket-events", "Invalid ticket"],
    ] as const;

    for (const [channel, expectedError] of cases) {
      describe(channel, () => {
        const { guard, invalidError } = DATA_IPC[channel];

        it("accepts a valid { ticketId } payload", () => {
          expect(guard([{ ticketId: "t1" }])).toBe(true);
        });

        it("rejects a non-object payload", () => {
          expect(guard([null])).toBe(false);
        });

        it("rejects a non-string ticketId", () => {
          expect(guard([{ ticketId: 1 }])).toBe(false);
        });

        it("rejects a wrong arity", () => {
          expect(guard([])).toBe(false);
          expect(guard([{ ticketId: "t1" }, {}])).toBe(false);
        });

        it("carries the handler's exact invalid-input message", () => {
          expect(invalidError).toBe(expectedError);
        });
      });
    }
  });

  describe("volli:ticket-list-archived", () => {
    const { guard, invalidError } = DATA_IPC["volli:ticket-list-archived"];

    it("accepts a single string projectId", () => {
      expect(guard(["p1"])).toBe(true);
    });

    it("rejects a non-string projectId", () => {
      expect(guard([1])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
      expect(guard(["p1", "extra"])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid project id");
    });
  });

  describe("volli:ticket-latest-signals", () => {
    const { guard, invalidError } = DATA_IPC["volli:ticket-latest-signals"];

    it("accepts a valid { projectId } payload", () => {
      expect(guard([{ projectId: "p1" }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string projectId", () => {
      expect(guard([{ projectId: 1 }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid project");
    });
  });

  describe("volli:comment-list", () => {
    const { guard, invalidError } = DATA_IPC["volli:comment-list"];

    it("accepts a valid { ticketId } payload", () => {
      expect(guard([{ ticketId: "t1" }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid ticket");
    });
  });

  describe("volli:comment-create", () => {
    const { guard, invalidError } = DATA_IPC["volli:comment-create"];
    const valid = { ticketId: "t1", body: "hello" };

    it("accepts a valid payload without sessionId", () => {
      expect(guard([valid])).toBe(true);
    });

    it("accepts a null or string sessionId", () => {
      expect(guard([{ ...valid, sessionId: null }])).toBe(true);
      expect(guard([{ ...valid, sessionId: "s1" }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string ticketId", () => {
      expect(guard([{ ...valid, ticketId: 1 }])).toBe(false);
    });

    it("rejects a non-string body", () => {
      expect(guard([{ ...valid, body: 1 }])).toBe(false);
    });

    it("rejects a blank body", () => {
      expect(guard([{ ...valid, body: "   " }])).toBe(false);
    });

    it("rejects a sessionId of the wrong type", () => {
      expect(guard([{ ...valid, sessionId: 1 }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid comment");
    });
  });

  describe("volli:comment-update", () => {
    const { guard, invalidError } = DATA_IPC["volli:comment-update"];

    it("accepts a valid payload", () => {
      expect(guard([{ commentId: "c1", body: "edited" }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string commentId", () => {
      expect(guard([{ commentId: 1, body: "edited" }])).toBe(false);
    });

    it("rejects a non-string body", () => {
      expect(guard([{ commentId: "c1", body: 1 }])).toBe(false);
    });

    it("rejects a blank body", () => {
      expect(guard([{ commentId: "c1", body: " " }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid comment update");
    });
  });

  describe("volli:comment-remove", () => {
    const { guard, invalidError } = DATA_IPC["volli:comment-remove"];

    it("accepts a valid { commentId } payload", () => {
      expect(guard([{ commentId: "c1" }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string commentId", () => {
      expect(guard([{ commentId: 1 }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid comment");
    });
  });

  describe("volli:session-list", () => {
    const { guard, invalidError } = DATA_IPC["volli:session-list"];

    it("accepts a valid { projectId } payload", () => {
      expect(guard([{ projectId: "p1" }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string projectId", () => {
      expect(guard([{ projectId: 1 }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid project");
    });
  });

  describe("volli:session-list-for-ticket", () => {
    const { guard, invalidError } = DATA_IPC["volli:session-list-for-ticket"];

    it("accepts a valid { ticketId } payload", () => {
      expect(guard([{ ticketId: "t1" }])).toBe(true);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid ticket");
    });
  });

  describe("volli:session-rename", () => {
    const { guard, invalidError } = DATA_IPC["volli:session-rename"];

    it("accepts a valid payload", () => {
      expect(guard([{ sessionId: "s1", title: "New title" }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string sessionId", () => {
      expect(guard([{ sessionId: 1, title: "New title" }])).toBe(false);
    });

    it("rejects a non-string title", () => {
      expect(guard([{ sessionId: "s1", title: 1 }])).toBe(false);
    });

    it("rejects a blank (whitespace-only) title", () => {
      expect(guard([{ sessionId: "s1", title: "   " }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid session title");
    });
  });

  describe("volli:label-set-color", () => {
    const { guard, invalidError } = DATA_IPC["volli:label-set-color"];

    it("accepts a valid payload with a string color", () => {
      expect(guard([{ labelId: "l1", color: "#fff" }])).toBe(true);
    });

    it("accepts a null color", () => {
      expect(guard([{ labelId: "l1", color: null }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string labelId", () => {
      expect(guard([{ labelId: 1, color: null }])).toBe(false);
    });

    it("rejects a color of the wrong type", () => {
      expect(guard([{ labelId: "l1", color: 1 }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid label color");
    });
  });

  describe("volli:app-state-set (positional string pair)", () => {
    const { guard, invalidError } = DATA_IPC["volli:app-state-set"];

    it("accepts a [key, value] string pair", () => {
      expect(guard(["volli:ui", "{}"])).toBe(true);
    });

    it("rejects a non-string member", () => {
      expect(guard(["volli:ui", 42])).toBe(false);
      expect(guard([42, "{}"])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard(["volli:ui"])).toBe(false);
      expect(guard(["volli:ui", "{}", "extra"])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid app state");
    });
  });

  describe("volli:worktree-remove", () => {
    const { guard, invalidError } = DATA_IPC["volli:worktree-remove"];

    it("accepts a valid payload", () => {
      expect(guard([{ ticketId: "t1", force: true }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string ticketId", () => {
      expect(guard([{ ticketId: 1, force: true }])).toBe(false);
    });

    it("rejects a non-boolean force", () => {
      expect(guard([{ ticketId: "t1", force: "yes" }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid worktree removal");
    });
  });

  describe("volli:worktree-branches", () => {
    const { guard, invalidError } = DATA_IPC["volli:worktree-branches"];

    it("accepts a valid { projectId } payload", () => {
      expect(guard([{ projectId: "p1" }])).toBe(true);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid project");
    });
  });

  describe("volli:worktree-orphans (optional opts — no-arg AND object-arg both valid on the wire)", () => {
    const { guard, invalidError } = DATA_IPC["volli:worktree-orphans"];

    it("accepts no argument at all", () => {
      expect(guard([])).toBe(true);
    });

    it("accepts an empty object (the preload's `opts ?? {}` default)", () => {
      expect(guard([{}])).toBe(true);
    });

    it("accepts an explicit boolean rescan", () => {
      expect(guard([{ rescan: true }])).toBe(true);
      expect(guard([{ rescan: false }])).toBe(true);
    });

    it("rejects a non-object first argument", () => {
      expect(guard(["nope"])).toBe(false);
      expect(guard([null])).toBe(false);
    });

    it("rejects a present-but-non-boolean rescan", () => {
      expect(guard([{ rescan: "yes" }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([{}, {}])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid request");
    });
  });

  describe("volli:worktree-orphan-delete", () => {
    const { guard, invalidError } = DATA_IPC["volli:worktree-orphan-delete"];

    it("accepts a valid { path } payload", () => {
      expect(guard([{ path: "/worktrees/foo" }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string path", () => {
      expect(guard([{ path: 1 }])).toBe(false);
    });

    it("rejects an empty path", () => {
      expect(guard([{ path: "" }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid orphan path");
    });
  });

  describe("volli:worktree-status", () => {
    const { guard, invalidError } = DATA_IPC["volli:worktree-status"];

    it("accepts a valid { ticketId } payload", () => {
      expect(guard([{ ticketId: "t1" }])).toBe(true);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid ticket");
    });
  });

  describe("volli:worktree-diff", () => {
    const { guard, invalidError } = DATA_IPC["volli:worktree-diff"];

    it("accepts the working-tree mode", () => {
      expect(guard([{ ticketId: "t1", mode: "working-tree" }])).toBe(true);
    });

    it("accepts the merge-base mode", () => {
      expect(guard([{ ticketId: "t1", mode: "merge-base" }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string ticketId", () => {
      expect(guard([{ ticketId: 1, mode: "working-tree" }])).toBe(false);
    });

    it("rejects a mode outside the two-mode vocabulary", () => {
      expect(guard([{ ticketId: "t1", mode: "full" }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid worktree diff request");
    });
  });

  describe("volli:worktree-change-set / volli:worktree-change-watch / volli:worktree-change-unwatch", () => {
    const channels = [
      "volli:worktree-change-set",
      "volli:worktree-change-watch",
      "volli:worktree-change-unwatch",
    ] as const;

    for (const channel of channels) {
      describe(channel, () => {
        const { guard, invalidError } = DATA_IPC[channel];

        it("accepts a valid { ticketId } payload", () => {
          expect(guard([{ ticketId: "t1" }])).toBe(true);
        });

        it("rejects a non-object payload", () => {
          expect(guard([null])).toBe(false);
        });

        it("rejects a wrong arity", () => {
          expect(guard([])).toBe(false);
        });

        it("carries the handler's exact invalid-input message", () => {
          expect(invalidError).toBe("Invalid ticket");
        });
      });
    }
  });

  describe("volli:worktree-base-read", () => {
    const { guard, invalidError } = DATA_IPC["volli:worktree-base-read"];

    it("accepts a valid { ticketId, path } payload", () => {
      expect(guard([{ ticketId: "t1", path: "src/a.ts" }])).toBe(true);
    });

    it("rejects a missing path", () => {
      expect(guard([{ ticketId: "t1" }])).toBe(false);
    });

    it("rejects a non-string path", () => {
      expect(guard([{ ticketId: "t1", path: 1 }])).toBe(false);
    });

    it("accepts a pinned baseRevision, present or absent", () => {
      expect(guard([{ ticketId: "t1", path: "src/a.ts", baseRevision: "abc123" }])).toBe(true);
      expect(guard([{ ticketId: "t1", path: "src/a.ts", baseRevision: undefined }])).toBe(true);
    });

    it("rejects a non-string baseRevision", () => {
      expect(guard([{ ticketId: "t1", path: "src/a.ts", baseRevision: 1 }])).toBe(false);
      expect(guard([{ ticketId: "t1", path: "src/a.ts", baseRevision: null }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid worktree base read request");
    });
  });

  describe("the ticketId-input worktree/retention channels (commit/push-pr/retention-state/dismiss/archive-clean)", () => {
    const cases = [
      ["volli:worktree-commit", "Invalid ticket"],
      ["volli:worktree-push-pr", "Invalid ticket"],
      ["volli:retention-state", "Invalid ticket"],
      ["volli:retention-dismiss", "Invalid ticket"],
      ["volli:retention-archive-clean", "Invalid ticket"],
    ] as const;

    for (const [channel, expectedError] of cases) {
      describe(channel, () => {
        const { guard, invalidError } = DATA_IPC[channel];

        it("accepts a valid { ticketId } payload", () => {
          expect(guard([{ ticketId: "t1" }])).toBe(true);
        });

        it("rejects a non-object payload", () => {
          expect(guard([null])).toBe(false);
        });

        it("rejects a non-string ticketId", () => {
          expect(guard([{ ticketId: 1 }])).toBe(false);
        });

        it("rejects a wrong arity", () => {
          expect(guard([])).toBe(false);
        });

        it("carries the handler's exact invalid-input message", () => {
          expect(invalidError).toBe(expectedError);
        });
      });
    }
  });

  describe("volli:retention-keep", () => {
    const { guard, invalidError } = DATA_IPC["volli:retention-keep"];

    it("accepts a valid payload", () => {
      expect(guard([{ ticketId: "t1", keep: true }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string ticketId", () => {
      expect(guard([{ ticketId: 1, keep: true }])).toBe(false);
    });

    it("rejects a non-boolean keep", () => {
      expect(guard([{ ticketId: "t1", keep: "yes" }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid keep request");
    });
  });

  describe("volli:retention-ttl-get (no-arg request)", () => {
    const { guard, invalidError } = DATA_IPC["volli:retention-ttl-get"];

    it("accepts an empty args tuple", () => {
      expect(guard([])).toBe(true);
    });

    it("rejects stray arguments", () => {
      expect(guard(["junk"])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid request");
    });
  });

  describe("volli:retention-ttl-set", () => {
    const { guard, invalidError } = DATA_IPC["volli:retention-ttl-set"];

    it("accepts a valid { days } payload", () => {
      expect(guard([{ days: 14 }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-number days", () => {
      expect(guard([{ days: "lots" }])).toBe(false);
    });

    it("rejects a non-finite days", () => {
      expect(guard([{ days: Infinity }])).toBe(false);
      expect(guard([{ days: NaN }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid TTL");
    });
  });

  describe("volli:retention-poll (no-arg request)", () => {
    const { guard, invalidError } = DATA_IPC["volli:retention-poll"];

    it("accepts an empty args tuple", () => {
      expect(guard([])).toBe(true);
    });

    it("rejects stray arguments", () => {
      expect(guard(["junk"])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid request");
    });
  });

  describe("DATA_CHANNELS derivation", () => {
    it("is exactly the descriptor table's key set — membership cannot be forgotten", () => {
      expect(DATA_CHANNELS).toEqual(Object.keys(DATA_IPC));
    });

    it("covers all 45 data channels", () => {
      expect(DATA_CHANNELS).toHaveLength(45);
      expect(DATA_CHANNELS).toContain("volli:data-bootstrap");
      expect(DATA_CHANNELS).toContain("volli:ticket-move");
      expect(DATA_CHANNELS).toContain("volli:app-state-set");
      expect(DATA_CHANNELS).toContain("volli:retention-poll");
      expect(DATA_CHANNELS).toContain("volli:worktree-change-set");
      expect(DATA_CHANNELS).toContain("volli:worktree-base-read");
      expect(DATA_CHANNELS).toContain("volli:worktree-change-watch");
      expect(DATA_CHANNELS).toContain("volli:worktree-change-unwatch");
    });
  });
});

describe("FILE_IPC descriptor table", () => {
  describe("volli:file-index", () => {
    const { guard, invalidError } = FILE_IPC["volli:file-index"];

    it("accepts a valid { projectId } payload", () => {
      expect(guard([{ projectId: "p1" }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string projectId", () => {
      expect(guard([{ projectId: 1 }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid request");
    });
  });

  describe("volli:file-read / volli:file-reveal / volli:file-watch / volli:file-unwatch (shared FilePathInput shape)", () => {
    const channels = [
      "volli:file-read",
      "volli:file-reveal",
      "volli:file-watch",
      "volli:file-unwatch",
    ] as const;

    for (const channel of channels) {
      describe(channel, () => {
        const { guard, invalidError } = FILE_IPC[channel];
        const valid = { projectId: "p1", relPath: "README.md" };

        it("accepts a valid payload without ticketId", () => {
          expect(guard([valid])).toBe(true);
        });

        it("accepts a valid payload with a ticketId", () => {
          expect(guard([{ ...valid, ticketId: "t1" }])).toBe(true);
        });

        it("rejects a non-object payload", () => {
          expect(guard([null])).toBe(false);
        });

        it("rejects a non-string projectId", () => {
          expect(guard([{ ...valid, projectId: 1 }])).toBe(false);
        });

        it("rejects a non-string relPath", () => {
          expect(guard([{ ...valid, relPath: 1 }])).toBe(false);
        });

        it("rejects a ticketId of the wrong type", () => {
          expect(guard([{ ...valid, ticketId: 1 }])).toBe(false);
        });

        it("rejects a wrong arity", () => {
          expect(guard([])).toBe(false);
        });

        it("carries the handler's exact invalid-input message", () => {
          expect(invalidError).toBe("Invalid request");
        });
      });
    }
  });

  describe("volli:dir-watch / volli:dir-unwatch (shared DirPathInput shape)", () => {
    const channels = ["volli:dir-watch", "volli:dir-unwatch"] as const;

    for (const channel of channels) {
      describe(channel, () => {
        const { guard, invalidError } = FILE_IPC[channel];
        const valid = { projectId: "p1", relPath: "src" };

        it("accepts a valid payload", () => {
          expect(guard([valid])).toBe(true);
        });

        it("accepts the empty relPath (the project root)", () => {
          expect(guard([{ ...valid, relPath: "" }])).toBe(true);
        });

        it("rejects a non-object payload", () => {
          expect(guard([null])).toBe(false);
        });

        it("rejects a non-string projectId", () => {
          expect(guard([{ ...valid, projectId: 1 }])).toBe(false);
        });

        it("rejects a missing relPath (main must be told which directory)", () => {
          expect(guard([{ projectId: "p1" }])).toBe(false);
        });

        it("rejects a wrong arity", () => {
          expect(guard([])).toBe(false);
        });

        it("carries the handler's exact invalid-input message", () => {
          expect(invalidError).toBe("Invalid request");
        });
      });
    }
  });

  describe("volli:file-write", () => {
    const { guard, invalidError } = FILE_IPC["volli:file-write"];
    const valid = { projectId: "p1", relPath: "notes.md", content: "# hi" };

    it("accepts a valid payload without expectedMtime", () => {
      expect(guard([valid])).toBe(true);
    });

    it("accepts a valid payload with expectedMtime", () => {
      expect(guard([{ ...valid, expectedMtime: 12345 }])).toBe(true);
    });

    it("rejects an invalid base FilePathInput shape", () => {
      expect(guard([{ relPath: "notes.md", content: "# hi" }])).toBe(false);
    });

    it("rejects a non-string content", () => {
      expect(guard([{ ...valid, content: 1 }])).toBe(false);
    });

    it("rejects an expectedMtime of the wrong type", () => {
      expect(guard([{ ...valid, expectedMtime: "now" }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid request");
    });
  });

  describe("volli:artifact-create", () => {
    const { guard, invalidError } = FILE_IPC["volli:artifact-create"];

    it("accepts a valid payload", () => {
      expect(guard([{ projectId: "p1", name: "notes" }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string projectId", () => {
      expect(guard([{ projectId: 1, name: "notes" }])).toBe(false);
    });

    it("rejects a non-string name", () => {
      expect(guard([{ projectId: "p1", name: 1 }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid request");
    });
  });

  describe("FILE_CHANNELS derivation", () => {
    it("is exactly the descriptor table's key set — membership cannot be forgotten", () => {
      expect(FILE_CHANNELS).toEqual(Object.keys(FILE_IPC));
    });

    it("covers all 9 file channels", () => {
      expect(FILE_CHANNELS).toHaveLength(9);
      expect(FILE_CHANNELS).toContain("volli:file-index");
      expect(FILE_CHANNELS).toContain("volli:file-unwatch");
      expect(FILE_CHANNELS).toContain("volli:dir-watch");
      expect(FILE_CHANNELS).toContain("volli:dir-unwatch");
    });
  });
});

describe("THEME_IPC descriptor table", () => {
  const theme = DEFAULT_THEME;

  describe("volli:theme-state", () => {
    const { guard, invalidError } = THEME_IPC["volli:theme-state"];

    it("accepts a global request and a project-scoped one", () => {
      expect(guard([{}])).toBe(true);
      expect(guard([{ projectId: "p1" }])).toBe(true);
    });

    it("rejects a non-string projectId or a missing payload", () => {
      expect(guard([{ projectId: 7 }])).toBe(false);
      expect(guard([])).toBe(false);
      expect(guard([null])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid theme request");
    });
  });

  describe("volli:theme-set-global", () => {
    const { guard, invalidError } = THEME_IPC["volli:theme-set-global"];

    it("accepts a well-formed authored definition", () => {
      expect(guard([{ theme }])).toBe(true);
    });

    it("rejects a definition with a bad canvas, seed, or appearance", () => {
      expect(guard([{ theme: { ...theme, canvas: { kind: "hologram" } } }])).toBe(false);
      expect(guard([{ theme: { ...theme, seed: 42 } }])).toBe(false);
      expect(guard([{ theme: { ...theme, appearance: "sepia" } }])).toBe(false);
    });

    // The resolved token set is derived, never sent or stored — but an
    // authored SPARSE override map is legitimate intent (#71), so the guard
    // must accept the latter while the repo layer strips the former.
    it("accepts a sparse authored override map and rejects a non-token key", () => {
      expect(guard([{ theme: { ...theme, overrides: { "--border-strong": "#4a3227" } } }])).toBe(
        true,
      );
      expect(guard([{ theme: { ...theme, overrides: { "--not-a-token": "#000" } } }])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid theme");
    });
  });

  describe("volli:theme-set-global-editor", () => {
    const { guard, invalidError } = THEME_IPC["volli:theme-set-global-editor"];

    it("accepts an authored catalog id or null to derive from the app theme", () => {
      expect(guard([{ editorThemeId: "nord" }])).toBe(true);
      expect(guard([{ editorThemeId: null }])).toBe(true);
    });

    it("rejects a missing or non-nullable-string editorThemeId", () => {
      expect(guard([{}])).toBe(false);
      expect(guard([{ editorThemeId: 7 }])).toBe(false);
      expect(guard([])).toBe(false);
    });

    it("rejects a non-catalog string id", () => {
      expect(guard([{ editorThemeId: "volli-dark" }])).toBe(false);
      expect(guard([{ editorThemeId: "not-a-theme" }])).toBe(false);
      expect(guard([{ editorThemeId: "" }])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid editor theme");
    });
  });

  describe("volli:theme-set-project", () => {
    const { guard, invalidError } = THEME_IPC["volli:theme-set-project"];
    const override = {
      appThemeSlug: null,
      terminalThemeName: "Nord",
      editorThemeId: null,
      seed: null,
    };

    it("accepts a per-surface override and a null (clear-to-inherit)", () => {
      expect(guard([{ projectId: "p1", override }])).toBe(true);
      expect(guard([{ projectId: "p1", override: null }])).toBe(true);
    });

    it("rejects a partial override shape or a missing project", () => {
      expect(guard([{ projectId: "p1", override: { appThemeSlug: "x" } }])).toBe(false);
      expect(guard([{ override }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
      expect(guard([{ projectId: "p1", override }, "stray"])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid project theme override");
    });
  });

  describe("volli:theme-terminal-overlay-write", () => {
    const { guard, invalidError } = THEME_IPC["volli:theme-terminal-overlay-write"];

    it("accepts a global scope and a project scope", () => {
      expect(guard([{ scope: "global", edits: { theme: "Nord" } }])).toBe(true);
      expect(guard([{ scope: "project", projectId: "p1", edits: { theme: null } }])).toBe(true);
    });

    it("requires a projectId for a project-scoped write", () => {
      expect(guard([{ scope: "project", edits: { theme: "Nord" } }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
      expect(guard([{ scope: "global", edits: {} }, "stray"])).toBe(false);
    });

    it("rejects an unknown scope or a non-string/null edit value", () => {
      expect(guard([{ scope: "everything", edits: {} }])).toBe(false);
      expect(guard([{ scope: "global", edits: { "font-size": 15 } }])).toBe(false);
      expect(guard([{ scope: "global" }])).toBe(false);
    });

    // Defense in depth with applyOverlayEdits, which throws on the same
    // shapes: one edit may never become two ghostty directives, and `command`
    // sets the program the terminal runs.
    it("rejects an edit that would inject a second ghostty directive", () => {
      expect(
        guard([{ scope: "global", edits: { theme: "Nord\ncommand = /bin/sh -c 'echo pwned'" } }]),
      ).toBe(false);
      expect(guard([{ scope: "global", edits: { theme: "Nord\rcommand = x" } }])).toBe(false);
      expect(guard([{ scope: "global", edits: { "a\nb": "x" } }])).toBe(false);
      expect(guard([{ scope: "project", projectId: "p1", edits: { "a\nb": null } }])).toBe(false);
      expect(guard([{ scope: "global", edits: { "theme=x": "Nord" } }])).toBe(false);
      expect(guard([{ scope: "global", edits: { "#theme": "Nord" } }])).toBe(false);
    });

    it("still accepts a value whose spaces, `#` or `=` are literal", () => {
      expect(guard([{ scope: "global", edits: { "font-family": " Berkeley Mono " } }])).toBe(true);
      expect(guard([{ scope: "global", edits: { "window-title": "a = b # c" } }])).toBe(true);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid terminal overlay write");
    });
  });

  describe("the custom-theme-file channels", () => {
    // The renderer names a SLUG, never a path — and the slug rule is imported
    // from the path builder, not restated, so this boundary cannot drift from
    // the directory it protects.
    const slugChannels = [
      "volli:theme-file-read",
      "volli:theme-file-delete",
      "volli:theme-file-reveal",
      "volli:theme-file-open",
    ] as const;

    it("accepts a slug a theme file could actually be named for", () => {
      for (const channel of slugChannels) {
        expect(THEME_IPC[channel].guard([{ slug: "tokyo-night" }])).toBe(true);
      }
    });

    it("refuses any slug that could escape the themes directory", () => {
      for (const channel of slugChannels) {
        const { guard, invalidError } = THEME_IPC[channel];
        for (const slug of ["", "..", "../evil", "/etc/passwd", "..\\evil", "a/b", "Ember"]) {
          expect(guard([{ slug }])).toBe(false);
        }
        expect(guard([{ slug: 7 }])).toBe(false);
        expect(guard([])).toBe(false);
        expect(guard([{ slug: "ember" }, "stray"])).toBe(false);
        expect(invalidError).toBe("Invalid theme slug");
      }
    });

    it("takes no arguments to list the catalog", () => {
      const { guard, invalidError } = THEME_IPC["volli:theme-file-list"];

      expect(guard([])).toBe(true);
      expect(guard([{}])).toBe(false);
      expect(invalidError).toBe("Invalid theme request");
    });

    it("requires a whole authored theme to write one", () => {
      const { guard, invalidError } = THEME_IPC["volli:theme-file-write"];

      expect(guard([{ theme: DEFAULT_THEME }])).toBe(true);
      expect(guard([{ theme: { name: "X" } }])).toBe(false);
      expect(guard([])).toBe(false);
      expect(invalidError).toBe("Invalid theme");
    });
  });

  describe("THEME_CHANNELS derivation", () => {
    it("derives from the descriptor table's keys", () => {
      expect(THEME_CHANNELS).toEqual(Object.keys(THEME_IPC));
    });

    it("covers the whole theme surface", () => {
      expect(THEME_CHANNELS).toHaveLength(11);
      expect(THEME_CHANNELS).toContain("volli:theme-state");
      expect(THEME_CHANNELS).toContain("volli:theme-set-global-editor");
      expect(THEME_CHANNELS).toContain("volli:theme-terminal-overlay-write");
      expect(THEME_CHANNELS).toContain("volli:theme-file-list");
      expect(THEME_CHANNELS).toContain("volli:theme-file-open");
    });
  });
});
