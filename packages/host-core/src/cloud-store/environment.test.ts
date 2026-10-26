import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import type { PowerEvent, PowerPort } from "../ports/power";
import { readEnvironmentRun } from "../worktree/environment-runs";
import {
  isFirstRunPending,
  markFirstRunPending,
  workingCopyRecordPath,
} from "../worktree/first-run";
import { resetPhasesForTest } from "../worktree/phase";
import { resetResumeEpochForTest } from "../worktree/resume-exec";
import type { WorktreePhase } from "../worktree/types";
import { createCloudEnvironmentPreparation } from "./environment";

let ctx: TestDb;
let root: string;
let directory: string;
type PreparationInput = Parameters<ReturnType<typeof createCloudEnvironmentPreparation>>[0];

beforeEach(() => {
  ctx = openTestDb();
  root = mkdtempSync(join(tmpdir(), "volli-cloud-environment-"));
  directory = join(root, "working-copy");
  mkdirSync(directory);
  insertProject(ctx.db, testProject({ id: "p", path: root }));
  insertTicket(ctx.db, testTicket("p", { id: "t" }));
  resetResumeEpochForTest();
  resetPhasesForTest();
  markFirstRunPending({ home: root }, directory, "t", ["setup"]);
});

afterEach(() => {
  vi.restoreAllMocks();
  ctx.cleanup();
  rmSync(root, { recursive: true, force: true });
});

function script(name: "setup" | "resume", body: string): void {
  mkdirSync(join(directory, ".agents"), { recursive: true });
  writeFileSync(join(directory, ".agents", name), body);
}

function input(): PreparationInput {
  return {
    request: { sessionId: "session-a", projectId: "p", ticketId: "t" },
    facts: {
      project: { id: "p", name: "Cloud project", setupCommand: "touch stored-ran" },
      ticketPrefix: "VC",
      ticket: {
        id: "t",
        projectId: "p",
        title: "Cloud ticket",
        number: 17,
        checkoutMode: "worktree",
        branch: null,
        baseBranch: "main",
      },
      primaryRepo: { id: "repo", projectId: "p", baseBranch: "main" },
    },
    directory,
    outcome: {
      identity: { worktreePath: directory, branch: "volli/VC-17-cloud-ticket", baseBranch: "main" },
      created: true,
      restamped: true,
      setupPending: true,
    },
  };
}

function fixture() {
  const listeners = new Map<PowerEvent, () => void>();
  const power: PowerPort = {
    on: vi.fn((event, listener) => listeners.set(event, listener)),
    removeListener: () => undefined,
  };
  const environment = vi.fn(async (_sessionId: string) => ({
    shellPath: "/bin/sh",
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", VOLLI_CONCURRENCY_HINT: "1" },
  }));
  const phases: WorktreePhase[] = [];
  const prepare = createCloudEnvironmentPreparation({
    db: ctx.db,
    home: root,
    power,
    environment,
    onPhase: (_ticketId, phase) => phases.push(phase),
  });
  return { prepare, environment, phases, power, listeners };
}

function boardRows() {
  return {
    projects: ctx.db.prepare("SELECT * FROM projects").all(),
    tickets: ctx.db.prepare("SELECT * FROM tickets").all(),
    events: ctx.db.prepare("SELECT * FROM ticket_events").all(),
  };
}

