import { afterEach, describe, expect, it } from "vite-plus/test";
import { createSessionEngine } from "@volli/session-engine";
import { getHarnessAdapter } from "@volli/shared";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import { insertTicket } from "../db/tickets-repo";
import { createSqliteSessionLedger } from "../session-control";
import { terminalNativeReference } from "../session-control";
import { resolveScope } from "./scope";

let ctx: TestDb;

afterEach(() => ctx.cleanup());

const provenance = {
  source: { kind: "system" as const, id: "test", detail: null },
  venue: { id: "local", kind: "local" as const },
};

function setup() {
  ctx = openTestDb();
  const project = testProject({ id: "project", path: "/repo" });
  const ticket = testTicket(project.id, { id: "ticket", usesWorktree: false });
  insertProject(ctx.db, project);
  insertTicket(ctx.db, ticket);
  let id = 0;
  const control = createSessionEngine({
    ledger: createSqliteSessionLedger(ctx.db),
    clock: { now: () => 1 },
    ids: { next: (kind) => `${kind}-${++id}` },
  });
  return { project, ticket, control };
}

async function seedTerminal(
  control: ReturnType<typeof createSessionEngine>,
  input: {
    projectId: string;
    ticketId: string | null;
    title: string;
    launchKind?: "agent" | "shell";
    close?: boolean;
  },
): Promise<string> {
  const created = await control.createSession({
    commandId: `create-${input.title}`,
    projectId: input.projectId,
    ticketId: input.ticketId,
    title: input.title,
    provenance,
  });
  const start = await control.submit({
    commandId: `start-${input.title}`,
    sessionId: created.session.id,
    intent: { kind: "executor.start", adapterId: "terminal", continuity: "fresh" },
    provenance,
  });
  await control.observe({
    id: `open-${input.title}`,
    kind: "attachment.opened",
    sessionId: created.session.id,
    commandId: start.command.id,
    occurredAt: 2,
    provenance,
    attachment: {
      id: `attachment-${input.title}`,
      sessionId: created.session.id,
      adapterId: "terminal",
      venue: { id: "local", kind: "local" },
      continuity: "fresh",
      native: terminalNativeReference({
        kind: "volli.terminal.v1",
        cwd: "/repo",
        harnessId: "claude-code",
        activeHarnessId: null,
        harnessSessionId: "native-id",
        launchKind: input.launchKind ?? "agent",
        placement: "tab",
        exitCode: null,
      }),
    },
  });
  if (input.close) {
    await control.observe({
      id: `close-${input.title}`,
      kind: "attachment.closed",
      sessionId: created.session.id,
      attachmentId: `attachment-${input.title}`,
      occurredAt: 3,
      provenance,
      outcome: "completed",
    });
  }
  return created.session.id;
}

describe("resolveScope", () => {
  it("numbers from control-plane projections rather than terminal columns", async () => {
    const { project, ticket, control } = setup();
    await control.createSession({
      commandId: "create",
      projectId: project.id,
      ticketId: ticket.id,
      title: "Session 1",
      provenance,
    });

    const result = await resolveScope(
      ctx.db,
      control,
      {
        workspaceId: project.id,
        cwd: project.path,
        cols: 80,
        rows: 24,
        ticket: { ticketId: ticket.id },
      },
      "",
      () => null,
      (id) => getHarnessAdapter(id),
    );

    expect(result).toMatchObject({ ok: true, scope: { title: "Session 2", resume: null } });
  });

  it("numbers scratch Sessions through the scratch projection scope", async () => {
    const { project, control } = setup();
    await seedTerminal(control, {
      projectId: project.id,
      ticketId: null,
      title: "Terminal 1",
      close: true,
    });
    const result = await resolveScope(
      ctx.db,
      control,
      { workspaceId: project.id, cwd: project.path, cols: 80, rows: 24 },
      "",
      () => null,
      (id) => getHarnessAdapter(id),
    );
    expect(result).toMatchObject({ ok: true, scope: { title: "Terminal 2", ticketId: null } });
  });

  it("rejects unknown, mismatched, open, and shell history instead of manufacturing a resume", async () => {
    const { project, ticket, control } = setup();
    const other = testTicket(project.id, { id: "other", usesWorktree: false });
    insertTicket(ctx.db, other);
    const mismatched = await seedTerminal(control, {
      projectId: project.id,
      ticketId: other.id,
      title: "Other",
      close: true,
    });
    const open = await seedTerminal(control, {
      projectId: project.id,
      ticketId: ticket.id,
      title: "Open",
    });
    const shell = await seedTerminal(control, {
      projectId: project.id,
      ticketId: ticket.id,
      title: "Shell",
      launchKind: "shell",
      close: true,
    });
    const resolve = (sessionId: string) =>
      resolveScope(
        ctx.db,
        control,
        {
          workspaceId: project.id,
          cwd: project.path,
          cols: 80,
          rows: 24,
          ticket: { ticketId: ticket.id, resume: { sessionId } },
        },
        "",
        () => null,
        (id) => getHarnessAdapter(id),
      );
    await expect(resolve("missing")).resolves.toMatchObject({
      ok: false,
      error: "Cannot resume an unknown session",
    });
    await expect(resolve(mismatched)).resolves.toMatchObject({
      ok: false,
      error: "Cannot resume a session that belongs to another ticket",
    });
    await expect(resolve(open)).resolves.toMatchObject({
      ok: false,
      error: "Cannot resume a session that is still live",
    });
    await expect(resolve(shell)).resolves.toMatchObject({
      ok: false,
      error: "Only an agent session can be resumed",
    });
  });

  it("reuses a closed native Session identity for its next terminal attachment", async () => {
    const { project, ticket, control } = setup();
    const prior = await seedTerminal(control, {
      projectId: project.id,
      ticketId: ticket.id,
      title: "Investigate",
      close: true,
    });
    const result = await resolveScope(
      ctx.db,
      control,
      {
        workspaceId: project.id,
        cwd: project.path,
        cols: 80,
        rows: 24,
        ticket: { ticketId: ticket.id, resume: { sessionId: prior } },
      },
      "",
      () => null,
      (id) => getHarnessAdapter(id),
    );
    expect(result).toMatchObject({
      ok: true,
      scope: { title: "Investigate", resume: { sessionId: prior, harnessSessionId: "native-id" } },
    });
  });
});
