import type { Project, Ticket } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { buildCommandPaletteItems } from "./command-palette-model";
import { scratchScope, ticketScope, type SessionContainer } from "@renderer/stores/sessions";

function project(id: string, name: string, ticketPrefix: string): Project {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    ticketPrefix,
    colorIndex: 0,
    sortOrder: 0,
    baseBranch: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function ticket(
  id: string,
  projectId: string,
  number: number,
  title: string,
  updatedAt: number,
): Ticket {
  return {
    id,
    projectId,
    ticketNumber: number,
    title,
    body: "",
    status: "todo",
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    order: 0,
    createdAt: 0,
    updatedAt,
  };
}

function container(...tabs: SessionContainer["tabs"]): SessionContainer {
  return { tabs, activeSessionId: tabs[0]?.sessionId ?? null };
}

describe("buildCommandPaletteItems", () => {
  it("lists every ticket with current-project and recency ordering", () => {
    const alpha = project("p1", "Alpha", "ALP");
    const beta = project("p2", "Beta", "BET");
    const old = ticket("t1", alpha.id, 1, "Old", 10);
    const recent = ticket("t2", beta.id, 2, "Recent", 50);

    const result = buildCommandPaletteItems(
      [alpha, beta],
      { [alpha.id]: [old], [beta.id]: [recent] },
      {},
      alpha.id,
    );

    expect(result.tickets.map((item) => `${item.displayId}:${item.title}`)).toEqual([
      "ALP-1:Old",
      "BET-2:Recent",
    ]);
  });

  it("lists multiple live tabs per ticket plus scratch sessions", () => {
    const alpha = project("p1", "Alpha", "ALP");
    const linked = ticket("t1", alpha.id, 1, "Fix auth", 10);
    const scope = ticketScope(alpha.id, linked.id);

    const result = buildCommandPaletteItems(
      [alpha],
      { [alpha.id]: [linked] },
      {
        [linked.id]: container(
          {
            sessionId: "s1",
            title: "Claude review",
            scope,
            layout: { kind: "pane", sessionId: "s1", exitCode: null },
            activePaneId: "s1",
          },
          {
            sessionId: "s2",
            title: "Test runner",
            scope,
            layout: { kind: "pane", sessionId: "s2", exitCode: null },
            activePaneId: "s2",
          },
        ),
        [alpha.id]: container({
          sessionId: "scratch",
          title: "Scratch terminal",
          scope: scratchScope(alpha.id),
          layout: { kind: "pane", sessionId: "scratch", exitCode: null },
          activePaneId: "scratch",
        }),
      },
      alpha.id,
    );

    expect(result.sessions.map((item) => item.title)).toEqual([
      "Claude review",
      "Scratch terminal",
      "Test runner",
    ]);
    expect(result.sessions.find((item) => item.sessionId === "s1")?.ticketDisplayId).toBe("ALP-1");
    expect(
      result.sessions.find((item) => item.sessionId === "scratch")?.ticketDisplayId,
    ).toBeNull();
  });

  it("drops stale session scopes whose project or ticket no longer exists", () => {
    const alpha = project("p1", "Alpha", "ALP");
    const stale = ticketScope(alpha.id, "missing-ticket");
    const result = buildCommandPaletteItems(
      [alpha],
      { [alpha.id]: [] },
      {
        stale: container({
          sessionId: "stale",
          title: "Stale",
          scope: stale,
          layout: { kind: "pane", sessionId: "stale", exitCode: null },
          activePaneId: "stale",
        }),
      },
      alpha.id,
    );
    expect(result.sessions).toEqual([]);
  });
});