describe("cloud environment preparation", () => {
  it("runs repository setup before resume with the Session environment, without touching the frozen board", async () => {
    script(
      "setup",
      'printf "%s %s %s %s %s" "$VOLLI_PROJECT" "$VOLLI_TICKET" "$VOLLI_SETUP_REASON" "$VOLLI_CONCURRENCY_HINT" "$VOLLI_WORKING_COPY" > setup-env\n',
    );
    script(
      "resume",
      'test -f setup-env || exit 9\nprintf "%s" "$VOLLI_RESUME_REASON" > resume-reason\n',
    );
    const { prepare, environment, phases } = fixture();
    const before = boardRows();
    const sql = vi.spyOn(ctx.db, "prepare");

    await expect(prepare(input())).resolves.toBeUndefined();

    expect(sql).not.toHaveBeenCalled();
    expect(boardRows()).toEqual(before);
    expect(environment.mock.calls).toEqual([["session-a"], ["session-a"]]);
    expect(readFileSync(join(directory, "setup-env"), "utf8")).toBe(
      `p VC-17 new-working-copy 1 ${directory}`,
    );
    expect(readFileSync(join(directory, "resume-reason"), "utf8")).toBe("runner-start");
    expect(existsSync(join(directory, "stored-ran"))).toBe(false);
    expect(isFirstRunPending({ home: root }, directory, "setup")).toBe(false);
    expect(phases).toEqual(["setting-up", "ready"]);
    expect(readEnvironmentRun({ home: root }, directory, "setup")).toMatchObject({
      source: "repo",
      outcome: "succeeded",
      exitCode: 0,
    });
    expect(readEnvironmentRun({ home: root }, directory, "resume")).toMatchObject({
      source: "repo",
      outcome: "succeeded",
      exitCode: 0,
    });
  });

  it("records a setup failure on disk, refuses every later start and never emits a frozen ticket event", async () => {
    script("setup", "echo dependency-missing\nexit 7\n");
    script("resume", "touch resume-ran\n");
    const { prepare, environment, phases } = fixture();
    const before = boardRows();
    const sql = vi.spyOn(ctx.db, "prepare");

    await expect(prepare(input())).rejects.toThrow(
      ".agents/setup exited with code 7: dependency-missing",
    );
    const first = readEnvironmentRun({ home: root }, directory, "setup");
    expect(first).toMatchObject({
      script: "setup",
      source: "repo",
      outcome: "failed",
      exitCode: 7,
      tail: "dependency-missing\n",
    });
    const reused = input();
    reused.outcome.setupPending = false;
    reused.outcome.created = false;
    await expect(prepare(reused)).rejects.toThrow(
      "Environment setup failed: .agents/setup exited with code 7: dependency-missing. Retry setup, or start anyway.",
    );

    expect(readEnvironmentRun({ home: root }, directory, "setup")).toEqual(first);
    expect(environment).toHaveBeenCalledTimes(1);
    expect(existsSync(join(directory, "resume-ran"))).toBe(false);
    expect(phases).toEqual(["setting-up", "failed"]);
    expect(sql).not.toHaveBeenCalled();
    expect(boardRows()).toEqual(before);
  });

  it("routes environment acquisition failures through machine-only reporting and keeps the setup gate", async () => {
    script("setup", "true\n");
    const { prepare, environment, phases } = fixture();
    environment.mockRejectedValueOnce(new Error("no runner environment"));
    const sql = vi.spyOn(ctx.db, "prepare");

    await expect(prepare(input())).rejects.toThrow(
      ".agents/setup could not start (no runner environment).",
    );
    await expect(prepare(input())).rejects.toThrow("Retry setup, or start anyway.");

    expect(sql).not.toHaveBeenCalled();
    expect(readEnvironmentRun({ home: root }, directory, "setup")).toMatchObject({
      outcome: "failed",
      exitCode: null,
    });
    expect(environment).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(["setting-up", "failed"]);
  });

  it("reports a failed claim without writing the board and leaves the setup owed", async () => {
    const marker = workingCopyRecordPath({ home: root }, directory, "setup");
    rmSync(marker);
    mkdirSync(marker);
    const { prepare, environment, phases } = fixture();
    const sql = vi.spyOn(ctx.db, "prepare");

    await expect(prepare(input())).rejects.toThrow("could not be claimed");

    expect(sql).not.toHaveBeenCalled();
    expect(isFirstRunPending({ home: root }, directory, "setup")).toBe(true);
    expect(environment).not.toHaveBeenCalled();
    expect(phases).toEqual(["failed"]);
  });

  it("joins an in-flight setup even when a second ensure no longer sees it pending", async () => {
    script("setup", "echo setup >> runs\n");
    script("resume", "echo resume >> runs\n");
    const { prepare, environment } = fixture();
    const second = input();
    second.request.sessionId = "session-b";
    second.outcome.setupPending = false;
    second.outcome.created = false;

    await Promise.all([prepare(input()), prepare(second)]);

    expect(readFileSync(join(directory, "runs"), "utf8")).toBe("setup\nresume\n");
    expect(environment.mock.calls).toEqual([["session-a"], ["session-a"]]);
  });

  it("keeps resume failures nonblocking and resumes once again after a wake, never rerunning setup", async () => {
    script("setup", "echo setup >> setup-runs\n");
    script("resume", 'printf "%s\\n" "$VOLLI_RESUME_REASON" >> reasons\nexit 2\n');
    const { prepare, listeners, power } = fixture();
    const sql = vi.spyOn(ctx.db, "prepare");

    await expect(prepare(input())).resolves.toBeUndefined();
    await expect(prepare(input())).resolves.toBeUndefined();
    listeners.get("resume")!();
    await expect(prepare(input())).resolves.toBeUndefined();

    expect(sql).not.toHaveBeenCalled();
    expect(power.on).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(directory, "setup-runs"), "utf8")).toBe("setup\n");
    expect(readFileSync(join(directory, "reasons"), "utf8")).toBe("runner-start\nwake\n");
    expect(readEnvironmentRun({ home: root }, directory, "resume")).toMatchObject({
      reason: "wake",
      outcome: "failed",
      exitCode: 2,
    });
  });

  it("retains the stored setup fallback when the repository has no setup file", async () => {
    const { prepare } = fixture();

    await prepare(input());

    expect(existsSync(join(directory, "stored-ran"))).toBe(true);
    expect(readEnvironmentRun({ home: root }, directory, "setup")).toMatchObject({
      source: "legacyCommand",
      outcome: "succeeded",
    });
  });

  it("consumes an empty recipe without asking for an environment or recording a run", async () => {
    const { prepare, environment } = fixture();
    const request = input();
    request.facts.project.setupCommand = null;

    await prepare(request);

    expect(environment).not.toHaveBeenCalled();
    expect(isFirstRunPending({ home: root }, directory, "setup")).toBe(false);
    expect(readEnvironmentRun({ home: root }, directory, "setup")).toBeNull();
    expect(readEnvironmentRun({ home: root }, directory, "resume")).toBeNull();
  });

  it("leaves project and main-checkout Sessions unchanged", async () => {
    script("setup", "touch setup-ran\n");
    script("resume", "touch resume-ran\n");
    const { prepare, environment } = fixture();
    const main = input();
    main.facts.ticket!.checkoutMode = "main_checkout";
    await prepare(main);
    const project = input();
    project.request.ticketId = null;
    project.facts.ticket = null;
    await prepare(project);

    expect(environment).not.toHaveBeenCalled();
    expect(isFirstRunPending({ home: root }, directory, "setup")).toBe(true);
    expect(existsSync(join(directory, "setup-ran"))).toBe(false);
    expect(existsSync(join(directory, "resume-ran"))).toBe(false);
  });
});
