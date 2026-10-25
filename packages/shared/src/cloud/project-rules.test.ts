import { describe, expect, test } from "vite-plus/test";

import { PROJECT_COLORS } from "../project-prefix";
import { BoardRuleError } from "./board-rules";
import { decideArchiveProject, decideCreateProject, decideRenameProject } from "./project-rules";

function refusal(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BoardRuleError);
    return { code: (error as BoardRuleError).code, message: (error as Error).message };
  }
  throw new Error("expected a refusal");
}

describe("decideCreateProject", () => {
  test("derives the prefix from the name, assigns the next tile colour, records project_created", () => {
    const decision = decideCreateProject(
      { projects: [{ name: "Other", ticketPrefix: "OT" }] },
      { name: "  Volli Code  ", description: " The app " },
    );
    expect(decision).toEqual({
      name: "Volli Code",
      description: "The app",
      ticketPrefix: "VC",
      colorIndex: 1,
      events: [
        {
          ticketId: null,
          payload: { kind: "project_created", name: "Volli Code", ticketPrefix: "VC" },
        },
      ],
    });
  });

  test("takes a named prefix and wraps the colour round the palette", () => {
    const projects = PROJECT_COLORS.map((_, index) => ({
      name: `P${index}`,
      ticketPrefix: `P${index}`,
    }));
    const decision = decideCreateProject({ projects }, { name: "Next", ticketPrefix: "NX" });
    expect(decision.ticketPrefix).toBe("NX");
    expect(decision.description).toBe("");
    expect(decision.colorIndex).toBe(0);
  });

  test("refuses an invalid prefix, a taken one, and an over-long description", () => {
    expect(
      refusal(() => decideCreateProject({ projects: [] }, { name: "A", ticketPrefix: "vc" })).code,
    ).toBe("invalid_argument");
    expect(
      refusal(() =>
        decideCreateProject(
          { projects: [{ name: "Volli", ticketPrefix: "VC" }] },
          { name: "Volli Code" },
        ),
      ),
    ).toEqual({ code: "prefix_taken", message: 'Ticket prefix "VC" is already used by Volli.' });
    expect(
      refusal(() =>
        decideCreateProject({ projects: [] }, { name: "A", description: "x".repeat(2_001) }),
      ).code,
    ).toBe("invalid_argument");
  });
});

describe("decideRenameProject", () => {
  test("trims and bounds the name", () => {
    expect(refusal(() => decideRenameProject({ name: "A" }, "   ")).code).toBe("invalid_argument");
    expect(refusal(() => decideRenameProject({ name: "A" }, "x".repeat(201))).code).toBe(
      "invalid_argument",
    );
  });

  test("records the rename, and the same name changes nothing", () => {
    expect(decideRenameProject({ name: "A" }, " B ")).toEqual({
      patch: { name: "B" },
      events: [{ ticketId: null, payload: { kind: "project_renamed", from: "A", to: "B" } }],
    });
    expect(decideRenameProject({ name: "A" }, "A ")).toEqual({ patch: {}, events: [] });
  });
});

describe("decideArchiveProject", () => {
  test("archives and restores once; a repeat changes nothing", () => {
    expect(decideArchiveProject({ archivedAt: null }, true, 9)).toEqual({
      patch: { archivedAt: 9 },
      events: [{ ticketId: null, payload: { kind: "project_archived" } }],
    });
    expect(decideArchiveProject({ archivedAt: 9 }, false, 10)).toEqual({
      patch: { archivedAt: null },
      events: [{ ticketId: null, payload: { kind: "project_unarchived" } }],
    });
    expect(decideArchiveProject({ archivedAt: 9 }, true, 10)).toEqual({ patch: {}, events: [] });
    expect(decideArchiveProject({ archivedAt: null }, false, 10)).toEqual({
      patch: {},
      events: [],
    });
  });
});
