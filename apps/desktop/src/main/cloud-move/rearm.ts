/** The person's result list and ordinary arming doors, never a move-runner capability upgrade. */
import { randomUUID } from "node:crypto";
import {
  OperationUnavailableError,
  isTicketStatus,
  type CloudMoveAutomationRearm,
  type CloudMoveRearmTarget,
  type ThisMacRunnerSnapshot,
} from "@volli/shared";
import type { MoveBackend, MoveRow } from "@volli/host-core/cloud-move";
import { hostLogger } from "@volli/host-core/log";

type RearmList = Pick<CloudMoveAutomationRearm, "columns" | "schedules" | "inertGlobals"> & {
  projectId: string;
};
type Runner = { id: string; kind: string; status: string; capable: boolean };
class InvalidAutomationDetailsError extends Error {
  constructor() {
    super("Invalid moved Automation details.");
  }
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new InvalidAutomationDetailsError();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new InvalidAutomationDetailsError();
  return value;
}
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 1000) throw new InvalidAutomationDetailsError();
  return value.map(record);
}
function parseList(value: unknown): RearmList {
  const raw = record(value);
  return {
    projectId: text(raw.projectId, 200),
    columns: records(raw.columns).map((item) => {
      if (!isTicketStatus(item.status)) throw new InvalidAutomationDetailsError();
      return {
        automationId: text(item.automationId, 200),
        name: text(item.name, 4096),
        status: item.status,
      };
    }),
    schedules: records(raw.schedules).map((item) => ({
      automationId: text(item.automationId, 200),
      name: text(item.name, 4096),
    })),
    inertGlobals: records(raw.inertGlobals).map((item) => ({
      id: text(item.id, 200),
      name: text(item.name, 4096),
    })),
  };
}
function parseRunners(value: unknown): Runner[] {
  return records(value).map((item) => {
    const capabilities = item.capabilities;
    const tools =
      capabilities !== null && typeof capabilities === "object" && !Array.isArray(capabilities)
        ? (capabilities as Record<string, unknown>).tools
        : null;
    return {
      id: text(item.id, 200),
      kind: text(item.kind, 100),
      status: text(item.status, 100),
      capable:
        Array.isArray(tools) &&
        tools.length <= 64 &&
        tools.every((tool) => typeof tool === "string") &&
        tools.includes("automation.run"),
    };
  });
}
type Row = Pick<MoveRow, "moveId" | "projectId" | "userId">;
const LIST_CACHE_MS = 30_000;
const RUNNER_CACHE_MS = 5_000;
function refusalCode(error: unknown): string | undefined {
  if (error instanceof InvalidAutomationDetailsError) return "invalid_details";
  const value = error as { code?: unknown; data?: { code?: unknown } } | null;
  if (value?.code === "move_signed_out") return "signed_out";
  return typeof value?.data?.code === "string" ? value.data.code : undefined;
}
const permanent = (error: unknown) =>
  ["invalid_details", "feature_unavailable"].includes(refusalCode(error) ?? "");
const REFUSALS: Readonly<Record<string, string>> = {
  signed_out: "Sign in as the person who started this move.",
  feature_unavailable: "Re-arm when Automations are available in Volli Cloud.",
  invalid_details: "These Automation details need a newer Volli build.",
  runner_needs_update: "Update Volli to re-arm Automations on this Mac.",
  runner_not_live: "Waiting for this Mac to connect. Try again when it is online.",
  runner_unavailable: "This Mac is not available. Open Volli Cloud, then try again.",
  runner_not_yours: "Sign in as the person who started this move.",
  forbidden: "Your Workspace access changed. Check your access, then try again.",
  wrong_trigger: "This Automation changed. Check the current list.",
  automation_not_found: "This Automation changed. Check the current list.",
  automation_not_in_project: "This Automation changed. Check the current list.",
};

export interface MoveRearmPort {
  read(row: MoveRow, fresh?: boolean): Promise<CloudMoveAutomationRearm>;
  perform(row: MoveRow, target: CloudMoveRearmTarget): Promise<void>;
}

