/**
 * `volli perf` through the real dispatch (VC-1092): the socket's request, the
 * map's entry, the store's answer.
 */
import type { AgentCommand, AgentRequest, AgentResponse } from "@volli/shared";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createAgentCommandService } from "../agent-commands";
import { openTestDb, type TestDb } from "../db/test-helpers";
import { openPerfStore, type PerfStore } from "../perf/store";
import { testHostHandlers } from "../testing/host-handlers";
import { createTestSessionEngine } from "../testing/session-engine";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;

const dbs: TestDb[] = [];
let store: PerfStore | null = null;
let clock = T0;

afterEach(() => {
  store?.close();
  store = null;
  for (const db of dbs.splice(0)) db.cleanup();
});

function service(perf: PerfStore | null | undefined) {
  const db = openTestDb();
  dbs.push(db);
  return createAgentCommandService({
    handlers: testHostHandlers({ db: db.db }),
    db: db.db,
    sessionEngine: createTestSessionEngine(db.db),
    appVersion: "0.3.1",
    now: () => clock,
    ...(perf === undefined ? {} : { perfStore: () => perf }),
  });
}

/** A store with an hour of 0.3.0 and, from an hour in, a build of 0.3.1 labelled `fix`. */
function seeded(): PerfStore {
  clock = T0;
  const old = openPerfStore({
    path: ":memory:",
    version: "0.3.0",
    now: () => clock,
    every: () => () => {},
  });
  if (old === null) throw new Error("no store");
  store = old;
  old.record({
    at: T0 + 1,
    process: "main",
    kind: "door",
    door: "ipc",
    operation: "volli:board-load",
    durationMs: 900,
  });
  old.record({
    at: T0 + 2,
    process: "main",
    kind: "door",
    door: "ipc",
    operation: "volli:board-load",
    durationMs: 700,
  });
  old.record({
    at: T0 + 3,
    process: "renderer",
    kind: "input",
    door: "renderer",
    operation: "keydown",
    label: "draft-typing",
    windowId: 1,
    durationMs: 300,
  });
  clock = T0 + HOUR;
  old.setBuild("fix");
  old.record({
    at: T0 + HOUR + 1,
    process: "main",
    kind: "unattributed",
    door: "unattributed",
    operation: "unattributed",
    hint: "socket/ticket.list",
    durationMs: 250,
  });
  return old;
}

async function run(
  perf: PerfStore | null | undefined,
  cmd: AgentCommand,
  args: Record<string, unknown> = {},
): Promise<AgentResponse> {
  const request: AgentRequest = { v: 1, cmd, args, ctx: { cwd: "/", env: {} } };
  return service(perf).execute(request);
}

function data(response: AgentResponse): Record<string, unknown> {
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.data as Record<string, unknown>;
}

describe("volli perf", () => {
  it("top: the last day's offenders by default, with the store's bounds", async () => {
    const perf = seeded();
    clock = T0 + 2 * HOUR;
    const answer = data(await run(perf, "perf.top"));
    expect(answer).toMatchObject({
      since: clock - 24 * HOUR,
      until: clock,
      by: "operation",
      process: null,
      stalls: 4,
      stallMs: 2_150,
      groupCount: 3,
      store: { rows: 4, dropped: 0, maxRows: 100_000 },
    });
    expect((answer["groups"] as { key: string }[]).map((group) => group.key)).toEqual([
      "ipc/volli:board-load",
      "renderer/keydown",
      "unattributed/unattributed",
    ]);
  });

  it("top: --since, --process, --by and --limit", async () => {
    const perf = seeded();
    clock = T0 + 2 * HOUR;
    const answer = data(
      await run(perf, "perf.top", {
        since: { kind: "duration", ms: 90 * 60 * 1000 },
        process: "main",
        by: "version",
        limit: 1,
      }),
    );
    expect(answer).toMatchObject({ stalls: 1, groupCount: 1, by: "version" });
    expect(answer["groups"]).toEqual([expect.objectContaining({ key: "0.3.0+fix", totalMs: 250 })]);
  });

  it("stalls: newest first, filtered, with no internal id", async () => {
    const perf = seeded();
    const all = data(await run(perf, "perf.stalls", { limit: 2 }));
    expect(
      (all["stalls"] as { operation: string; version: string }[]).map((row) => [
        row.operation,
        row.version,
      ]),
    ).toEqual([
      ["unattributed", "0.3.0+fix"],
      ["keydown", "0.3.0+fix"],
    ]);
    const filtered = data(
      await run(perf, "perf.stalls", {
        since: { kind: "instant", epochMs: T0 },
        process: "renderer",
        label: "draft-typing",
        operation: "renderer/keydown",
        door: "renderer",
        version: "0.3.0",
      }),
    );
    expect(filtered["stalls"]).toEqual([expect.objectContaining({ window: 1, durationMs: 300 })]);
  });

  it("compare: two builds per hour observed", async () => {
    const perf = seeded();
    clock = T0 + 2 * HOUR;
    const answer = data(
      await run(perf, "perf.compare", { versions: ["0.3.0", "fix"], by: "door" }),
    );
    // The build label was set an hour in, so the run is labelled `fix` for all
    // of it: "0.3.0" matches it too. That pooling is what `matched` shows.
    expect(answer["a"]).toMatchObject({ version: "0.3.0", matched: ["0.3.0+fix"], stalls: 4 });
    expect(answer["b"]).toMatchObject({ version: "fix", stalls: 4, observedMs: 2 * HOUR });
  });

  it("refuses arguments a raw socket caller could send", async () => {
    const perf = seeded();
    const refusals = await Promise.all([
      run(perf, "perf.top", { since: { kind: "someday" } }),
      run(perf, "perf.top", { process: "gpu" }),
      run(perf, "perf.top", { by: "colour" }),
      run(perf, "perf.top", { limit: 0 }),
      run(perf, "perf.stalls", { since: "yesterday" }),
      run(perf, "perf.stalls", { process: 1 }),
      run(perf, "perf.stalls", { limit: 1.5 }),
      run(perf, "perf.stalls", { door: "" }),
      run(perf, "perf.compare", { versions: ["only-one"] }),
      run(perf, "perf.compare", { versions: ["a", 2] }),
      run(perf, "perf.compare", { versions: ["a", "b"], since: 5 }),
      run(perf, "perf.compare", { versions: ["a", "b"], process: "gpu" }),
      run(perf, "perf.compare", { versions: ["a", "b"], by: "colour" }),
      run(perf, "perf.compare", { versions: ["a", "b"], limit: -1 }),
    ]);
    for (const response of refusals) {
      expect(response).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }
  });

  it("caps a limit at the verb's maximum", async () => {
    const perf = seeded();
    const answer = data(await run(perf, "perf.stalls", { limit: 10_000 }));
    expect(answer["stalls"]).toHaveLength(4);
  });

  it("refuses with DB_UNAVAILABLE on a host that keeps no perf store", async () => {
    for (const perf of [undefined, null]) {
      for (const cmd of ["perf.top", "perf.stalls", "perf.compare"] as const) {
        expect(await run(perf, cmd, { versions: ["a", "b"] })).toMatchObject({
          ok: false,
          error: { code: "DB_UNAVAILABLE" },
        });
      }
    }
  });
});
