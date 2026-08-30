import { describe, expect, it } from "vite-plus/test";

import {
  automationMarkName,
  automationProvenanceName,
  drawsSessionProvenanceMark,
  PERSON_STARTED,
  sessionProvenanceHoverLine,
  sessionProvenanceOf,
  type SessionProvenance,
} from "./session-provenance";

const AUTOMATION: SessionProvenance = { kind: "automation", automationName: "Nightly sweep" };
const UNBOUND: SessionProvenance = { kind: "automation", automationName: null };
const PARENT: SessionProvenance = {
  kind: "session",
  parentSessionId: "session-parent",
  parentTitle: "Orchestrator",
};

describe("PERSON_STARTED", () => {
  it("is the resting case and carries nothing beyond its kind", () => {
    expect(PERSON_STARTED).toEqual({ kind: "user" });
  });

  it("is frozen, so the one shared value cannot be edited into another party", () => {
    expect(Object.isFrozen(PERSON_STARTED)).toBe(true);
  });
});

describe("sessionProvenanceOf", () => {
  it("reads a Session the map has something to say about", () => {
    expect(sessionProvenanceOf({ "session-run": AUTOMATION }, "session-run")).toEqual(AUTOMATION);
  });

  // The holes ARE the answer: a project nobody has automated stores an empty
  // object, and every Session in it reads as person-started from that.
  it("reads a miss as the resting case, by identity", () => {
    expect(sessionProvenanceOf({}, "session-human")).toBe(PERSON_STARTED);
    expect(sessionProvenanceOf({ "session-run": AUTOMATION }, "session-human")).toBe(
      PERSON_STARTED,
    );
  });
});

describe("drawsSessionProvenanceMark", () => {
  it("marks only a Run-started Session", () => {
    expect(drawsSessionProvenanceMark(AUTOMATION)).toBe(true);
    expect(drawsSessionProvenanceMark(UNBOUND)).toBe(true);
  });

  // The acceptance criterion, as a test rather than as a comment: a rail of
  // person-started Sessions, and one whose parent is another Session, must both
  // stay quiet. Only the bolt is resting weight.
  it("leaves a person-started and a Session-started row unmarked", () => {
    expect(drawsSessionProvenanceMark(PERSON_STARTED)).toBe(false);
    expect(drawsSessionProvenanceMark(PARENT)).toBe(false);
  });
});

describe("automationProvenanceName", () => {
  it("is the bound Automation's name at launch", () => {
    expect(automationProvenanceName({ automationName: "Nightly sweep" })).toBe("Nightly sweep");
  });

  it("names the act for an Unbound Run, which has no record to name", () => {
    expect(automationProvenanceName({ automationName: null })).toBe("Run once");
  });
});

describe("automationMarkName", () => {
  it("says nothing for a row that is not a Run's", () => {
    expect(automationMarkName(PERSON_STARTED, "Plan the migration")).toBeNull();
    expect(automationMarkName(PARENT, "Plan the migration")).toBeNull();
  });

  // The ordinary Run: `run.ts` titles the Session after its Automation, so the
  // word is already the largest text on the row.
  it("does not repeat a name the row's title already is", () => {
    expect(automationMarkName(AUTOMATION, "Nightly sweep")).toBeNull();
    expect(automationMarkName(AUTOMATION, "  nightly SWEEP ")).toBeNull();
  });

  it("prints the name once the title no longer carries it", () => {
    expect(automationMarkName(AUTOMATION, "Fixing the flaky worktree test")).toBe("Nightly sweep");
    expect(automationMarkName(UNBOUND, "Fixing the flaky worktree test")).toBe("Run once");
  });
});

describe("sessionProvenanceHoverLine", () => {
  it("says nothing for a Session a person started", () => {
    expect(sessionProvenanceHoverLine(PERSON_STARTED)).toBeNull();
  });

  it("leads with the noun for a Run, so the two lines cannot be confused", () => {
    expect(sessionProvenanceHoverLine(AUTOMATION)).toBe("Automation · Nightly sweep");
    expect(sessionProvenanceHoverLine(UNBOUND)).toBe("Automation · Run once");
  });

  it("names the parent Session, which is the whole of that mark", () => {
    expect(sessionProvenanceHoverLine(PARENT)).toBe("Started by Orchestrator");
  });

  it("still says no person opened it when the parent cannot be named", () => {
    expect(
      sessionProvenanceHoverLine({
        kind: "session",
        parentSessionId: "session-parent",
        parentTitle: null,
      }),
    ).toBe("Started by another Session");
  });
});
