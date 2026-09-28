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
  containerRenamed: false,
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

  it("reports that new worktrees will be grouped under the new folder name", () => {
    expect(projectRelinkNotices({ ...SETTLED, containerRenamed: true })).toEqual([
      "worktree-container-renamed",
    ]);
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

  it("says where the next worktree will be created", () => {
    expect(
      projectRelinkNoticeText("worktree-container-renamed", {
        ...SETTLED,
        containerRenamed: true,
      }),
    ).toBe("New worktrees will be grouped under the new folder name; existing ones stay put.");
  });
});
