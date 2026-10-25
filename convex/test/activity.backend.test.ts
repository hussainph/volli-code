import { randomUUID } from "node:crypto";

import { beforeAll, expect, test } from "vite-plus/test";

import type { ActivityPage } from "@volli/shared/cloud";

import { api } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";

const backend = connectBackend();
const uuid = () => randomUUID();

// The backend is shared by every file in the run: this file signs in as a
// fresh subject with its own Workspace and two projects.
const subject = `user:${uuid()}`;
const client = () => backend.client(subject);
let workspaceId: string;
const projects: string[] = [];

const created = (page: ActivityPage) =>
  page.page.flatMap((item) => (item.what.kind === "created" ? [item.what.title] : []));

beforeAll(async () => {
  await client().mutation(api.accounts.ensureViewer, {});
  const [workspace] = await client().query(api.workspaces.listMine, {});
  workspaceId = workspace!.workspaceId;
  for (const name of ["Feed one", "Feed two"]) {
    const projectId = uuid();
    await client().mutation(api.projects.create, {
      commandId: uuid(),
      workspaceId,
      projectId,
      name,
      origin: "github",
    });
    projects.push(projectId);
  }
}, 120_000);

test("the Workspace feed merges its projects' histories on a real backend, page by page", async () => {
  const titles: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const title = `Ticket ${index}`;
    titles.unshift(title);
    await client().mutation(api.board.createTicket, {
      commandId: uuid(),
      projectId: projects[index % 2]!,
      ticketId: uuid(),
      status: "todo",
      title,
    });
  }

  const whole = await client().query(api.activity.workspace, {
    workspaceId,
    page: { numItems: 50, cursor: null },
  });
  // Newest first; events in the same millisecond may tie across projects, so
  // only the set is fixed here (the order rule is covered by the unit suite).
  expect(created(whole).toSorted()).toEqual(titles.toSorted());
  expect(whole.isDone).toBe(true);

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 10; pages += 1) {
    const page: ActivityPage = await client().query(api.activity.workspace, {
      workspaceId,
      page: { numItems: 2, cursor },
    });
    seen.push(...created(page));
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  expect(seen).toEqual(created(whole));
});
