import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createBackendLink,
  type BackendConnection,
  type BackendLink,
} from "../cloud-runner/backend-link";
import { createMutationGate } from "../cloud-runner/flow";
import { openRawDb, openTestDb, type TestDb } from "../db/test-helpers";
import type { CloudWorkingCopyReport } from "./location";
import { createRunnerPathRegistry } from "./paths";
import { createCloudReportPublisher } from "./reports";

type Publisher = ReturnType<typeof createCloudReportPublisher>;
interface Call {
  name: string;
  args: Record<string, unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}
/** Real BackendLink and shared mutation gate; only the backend connection is in-process. */
function fakeBackendLink() {
  let connected = true;
  let listener: ((connected: boolean) => void) | undefined;
  const calls: Call[] = [];
  const gate = createMutationGate();
  const run = vi.spyOn(gate, "run");
  const connection: BackendConnection = {
    mutation: (name, args) =>
      new Promise((resolve, reject) => calls.push({ name, args, resolve, reject })),
    onUpdate: () => () => {},
    isConnected: () => connected,
    onConnectionChange: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    close: async () => {},
  };
  const link = createBackendLink({ connect: () => connection, token: async () => null, gate });
  links.push(link);
  return {
    link,
    calls,
    run,
    setConnected(up: boolean) {
      connected = up;
      listener?.(up);
    },
  };
}

