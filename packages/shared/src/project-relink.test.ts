import { describe, expect, it } from "vite-plus/test";

import {
  projectRelinkNotices,
  projectRelinkNoticeText,
  validateProjectRelink,
} from "./project-relink";
import type { ProjectRelinkAftermath, ProjectRelinkSubject } from "./project-relink";

const PROJECT: ProjectRelinkSubject = { id: "p1", name: "Volli", path: "/Users/me/volli" };

/** A move nothing was left behind by: no sessions, no worktrees, same folder name. */
const SETTLED: ProjectRelinkAftermath = {
  liveSessions: 0,
  worktrees: 0,
  worktreesRepaired: true,
  containerMoveNeeded: false,
  containerMoved: true,
};

describe("validateProjectRelink", () => {
  it("refuses a replacement folder that is not on disk", () => {
    const result = validateProjectRelink({
      project: PROJECT,
      candidatePath: "/Users/me/moved-volli",
      candidateState: "missing",
      projects: [PROJECT],
    });

    expect(result).toEqual({
      ok: false,
      refusal: "missing",
      error: "That folder doesn't exist.",
    });
  });

  it("refuses a replacement that is a file rather than a folder", () => {
    const result = validateProjectRelink({
      project: PROJECT,
      candidatePath: "/Users/me/volli.zip",
      candidateState: "not-a-directory",
      projects: [PROJECT],
    });

    expect(result).toEqual({
      ok: false,
      refusal: "not-a-directory",
      error: "That's a file, not a folder.",
    });
  });

  it("refuses a folder another project already tracks, naming that project", () => {
    const other: ProjectRelinkSubject = { id: "p2", name: "Atlas", path: "/Users/me/atlas" };

    const result = validateProjectRelink({
      project: PROJECT,
      candidatePath: "/Users/me/atlas",
      candidateState: "present",
      projects: [PROJECT, other],
    });

    expect(result).toEqual({
      ok: false,
      refusal: "claimed",
      error: "Atlas already tracks that folder.",
    });
  });

  it("refuses the folder this project already points at", () => {
    const result = validateProjectRelink({
      project: PROJECT,
      candidatePath: "/Users/me/volli",
      candidateState: "present",
      projects: [PROJECT],
    });

    expect(result).toEqual({
      ok: false,
      refusal: "unchanged",
      error: "Volli already points at that folder.",
    });
  });

  it("accepts a folder on disk that nothing else tracks, without its trailing slash", () => {
    const result = validateProjectRelink({
      project: PROJECT,
      candidatePath: "/Users/me/code/volli/",
      candidateState: "present",
      projects: [PROJECT],
    });

    expect(result).toEqual({ ok: true, path: "/Users/me/code/volli" });
  });

  // macOS is case-insensitive by default, so these two paths are ONE directory.
  // The strings differ, so a rule that compared them would accept the relink
  // and leave two rows on one checkout — the duplicate this refuses.
  it("refuses a folder another project tracks under a different spelling", () => {
    const other: ProjectRelinkSubject = {
      id: "p2",
      name: "Atlas",
      path: "/Users/me/atlas",
      folder: "16777232:5051",
    };

    const result = validateProjectRelink({
      project: PROJECT,
      candidatePath: "/Users/me/Atlas",
      candidateState: "present",
      candidateFolder: "16777232:5051",
      projects: [PROJECT, other],
    });

    expect(result).toEqual({
      ok: false,
      refusal: "claimed",
      error: "Atlas already tracks that folder.",
    });
  });

  it("refuses the folder this project already points at under a different spelling", () => {
    const result = validateProjectRelink({
      project: { ...PROJECT, folder: "16777232:9001" },
      candidatePath: "/Users/me/VOLLI",
      candidateState: "present",
      candidateFolder: "16777232:9001",
      projects: [PROJECT],
    });

    expect(result).toEqual({
      ok: false,
      refusal: "unchanged",
      error: "Volli already points at that folder.",
    });
  });

  // Two DIFFERENT directories that happen to be spelled alike cannot exist, but
  // two different directories whose identities differ are the ordinary case:
  // the identity must be what decides, not the coincidence of a shared prefix.
  it("accepts a folder whose identity differs from every tracked project's", () => {
    const other: ProjectRelinkSubject = {
      id: "p2",
      name: "Atlas",
      path: "/Users/me/atlas",
      folder: "16777232:5051",
    };

    const result = validateProjectRelink({
      project: { ...PROJECT, folder: "16777232:9001" },
      candidatePath: "/Users/me/code/volli",
      candidateState: "present",
      candidateFolder: "16777232:7777",
      projects: [PROJECT, other],
    });

    expect(result).toEqual({ ok: true, path: "/Users/me/code/volli" });
  });

  // The relink case itself: the project's OWN folder is gone, so it has no
  // identity to compare. Falling back to the paths is what lets the move
  // through — an unmeasurable folder must not read as "the same one".
  it("falls back to the paths when one side could not be measured", () => {
    const result = validateProjectRelink({
      project: PROJECT,
      candidatePath: "/Users/me/code/volli",
      candidateState: "present",
      candidateFolder: "16777232:7777",
      projects: [PROJECT],
    });

    expect(result).toEqual({ ok: true, path: "/Users/me/code/volli" });
  });
});