export function createMoveRearm(options: {
  backend: Pick<MoveBackend, "query" | "mutation">;
  personId(): string | null;
  /** Only the already-composed cloud-launch runner. Reading this never starts or registers one. */
  fullRunner(userId: string): Pick<ThisMacRunnerSnapshot, "state" | "runnerId"> | null;
}): MoveRearmPort {
  const lists = new Map<string, { at: number; work: Promise<RearmList> }>();
  const runners = new Map<string, { at: number; work: Promise<Runner[]> }>();
  const warned = new Set<string>();
  const assertPerson = (row: Row) => {
    if (options.personId() !== row.userId)
      throw Object.assign(
        new OperationUnavailableError("Sign in as the person who started this move."),
        { code: "move_signed_out" },
      );
  };
  async function list(row: Row, fresh = false) {
    assertPerson(row);
    const key = row.userId + ":" + row.moveId;
    let cached = fresh ? undefined : lists.get(key);
    if (cached === undefined || Date.now() - cached.at >= LIST_CACHE_MS) {
      const work = options.backend
        .query("projectImports:rearmList", { moveId: row.moveId })
        .then((value) => {
          const parsed = parseList(value);
          if (parsed.projectId !== row.projectId) throw new InvalidAutomationDetailsError();
          return parsed;
        });
      cached = { at: Date.now(), work };
      lists.set(key, cached);
      while (lists.size > 128) lists.delete(lists.keys().next().value!);
      void work.catch((error: unknown) => {
        if (!permanent(error) && lists.get(key)?.work === work) lists.delete(key);
      });
    }
    const value = await cached.work;
    assertPerson(row);
    return value;
  }
  async function readiness(
    row: Row,
    fresh = false,
  ): Promise<{ runnerId: string | null; unavailable: string | null }> {
    assertPerson(row);
    const live = options.fullRunner(row.userId);
    if (live === null)
      return { runnerId: null, unavailable: "Open in Volli Cloud to re-arm on this Mac." };
    if (live.state !== "online" || live.runnerId === null)
      return { runnerId: null, unavailable: "Waiting for this Mac to connect." };
    const key = row.userId + ":" + live.runnerId;
    let cached = fresh ? undefined : runners.get(key);
    if (cached === undefined || Date.now() - cached.at >= RUNNER_CACHE_MS) {
      const work = options.backend.query("runners:list", {}).then(parseRunners);
      cached = { at: Date.now(), work };
      runners.clear();
      runners.set(key, cached);
      void work.catch(() => {
        if (runners.get(key)?.work === work) runners.delete(key);
      });
    }
    const owned = (await cached.work).find((item) => item.id === live.runnerId);
    assertPerson(row);
    const after = options.fullRunner(row.userId);
    // The full MacRunner proves a live connection. The ordinary arming rule also
    // admits the backend's degraded status when that Mac still has the capability.
    if (
      after?.state !== "online" ||
      after.runnerId !== live.runnerId ||
      owned?.kind !== "mac" ||
      (owned.status !== "online" && owned.status !== "degraded")
    )
      return { runnerId: null, unavailable: "Waiting for this Mac to connect." };
    if (!owned.capable)
      return { runnerId: null, unavailable: "Update Volli to re-arm Automations on this Mac." };
    return { runnerId: live.runnerId, unavailable: null };
  }
  return {
    async read(row, fresh = false) {
      let value: RearmList | undefined;
      try {
        value = await list(row, fresh);
        const ready =
          value.columns.length + value.schedules.length > 0
            ? await readiness(row, fresh)
            : { runnerId: null, unavailable: null };
        assertPerson(row);
        return {
          columns: value.columns,
          schedules: value.schedules,
          inertGlobals: value.inertGlobals,
          canRearmOnThisMac: ready.runnerId !== null,
          unavailable: ready.unavailable,
          retryable: ready.unavailable !== null && options.fullRunner(row.userId) !== null,
        };
      } catch (error) {
        const code = refusalCode(error);
        const reason =
          code === "invalid_details" || code === "feature_unavailable" || code === "signed_out"
            ? code
            : "unavailable";
        const warning = row.moveId + ":" + reason;
        if (!warned.has(warning)) {
          warned.add(warning);
          hostLogger("cloud-move").warn("moved Automation details unavailable", {
            moveId: row.moveId,
            reason,
          });
        }
        const retained = options.personId() === row.userId ? value : undefined;
        return {
          columns: retained?.columns ?? [],
          schedules: retained?.schedules ?? [],
          inertGlobals: retained?.inertGlobals ?? [],
          canRearmOnThisMac: false,
          unavailable: REFUSALS[code ?? ""] ?? "Couldn’t read paused Automations.",
          retryable: !permanent(error) && code !== "signed_out",
        };
      }
    },
    async perform(row, target) {
      try {
        const value = await list(row, true);
        const present =
          target.kind === "column"
            ? value.columns.some(
                (item) =>
                  item.automationId === target.automationId && item.status === target.status,
              )
            : value.schedules.some((item) => item.automationId === target.automationId);
        if (!present)
          throw new OperationUnavailableError(
            "This Automation is no longer paused. Check the current list.",
          );
        const ready = await readiness(row, true);
        if (ready.runnerId === null)
          throw new OperationUnavailableError(
            ready.unavailable ?? "This Mac is not ready to re-arm Automations.",
          );
        assertPerson(row);
        const intent = {
          commandId: randomUUID(),
          automationId: target.automationId,
          runnerId: ready.runnerId,
        };
        if (target.kind === "column")
          await options.backend.mutation("automations:arm", {
            ...intent,
            projectId: row.projectId,
            status: target.status,
          });
        else await options.backend.mutation("automations:armSchedule", intent);
      } catch (error) {
        if (error instanceof OperationUnavailableError) throw error;
        const code = refusalCode(error);
        throw new OperationUnavailableError(
          (typeof code === "string" ? REFUSALS[code] : undefined) ??
            "Couldn’t re-arm this Automation. Try again.",
        );
      } finally {
        lists.delete(row.userId + ":" + row.moveId);
        runners.clear();
      }
    },
  };
}
