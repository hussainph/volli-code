import { describe, expect, it } from "vite-plus/test";
import {
  personLabel,
  teamSessionModel,
  type Directory,
  type TeamSession,
} from "./cloud-team-model";

const directory: Directory = {
  viewerUserId: "ana",
  people: [
    { userId: "ana", displayName: "Ana Li", status: "active" },
    { userId: "ben", displayName: "Ben Jones", status: "left" },
  ],
};
const session: TeamSession = {
  ownerUserId: "ana",
  visibility: "private",
  role: "project",
  turnActive: true,
};

describe("team Session presentation", () => {
  it("names people, never mistakes another person or an unknown person for you", () => {
    expect(personLabel(directory, "ana")).toBe("You");
    expect(personLabel(directory, "ben")).toBe("Ben Jones");
    expect(personLabel(directory, "missing")).toBe("Unknown");
  });
  it("offers the owner's one-way Share only on private root Sessions", () => {
    expect(teamSessionModel(directory, session, false)).toMatchObject({
      canAct: true,
      canShare: true,
      private: true,
      initials: "AL",
      visibilityLabel: "Private",
    });
    expect(teamSessionModel(directory, { ...session, role: "subagent" }, false)?.canShare).toBe(
      false,
    );
    expect(teamSessionModel(directory, { ...session, visibility: "shared" }, false)).toMatchObject({
      canShare: false,
      private: false,
      visibilityLabel: "Shared with workspace",
    });
  });
  it("makes teammates read-only even under shareAll and preserves departed attribution", () => {
    const other = { ...session, ownerUserId: "ben" };
    expect(teamSessionModel(directory, other, true)).toMatchObject({
      canAct: false,
      canShare: false,
      visibilityLabel: "Visible to the workspace (admin setting)",
      ended: "Ended · Ben Jones left",
      initials: "BJ",
    });
    expect(teamSessionModel(directory, { ...other, turnActive: false }, true)?.ended).toBeNull();
    expect(teamSessionModel({ viewerUserId: null, people: [] }, session, false)).toMatchObject({
      canAct: false,
      canShare: false,
      ownerName: "Unknown",
    });
    expect(teamSessionModel(directory, null, false)).toBeNull();
  });
});
