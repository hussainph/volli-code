/**
 * Losing or damaging the secrets key never bricks a host (VC-641;
 * `docs/plans/sealed-credential-store.md` §7). Real boots against a real data
 * directory holding board and Session history and sealed sentinel secrets:
 * each fault boots, serves the board, reports a credential status, leaves
 * history and the sealed file alone, and never uses or leaks a stored value.
 * Then re-entry: the key put back opens them; a reset sets them aside.
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import Database from "better-sqlite3";
import type { AgentResponse } from "@volli/shared";
import { insertProject } from "@volli/host-core/db/projects-repo";
import { testProject, testSession, testTicket } from "@volli/host-core/db/test-helpers";
import { insertTicket } from "@volli/host-core/db/tickets-repo";
import { insertSession } from "@volli/host-core/session-control/test-support";
import {
  SECRET_KEY_FILE_ENV,
  SECRET_KEY_FILE_NAME,
  SECRET_STORE_FILE_NAME,
  type CredentialKind,
  type CredentialStatus,
} from "@volli/host-core/secrets";

import { runCredentialsReset } from "./credentials";
import { startHostd, type RunningHostd } from "./hostd";
import type { HostdLogger } from "./log";
import { readStatus } from "./status";

const STORED = "stored-sentinel-VC641-0123456789";
const HISTORY_TABLES = ["projects", "tickets", "ticket_events", "sessions", "session_events"];

let root: string;
let dataDir: string;
let keyPath: string;
let storePath: string;
const running: RunningHostd[] = [];

type LogFn = HostdLogger["info"];
function logger() {
  return {
    debug: vi.fn<LogFn>(),
    info: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
    error: vi.fn<LogFn>(),
  };
}

async function boot(env: Record<string, string> = {}, log = logger()): Promise<RunningHostd> {
  const host = await startHostd({
    dataDir,
    socketPath: join(dataDir, "volli.sock"),
    version: "9.9.9-test",
    env,
    logger: log,
    operatorsFile: join(root, "operators"),
    operatorsOwnerUid: process.getuid!(),
  });
  running.push(host);
  return host;
}

async function stop(host: RunningHostd): Promise<void> {
  running.splice(running.indexOf(host), 1);
  expect(await host.stop("test")).toBe(true);
}

function ask(cmd: string): Promise<AgentResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(dataDir, "volli.sock"));
    let body = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (body += chunk));
    socket.on("end", () => resolve(JSON.parse(body) as AgentResponse));
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.end(`${JSON.stringify({ v: 1, cmd, args: {}, ctx: { cwd: root, env: {} } })}\n`),
    );
  });
}

/** Every history row, read from a closed database. */
function history(): string {
  const db = new Database(join(dataDir, "volli.db"), { readonly: true });
  try {
    return JSON.stringify(
      HISTORY_TABLES.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    );
  } finally {
    db.close();
  }
}

let before: string;
let sealed: Buffer;
let key: Buffer;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "hostd-lost-key-"));
  dataDir = join(root, "data");
  keyPath = join(dataDir, SECRET_KEY_FILE_NAME);
  storePath = join(dataDir, SECRET_STORE_FILE_NAME);
  // A host that has been used: board and Session history, and saved secrets.
  const host = await boot();
  if (!host.host.database.ok) throw new Error("database did not open");
  const db = host.host.database.db;
  const project = testProject({ id: "p1", path: join(root, "repo"), ticketPrefix: "LK" });
  insertProject(db, project);
  const ticket = testTicket(project.id, { id: "t1", title: "Kept through key loss" });
  insertTicket(db, ticket);
  insertSession(db, testSession(project.id, ticket.id, { id: "s1", title: "Kept too" }));
  host.secrets.store.put({ name: "STORED_TOKEN", value: STORED, scope: "always" });
  host.secrets.store.put({
    name: "PROJECT_TOKEN",
    value: `${STORED}-project`,
    scope: "project",
    projectId: project.id,
  });
  await stop(host);
  before = history();
  sealed = readFileSync(storePath);
  key = readFileSync(keyPath);
  expect(before).toContain("Kept through key loss");
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((host) => host.stop("test over")));
  rmSync(root, { recursive: true, force: true });
});