let ctx: TestDb;
let publishers: Publisher[];
let links: BackendLink[];
let reopened: Database.Database[];
beforeEach(() => {
  ctx = openTestDb();
  publishers = [];
  links = [];
  reopened = [];
});
afterEach(async () => {
  for (const publisher of publishers) publisher.stop();
  for (const link of links) await link.close();
  await tick();
  for (const db of reopened) db.close();
  ctx.cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function tick() {
  // Drain only promise continuations, never a timer or a real backend call.
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
}
const checkout = {
  projectId: "project",
  projectRepoId: "repo",
  kind: "main" as const,
  headBranch: "main",
  headSha: "checkout-sha",
};
const copy: CloudWorkingCopyReport = {
  ticketId: "ticket",
  projectRepoId: "repo",
  kind: "worktree",
  state: "ready",
  branch: "volli/VC-1-ticket",
  baseBranch: "main",
  headSha: "copy-sha",
};
function make(
  options: {
    ownerUserId?: string;
    runnerId?: string;
    db?: Database.Database;
    currentLink?: () => BackendLink | null;
  } = {},
) {
  const db = options.db ?? ctx.db;
  const ownerUserId = options.ownerUserId ?? "owner";
  const runnerId = options.runnerId ?? "runner";
  const registry = createRunnerPathRegistry(db, { runnerId });
  const onError = vi.fn();
  const publisher = createCloudReportPublisher({
    db,
    ownerUserId,
    runnerId,
    registry,
    onError,
    currentLink: options.currentLink ?? (() => null),
  });
  publishers.push(publisher);
  return { publisher, registry, onError };
}
function register(f: ReturnType<typeof make>, input: CloudWorkingCopyReport = copy) {
  const path = `/reports/${f.registry.runnerId}`;
  f.registry.checkouts.register({
    projectId: "project",
    projectRepoId: "repo",
    absPath: `${path}/main`,
  });
  f.registry.workingCopies.register({ ...input, absPath: `${path}/copy` });
}
function stored() {
  return ctx.db
    .prepare("SELECT key, value FROM app_state WHERE key LIKE 'volli:runner-report:%' ORDER BY key")
    .all() as { key: string; value: string }[];
}

describe("durable cloud machine reports", () => {
  it("persists synchronously, returns offline without a backend id, and stores no paths or Session facts", async () => {
    const f = make();
    register(f);
    const extra = {
      absPath: "/private/machine",
      sessionId: "private-session",
      body: "private-board-prose",
    };
    const observedCheckout = f.publisher.reports.checkout({ ...checkout, ...extra });
    const observedCopy = f.publisher.reports.workingCopy({ ...copy, ...extra });
    // These writes have happened before either returned promise is awaited.
    expect(f.publisher.pending()).toBe(2);
    const raw = JSON.stringify(stored());
    for (const secret of [
      "/private/machine",
      "/reports/runner",
      "private-session",
      "private-board-prose",
      "absPath",
    ])
      expect(raw).not.toContain(secret);
    await observedCheckout;
    expect(await observedCopy).toEqual({ workingCopyId: null });
    await f.publisher.flush();
    expect(f.publisher.pending()).toBe(2);
    expect(f.onError).not.toHaveBeenCalled();
    f.registry.workingCopies.register({
      ...f.registry.workingCopies.get("ticket", "repo")!,
      workingCopyId: "already-known",
    });
    expect(await f.publisher.reports.workingCopy(copy)).toEqual({ workingCopyId: "already-known" });
    expect(f.publisher.pending()).toBe(2);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM session_events").get()).toEqual({ n: 0 });
  });

  it("coalesces checkout per repo and Working copy per ticket/repo, not per Session or observation", async () => {
    const f = make();
    register(f);
    await f.publisher.reports.checkout(checkout);
    await f.publisher.reports.checkout({ ...checkout, headSha: "latest" });
    await f.publisher.reports.workingCopy(copy);
    await f.publisher.reports.workingCopy({ ...copy, state: "reclaimed" });
    await f.publisher.reports.workingCopy({ ...copy, ticketId: "another-ticket" });
    expect(f.publisher.pending()).toBe(3);
    const reports = stored().map((row) => JSON.parse(row.value));
    expect(reports.find((report) => report.kind === "checkout").args.headSha).toBe("latest");
    expect(reports.find((report) => report.args.ticketId === "ticket").args.state).toBe(
      "reclaimed",
    );
  });

  it("survives SQLite reopen, waits for connection, and eventually records the backend-minted identity", async () => {
    const backend = fakeBackendLink();
    const first = make();
    register(first);
    await first.publisher.reports.checkout(checkout);
    await first.publisher.reports.workingCopy(copy);
    first.publisher.stop();
    const db = openRawDb(ctx.dbPath);
    reopened.push(db);
    backend.setConnected(false);
    const second = make({ db, currentLink: () => backend.link });
    await second.publisher.flush();
    expect(backend.calls).toHaveLength(0);
    expect(second.publisher.pending()).toBe(2);
    expect(second.registry.workingCopies.get("ticket", "repo")?.workingCopyId).toBeNull();
    backend.setConnected(true);
    // The composition calls flush on reconnect; it never awaits reports to prepare a Session.
    const flush = second.publisher.flush();
    expect(second.publisher.flush()).toBe(flush);
    await tick();
    expect(backend.calls[0]!.name).toBe("projectCheckouts:report");
    expect(backend.calls[0]!.args).toEqual(checkout);
    backend.calls[0]!.resolve({ projectRepoId: "repo" });
    await tick();
    expect(backend.calls[1]!.name).toBe("workingCopies:report");
    expect(backend.calls[1]!.args).toEqual(copy);
    backend.calls[1]!.resolve({ workingCopyId: "minted-id" });
    await flush;
    expect(second.registry.workingCopies.get("ticket", "repo")).toMatchObject({
      workingCopyId: "minted-id",
      kind: "worktree",
      branch: copy.branch,
    });
    expect(second.publisher.pending()).toBe(0);
    expect(backend.run.mock.calls.map((args) => args[0])).toEqual(["control", "control"]);
    expect(second.onError).not.toHaveBeenCalled();
    expect(JSON.stringify(backend.calls.map((call) => call.args))).not.toContain("/reports/");
  });

  it("returns before an online backend reply, and cannot erase an identical newer in-flight report", async () => {
    const backend = fakeBackendLink();
    const f = make({ currentLink: () => backend.link });
    register(f);
    expect(await f.publisher.reports.workingCopy(copy)).toEqual({ workingCopyId: null });
    const flush = f.publisher.flush();
    await tick();
    expect(backend.calls).toHaveLength(1);
    const original = stored()[0]!.value;
    // Even identical metadata gets a distinct revision; it is a newer observation.
    expect(await f.publisher.reports.workingCopy(copy)).toEqual({ workingCopyId: null });
    expect(stored()[0]!.value).not.toBe(original);
    backend.calls[0]!.resolve({ workingCopyId: "minted-id" });
    await tick();
    expect(f.publisher.pending()).toBe(1);
    expect(f.registry.workingCopies.get("ticket", "repo")?.workingCopyId).toBeNull();
    expect(backend.calls).toHaveLength(2);
    backend.calls[1]!.resolve({ workingCopyId: "minted-id" });
    await flush;
    expect(f.publisher.pending()).toBe(0);
    expect(f.registry.workingCopies.get("ticket", "repo")?.workingCopyId).toBe("minted-id");
  });

  it("never replaces a newer report or resets registry mode/path when an old ack arrives", async () => {
    const backend = fakeBackendLink();
    const f = make({ currentLink: () => backend.link });
    register(f);
    await f.publisher.reports.workingCopy(copy);
    const flush = f.publisher.flush();
    await tick();
    const changed = { ...copy, kind: "main_checkout" as const, branch: "main", headSha: "new-sha" };
    f.registry.workingCopies.register({ ...changed, absPath: "/reports/runner/main" });
    await f.publisher.reports.workingCopy(changed);
    backend.calls[0]!.resolve({ workingCopyId: "minted-id" });
    await tick();
    expect(f.publisher.pending()).toBe(1);
    expect(f.registry.workingCopies.get("ticket", "repo")).toMatchObject({
      kind: "main_checkout",
      absPath: "/reports/runner/main",
      workingCopyId: null,
    });
    expect(backend.calls[1]!.args).toEqual(changed);
    backend.calls[1]!.resolve({ workingCopyId: "minted-id" });
    await flush;
    expect(f.registry.workingCopies.get("ticket", "repo")).toMatchObject({
      kind: "main_checkout",
      absPath: "/reports/runner/main",
      branch: "main",
      headSha: "new-sha",
      workingCopyId: "minted-id",
    });
  });

  it.each(["path", "mode", "git"] as const)(
    "does not attach a stale identity after registry %s changes without another report",
    async (change) => {
      const backend = fakeBackendLink();
      const f = make({ currentLink: () => backend.link });
      register(f);
      await f.publisher.reports.workingCopy(copy);
      const flush = f.publisher.flush();
      await tick();
      f.registry.workingCopies.register({
        ...f.registry.workingCopies.get("ticket", "repo")!,
        ...(change === "path" ? { absPath: "/reports/runner/elsewhere" } : {}),
        ...(change === "mode" ? { kind: "main_checkout", absPath: "/reports/runner/main" } : {}),
        ...(change === "git" ? { branch: "new-branch" } : {}),
      });
      const newer = f.registry.workingCopies.get("ticket", "repo");
      backend.calls[0]!.resolve({ workingCopyId: "stale-id" });
      await flush;
      expect(f.registry.workingCopies.get("ticket", "repo")).toEqual(newer);
      expect(f.publisher.pending()).toBe(0);
    },
  );

  it("does not overwrite an identity associated locally while the report was in flight", async () => {
    const backend = fakeBackendLink();
    const f = make({ currentLink: () => backend.link });
    register(f);
    await f.publisher.reports.workingCopy(copy);
    const flush = f.publisher.flush();
    await tick();
    f.registry.workingCopies.register({
      ...f.registry.workingCopies.get("ticket", "repo")!,
      workingCopyId: "newer-local-id",
    });
    backend.calls[0]!.resolve({ workingCopyId: "old-reply-id" });
    await flush;
    expect(f.registry.workingCopies.get("ticket", "repo")?.workingCopyId).toBe("newer-local-id");
    expect(f.publisher.pending()).toBe(0);
  });

  it("does not assign a report's identity to a registry row already in another mode", async () => {
    const backend = fakeBackendLink();
    const f = make({ currentLink: () => backend.link });
    register(f);
    await f.publisher.reports.workingCopy({ ...copy, kind: "main_checkout" });
    const flush = f.publisher.flush();
    await tick();
    backend.calls[0]!.resolve({ workingCopyId: "wrong-mode-id" });
    await flush;
    expect(f.registry.workingCopies.get("ticket", "repo")?.workingCopyId).toBeNull();
  });

  it("selects only this owner/runner BEFORE decode, including delimiter/wildcard ids and corrupt foreign values", async () => {
    const backend = fakeBackendLink();
    const a = make({
      ownerUserId: "a:%_",
      runnerId: "runner:one",
      currentLink: () => backend.link,
    });
    const otherOwner = make({ ownerUserId: "a:%_:other", runnerId: "runner:one" });
    const otherRunner = make({ ownerUserId: "a:%_", runnerId: "runner:one:other" });
    await a.publisher.reports.checkout(checkout);
    await otherOwner.publisher.reports.checkout({ ...checkout, projectRepoId: "foreign-repo" });
    await otherRunner.publisher.reports.checkout({
      ...checkout,
      projectRepoId: "foreign-runner-repo",
    });
    ctx.db
      .prepare("INSERT INTO app_state(key,value,updated_at) VALUES(?, ?, 0)")
      .run("volli:runner-report:foreign:runner:checkout:repo", "FOREIGN SECRET RAW");
    const parse = vi.spyOn(JSON, "parse");
    expect(a.publisher.pending()).toBe(1);
    const flush = a.publisher.flush();
    await tick();
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]!.args).toEqual(checkout);
    backend.calls[0]!.resolve({ projectRepoId: "repo" });
    await flush;
    expect(a.publisher.pending()).toBe(0);
    expect(otherOwner.publisher.pending()).toBe(1);
    expect(otherRunner.publisher.pending()).toBe(1);
    expect(stored()).toHaveLength(3);
    expect(parse).not.toHaveBeenCalledWith("FOREIGN SECRET RAW");
    expect(a.onError).not.toHaveBeenCalled();
  });

  it.each([
    "unauthenticated",
    "not_a_member",
    "forbidden",
    "invalid_repo",
    "invalid_request",
    "not_found",
    "revoked",
  ])("persists %s as blocked, visible pending state without an automatic retry", async (code) => {
    vi.useFakeTimers();
    const backend = fakeBackendLink();
    const f = make({ currentLink: () => backend.link });
    await f.publisher.reports.checkout(checkout);
    const flush = f.publisher.flush();
    await tick();
    const error = { data: { code, message: "Explicit recovery required" } };
    backend.calls[0]!.reject(error);
    await flush;
    expect(f.publisher.pending()).toBe(1);
    expect(JSON.parse(stored()[0]!.value).blocked).toEqual(error.data);
    expect(f.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await f.publisher.flush();
    f.publisher.stop();
    const restarted = make({ currentLink: () => backend.link });
    await restarted.publisher.flush();
    expect(restarted.publisher.pending()).toBe(1);
    expect(backend.calls).toHaveLength(1);
  });

  it("allows a fresh observation to replace a blocked report after explicit recovery", async () => {
    const backend = fakeBackendLink();
    const f = make({ currentLink: () => backend.link });
    await f.publisher.reports.checkout(checkout);
    const first = f.publisher.flush();
    await tick();
    backend.calls[0]!.reject({ data: { code: "not_a_member" } });
    await first;
    await f.publisher.reports.checkout({ ...checkout, headSha: "recovered" });
    const second = f.publisher.flush();
    await tick();
    expect(backend.calls).toHaveLength(2);
    expect(backend.calls[1]!.args.headSha).toBe("recovered");
    backend.calls[1]!.resolve({ projectRepoId: "repo" });
    await second;
    expect(f.publisher.pending()).toBe(0);
  });

  it("blocks a malformed backend identity instead of deleting the report or retrying forever", async () => {
    const backend = fakeBackendLink();
    const f = make({ currentLink: () => backend.link });
    register(f);
    await f.publisher.reports.workingCopy(copy);
    const flush = f.publisher.flush();
    await tick();
    backend.calls[0]!.resolve({ workingCopyId: null });
    await flush;
    expect(JSON.parse(stored()[0]!.value).blocked.code).toBe("invalid_report_reply");
    expect(f.registry.workingCopies.get("ticket", "repo")?.workingCopyId).toBeNull();
    await f.publisher.flush();
    expect(backend.calls).toHaveLength(1);
  });

  it("retries transient failures with bounded 250..5000ms backoff and cancels the timer on stop", async () => {
    vi.useFakeTimers();
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    const backend = fakeBackendLink();
    const f = make({ currentLink: () => backend.link });
    await f.publisher.reports.checkout(checkout);
    const flush = f.publisher.flush();
    await tick();
    backend.calls[0]!.reject(new Error("offline"));
    await flush;
    const delays = [250, 500, 1000, 2000, 4000, 5000, 5000];
    for (let i = 0; i < delays.length; i += 1) {
      expect(timeouts.mock.calls.at(-1)![1]).toBe(delays[i]);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(delays[i]!);
      expect(backend.calls).toHaveLength(i + 2);
      backend.calls[i + 1]!.reject(new Error("still offline"));
      await tick();
    }
    expect(f.publisher.pending()).toBe(1);
    f.publisher.stop();
    expect(vi.getTimerCount()).toBe(0);
    const calls = backend.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    await f.publisher.flush();
    expect(backend.calls).toHaveLength(calls);
  });

  it("unrefs a real retry timer so the publisher cannot keep the process alive", async () => {
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    const backend = fakeBackendLink();
    const f = make({ currentLink: () => backend.link });
    await f.publisher.reports.checkout(checkout);
    const flush = f.publisher.flush();
    await tick();
    backend.calls[0]!.reject(new Error("temporary reset"));
    await flush;
    const timer = timeouts.mock.results.at(-1)!.value as ReturnType<typeof setTimeout>;
    expect(timer.hasRef()).toBe(false);
    f.publisher.stop();
  });

  it("retains an in-flight row after stop and ignores its late ack", async () => {
    const backend = fakeBackendLink();
    const f = make({ currentLink: () => backend.link });
    register(f);
    await f.publisher.reports.workingCopy(copy);
    const flush = f.publisher.flush();
    await tick();
    f.publisher.stop();
    backend.calls[0]!.resolve({ workingCopyId: "late-id" });
    await flush;
    expect(f.publisher.pending()).toBe(1);
    expect(f.registry.workingCopies.get("ticket", "repo")?.workingCopyId).toBeNull();
    await expect(f.publisher.reports.checkout(checkout)).rejects.toThrow("stopped");
    await f.publisher.flush();
    expect(backend.calls).toHaveLength(1);
  });

  it("does not send a queued microtask after stop", async () => {
    const backend = fakeBackendLink();
    const f = make({ currentLink: () => backend.link });
    const observed = f.publisher.reports.checkout(checkout);
    f.publisher.stop();
    await observed;
    await tick();
    expect(f.publisher.pending()).toBe(1);
    expect(backend.calls).toHaveLength(0);
  });

  it("retains corrupt own rows with one local diagnostic and never sends them", async () => {
    const backend = fakeBackendLink();
    const f = make({ currentLink: () => backend.link });
    ctx.db
      .prepare("INSERT INTO app_state(key,value,updated_at) VALUES(?, ?, 0)")
      .run("volli:runner-report:owner:runner:checkout:repo", "not JSON");
    await f.publisher.flush();
    await f.publisher.flush();
    expect(f.publisher.pending()).toBe(1);
    expect(f.onError).toHaveBeenCalledTimes(1);
    expect(backend.calls).toHaveLength(0);
  });

  it("rejects failed local persistence rather than pretending an observation was durable", async () => {
    const backend = fakeBackendLink();
    const f = make({ currentLink: () => backend.link });
    ctx.db.exec(`CREATE TRIGGER refuse_report BEFORE INSERT ON app_state
      WHEN NEW.key LIKE 'volli:runner-report:%' BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
    await expect(f.publisher.reports.checkout(checkout)).rejects.toThrow("disk full");
    expect(f.publisher.pending()).toBe(0);
    await tick();
    expect(backend.calls).toHaveLength(0);
  });
});