describe("projectRelinkNotices", () => {
  it("says nothing when nothing was left behind by the move", () => {
    expect(projectRelinkNotices(SETTLED)).toEqual([]);
  });

  it("reports sessions still running in the folder the project left", () => {
    expect(projectRelinkNotices({ ...SETTLED, liveSessions: 2 })).toEqual([
      "sessions-keep-old-cwd",
    ]);
  });

  it("reports ticket worktrees whose git links were repaired", () => {
    expect(projectRelinkNotices({ ...SETTLED, worktrees: 3, worktreesRepaired: true })).toEqual([
      "worktrees-repaired",
    ]);
  });

  it("reports ticket worktrees whose git links could not be repaired", () => {
    expect(projectRelinkNotices({ ...SETTLED, worktrees: 3, worktreesRepaired: false })).toEqual([
      "worktrees-unrepaired",
    ]);
  });

  // A repair that found nothing to fix is not worth saying: with no worktrees
  // linked, "repaired" and "could not repair" describe the same empty set.
  it("says nothing about worktrees when the project has none", () => {
    expect(projectRelinkNotices({ ...SETTLED, worktrees: 0, worktreesRepaired: false })).toEqual(
      [],
    );
  });

  it("reports the ticket worktrees that moved to keep matching the project", () => {
    expect(
      projectRelinkNotices({
        ...SETTLED,
        worktrees: 2,
        containerMoveNeeded: true,
        containerMoved: true,
      }),
    ).toEqual(["worktrees-repaired", "worktrees-followed"]);
  });

  it("reports the ticket worktrees that could not move", () => {
    expect(
      projectRelinkNotices({
        ...SETTLED,
        worktrees: 2,
        containerMoveNeeded: true,
        containerMoved: false,
      }),
    ).toEqual(["worktrees-repaired", "worktrees-left-behind"]);
  });

  // A move that did not rename the folder never had to touch the container, so
  // there is nothing to say about it either way.
  it("says nothing about the container when the folder name did not change", () => {
    expect(projectRelinkNotices({ ...SETTLED, worktrees: 2, containerMoveNeeded: false })).toEqual([
      "worktrees-repaired",
    ]);
  });

  // With no worktrees there is no container to move, so a needed move that
  // nothing was in reports nothing.
  it("says nothing about the container for a project with no worktrees", () => {
    expect(projectRelinkNotices({ ...SETTLED, worktrees: 0, containerMoveNeeded: true })).toEqual(
      [],
    );
  });
});

describe("projectRelinkNoticeText", () => {
  it("counts the sessions left behind, and says one of them in the singular", () => {
    expect(projectRelinkNoticeText("sessions-keep-old-cwd", { ...SETTLED, liveSessions: 1 })).toBe(
      "1 running session is still working in the old folder. Restart it to pick up the new path.",
    );
    expect(projectRelinkNoticeText("sessions-keep-old-cwd", { ...SETTLED, liveSessions: 4 })).toBe(
      "4 running sessions are still working in the old folder. Restart them to pick up the new path.",
    );
  });

  it("says which way the worktree repair went", () => {
    const repaired = { ...SETTLED, worktrees: 2, worktreesRepaired: true };
    expect(projectRelinkNoticeText("worktrees-repaired", repaired)).toBe(
      "Reconnected 2 ticket worktrees to the repository at its new path.",
    );

    const failed = { ...SETTLED, worktrees: 1, worktreesRepaired: false };
    expect(projectRelinkNoticeText("worktrees-unrepaired", failed)).toBe(
      "1 ticket worktree could not be reconnected. Run `git worktree repair` in the project folder.",
    );
  });

  // Deliberately COUNTLESS: `worktrees` is the whole set, and a row stamped
  // outside the container is in that set without having moved, so a number here
  // would be a claim the aftermath cannot support.
  it("says the worktrees followed without claiming a count", () => {
    const moved = { ...SETTLED, worktrees: 3, containerMoveNeeded: true, containerMoved: true };
    expect(projectRelinkNoticeText("worktrees-followed", moved)).toBe(
      "The ticket worktrees moved with it, so they stay under the project's folder name.",
    );
  });

  // The consequence is named, not implied: an unmoved container is one the app
  // no longer recognises as its own, which is what costs it cleanup.
  it("says what a container that could not move costs", () => {
    const stuck = { ...SETTLED, worktrees: 1, containerMoveNeeded: true, containerMoved: false };
    expect(projectRelinkNoticeText("worktrees-left-behind", stuck)).toBe(
      "The ticket worktrees could not move to match the folder's new name. Git still reaches them, but Volli's worktree cleanup will not list them.",
    );
  });
});
