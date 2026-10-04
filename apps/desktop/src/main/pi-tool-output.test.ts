import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "@volli/host-core/db/projects-repo";
import {
  openTestDb,
  testProject,
  testSession,
  testTicket,
  type TestDb,
} from "@volli/host-core/db/test-helpers";
import { insertTicket } from "@volli/host-core/db/tickets-repo";
import { insertSession } from "./session-control/test-support";
import { piSessionDirectoryName, piSessionFilename } from "./pi-session-orphans";
import { removeTicketToolOutput } from "./pi-tool-output";

let ctx: TestDb;
let root: string;

beforeEach(async () => {
  ctx = openTestDb();
  root = await mkdtemp(join(tmpdir(), "volli-pi-tool-output-"));
});

afterEach(() => {
  ctx.cleanup();
  rmSync(root, { recursive: true, force: true });
});

/** A Pi sidecar path in the owned layout, with saved output beside it. */
function sidecarWithOutput(id: string): { sidecar: string; output: string } {
  const directory = join(root, piSessionDirectoryName("/Users/test/code/project"));
  mkdirSync(directory, { recursive: true });
  const sidecar = join(directory, piSessionFilename(Date.parse("2026-01-02T03:04:05Z"), id));
  writeFileSync(sidecar, "{}\n");
  const output = sidecar.replace(/\.jsonl$/u, ".tool-output");
  mkdirSync(output);
  writeFileSync(join(output, "tc-1.0a1b2c3d.txt"), "saved");
  return { sidecar, output };
}

/** A Session on `ticketId` whose one attachment is Pi's, bound to `detail`. */
function piSession(projectId: string, ticketId: string | null, detail: unknown): void {
  const session = testSession(projectId, ticketId);
  insertSession(ctx.db, session);
  ctx.db
    .prepare(
      `UPDATE session_attachments SET adapter_id = 'pi', native_detail = ? WHERE session_id = ?`,
    )
    .run(detail === null ? null : JSON.stringify(detail), session.id);
}

function binding(sessionFilePath: unknown, runtime = "pi"): unknown {
  return {
    kind: "volli.native-binding.v1",
    directory: "/Users/test/code/project",
    runtime: { path: "pi", version: "1", fingerprint: "sha256:test" },
    locator: { runtime, sessionId: "s", sessionFilePath },
  };
}

describe("removeTicketToolOutput", () => {
  it("removes the saved output of the ticket's Pi attachments, and nobody else's", () => {
    const project = testProject();
    insertProject(ctx.db, project);
    const ticket = testTicket(project.id);
    const other = testTicket(project.id);
    insertTicket(ctx.db, ticket);
    insertTicket(ctx.db, other);
    const mine = sidecarWithOutput("mine");
    const theirs = sidecarWithOutput("theirs");
    const boardChat = sidecarWithOutput("board");
    piSession(project.id, ticket.id, binding(mine.sidecar));
    piSession(project.id, other.id, binding(theirs.sidecar));
    piSession(project.id, null, binding(boardChat.sidecar));

    expect(removeTicketToolOutput(ctx.db, root, ticket.id)).toBe(1);

    expect(existsSync(mine.output)).toBe(false);
    // The sidecar, the conversation, stays.
    expect(existsSync(mine.sidecar)).toBe(true);
    expect(existsSync(theirs.output)).toBe(true);
    expect(existsSync(boardChat.output)).toBe(true);
    // Nothing left to remove the second time.
    expect(removeTicketToolOutput(ctx.db, root, ticket.id)).toBe(0);
  });

  it("touches nothing a record names outside the owned layout, or cannot read", () => {
    const project = testProject();
    insertProject(ctx.db, project);
    const ticket = testTicket(project.id);
    insertTicket(ctx.db, ticket);
    const outside = join(root, "..", `outside-${Date.now()}`);
    mkdirSync(`${outside}.tool-output`, { recursive: true });
    const flat = join(root, "flat.jsonl");
    mkdirSync(join(root, "flat.tool-output"));
    const unlayered = join(root, "not-a-pi-dir", "x.jsonl");
    mkdirSync(join(root, "not-a-pi-dir", "x.tool-output"), { recursive: true });
    const text = join(root, piSessionDirectoryName("/p"), "x.txt");
    mkdirSync(join(root, piSessionDirectoryName("/p"), "x.txt.tool-output"), { recursive: true });
    for (const detail of [
      binding(`${outside}.jsonl`),
      binding(flat),
      binding(unlayered),
      binding(text),
      binding(join(root, "--p--", "y.jsonl"), "other-runtime"),
      binding(42),
      { kind: "something-else" },
      { kind: "volli.native-binding.v1", locator: null },
      "not json at all",
      7,
    ]) {
      piSession(project.id, ticket.id, detail);
    }

    expect(removeTicketToolOutput(ctx.db, root, ticket.id)).toBe(0);
    expect(existsSync(`${outside}.tool-output`)).toBe(true);
    expect(existsSync(join(root, "flat.tool-output"))).toBe(true);
    expect(existsSync(join(root, "not-a-pi-dir", "x.tool-output"))).toBe(true);
    rmSync(`${outside}.tool-output`, { recursive: true, force: true });
  });

  it("removes a link standing in the directory's place, never what it points at", () => {
    const project = testProject();
    insertProject(ctx.db, project);
    const ticket = testTicket(project.id);
    insertTicket(ctx.db, ticket);
    const { sidecar, output } = sidecarWithOutput("linked");
    rmSync(output, { recursive: true });
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "keep.txt"), "keep");
    symlinkSync(elsewhere, output);
    piSession(project.id, ticket.id, binding(sidecar));

    expect(removeTicketToolOutput(ctx.db, root, ticket.id)).toBe(1);
    expect(existsSync(join(elsewhere, "keep.txt"))).toBe(true);
  });
});
