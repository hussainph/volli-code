/**
 * The host-facing Automation service at its own seam (VC-259): what a save
 * accepts as a Runtime, and what it refuses. The IPC adapter over it is
 * exercised in `ipc.test.ts`; this file stays on the service so a rule about
 * the record does not have to be read through a transport.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { NO_AUTOMATION_TRIGGER } from "@volli/shared";
import type { ModelAccessSnapshot, ModelSelection } from "@volli/shared";

import { createAutomationEngine } from "./engine";
import { createAutomationService } from "./service";
import { SqliteAutomationLedger } from "./sqlite-ledger";
import {
  getAutomation,
  listAutomationsForProject,
  listRunsForProject,
  listRunsForTicket,
  listSkippedOccurrencesForProject,
} from "../db/automations-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

const PIN: ModelSelection = {
  providerId: "anthropic",
  modelId: "claude-opus",
  reasoningLevel: "high",
};

const ACCESS: ModelAccessSnapshot = {
  observedAt: 0,
  providers: [],
  models: [
    {
      providerId: PIN.providerId,
      modelId: PIN.modelId,
      label: "Claude Opus",
      state: "available",
      reasoningLevels: ["medium", "high"],
      acceptsImageInput: true,
    },
  ],
};

function setup(overrides: { inspectModelAccess?: () => Promise<ModelAccessSnapshot> } = {}) {
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  const engine = createAutomationEngine({
    ledger: new SqliteAutomationLedger(ctx.db),
    now: () => 5_000,
    nextId: randomUUID,
  });
  const service = createAutomationService({
    engine,
    findProject: (id) => id === project.id,
    findAutomation: (id) => getAutomation(ctx.db, id),
    listAutomationsForProject: (id) => listAutomationsForProject(ctx.db, id),
    runsForTicket: (id) => listRunsForTicket(ctx.db, id),
    runsForProject: (id) => listRunsForProject(ctx.db, id),
    skipsForProject: (id) => listSkippedOccurrencesForProject(ctx.db, id),
    ...(overrides.inspectModelAccess === undefined
      ? {}
      : { inspectModelAccess: overrides.inspectModelAccess }),
  });
  return { project, service };
}

const DRAFT = { name: "Tiered", instructions: "/sweep", trigger: NO_AUTOMATION_TRIGGER };

describe("a tier Runtime at the save door (VC-259)", () => {
  it("saves a tier without consulting Model Access — the tier is resolved when a Run starts", async () => {
    // No `inspectModelAccess` at all: a pin would be refused as unvalidatable
    // here, and a tier must not be, because there is no model to validate yet.
    const { project, service } = setup();

    const created = await service.create({
      commandId: randomUUID(),
      projectId: project.id,
      ...DRAFT,
      runtime: { kind: "tier", tier: "fast" },
    });
    expect(created).toMatchObject({
      ok: true,
      automation: { runtime: { kind: "tier", tier: "fast" } },
    });
    if (!created.ok) throw new Error(created.error);

    const updated = await service.update({
      commandId: randomUUID(),
      automationId: created.automation.id,
      ...DRAFT,
      runtime: { kind: "tier", tier: "visual" },
    });
    expect(updated).toMatchObject({
      ok: true,
      automation: { runtime: { kind: "tier", tier: "visual" } },
    });
    expect(getAutomation(ctx.db, created.automation.id)?.runtime).toEqual({
      kind: "tier",
      tier: "visual",
    });
  });

  it("refuses a tier name this build does not know, at create and at update, and writes nothing", async () => {
    // The wire guard judges shape only; the vocabulary is checked here so an
    // unknown tier never reaches the record — where it would read back as
    // the invalid row and refuse every Run until someone repaired it.
    const { project, service } = setup({ inspectModelAccess: async () => ACCESS });
    const smol = { kind: "tier", tier: "smol" } as unknown as { kind: "tier"; tier: "fast" };

    await expect(
      service.create({ commandId: randomUUID(), projectId: project.id, ...DRAFT, runtime: smol }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/"smol".*fast/) });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM automation_commands").get()).toEqual({ n: 0 });

    const created = await service.create({
      commandId: randomUUID(),
      projectId: project.id,
      ...DRAFT,
      runtime: PIN,
    });
    if (!created.ok) throw new Error(created.error);
    await expect(
      service.update({
        commandId: randomUUID(),
        automationId: created.automation.id,
        ...DRAFT,
        runtime: smol,
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/"smol"/) });
    expect(getAutomation(ctx.db, created.automation.id)?.runtime).toEqual(PIN);
  });

  it("still validates a pin against Model Access, so the tier arm took nothing away", async () => {
    const { project, service } = setup({ inspectModelAccess: async () => ACCESS });
    await expect(
      service.create({
        commandId: randomUUID(),
        projectId: project.id,
        ...DRAFT,
        runtime: { ...PIN, reasoningLevel: "low" },
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/reasoning level/) });
  });
});
