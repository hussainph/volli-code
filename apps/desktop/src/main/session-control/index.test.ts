import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SESSION_LISTING_FOLD_CHUNK } from "@volli/session-engine";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import { createDesktopSessionEngine } from "./index";

const immediates = vi.hoisted(() => ({ scheduled: 0 }));

vi.mock("node:timers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers")>();
  return {
    ...actual,
    setImmediate: ((callback: () => void) => {
      immediates.scheduled += 1;
      return actual.setImmediate(callback);
    }) as typeof actual.setImmediate,
  };
});

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

const provenance = {
  source: { kind: "system" as const, id: "desktop", detail: null },
  venue: { id: "local", kind: "local" as const },
};

describe("createDesktopSessionEngine", () => {
  /**
   * The engine owns no Node API, so its default yield between roster chunks
   * is `setTimeout(0)` and its millisecond clamp. This host has `setImmediate`
   * and injects it (VC-388): a roster one row past a chunk folds in two
   * chunks, and the turn given back between them is a check-phase immediate,
   * not a timer.
   */
  it("yields between roster chunks on setImmediate", async () => {
    ctx = openTestDb();
    const project = testProject({ id: "project" });
    insertProject(ctx.db, project);
    let id = 0;
    const engine = createDesktopSessionEngine(ctx.db, {
      now: () => 100 + id,
      nextId: () => `id-${++id}`,
    });
    const count = SESSION_LISTING_FOLD_CHUNK + 1;
    for (let index = 0; index < count; index += 1) {
      await engine.createSession({
        commandId: `create-${index}`,
        projectId: project.id,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: `Session ${index}`,
        provenance,
      });
    }

    immediates.scheduled = 0;
    await expect(
      engine.listSessions({ projectId: project.id, scope: "all" }),
    ).resolves.toHaveLength(count);
    expect(immediates.scheduled).toBe(1);
  });
});
