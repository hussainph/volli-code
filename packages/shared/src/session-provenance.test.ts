import { describe, expect, it } from "vite-plus/test";

import {
  automationMarkLabel,
  automationMarkName,
  drawsSessionProvenanceMark,
  PERSON_STARTED,
  sessionProvenanceHoverLine,
  sessionProvenanceOf,
  type SessionProvenance,
} from "./session-provenance";

const AUTOMATION: SessionProvenance = { kind: "automation", automationName: "Nightly sweep" };
/**
 * A Run whose Automation cannot be named: an Unbound Run, or one whose
 * `automation_runs` row had not landed when the app stopped. The mark treats
 * the two alike — see `SessionProvenance`.
 */
const UNNAMED: SessionProvenance = { kind: "automation", automationName: null };
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
    // A Run whose Automation cannot be named is still a Run: the bolt and the
    // board's live ring both hang off this answer, and losing them in the
    // pre-Run window is what makes a Run read as person-started.
    expect(drawsSessionProvenanceMark(UNNAMED)).toBe(true);
  });

  // The acceptance criterion, as a test rather than as a comment: a rail of
  // person-started Sessions, and one whose parent is another Session, must both
  // stay quiet. Only the bolt is resting weight.
  it("leaves a person-started and a Session-started row unmarked", () => {
    expect(drawsSessionProvenanceMark(PERSON_STARTED)).toBe(false);
    expect(drawsSessionProvenanceMark(PARENT)).toBe(false);
  });
});

describe("automationMarkLabel", () => {
  it("names the Automation in full, whatever the visible half decided", () => {
    expect(automationMarkLabel(AUTOMATION)).toBe("Started by the Automation Nightly sweep");
  });

  // Not silence: the sentence keeps the half it knows rather than letting a
  // Run's Session be announced as one nobody's machinery started.
  it("still says an Automation started it when it cannot name which", () => {
    expect(automationMarkLabel(UNNAMED)).toBe("Started by an Automation");
  });

  it("says nothing for the two arms that draw no bolt", () => {
    expect(automationMarkLabel(PERSON_STARTED)).toBeNull();
    expect(automationMarkLabel(PARENT)).toBeNull();
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
  });

  // The bolt has already said the only thing that is known here, and a
  // stand-in word beside it would be a name the reader could go looking for.
  it("prints nothing for an Automation it cannot name", () => {
    expect(automationMarkName(UNNAMED, "Fixing the flaky worktree test")).toBeNull();
  });
});

describe("sessionProvenanceHoverLine", () => {
  it("says nothing for a Session a person started", () => {
    expect(sessionProvenanceHoverLine(PERSON_STARTED)).toBeNull();
  });

  it("leads with the noun for a Run, so the two lines cannot be confused", () => {
    expect(sessionProvenanceHoverLine(AUTOMATION)).toBe("Automation · Nightly sweep");
  });

  it("says the useful half for a Run whose Automation it cannot name", () => {
    expect(sessionProvenanceHoverLine(UNNAMED)).toBe("Started by an Automation");
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