const LOCKED: readonly CredentialKind[] = ["session-env"];
const cases: {
  name: string;
  fault: () => void;
  env?: Record<string, string>;
  status: CredentialStatus;
  fix: RegExp;
}[] = [
  {
    name: "a missing key",
    fault: () => rmSync(keyPath),
    status: { state: "locked", reason: "missing", unavailable: LOCKED },
    fix: /is missing\. Put the key file back/,
  },
  {
    name: "a wrong key",
    fault: () => writeFileSync(keyPath, `${Buffer.alloc(32, 9).toString("base64")}\n`),
    status: { state: "locked", reason: "wrong-key", unavailable: LOCKED },
    fix: /is not the key the saved secrets were sealed with/,
  },
  {
    name: "a malformed key",
    fault: () => writeFileSync(keyPath, "not a key\n"),
    status: { state: "locked", reason: "malformed", unavailable: LOCKED },
    fix: /does not hold a key/,
  },
  {
    name: "a corrupt store",
    fault: () => {
      const bytes = Buffer.from(sealed);
      bytes[bytes.length - 1]! ^= 1;
      writeFileSync(storePath, bytes);
    },
    status: { state: "corrupt", reason: null, unavailable: LOCKED },
    fix: /could not be opened, so saved secrets are unavailable/,
  },
  {
    name: "a key file other users can read (refused, not lost)",
    fault: () => chmodSync(keyPath, 0o644),
    status: { state: "refused", reason: "too-open", unavailable: LOCKED },
    fix: /are too open: other users on this machine could read it/,
  },
  {
    name: "a relative VOLLI_SECRET_KEY_FILE (refused, not lost)",
    fault: () => undefined,
    env: { [SECRET_KEY_FILE_ENV]: "relative.key" },
    status: { state: "refused", reason: "relative-path", unavailable: LOCKED },
    fix: /must be an absolute path/,
  },
];

describe("a host whose key is lost or damaged", () => {
  it.each(cases)(
    "boots with $name, serves the board, and reports it",
    async ({ fault, env, status, fix }) => {
      fault();
      const keyBefore = existsSync(keyPath) ? readFileSync(keyPath) : null;
      const storeBefore = readFileSync(storePath);
      const log = logger();

      const host = await boot(env, log);

      expect(host.status()).toMatchObject({ state: "serving", credentials: status });
      const recorded = readStatus(dataDir);
      expect(recorded).toMatchObject({ state: "serving", credentials: status });
      // The status file says what, never where the key is or what it held.
      const statusText = readFileSync(join(dataDir, "hostd-status.json"), "utf8");
      expect(statusText).not.toContain(SECRET_KEY_FILE_NAME);
      expect(statusText).not.toContain(STORED);
      expect(log.warn).toHaveBeenCalledWith("serving without saved credentials", {
        state: status.state,
        reason: status.reason,
        unavailable: LOCKED,
        fix: expect.stringMatching(fix),
      });

      // Everything that needs no stored secret works.
      expect(await ask("project.list")).toMatchObject({
        ok: true,
        data: { projects: [expect.objectContaining({ prefix: "LK", tickets: 1 })] },
      });
      // No stored value is listed, injected or sealed over.
      const { store } = host.secrets;
      expect(store.list()).toEqual([]);
      expect(store.environment("s1", "p1")).toEqual({});
      expect(() => store.put({ name: "NEW", value: "new", scope: "always" })).toThrow();
      store.put({ name: "LIVE", value: "live-value", scope: "session", sessionId: "s1" });
      expect(store.environment("s1", "p1")).toEqual({ LIVE: "live-value" });
      await stop(host);

      expect(history()).toBe(before);
      expect(readFileSync(storePath).equals(storeBefore)).toBe(true);
      // No key was made, and none replaced.
      expect(existsSync(keyPath) ? readFileSync(keyPath) : null).toEqual(keyBefore);
      expect(readdirSync(dataDir).filter((name) => name.includes("session-secrets"))).toEqual(
        keyBefore === null
          ? [SECRET_STORE_FILE_NAME]
          : [SECRET_STORE_FILE_NAME, SECRET_KEY_FILE_NAME].toSorted(),
      );
      const logged = JSON.stringify([
        log.info.mock.calls,
        log.warn.mock.calls,
        log.error.mock.calls,
      ]);
      expect(logged).not.toContain(STORED);
    },
  );

  it("opens them again once the key is back", async () => {
    rmSync(keyPath);
    await stop(await boot());
    writeFileSync(keyPath, key, { mode: 0o600 });
    const host = await boot();
    expect(host.status().credentials).toEqual({ state: "ready", reason: null, unavailable: [] });
    expect(host.secrets.store.environment("s1", "p1")).toEqual({
      STORED_TOKEN: STORED,
      PROJECT_TOKEN: `${STORED}-project`,
    });
  });

  it("starts over after a reset, keeping the old store aside", async () => {
    rmSync(keyPath);
    await stop(await boot());
    let out = "";
    const code = runCredentialsReset(
      { kind: "credentials-reset", dataDir, confirmed: true },
      { env: {}, now: () => new Date(), out: (text) => (out += text), err: () => undefined },
    );
    expect(code).toBe(0);
    expect(out).toContain("Saved credentials are now empty.");
    const archive = readdirSync(dataDir).find((name) => name.includes(".locked-"))!;
    expect(readFileSync(join(dataDir, archive)).equals(sealed)).toBe(true);

    let host = await boot();
    expect(host.status().credentials?.state).toBe("empty");
    host.secrets.store.put({ name: "RE_ENTERED", value: "re-entered", scope: "always" });
    await stop(host);
    host = await boot();
    expect(host.status().credentials?.state).toBe("ready");
    expect(host.secrets.store.environment("s1", "p1")).toEqual({ RE_ENTERED: "re-entered" });
    expect(history()).toBe(before);
    expect(readFileSync(join(dataDir, archive)).equals(sealed)).toBe(true);
  });
});
