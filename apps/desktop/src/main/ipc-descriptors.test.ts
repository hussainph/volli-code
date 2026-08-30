import { describe, expect, it } from "vite-plus/test";
import {
  AUTOMATION_CHANNELS,
  AUTOMATION_IPC,
  DATA_CHANNELS,
  DATA_IPC,
  FILE_CHANNELS,
  FILE_IPC,
  HARNESS_CHANNELS,
  HARNESS_IPC,
  CLI_IPC,
  MODEL_ACCESS_CHANNELS,
  MODEL_ACCESS_IPC,
  THEME_CHANNELS,
  THEME_IPC,
  UPDATE_CHANNELS,
  UPDATE_IPC,
  AGENT_OBSERVABILITY_CHANNELS,
  AGENT_OBSERVABILITY_IPC,
  WEB_ACCESS_CHANNELS,
  WEB_ACCESS_IPC,
} from "./ipc-descriptors";

describe("UPDATE_IPC descriptor table", () => {
  /**
   * The release-channel WRITE is the one update request that carries caller
   * data (VC-111). Everything else on this surface is argument-less — the
   * state is main's to own — so the loop below still holds for the rest.
   */
  const CHANNELS_WITH_ARGS = new Set<string>(["volli:update-channel-set"]);

  for (const channel of UPDATE_CHANNELS.filter((c) => !CHANNELS_WITH_ARGS.has(c))) {
    describe(`${channel} (no-arg request)`, () => {
      const { guard, invalidError } = UPDATE_IPC[channel];

      it("accepts an empty args tuple", () => {
        expect(guard([])).toBe(true);
      });

      it("rejects stray arguments", () => {
        expect(guard(["junk"])).toBe(false);
        expect(guard([{}])).toBe(false);
      });

      it("carries the handler's exact invalid-input message", () => {
        expect(invalidError).toBe("Invalid request");
      });
    });
  }

  describe("UPDATE_CHANNELS derivation", () => {
    it("derives from the descriptor table's keys", () => {
      expect(UPDATE_CHANNELS).toEqual(Object.keys(UPDATE_IPC));
    });

    it("covers the whole self-update surface", () => {
      expect(UPDATE_CHANNELS).toEqual([
        "volli:update-state-get",
        "volli:update-check",
        "volli:update-install",
        "volli:update-live-work",
        "volli:update-channel-get",
        "volli:update-channel-set",
      ]);
    });
  });

  describe("volli:update-channel-set", () => {
    const { guard, invalidError } = UPDATE_IPC["volli:update-channel-set"];

    it("accepts exactly the two release lines", () => {
      expect(guard(["stable"])).toBe(true);
      expect(guard(["canary"])).toBe(true);
    });

    it("rejects any other line, and a missing one", () => {
      expect(guard(["nightly"])).toBe(false);
      expect(guard([])).toBe(false);
      expect(guard([{ channel: "canary" }])).toBe(false);
    });

    it("names the release channel in its refusal", () => {
      expect(invalidError).toBe("Invalid release channel");
    });
  });
});

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

  describe("volli:database", () => {
    const { guard, invalidError } = DATA_IPC["volli:database"];

    it("accepts a size read with no renderer-supplied path", () => {
      expect(guard([])).toBe(true);
    });

    it("accepts only the main-owned reveal and export actions", () => {
      expect(guard(["reveal"])).toBe(true);
      expect(guard(["export"])).toBe(true);
    });

    it("rejects renderer paths, an unknown action, and a wrong arity", () => {
      expect(guard(["/Users/me/anything"])).toBe(false);
      expect(guard([{ path: "/Users/me/anything" }])).toBe(false);
      expect(guard(["delete"])).toBe(false);
      expect(guard(["reveal", "extra"])).toBe(false);
    });

    it("names the database request in its refusal", () => {
      expect(invalidError).toBe("Invalid database request");
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

  describe("volli:project-skill-modes", () => {
    const { guard } = DATA_IPC["volli:project-skill-modes"];

    it("accepts an empty map — the shape that clears every rule", () => {
      expect(guard([{ id: "p1", modes: {} }])).toBe(true);
    });

    it("accepts the two storable modes", () => {
      expect(guard([{ id: "p1", modes: { tdd: "manual", mintlify: "off" } }])).toBe(true);
    });

    it("rejects a mode outside the vocabulary", () => {
      expect(guard([{ id: "p1", modes: { tdd: "sideways" } }])).toBe(false);
      // `auto` is the absence of a rule, so it is never on the wire.
      expect(guard([{ id: "p1", modes: { tdd: "auto" } }])).toBe(false);
    });

    it("rejects a slug the `/name` grammar cannot spell", () => {
      expect(guard([{ id: "p1", modes: { "not a slug": "off" } }])).toBe(false);
    });

    it("rejects a missing id, non-object map, or wrong arity", () => {
      expect(guard([{ modes: {} }])).toBe(false);
      expect(guard([{ id: "p1", modes: null }])).toBe(false);
      expect(guard([{ id: "p1", modes: ["tdd"] }])).toBe(false);
      expect(guard([])).toBe(false);
    });
  });

  describe("volli:project-authority-policy", () => {
    const { guard } = DATA_IPC["volli:project-authority-policy"];

    it("accepts a departure document and the null that clears every departure", () => {
      expect(guard([{ id: "p1", override: { enforcement: "enforce" } }])).toBe(true);
      expect(guard([{ id: "p1", override: {} }])).toBe(true);
      expect(guard([{ id: "p1", override: null }])).toBe(true);
    });

    it("admits a document it cannot vouch for, leaving the judgment to the handler", () => {
      // SHAPE ONLY, on purpose. A guard can only refuse, and a refused policy
      // write has to come back naming the field that was wrong —
      // `validateAuthorityPolicyOverride` does that in the handler. A second
      // structural check here would be a second validator to keep in agreement
      // with the first, which is how the two drift apart.
      expect(guard([{ id: "p1", override: { enforcement: "sideways" } }])).toBe(true);
      expect(guard([{ id: "p1", override: { enforcment: "off" } }])).toBe(true);
    });

    it("rejects a missing id, a non-object override, or wrong arity", () => {
      expect(guard([{ override: {} }])).toBe(false);
      expect(guard([{ id: "p1" }])).toBe(false);
      expect(guard([{ id: "p1", override: "enforce" }])).toBe(false);
      expect(guard([{ id: "p1", override: [] }])).toBe(false);
      expect(guard([])).toBe(false);
    });
  });

  describe("volli:project-session-defaults", () => {
    const { guard } = DATA_IPC["volli:project-session-defaults"];
    const model = { providerId: "anthropic", modelId: "opus", reasoningLevel: "high" };

    it("accepts both fields null — the shape that clears both overrides", () => {
      expect(guard([{ id: "p1", harness: null, model: null }])).toBe(true);
    });

    it("accepts a harness and a full model selection", () => {
      expect(guard([{ id: "p1", harness: "codex", model }])).toBe(true);
    });

    it("rejects a model missing a field or carrying an unknown reasoning level", () => {
      expect(guard([{ id: "p1", harness: null, model: { providerId: "a", modelId: "b" } }])).toBe(
        false,
      );
      expect(
        guard([{ id: "p1", harness: null, model: { ...model, reasoningLevel: "extreme" } }]),
      ).toBe(false);
    });

    it("rejects a non-string harness", () => {
      expect(guard([{ id: "p1", harness: 7, model: null }])).toBe(false);
    });

    it("rejects a missing id, non-record payload, or wrong arity", () => {
      expect(guard([{ harness: null, model: null }])).toBe(false);
      expect(guard([null])).toBe(false);
      expect(guard([])).toBe(false);
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
            baseBranch: "origin/main",
          },
        ]),
      ).toBe(true);
    });

    it("accepts an explicitly null baseBranch (leave it to worktree-time detection)", () => {
      expect(guard([{ ...valid, baseBranch: null }])).toBe(true);
    });

    it("rejects a non-string baseBranch when present", () => {
      expect(guard([{ ...valid, baseBranch: 7 }])).toBe(false);
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

    it("accepts a registered harness's slug as the preference, not only a built-in", () => {
      expect(guard([{ ...valid, preferredHarnessId: "claude-code" }])).toBe(true);
      expect(guard([{ ...valid, preferredHarnessId: "my-harness" }])).toBe(true);
    });

    it("rejects a preference that could not name any harness", () => {
      // Trust is checked at the launch door, which is the only place that can
      // see it; this guard only refuses strings no manifest could be filed
      // under — a path, a shell word, a non-string.
      expect(guard([{ ...valid, preferredHarnessId: "../etc/passwd" }])).toBe(false);
      expect(guard([{ ...valid, preferredHarnessId: "My Harness" }])).toBe(false);
      expect(guard([{ ...valid, preferredHarnessId: 7 }])).toBe(false);
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

    it("accepts a usesWorktree flip (the pre-materialization destination control)", () => {
      expect(guard([{ ticketId: "t1", usesWorktree: false }])).toBe(true);
      expect(guard([{ ticketId: "t1", usesWorktree: true }])).toBe(true);
    });

    it("rejects a non-boolean usesWorktree when present", () => {
      expect(guard([{ ticketId: "t1", usesWorktree: "yes" }])).toBe(false);
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

  describe("volli:ticket-status-entries", () => {
    const { guard, invalidError } = DATA_IPC["volli:ticket-status-entries"];

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

  describe("volli:blob-attach", () => {
    const { guard, invalidError } = DATA_IPC["volli:blob-attach"];
    const bytes = new Uint8Array([1, 2, 3]);

    it("accepts bytes with each kind of owner", () => {
      expect(guard([{ fileName: "a.png", bytes, owner: { ticketId: "t1" } }])).toBe(true);
      expect(guard([{ fileName: "a.png", bytes, owner: { sessionId: "s1" } }])).toBe(true);
      expect(guard([{ fileName: "a.png", bytes, owner: { unowned: true } }])).toBe(true);
    });

    it("accepts a source path instead of bytes, which is the native picker", () => {
      expect(guard([{ fileName: "a.png", sourcePath: "/x/a.png", owner: { unowned: true } }])).toBe(
        true,
      );
    });

    it("accepts the optional descriptive fields", () => {
      expect(
        guard([
          {
            fileName: "a.png",
            bytes,
            mime: "image/png",
            label: "Mock",
            refRoot: "/repo",
            owner: { unowned: true },
          },
        ]),
      ).toBe(true);
    });

    it("rejects a payload with neither bytes nor a path", () => {
      expect(guard([{ fileName: "a.png", owner: { unowned: true } }])).toBe(false);
    });

    it("rejects bytes that are not actually bytes", () => {
      expect(guard([{ fileName: "a.png", bytes: [1, 2, 3], owner: { unowned: true } }])).toBe(
        false,
      );
    });

    it("rejects a missing or blank file name", () => {
      expect(guard([{ bytes, owner: { unowned: true } }])).toBe(false);
      expect(guard([{ fileName: "   ", bytes, owner: { unowned: true } }])).toBe(false);
    });

    it("rejects an owner that names nothing", () => {
      expect(guard([{ fileName: "a.png", bytes, owner: {} }])).toBe(false);
      expect(guard([{ fileName: "a.png", bytes, owner: null }])).toBe(false);
      expect(guard([{ fileName: "a.png", bytes, owner: { unowned: false } }])).toBe(false);
      expect(guard([{ fileName: "a.png", bytes }])).toBe(false);
    });

    it("rejects a non-string optional field", () => {
      expect(guard([{ fileName: "a.png", bytes, mime: 7, owner: { unowned: true } }])).toBe(false);
      expect(guard([{ fileName: "a.png", bytes, label: 7, owner: { unowned: true } }])).toBe(false);
      expect(guard([{ fileName: "a.png", bytes, refRoot: 7, owner: { unowned: true } }])).toBe(
        false,
      );
    });

    it("rejects a non-object payload and a wrong arity", () => {
      expect(guard([null])).toBe(false);
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid attachment");
    });
  });

  describe("volli:blob-list", () => {
    const { guard, invalidError } = DATA_IPC["volli:blob-list"];

    it("accepts either owner", () => {
      expect(guard([{ ticketId: "t1" }])).toBe(true);
      expect(guard([{ sessionId: "s1" }])).toBe(true);
    });

    it("rejects a non-string owner id", () => {
      expect(guard([{ ticketId: 1 }])).toBe(false);
      expect(guard([{ sessionId: 1 }])).toBe(false);
    });

    it("rejects a non-object payload and a wrong arity", () => {
      expect(guard([null])).toBe(false);
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid attachment owner");
    });
  });

  describe("volli:blob-remove", () => {
    const { guard, invalidError } = DATA_IPC["volli:blob-remove"];

    it("accepts a valid { linkId } payload", () => {
      expect(guard([{ linkId: "l1" }])).toBe(true);
    });

    it("rejects a non-object payload, a non-string id and a wrong arity", () => {
      expect(guard([null])).toBe(false);
      expect(guard([{ linkId: 1 }])).toBe(false);
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid attachment");
    });
  });

  describe("volli:blob-link-drafts", () => {
    const { guard, invalidError } = DATA_IPC["volli:blob-link-drafts"];

    it("accepts drafts with and without labels", () => {
      expect(
        guard([{ ticketId: "t1", blobs: [{ blobHash: "a" }, { blobHash: "b", label: "Mock" }] }]),
      ).toBe(true);
    });

    it("accepts an empty draft list, which is a ticket created with nothing attached", () => {
      expect(guard([{ ticketId: "t1", blobs: [] }])).toBe(true);
    });

    it("rejects a malformed draft entry", () => {
      expect(guard([{ ticketId: "t1", blobs: [{ blobHash: 1 }] }])).toBe(false);
      expect(guard([{ ticketId: "t1", blobs: [{ blobHash: "a", label: 1 }] }])).toBe(false);
      expect(guard([{ ticketId: "t1", blobs: [null] }])).toBe(false);
    });

    it("rejects a missing ticket, a non-array list and a wrong arity", () => {
      expect(guard([{ blobs: [] }])).toBe(false);
      expect(guard([{ ticketId: "t1", blobs: "nope" }])).toBe(false);
      expect(guard([null])).toBe(false);
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid attachment drafts");
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

  describe("volli:session-starts", () => {
    const { guard, invalidError } = DATA_IPC["volli:session-starts"];

    it("accepts a finite epoch-ms window", () => {
      expect(guard([{ sinceMs: 0 }])).toBe(true);
      expect(guard([{ sinceMs: 1_767_225_600_000 }])).toBe(true);
    });

    it("rejects a window that is not a finite number", () => {
      expect(guard([{ sinceMs: "yesterday" }])).toBe(false);
      expect(guard([{ sinceMs: Number.NaN }])).toBe(false);
      expect(guard([{ sinceMs: Number.POSITIVE_INFINITY }])).toBe(false);
      expect(guard([{}])).toBe(false);
      expect(guard([null])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid session window");
    });
  });

  describe("volli:usage-report", () => {
    const { guard, invalidError } = DATA_IPC["volli:usage-report"];

    it("accepts each scope arm with the id that arm requires", () => {
      expect(guard([{ scope: { kind: "all" } }])).toBe(true);
      expect(guard([{ scope: { kind: "project", projectId: "p1" } }])).toBe(true);
      expect(guard([{ scope: { kind: "ticket", ticketId: "t1" } }])).toBe(true);
      expect(guard([{ scope: { kind: "session", sessionId: "s1" } }])).toBe(true);
    });

    it("rejects an unknown scope arm, and an arm missing its id", () => {
      // The arm must not fall through to the ledger's own switch: an
      // unrecognised kind there would read a scope nobody asked for.
      expect(guard([{ scope: { kind: "everything" } }])).toBe(false);
      expect(guard([{ scope: { kind: "project" } }])).toBe(false);
      expect(guard([{ scope: { kind: "ticket", ticketId: 7 } }])).toBe(false);
      expect(guard([{ scope: { kind: "session", sessionId: null } }])).toBe(false);
      expect(guard([{}])).toBe(false);
      expect(guard([null])).toBe(false);
    });

    it("treats the window bounds as optional but requires them to be usable", () => {
      expect(guard([{ scope: { kind: "all" }, sinceMs: 0 }])).toBe(true);
      expect(guard([{ scope: { kind: "all" }, sinceMs: 1, untilMs: 2 }])).toBe(true);
      // A NaN bound would reach SQLite as a comparison that matches nothing,
      // and the surface would draw the empty report as a measured zero.
      expect(guard([{ scope: { kind: "all" }, sinceMs: Number.NaN }])).toBe(false);
      expect(guard([{ scope: { kind: "all" }, untilMs: Number.POSITIVE_INFINITY }])).toBe(false);
      expect(guard([{ scope: { kind: "all" }, sinceMs: "last week" }])).toBe(false);
    });

    it("accepts only the four grouping dimensions the report offers", () => {
      for (const groupBy of ["ticket", "session", "model", "day"]) {
        expect(guard([{ scope: { kind: "all" }, groupBy }])).toBe(true);
      }
      expect(guard([{ scope: { kind: "all" }, groupBy: "provider" }])).toBe(false);
      expect(guard([{ scope: { kind: "all" }, groupBy: null }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
      expect(guard([{ scope: { kind: "all" } }, { scope: { kind: "all" } }])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid usage query");
    });
  });

  describe("volli:venue-snapshot", () => {
    const { guard, invalidError } = DATA_IPC["volli:venue-snapshot"];

    it("accepts both scopes a Session can have", () => {
      expect(guard([{ projectId: "p1", ticketId: null }])).toBe(true);
      expect(guard([{ projectId: "p1", ticketId: "t1" }])).toBe(true);
    });

    it("rejects an omitted ticket scope — absent is not the same claim as null", () => {
      expect(guard([{ projectId: "p1" }])).toBe(false);
      expect(guard([{ projectId: "p1", ticketId: 7 }])).toBe(false);
    });

    it("rejects a missing or non-string project", () => {
      expect(guard([{ ticketId: null }])).toBe(false);
      expect(guard([{ projectId: 1, ticketId: null }])).toBe(false);
      expect(guard([null])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid venue");
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

    it("accepts the optional auto-title rider", () => {
      expect(guard([{ sessionId: "s1", title: "New title", refineFrom: "Fix the parser" }])).toBe(
        true,
      );
    });

    it("rejects a non-string rider", () => {
      expect(guard([{ sessionId: "s1", title: "New title", refineFrom: 1 }])).toBe(false);
    });

    it("rejects a blank rider — there is no message to title from", () => {
      expect(guard([{ sessionId: "s1", title: "New title", refineFrom: "   " }])).toBe(false);
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

  describe("volli:worktree-commit", () => {
    const { guard, invalidError } = DATA_IPC["volli:worktree-commit"];

    it("accepts the bare { ticketId } payload every pre-field caller sends", () => {
      expect(guard([{ ticketId: "t1" }])).toBe(true);
      expect(guard([{ ticketId: "t1", message: undefined, includeUnstaged: undefined }])).toBe(
        true,
      );
    });

    it("rejects a non-object payload, a non-string ticketId and a wrong arity", () => {
      expect(guard([null])).toBe(false);
      expect(guard([{ ticketId: 1 }])).toBe(false);
      expect(guard([])).toBe(false);
    });

    it("accepts a message, blank or multi-line (blank means generate one)", () => {
      expect(guard([{ ticketId: "t1", message: "fix(VC-1): the thing" }])).toBe(true);
      expect(guard([{ ticketId: "t1", message: "" }])).toBe(true);
      expect(guard([{ ticketId: "t1", message: "subject\n\nbody\r\n\twith a tab" }])).toBe(true);
    });

    it("rejects a non-string message", () => {
      expect(guard([{ ticketId: "t1", message: 1 }])).toBe(false);
      expect(guard([{ ticketId: "t1", message: null }])).toBe(false);
    });

    it("rejects control characters — a NUL cannot cross argv, the rest is invisible junk", () => {
      expect(guard([{ ticketId: "t1", message: "subject\u0000rest" }])).toBe(false);
      expect(guard([{ ticketId: "t1", message: "subject\u001brest" }])).toBe(false);
      expect(guard([{ ticketId: "t1", message: "subject\u007f" }])).toBe(false);
    });

    it("rejects a message past the length cap, accepts one exactly at it", () => {
      expect(guard([{ ticketId: "t1", message: "a".repeat(5000) }])).toBe(true);
      expect(guard([{ ticketId: "t1", message: "a".repeat(5001) }])).toBe(false);
    });

    it("accepts a boolean includeUnstaged and rejects anything else", () => {
      expect(guard([{ ticketId: "t1", includeUnstaged: true }])).toBe(true);
      expect(guard([{ ticketId: "t1", includeUnstaged: false }])).toBe(true);
      expect(guard([{ ticketId: "t1", includeUnstaged: "yes" }])).toBe(false);
      expect(guard([{ ticketId: "t1", includeUnstaged: null }])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid commit request");
    });
  });

  describe("the ticketId-input worktree/retention channels (push-pr/retention-state/dismiss/archive-clean)", () => {
    const cases = [
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

    it("covers all 58 data channels", () => {
      expect(DATA_CHANNELS).toHaveLength(58);
      expect(DATA_CHANNELS).toContain("volli:data-bootstrap");
      expect(DATA_CHANNELS).toContain("volli:usage-report");
      // The authority policy write (VC-172). App-only on purpose: there is no
      // agent verb behind it, because the agent must not author the policy that
      // governs it.
      expect(DATA_CHANNELS).toContain("volli:project-authority-policy");
      expect(DATA_CHANNELS).toContain("volli:database");
      expect(DATA_CHANNELS).toContain("volli:worktree-recreate");
      expect(DATA_CHANNELS).toContain("volli:blob-attach");
      expect(DATA_CHANNELS).toContain("volli:blob-list");
      expect(DATA_CHANNELS).toContain("volli:blob-remove");
      expect(DATA_CHANNELS).toContain("volli:blob-link-drafts");
      expect(DATA_CHANNELS).toContain("volli:ticket-move");
      expect(DATA_CHANNELS).toContain("volli:app-state-set");
      expect(DATA_CHANNELS).toContain("volli:retention-poll");
      expect(DATA_CHANNELS).toContain("volli:worktree-change-set");
      expect(DATA_CHANNELS).toContain("volli:worktree-base-read");
      expect(DATA_CHANNELS).toContain("volli:worktree-change-watch");
      expect(DATA_CHANNELS).toContain("volli:worktree-change-unwatch");
      expect(DATA_CHANNELS).toContain("volli:session-starts");
      expect(DATA_CHANNELS).toContain("volli:venue-snapshot");
    });
  });
});

describe("FILE_IPC descriptor table", () => {
  describe("volli:file-index", () => {
    const { guard, invalidError } = FILE_IPC["volli:file-index"];

    it("accepts a valid { projectId } payload — the main checkout", () => {
      expect(guard([{ projectId: "p1" }])).toBe(true);
    });

    it("accepts the { projectId, ticketId } scope pair — a ticket's worktree (VC-190)", () => {
      expect(guard([{ projectId: "p1", ticketId: "t1" }])).toBe(true);
    });

    it("accepts an explicitly undefined ticketId", () => {
      expect(guard([{ projectId: "p1", ticketId: undefined }])).toBe(true);
    });

    it("rejects a non-string ticketId", () => {
      expect(guard([{ projectId: "p1", ticketId: 7 }])).toBe(false);
    });

    it("rejects a null ticketId — absent means Main, null means malformed", () => {
      expect(guard([{ projectId: "p1", ticketId: null }])).toBe(false);
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

  describe("volli:search", () => {
    const { guard, invalidError } = FILE_IPC["volli:search"];
    const valid = { projectId: "p1", query: "resolveFileScope" };

    it("accepts a query scoped to the main checkout", () => {
      expect(guard([valid])).toBe(true);
    });

    it("accepts the { projectId, ticketId } scope pair — a ticket's worktree", () => {
      expect(guard([{ ...valid, ticketId: "t1" }])).toBe(true);
    });

    // An empty box is what a Search page holds every time it opens, so the
    // boundary must not call it malformed — main answers it with an empty
    // result instead.
    it("accepts an empty query rather than refusing it as a bad shape", () => {
      expect(guard([{ ...valid, query: "" }])).toBe(true);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a missing query", () => {
      expect(guard([{ projectId: "p1" }])).toBe(false);
    });

    it("rejects a non-string projectId", () => {
      expect(guard([{ ...valid, projectId: 1 }])).toBe(false);
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

  describe("volli:external-app-list", () => {
    const { guard, invalidError } = FILE_IPC["volli:external-app-list"];

    it("takes no input", () => {
      expect(guard([])).toBe(true);
      expect(guard([{}])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid request");
    });
  });

  describe("external app target channels", () => {
    const file = FILE_IPC["volli:external-app-open-file"];
    const worktree = FILE_IPC["volli:external-app-open-worktree"];
    const revealWorktree = FILE_IPC["volli:worktree-reveal"];

    it("accepts a safe-shaped external-app file target and rejects an unknown app id", () => {
      expect(
        file.guard([{ projectId: "p1", ticketId: "t1", relPath: "src/main.ts", appId: "vscode" }]),
      ).toBe(true);
      expect(
        file.guard([
          { projectId: "p1", ticketId: "t1", relPath: "src/main.ts", appId: "android-studio" },
        ]),
      ).toBe(true);
      expect(file.guard([{ projectId: "p1", relPath: "src/main.ts", appId: "unknown" }])).toBe(
        false,
      );
    });

    it("rejects malformed external-app file targets", () => {
      expect(file.guard([null])).toBe(false);
      expect(file.guard([{ projectId: 1, relPath: "x.ts", appId: "vscode" }])).toBe(false);
      expect(file.guard([{ projectId: "p1", relPath: 1, appId: "vscode" }])).toBe(false);
      expect(file.guard([])).toBe(false);
    });

    it("accepts a ticket worktree target and rejects every missing or malformed part", () => {
      expect(worktree.guard([{ projectId: "p1", ticketId: "t1", appId: "terminal" }])).toBe(true);
      expect(worktree.guard([null])).toBe(false);
      expect(worktree.guard([{ projectId: 1, ticketId: "t1", appId: "terminal" }])).toBe(false);
      expect(worktree.guard([{ projectId: "p1", ticketId: 1, appId: "terminal" }])).toBe(false);
      expect(worktree.guard([{ projectId: "p1", ticketId: "t1", appId: "unknown" }])).toBe(false);
    });

    it("accepts only a project/ticket pair for worktree reveal", () => {
      expect(revealWorktree.guard([{ projectId: "p1", ticketId: "t1" }])).toBe(true);
      expect(revealWorktree.guard([null])).toBe(false);
      expect(revealWorktree.guard([{ projectId: 1, ticketId: "t1" }])).toBe(false);
      expect(revealWorktree.guard([{ projectId: "p1", ticketId: 1 }])).toBe(false);
    });
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

  describe("the creation track's scoped-path channels (VC-191)", () => {
    const channels = [
      "volli:file-create",
      "volli:dir-create",
      "volli:file-duplicate",
      "volli:file-delete",
    ] as const;

    for (const channel of channels) {
      describe(channel, () => {
        const { guard, invalidError } = FILE_IPC[channel];
        const valid = { projectId: "p1", relPath: "src/new.ts" };

        it("accepts the scoped path shape, with and without a ticketId", () => {
          expect(guard([valid])).toBe(true);
          expect(guard([{ ...valid, ticketId: "t1" }])).toBe(true);
        });

        it("rejects a non-object payload", () => {
          expect(guard([null])).toBe(false);
        });

        it("rejects a non-string relPath", () => {
          expect(guard([{ ...valid, relPath: 1 }])).toBe(false);
        });

        it("rejects a non-string projectId", () => {
          expect(guard([{ ...valid, projectId: 1 }])).toBe(false);
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

  describe("volli:file-rename", () => {
    const { guard, invalidError } = FILE_IPC["volli:file-rename"];
    const valid = { projectId: "p1", relPath: "src/a.ts", toRelPath: "src/b.ts" };

    it("accepts a valid payload, with and without a ticketId", () => {
      expect(guard([valid])).toBe(true);
      expect(guard([{ ...valid, ticketId: "t1" }])).toBe(true);
    });

    it("rejects a missing or non-string destination", () => {
      expect(guard([{ projectId: "p1", relPath: "src/a.ts" }])).toBe(false);
      expect(guard([{ ...valid, toRelPath: 1 }])).toBe(false);
    });

    it("rejects an invalid base FilePathInput shape", () => {
      expect(guard([{ relPath: "src/a.ts", toRelPath: "src/b.ts" }])).toBe(false);
      expect(guard([null])).toBe(false);
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

  describe("volli:prompt-template-create", () => {
    const { guard, invalidError } = FILE_IPC["volli:prompt-template-create"];
    const valid = {
      projectId: "p1",
      scope: "project",
      name: "review",
      description: "Review a file",
      body: "Review $1.",
    };

    it("accepts each writable scope", () => {
      expect(guard([valid])).toBe(true);
      expect(guard([{ ...valid, scope: "personal" }])).toBe(true);
    });

    it("rejects a non-record payload or wrong arity", () => {
      expect(guard([null])).toBe(false);
      expect(guard([])).toBe(false);
    });

    it("rejects every invalid command field", () => {
      expect(guard([{ ...valid, projectId: 1 }])).toBe(false);
      expect(guard([{ ...valid, scope: "shared" }])).toBe(false);
      expect(guard([{ ...valid, name: 1 }])).toBe(false);
      expect(guard([{ ...valid, name: "../escape" }])).toBe(false);
      expect(guard([{ ...valid, description: 1 }])).toBe(false);
      expect(guard([{ ...valid, body: 1 }])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid command");
    });
  });

  describe("volli:prompt-templates", () => {
    const { guard, invalidError } = FILE_IPC["volli:prompt-templates"];

    it("accepts a valid payload", () => {
      expect(guard([{ projectId: "p1" }])).toBe(true);
    });

    it("accepts the Skills pane's unruled read", () => {
      expect(guard([{ projectId: "p1", ruled: false }])).toBe(true);
      expect(guard([{ projectId: "p1", ruled: true }])).toBe(true);
    });

    it("rejects a non-boolean ruled flag", () => {
      expect(guard([{ projectId: "p1", ruled: "no" }])).toBe(false);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
    });

    it("rejects a non-string projectId", () => {
      expect(guard([{ projectId: 1 }])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
      expect(guard([{ projectId: "p1" }, { projectId: "p2" }])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid request");
    });
  });

  describe("FILE_CHANNELS derivation", () => {
    it("is exactly the descriptor table's key set — membership cannot be forgotten", () => {
      expect(FILE_CHANNELS).toEqual(Object.keys(FILE_IPC));
    });

    it("covers all 21 file channels", () => {
      expect(FILE_CHANNELS).toHaveLength(21);
      expect(FILE_CHANNELS).toContain("volli:search");
      expect(FILE_CHANNELS).toContain("volli:file-create");
      expect(FILE_CHANNELS).toContain("volli:dir-create");
      expect(FILE_CHANNELS).toContain("volli:file-rename");
      expect(FILE_CHANNELS).toContain("volli:file-duplicate");
      expect(FILE_CHANNELS).toContain("volli:file-delete");
      expect(FILE_CHANNELS).toContain("volli:prompt-templates");
      expect(FILE_CHANNELS).toContain("volli:file-index");
      expect(FILE_CHANNELS).toContain("volli:file-unwatch");
      expect(FILE_CHANNELS).toContain("volli:external-app-list");
      expect(FILE_CHANNELS).toContain("volli:external-app-open-file");
      expect(FILE_CHANNELS).toContain("volli:external-app-open-worktree");
      expect(FILE_CHANNELS).toContain("volli:worktree-reveal");
      expect(FILE_CHANNELS).toContain("volli:dir-watch");
      expect(FILE_CHANNELS).toContain("volli:dir-unwatch");
    });
  });
});

describe("THEME_IPC descriptor table", () => {
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

  describe("the retired volli:theme-set-global-editor channel", () => {
    it("is absent from the descriptor table", () => {
      // VC-123: the editor has no persisted theme, so it has no write channel.
      // A guard left behind would keep an unreachable id reachable over IPC.
      expect(THEME_IPC).not.toHaveProperty("volli:theme-set-global-editor");
    });
  });

  describe("volli:theme-set-project", () => {
    const { guard, invalidError } = THEME_IPC["volli:theme-set-project"];
    const override = { terminalThemeName: "Nord" };

    it("accepts a per-surface override and a null (clear-to-inherit)", () => {
      expect(guard([{ projectId: "p1", override }])).toBe(true);
      expect(guard([{ projectId: "p1", override: null }])).toBe(true);
    });

    it("rejects a missing project or a non-string terminal name", () => {
      expect(guard([{ override }])).toBe(false);
      expect(guard([{ projectId: "p1", override: { terminalThemeName: 7 } }])).toBe(false);
      expect(guard([{ projectId: "p1", override: {} }])).toBe(false);
    });

    it("ignores a stale editorThemeId from an older renderer", () => {
      // Rejecting the whole override for a field nothing reads would turn a
      // retired picker into a broken terminal theme (VC-123).
      expect(guard([{ projectId: "p1", override: { ...override, editorThemeId: "nord" } }])).toBe(
        true,
      );
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

  describe("the canvas channels (migration 014)", () => {
    const canvas = {
      stops: [
        { hex: "#e8652a", x: 0.2, y: 0.15 },
        { hex: "#3a7d9a", x: 0.8, y: 0.9 },
      ],
      primaryIndex: 1,
      vibrancy: 0.6,
      grain: 0.15,
    };

    it("accepts a canvas the pipeline can actually paint", () => {
      expect(THEME_IPC["volli:theme-canvas-set-global"].guard([{ canvas }])).toBe(true);
      expect(THEME_IPC["volli:theme-canvas-set-project"].guard([{ projectId: "p1", canvas }])).toBe(
        true,
      );
      // null clears the project override back to inheriting — not a malformed canvas.
      expect(
        THEME_IPC["volli:theme-canvas-set-project"].guard([{ projectId: "p1", canvas: null }]),
      ).toBe(true);
    });

    // The guard IS `parseCanvas` — the package's one storage boundary for this
    // shape — rather than a second hand-written copy of the same rules, so a
    // canvas cannot be storable but un-resendable.
    it("refuses a canvas nothing downstream could derive a ladder from", () => {
      const { guard, invalidError } = THEME_IPC["volli:theme-canvas-set-global"];

      expect(guard([{ canvas: { ...canvas, stops: [] } }])).toBe(false);
      expect(guard([{ canvas: { ...canvas, primaryIndex: 7 } }])).toBe(false);
      expect(guard([{ canvas: { ...canvas, stops: [{ hex: "nope", x: 0, y: 0 }] } }])).toBe(false);
      expect(guard([{ canvas: { ...canvas, vibrancy: "high" } }])).toBe(false);
      expect(guard([{ canvas: null }])).toBe(false);
      expect(guard([])).toBe(false);
      expect(invalidError).toBe("Invalid canvas");
    });

    // Ranges are the parser's to clamp, not this boundary's to refuse: a
    // vibrancy of 4 is a stale value that still says what the user meant, and
    // refusing it here would make the accepted set smaller than the storable one.
    it("admits an out-of-range scalar rather than second-guessing the parser", () => {
      expect(
        THEME_IPC["volli:theme-canvas-set-global"].guard([
          { canvas: { ...canvas, vibrancy: 4, grain: -1 } },
        ]),
      ).toBe(true);
    });

    it("takes only the three appearance words, and null to clear a project's", () => {
      const global = THEME_IPC["volli:theme-appearance-set-global"];
      const project = THEME_IPC["volli:theme-appearance-set-project"];

      for (const appearance of ["light", "dark", "auto"]) {
        expect(global.guard([{ appearance }])).toBe(true);
        expect(project.guard([{ projectId: "p1", appearance }])).toBe(true);
      }
      expect(project.guard([{ projectId: "p1", appearance: null }])).toBe(true);
      // Null at the GLOBAL scope has nothing to inherit from — there is no
      // "unset" to fall back to, so it is a malformed request, not a clear.
      expect(global.guard([{ appearance: null }])).toBe(false);
      expect(global.guard([{ appearance: "sepia" }])).toBe(false);
      expect(project.guard([{ appearance: "dark" }])).toBe(false);
      expect(global.invalidError).toBe("Invalid appearance");
    });

    it("refuses an unresolved first-paint appearance, and a background that is not a color", () => {
      const { guard, invalidError } = THEME_IPC["volli:theme-first-paint-set"];

      expect(guard([{ appearance: "dark", background: "#141210" }])).toBe(true);
      expect(guard([{ appearance: "light", background: "#f4efe9" }])).toBe(true);
      // `auto` is the one value main cannot act on at window construction.
      expect(guard([{ appearance: "auto", background: "#141210" }])).toBe(false);
      expect(guard([{ appearance: "dark", background: "rebeccapurple" }])).toBe(false);
      expect(guard([{ appearance: "dark" }])).toBe(false);
      expect(guard([])).toBe(false);
      expect(invalidError).toBe("Invalid first-paint hint");
    });

    // Every project-scoped row carries a second required field, so it has an
    // arity check and an id check the global rows do not. Both are the arms a
    // malformed renderer call actually lands on, and neither is reachable
    // through the payload cases above.
    it("refuses a project-scoped write with no id, a wrong-typed id, or the wrong arity", () => {
      const canvasRow = THEME_IPC["volli:theme-canvas-set-project"];
      const appearanceRow = THEME_IPC["volli:theme-appearance-set-project"];

      for (const row of [canvasRow, appearanceRow]) {
        expect(row.guard([])).toBe(false);
        expect(row.guard([{ projectId: "p1" }, { projectId: "p2" }])).toBe(false);
        expect(row.guard(["p1"])).toBe(false);
        expect(row.guard([null])).toBe(false);
      }

      expect(canvasRow.guard([{ projectId: 7, canvas }])).toBe(false);
      expect(appearanceRow.guard([{ projectId: 7, appearance: "dark" }])).toBe(false);
    });

    it("refuses a first-paint hint that is not a record at all", () => {
      expect(THEME_IPC["volli:theme-first-paint-set"].guard(["dark"])).toBe(false);
      expect(THEME_IPC["volli:theme-first-paint-set"].guard([null])).toBe(false);
    });
  });

  describe("THEME_CHANNELS derivation", () => {
    it("derives from the descriptor table's keys", () => {
      expect(THEME_CHANNELS).toEqual(Object.keys(THEME_IPC));
    });

    it("covers the whole theme surface", () => {
      expect(THEME_CHANNELS).toHaveLength(8);
      expect(THEME_CHANNELS).toContain("volli:theme-state");
      expect(THEME_CHANNELS).toContain("volli:theme-set-project");
      expect(THEME_CHANNELS).toContain("volli:theme-terminal-overlay-write");
      expect(THEME_CHANNELS).toContain("volli:theme-canvas-set-global");
      expect(THEME_CHANNELS).toContain("volli:theme-appearance-set-global");
      expect(THEME_CHANNELS).toContain("volli:theme-canvas-set-project");
      expect(THEME_CHANNELS).toContain("volli:theme-appearance-set-project");
      expect(THEME_CHANNELS).toContain("volli:theme-first-paint-set");
    });
  });
});

describe("MODEL_ACCESS_IPC descriptor table", () => {
  describe("volli:model-access-sign-in-begin", () => {
    const { guard, invalidError } = MODEL_ACCESS_IPC["volli:model-access-sign-in-begin"];

    it("accepts each method a provider can offer", () => {
      expect(guard(["anthropic", "api-key"])).toBe(true);
      expect(guard(["anthropic", "oauth"])).toBe(true);
    });

    it("rejects a method Volli has no vocabulary for", () => {
      // Pi's own spelling, which is deliberately NOT this boundary's spelling.
      expect(guard(["anthropic", "api_key"])).toBe(false);
      expect(guard(["anthropic", ""])).toBe(false);
    });

    it("rejects a missing or empty provider id", () => {
      expect(guard(["", "api-key"])).toBe(false);
      expect(guard([null, "api-key"])).toBe(false);
      expect(guard(["anthropic"])).toBe(false);
      expect(guard(["anthropic", "api-key", "extra"])).toBe(false);
    });

    it("names the request and never an argument", () => {
      expect(invalidError).toBe("Invalid sign-in request");
    });
  });

  describe("volli:model-access-sign-in-respond", () => {
    const { guard, invalidError } = MODEL_ACCESS_IPC["volli:model-access-sign-in-respond"];

    it("accepts an answer addressed to one step of one attempt", () => {
      expect(guard(["attempt-1", "prompt-1", "sk-live-0123456789"])).toBe(true);
    });

    it("accepts an empty answer, because a provider decides what its steps accept", () => {
      // The value is unconstrained beyond being a string on purpose: a length
      // or charset rule invented here would reject the next credential format
      // a provider ships.
      expect(guard(["attempt-1", "prompt-1", ""])).toBe(true);
    });

    it("refuses an answer that names no attempt or no step", () => {
      expect(guard(["", "prompt-1", "value"])).toBe(false);
      expect(guard(["attempt-1", "", "value"])).toBe(false);
      expect(guard(["attempt-1", "prompt-1"])).toBe(false);
      expect(guard(["attempt-1", "prompt-1", 42])).toBe(false);
    });

    it("says nothing about the value it rejected", () => {
      // The one request surface an argument can be a credential on: a message
      // shaped by what it rejected would be a message describing a secret.
      expect(invalidError).toBe("Invalid sign-in answer");
    });
  });

  describe("volli:model-access-sign-in-cancel", () => {
    const { guard } = MODEL_ACCESS_IPC["volli:model-access-sign-in-cancel"];

    it("accepts one attempt id and nothing else", () => {
      expect(guard(["attempt-1"])).toBe(true);
      expect(guard([""])).toBe(false);
      expect(guard([])).toBe(false);
      expect(guard(["attempt-1", "attempt-2"])).toBe(false);
    });
  });

  describe("volli:model-access-sign-out", () => {
    const { guard, invalidError } = MODEL_ACCESS_IPC["volli:model-access-sign-out"];

    it("accepts one provider id and nothing else", () => {
      expect(guard(["groq"])).toBe(true);
      expect(guard([""])).toBe(false);
      expect(guard([{ providerId: "groq" }])).toBe(false);
      expect(guard([])).toBe(false);
    });

    it("names the request", () => {
      expect(invalidError).toBe("Invalid sign-out request");
    });
  });

  describe("MODEL_ACCESS_CHANNELS derivation", () => {
    it("derives the channel list from the table rather than repeating it", () => {
      expect(MODEL_ACCESS_CHANNELS).toEqual(Object.keys(MODEL_ACCESS_IPC));
    });
  });
});

describe("WEB_ACCESS_IPC descriptor table", () => {
  describe("volli:web-access-get", () => {
    const { guard, invalidError } = WEB_ACCESS_IPC["volli:web-access-get"];

    it("takes no arguments at all", () => {
      expect(guard([])).toBe(true);
      expect(guard(["junk"])).toBe(false);
    });

    it("names the request", () => {
      expect(invalidError).toBe("Invalid request");
    });
  });

  describe("volli:web-access-set-provider", () => {
    const { guard, invalidError } = WEB_ACCESS_IPC["volli:web-access-set-provider"];

    it("accepts each provider this version knows, with or without an endpoint", () => {
      expect(guard(["off", null])).toBe(true);
      expect(guard(["brave", null])).toBe(true);
      expect(guard(["searxng", "http://localhost:8888"])).toBe(true);
    });

    it("refuses a provider Volli has no vocabulary for", () => {
      expect(guard(["yandex", null])).toBe(false);
      expect(guard(["", null])).toBe(false);
      expect(guard([null, null])).toBe(false);
    });

    it("refuses an endpoint that is not a string or absent", () => {
      expect(guard(["searxng", 8888])).toBe(false);
      expect(guard(["searxng", { url: "http://localhost" }])).toBe(false);
      expect(guard(["searxng"])).toBe(false);
      expect(guard(["searxng", null, "extra"])).toBe(false);
    });

    it("accepts an endpoint this guard cannot judge, because the policy judges it", () => {
      // Shape here, admission in `WebAccessSettings.setProvider`: a person who
      // typed a LAN address needs the endpoint policy's sentence, not
      // "Invalid".
      expect(guard(["searxng", "http://169.254.169.254/"])).toBe(true);
      expect(invalidError).toBe("Invalid web access provider");
    });
  });

  describe("volli:web-access-set-key", () => {
    const { guard, invalidError } = WEB_ACCESS_IPC["volli:web-access-set-key"];

    it("accepts any string, because each provider decides what its token looks like", () => {
      expect(guard(["brave", "BSA-anything-at-all"])).toBe(true);
      expect(guard(["exa", ""])).toBe(true);
    });

    it("refuses anything that is not one keyed provider and one string", () => {
      expect(guard(["brave", 42])).toBe(false);
      expect(guard([])).toBe(false);
      expect(guard(["brave"])).toBe(false);
      expect(guard(["key", "key"])).toBe(false);
      // SearXNG has an address, not a key, and `off` has neither.
      expect(guard(["searxng", "anything"])).toBe(false);
      expect(guard(["off", "anything"])).toBe(false);
    });

    it("says nothing about the value it rejected", () => {
      // The second surface an argument can be a credential on. A message shaped
      // by what it rejected would be a message describing a secret.
      expect(invalidError).toBe("Invalid API key");
    });
  });

  describe("volli:web-access-clear-key", () => {
    const { guard } = WEB_ACCESS_IPC["volli:web-access-clear-key"];

    it("names exactly one keyed provider", () => {
      expect(guard(["brave"])).toBe(true);
      expect(guard(["exa"])).toBe(true);
      expect(guard([])).toBe(false);
      expect(guard(["searxng"])).toBe(false);
      expect(guard(["web-access.brave.api-key"])).toBe(false);
    });
  });

  describe("WEB_ACCESS_CHANNELS derivation", () => {
    it("derives the channel list from the table rather than repeating it", () => {
      expect(WEB_ACCESS_CHANNELS).toEqual(Object.keys(WEB_ACCESS_IPC));
    });

    it("covers the whole Web Access surface", () => {
      expect(WEB_ACCESS_CHANNELS).toEqual([
        "volli:web-access-get",
        "volli:web-access-set-provider",
        "volli:web-access-set-key",
        "volli:web-access-clear-key",
      ]);
    });
  });
});

describe("AGENT_OBSERVABILITY_IPC descriptor table", () => {
  describe("volli:agent-observability-get", () => {
    const { guard, invalidError } = AGENT_OBSERVABILITY_IPC["volli:agent-observability-get"];

    it("accepts an empty args tuple", () => {
      expect(guard([])).toBe(true);
    });

    it("rejects stray arguments", () => {
      expect(guard(["junk"])).toBe(false);
      expect(invalidError).toBe("Invalid request");
    });
  });

  describe("volli:agent-observability-set", () => {
    const { guard } = AGENT_OBSERVABILITY_IPC["volli:agent-observability-set"];

    it("accepts a switch and an address", () => {
      expect(guard([true, "http://localhost:4318"])).toBe(true);
      expect(guard([false, ""])).toBe(true);
    });

    it("rejects the wrong shapes", () => {
      expect(guard([])).toBe(false);
      expect(guard([true])).toBe(false);
      expect(guard(["true", "http://localhost:4318"])).toBe(false);
      expect(guard([true, 4318])).toBe(false);
      expect(guard([true, "http://localhost:4318", "extra"])).toBe(false);
    });

    it("leaves WHERE telemetry may go to policy, not to the guard", () => {
      // `admitCollectorEndpoint` refuses these with sentences a person can act
      // on; "Invalid request" would tell them nothing about what to fix.
      expect(guard([true, "ftp://localhost:4318"])).toBe(true);
      expect(guard([true, "http://user:pw@localhost:4318"])).toBe(true);
    });
  });

  describe("AGENT_OBSERVABILITY_CHANNELS derivation", () => {
    it("derives the channel list from the table rather than repeating it", () => {
      expect(AGENT_OBSERVABILITY_CHANNELS).toEqual(Object.keys(AGENT_OBSERVABILITY_IPC));
    });

    it("covers the whole agent-observability surface", () => {
      expect(AGENT_OBSERVABILITY_CHANNELS).toEqual([
        "volli:agent-observability-get",
        "volli:agent-observability-set",
      ]);
    });
  });
});

describe("HARNESS_IPC descriptor table", () => {
  describe("volli:harness-pending (no-arg request)", () => {
    const { guard } = HARNESS_IPC["volli:harness-pending"];

    it("accepts an empty args tuple", () => {
      expect(guard([])).toBe(true);
    });

    it("rejects stray arguments", () => {
      expect(guard(["junk"])).toBe(false);
    });
  });

  describe("volli:harness-trust-set", () => {
    const { guard, invalidError } = HARNESS_IPC["volli:harness-trust-set"];
    const valid = { slug: "my-harness", manifestSha256: "a1", decision: "trusted" };

    it("accepts a verdict about a named version of a manifest", () => {
      expect(guard([valid])).toBe(true);
      expect(guard([{ ...valid, decision: "blocked" }])).toBe(true);
    });

    it("refuses a verdict with no hash, so nothing can be trusted in the abstract", () => {
      expect(guard([{ slug: "my-harness", decision: "trusted" }])).toBe(false);
    });

    it("refuses `reconfirm` — a conclusion Volli draws, not an answer a human gave", () => {
      expect(guard([{ ...valid, decision: "reconfirm" }])).toBe(false);
    });

    it("refuses a payload that is not a record, or the wrong arity", () => {
      expect(guard([null])).toBe(false);
      expect(guard([])).toBe(false);
      expect(guard([valid, valid])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid harness verdict");
    });
  });

  describe("volli:harness-registered (no-arg request)", () => {
    const { guard, invalidError } = HARNESS_IPC["volli:harness-registered"];

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

  describe("HARNESS_CHANNELS derivation", () => {
    it("derives from the descriptor table's keys", () => {
      expect(HARNESS_CHANNELS).toEqual(Object.keys(HARNESS_IPC));
    });

    it("covers the whole bring-your-own-harness surface", () => {
      expect(HARNESS_CHANNELS).toEqual([
        "volli:harness-pending",
        "volli:harness-trust-set",
        "volli:harness-registered",
      ]);
    });
  });
});

describe("CLI_IPC descriptor table", () => {
  describe("volli:cli-status", () => {
    const { guard, invalidError } = CLI_IPC["volli:cli-status"];

    it("accepts a host-wide read or a project root", () => {
      expect(guard([])).toBe(true);
      expect(guard([{ cwd: "/work/acme" }])).toBe(true);
      expect(guard([{}])).toBe(true);
    });

    it("rejects a non-string project root or stray arguments", () => {
      expect(guard([{ cwd: 42 }])).toBe(false);
      expect(guard(["junk"])).toBe(false);
      expect(guard([{ cwd: "/work/acme" }, "extra"])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid request");
    });
  });

  describe("volli:cli-doctor", () => {
    const { guard, invalidError } = CLI_IPC["volli:cli-doctor"];

    it("accepts a boolean fix flag, in both positions", () => {
      expect(guard([{ fix: false }])).toBe(true);
      expect(guard([{ fix: true }])).toBe(true);
    });

    it("rejects a missing or non-boolean flag, a non-record, and the wrong arity", () => {
      expect(guard([{}])).toBe(false);
      expect(guard([{ fix: "yes" }])).toBe(false);
      expect(guard([null])).toBe(false);
      expect(guard([])).toBe(false);
      expect(guard([{ fix: true }, { fix: true }])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid doctor request");
    });
  });
});

describe("AUTOMATION_IPC descriptor table", () => {
  const PIN = { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" };
  const COMMAND_ID = "00000000-0000-4000-8000-000000000001";
  const DRAFT = {
    commandId: COMMAND_ID,
    name: "Review",
    instructions: "/review go",
    // Carried as a value, never omitted: "Nothing else" is a union member so a
    // JSON transport can spell the default (docs/BOUNDARIES.md rule 3).
    trigger: { kind: "none" },
    runtime: null,
  };

  describe("volli:automation-list", () => {
    const { guard, invalidError } = AUTOMATION_IPC["volli:automation-list"];

    it("accepts a projectId record and refuses everything else", () => {
      expect(guard([{ projectId: "p1" }])).toBe(true);
      expect(guard([])).toBe(false);
      expect(guard([null])).toBe(false);
      expect(guard([{ projectId: 7 }])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid automation list request");
    });
  });

  describe("volli:automation-create", () => {
    const { guard, invalidError } = AUTOMATION_IPC["volli:automation-create"];

    it("accepts a project draft, a global draft, an inherit runtime and a whole pin", () => {
      expect(guard([{ projectId: "p1", ...DRAFT }])).toBe(true);
      expect(guard([{ projectId: null, ...DRAFT }])).toBe(true);
      expect(guard([{ projectId: "p1", ...DRAFT, runtime: PIN }])).toBe(true);
    });

    it("refuses a malformed envelope: arity, non-record, bad projectId", () => {
      expect(guard([])).toBe(false);
      expect(guard([{ projectId: "p1", ...DRAFT }, "extra"])).toBe(false);
      expect(guard(["p1"])).toBe(false);
      expect(guard([{ projectId: 7, ...DRAFT }])).toBe(false);
    });

    it("refuses a draft whose fields are not strings, and a HALF pin — the pair travels whole", () => {
      expect(guard([{ projectId: "p1", ...DRAFT, name: 7 }])).toBe(false);
      expect(guard([{ projectId: "p1", ...DRAFT, instructions: 7 }])).toBe(false);
      expect(guard([{ projectId: "p1", ...DRAFT, runtime: "pin" }])).toBe(false);
      expect(guard([{ projectId: "p1", ...DRAFT, runtime: { ...PIN, providerId: "" } }])).toBe(
        false,
      );
      expect(guard([{ projectId: "p1", ...DRAFT, runtime: { ...PIN, modelId: "" } }])).toBe(false);
      expect(
        guard([{ projectId: "p1", ...DRAFT, runtime: { ...PIN, reasoningLevel: "galactic" } }]),
      ).toBe(false);
      expect(
        guard([
          { projectId: "p1", ...DRAFT, runtime: { providerId: "anthropic", modelId: "opus" } },
        ]),
      ).toBe(false);
    });

    it("judges the Trigger's wire GRAMMAR, and leaves its meaning to the parser", () => {
      expect(guard([{ projectId: "p1", ...DRAFT, trigger: { kind: "none" } }])).toBe(true);
      // OMITTED is refused. "Only when I run it" is a complete answer with a
      // union member of its own, so absence is a second spelling of it that a
      // JSON transport could not carry — the door takes the value instead.
      expect(guard([{ projectId: "p1", ...DRAFT, trigger: undefined }])).toBe(false);
      const { trigger: _dropped, ...withoutTrigger } = DRAFT;
      expect(guard([{ projectId: "p1", ...withoutTrigger }])).toBe(false);
      expect(
        guard([{ projectId: "p1", ...DRAFT, trigger: { kind: "columns", columns: ["doing"] } }]),
      ).toBe(true);
      // Which column names are real, and whether the list collapses, is the
      // shared parser's job on the way in — so an unknown name passes HERE.
      expect(
        guard([{ projectId: "p1", ...DRAFT, trigger: { kind: "columns", columns: ["shipped"] } }]),
      ).toBe(true);
      // Not a record at all: a string, a number, null, an array. This is the
      // shape the parser cannot be asked to rescue, so the door refuses it.
      expect(guard([{ projectId: "p1", ...DRAFT, trigger: "columns" }])).toBe(false);
      expect(guard([{ projectId: "p1", ...DRAFT, trigger: 7 }])).toBe(false);
      expect(guard([{ projectId: "p1", ...DRAFT, trigger: null }])).toBe(false);
      expect(guard([{ projectId: "p1", ...DRAFT, trigger: ["doing"] }])).toBe(false);
      // A schedule (VC-130) passes as a SHAPE; whether its zone is one this
      // build's ICU knows, and whether its hour is on the clock, is the shared
      // parser's job on the way in — the same division the columns get above.
      expect(
        guard([
          {
            projectId: "p1",
            ...DRAFT,
            trigger: {
              kind: "schedule",
              schedule: { preset: "daily", hour: 21, minute: 0, timeZone: "Europe/London" },
            },
          },
        ]),
      ).toBe(true);
      expect(
        guard([
          {
            projectId: "p1",
            ...DRAFT,
            trigger: { kind: "schedule", schedule: { preset: "daily", timeZone: "Mars/Olympus" } },
          },
        ]),
      ).toBe(true);
      // A record, but not a Trigger this build can read.
      expect(guard([{ projectId: "p1", ...DRAFT, trigger: {} }])).toBe(false);
      expect(guard([{ projectId: "p1", ...DRAFT, trigger: { kind: "schedule" } }])).toBe(false);
      expect(
        guard([{ projectId: "p1", ...DRAFT, trigger: { kind: "schedule", schedule: "daily" } }]),
      ).toBe(false);
      expect(guard([{ projectId: "p1", ...DRAFT, trigger: { kind: "columns" } }])).toBe(false);
      expect(
        guard([{ projectId: "p1", ...DRAFT, trigger: { kind: "columns", columns: "doing" } }]),
      ).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid automation");
    });
  });

  describe("volli:automation-update", () => {
    const { guard, invalidError } = AUTOMATION_IPC["volli:automation-update"];

    it("accepts an automationId plus the draft shape", () => {
      expect(guard([{ automationId: "a1", ...DRAFT }])).toBe(true);
      expect(guard([{ automationId: "a1", ...DRAFT, runtime: PIN }])).toBe(true);
    });

    it("refuses a missing id, a non-record, wrong arity and a bad draft", () => {
      expect(guard([{ ...DRAFT }])).toBe(false);
      expect(guard([null])).toBe(false);
      expect(guard([])).toBe(false);
      expect(guard([{ automationId: "a1", ...DRAFT, name: 7 }])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid automation");
    });
  });

  describe("volli:automation-delete", () => {
    const { guard, invalidError } = AUTOMATION_IPC["volli:automation-delete"];

    it("accepts a command id plus Automation id and refuses everything else", () => {
      expect(guard([{ commandId: COMMAND_ID, automationId: "a1" }])).toBe(true);
      expect(guard([])).toBe(false);
      expect(guard([null])).toBe(false);
      expect(guard([{ commandId: "counter-1", automationId: "a1" }])).toBe(false);
      expect(guard([{ commandId: COMMAND_ID, automationId: 7 }])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid automation delete request");
    });
  });

  describe("volli:automation-run", () => {
    const { guard, invalidError } = AUTOMATION_IPC["volli:automation-run"];

    const bound = { kind: "automation", automationId: "a1" };

    it("requires a UUID command, a whole target and the Ticket", () => {
      expect(
        guard([{ commandId: COMMAND_ID, target: bound, ticketId: "t1", modelOverride: null }]),
      ).toBe(true);
      expect(guard([{ target: bound, ticketId: "t1", modelOverride: null }])).toBe(false);
      expect(
        guard([{ commandId: "counter-1", target: bound, ticketId: "t1", modelOverride: null }]),
      ).toBe(false);
      expect(guard([{ commandId: COMMAND_ID, ticketId: "t1", modelOverride: null }])).toBe(false);
      // The pre-VC-129 spelling, which named the Automation beside the Ticket:
      // a target is a union now, and a bare id is not one of its members.
      expect(
        guard([{ commandId: COMMAND_ID, automationId: "a1", ticketId: "t1", modelOverride: null }]),
      ).toBe(false);
      expect(guard([null])).toBe(false);
      expect(guard([])).toBe(false);
    });

    it("takes an Unbound Run's own Instructions, and no other target kind", () => {
      const unbound = { kind: "unbound", instructions: "/sweep" };
      expect(
        guard([{ commandId: COMMAND_ID, target: unbound, ticketId: "t1", modelOverride: null }]),
      ).toBe(true);
      // An Unbound Run with nothing to say passes the SHAPE and is refused by
      // the domain rule instead (`unboundRunProblem`) — the door judges wire
      // shape only, as it does for every other automation write.
      expect(
        guard([
          {
            commandId: COMMAND_ID,
            target: { kind: "unbound", instructions: "" },
            ticketId: "t1",
            modelOverride: null,
          },
        ]),
      ).toBe(true);
      expect(
        guard([
          {
            commandId: COMMAND_ID,
            target: { kind: "unbound", instructions: 7 },
            ticketId: "t1",
            modelOverride: null,
          },
        ]),
      ).toBe(false);
      expect(
        guard([
          {
            commandId: COMMAND_ID,
            target: { kind: "schedule" },
            ticketId: "t1",
            modelOverride: null,
          },
        ]),
      ).toBe(false);
      expect(
        guard([{ commandId: COMMAND_ID, target: null, ticketId: "t1", modelOverride: null }]),
      ).toBe(false);
    });

    it("takes a whole per-invocation model override, or none", () => {
      const modelOverride = { providerId: "anthropic", modelId: "opus", reasoningLevel: "high" };
      expect(guard([{ commandId: COMMAND_ID, target: bound, ticketId: "t1", modelOverride }])).toBe(
        true,
      );
      // Half a pair is not an override: a reasoning level is a property of the
      // model that offers it (VC-112), so neither half travels alone.
      expect(
        guard([
          {
            commandId: COMMAND_ID,
            target: bound,
            ticketId: "t1",
            modelOverride: { providerId: "anthropic", modelId: "opus" },
          },
        ]),
      ).toBe(false);
      expect(
        guard([
          {
            commandId: COMMAND_ID,
            target: bound,
            ticketId: "t1",
            modelOverride: { ...modelOverride, reasoningLevel: "turbo" },
          },
        ]),
      ).toBe(false);
      // Absent is not null: an optional property would admit `undefined`, which
      // an HTTP transport would mangle (docs/BOUNDARIES.md rule 3).
      expect(guard([{ commandId: COMMAND_ID, target: bound, ticketId: "t1" }])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid automation run request");
    });
  });

  describe("volli:automation-runs-for-ticket", () => {
    const { guard, invalidError } = AUTOMATION_IPC["volli:automation-runs-for-ticket"];

    it("accepts a ticketId record and refuses everything else", () => {
      expect(guard([{ ticketId: "t1" }])).toBe(true);
      expect(guard([])).toBe(false);
      expect(guard([null])).toBe(false);
      expect(guard([{ ticketId: 7 }])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid automation runs request");
    });
  });

  describe("volli:automation-arming-list", () => {
    const { guard, invalidError } = AUTOMATION_IPC["volli:automation-arming-list"];

    it("accepts a projectId record and refuses everything else", () => {
      expect(guard([{ projectId: "p1" }])).toBe(true);
      expect(guard([])).toBe(false);
      expect(guard([null])).toBe(false);
      expect(guard([{ projectId: 7 }])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid automation arming request");
    });
  });

  describe("volli:automation-arm", () => {
    const { guard, invalidError } = AUTOMATION_IPC["volli:automation-arm"];

    it("takes a project, a real column and an Automation — or null to disarm", () => {
      expect(
        guard([{ commandId: COMMAND_ID, projectId: "p1", status: "doing", automationId: "a1" }]),
      ).toBe(true);
      expect(
        guard([{ commandId: COMMAND_ID, projectId: "p1", status: "doing", automationId: null }]),
      ).toBe(true);
      expect(
        guard([{ commandId: COMMAND_ID, projectId: "p1", status: "shipped", automationId: "a1" }]),
      ).toBe(false);
      expect(guard([{ commandId: COMMAND_ID, projectId: "p1", automationId: "a1" }])).toBe(false);
      expect(guard([{ commandId: COMMAND_ID, status: "doing", automationId: "a1" }])).toBe(false);
      expect(guard([null])).toBe(false);
      expect(guard([])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid automation arm request");
    });
  });

  describe("volli:automation-runs-for-project", () => {
    const { guard, invalidError } = AUTOMATION_IPC["volli:automation-runs-for-project"];

    it("accepts a projectId record and refuses everything else", () => {
      expect(guard([{ projectId: "p1" }])).toBe(true);
      expect(guard([])).toBe(false);
      expect(guard([null])).toBe(false);
      expect(guard([{ projectId: 7 }])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid automation runs request");
    });
  });

  describe("volli:automation-enablement", () => {
    const { guard, invalidError } = AUTOMATION_IPC["volli:automation-enablement"];

    it("takes no arguments at all", () => {
      expect(guard([])).toBe(true);
      expect(guard([{}])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid automation enablement request");
    });
  });

  describe("volli:automation-set-enabled", () => {
    const { guard, invalidError } = AUTOMATION_IPC["volli:automation-set-enabled"];

    it("needs the target and a BOOLEAN, so a request is a value rather than a toggle", () => {
      expect(guard([{ commandId: COMMAND_ID, automationId: "a1", enabled: true }])).toBe(true);
      expect(guard([{ commandId: COMMAND_ID, automationId: "a1", enabled: false }])).toBe(true);
      expect(guard([{ commandId: COMMAND_ID, automationId: "a1" }])).toBe(false);
      expect(guard([{ commandId: COMMAND_ID, automationId: "a1", enabled: "yes" }])).toBe(false);
      expect(guard([{ commandId: COMMAND_ID, enabled: true }])).toBe(false);
      expect(guard([null])).toBe(false);
      expect(guard([])).toBe(false);
    });

    it("carries a UUID commandId like every other write — the switch is a command", () => {
      // The PROJECTION is machine-local (`automations/enablement.ts`); the
      // intent is durable, so a lost reply is retried rather than re-decided.
      // A durable retry identity is a UUID the renderer minted, so a
      // machine-local counter is refused here exactly as create/update/delete
      // refuse it — otherwise two hosts could collide on "c1".
      expect(guard([{ automationId: "a1", enabled: true }])).toBe(false);
      expect(guard([{ commandId: 7, automationId: "a1", enabled: true }])).toBe(false);
      expect(guard([{ commandId: "counter-1", automationId: "a1", enabled: true }])).toBe(false);
      expect(guard([{ commandId: "", automationId: "a1", enabled: true }])).toBe(false);
      expect(guard([{ commandId: `${COMMAND_ID}-extra`, automationId: "a1", enabled: true }])).toBe(
        false,
      );
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid automation enablement request");
    });
  });

  describe("AUTOMATION_CHANNELS derivation", () => {
    it("derives from the descriptor table's keys and covers the whole surface", () => {
      expect(AUTOMATION_CHANNELS).toEqual(Object.keys(AUTOMATION_IPC));
      // 11 through VC-128, plus VC-130's two: the project's Skipped
      // occurrences, and the Run door whose Target is the Project.
      expect(AUTOMATION_CHANNELS).toHaveLength(13);
    });
  });
});
