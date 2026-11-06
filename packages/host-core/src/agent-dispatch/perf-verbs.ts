/**
 * `volli perf top | stalls | compare` — the perf store's reads (VC-1092).
 *
 * READ TIER, like `cost`: a hill-climbing agent samples them in a loop from
 * its shell. Each answer is computed from this machine's perf store
 * (`../perf`), never from log files, and every argument is checked here as
 * well as in the CLI's parser: the parser guards typed argv, and this guards
 * whatever a process wrote to the socket.
 */
import {
  isPerfGrouping,
  isPerfProcess,
  PERF_GROUP_LIMITS,
  PERF_GROUPINGS,
  PERF_PROCESSES,
  PERF_STALLS_LIMITS,
  sessionUsageWindowSince,
} from "@volli/shared";
import type { AgentRequest, AgentResponse, PerfGrouping, PerfProcess } from "@volli/shared";

import { perfCompare, perfStallLine, perfTop } from "../perf/queries";
import type { PerfStore } from "../perf/store";
import { failure } from "./context";
import type { AgentVerbContext } from "./context";
import { readSessionUsageWindow } from "./cost-verb";

/** The default `perf top` window: the last day. */
const DEFAULT_TOP_WINDOW_MS = 24 * 60 * 60 * 1000;

type Parsed<Value> = { ok: true; value: Value } | { ok: false; response: AgentResponse };

function invalid(reason: string): { ok: false; response: AgentResponse } {
  return { ok: false, response: failure("INVALID_REQUEST", reason) };
}

function storeOf(context: AgentVerbContext): Parsed<PerfStore> {
  const store = context.options.perfStore?.() ?? null;
  return store === null
    ? {
        ok: false,
        response: failure(
          "DB_UNAVAILABLE",
          "This host keeps no perf store.",
          "Stalls are recorded by the desktop app; run volli perf there.",
        ),
      }
    : { ok: true, value: store };
}

function since(request: AgentRequest, now: number): Parsed<number | null> {
  const window = readSessionUsageWindow(request.args["since"]);
  if (window === "invalid") {
    return invalid("since must be an RFC 3339 instant or a look-back like 7d, 24h or 90m.");
  }
  return { ok: true, value: window === null ? null : sessionUsageWindowSince(window, now) };
}

function processArg(request: AgentRequest): Parsed<PerfProcess | null> {
  const value = request.args["process"];
  if (value === undefined) return { ok: true, value: null };
  return isPerfProcess(value)
    ? { ok: true, value }
    : invalid(`Unknown process ${JSON.stringify(value)} (valid: ${PERF_PROCESSES.join(", ")}).`);
}

function byArg(request: AgentRequest): Parsed<PerfGrouping> {
  const value = request.args["by"];
  if (value === undefined) return { ok: true, value: "operation" };
  return isPerfGrouping(value)
    ? { ok: true, value }
    : invalid(`Unknown grouping ${JSON.stringify(value)} (valid: ${PERF_GROUPINGS.join(", ")}).`);
}

function limitArg(
  request: AgentRequest,
  limits: { readonly default: number; readonly max: number },
): Parsed<number> {
  const value = request.args["limit"];
  if (value === undefined) return { ok: true, value: limits.default };
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? { ok: true, value: Math.min(value, limits.max) }
    : invalid("limit must be a positive integer.");
}

function textArg(request: AgentRequest, key: string): Parsed<string | undefined> {
  const value = request.args[key];
  if (value === undefined) return { ok: true, value: undefined };
  return typeof value === "string" && value.length > 0
    ? { ok: true, value }
    : invalid(`${key} must be a non-empty string.`);
}

function answer(data: object): AgentResponse {
  return { v: 1, ok: true, data: data as Record<string, unknown> };
}

/** `volli perf top` — the top offenders in a window, by total stalled time. */
export async function perfTopVerb(
  context: AgentVerbContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const store = storeOf(context);
  if (!store.ok) return store.response;
  const now = context.now();
  const from = since(request, now);
  if (!from.ok) return from.response;
  const process = processArg(request);
  if (!process.ok) return process.response;
  const by = byArg(request);
  if (!by.ok) return by.response;
  const limit = limitArg(request, PERF_GROUP_LIMITS);
  if (!limit.ok) return limit.response;
  return answer({
    ...(await perfTop(store.value, {
      since: from.value ?? now - DEFAULT_TOP_WINDOW_MS,
      until: now,
      process: process.value,
      by: by.value,
      limit: limit.value,
    })),
    store: store.value.stats(),
  });
}

/** `volli perf stalls` — the stalls themselves, newest first. */
export async function perfStallsVerb(
  context: AgentVerbContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const store = storeOf(context);
  if (!store.ok) return store.response;
  const from = since(request, context.now());
  if (!from.ok) return from.response;
  const process = processArg(request);
  if (!process.ok) return process.response;
  const limit = limitArg(request, PERF_STALLS_LIMITS);
  if (!limit.ok) return limit.response;
  const filter: Record<string, string> = {};
  for (const key of ["door", "operation", "label", "version"] as const) {
    const value = textArg(request, key);
    if (!value.ok) return value.response;
    if (value.value !== undefined) filter[key] = value.value;
  }
  const stalls = store.value.stalls(
    {
      ...filter,
      ...(from.value === null ? {} : { since: from.value }),
      ...(process.value === null ? {} : { process: process.value }),
    },
    limit.value,
  );
  return answer({
    since: from.value,
    process: process.value,
    stalls: stalls.map(perfStallLine),
    store: store.value.stats(),
  });
}

/** `volli perf compare` — two builds, per group, per hour observed. */
export async function perfCompareVerb(
  context: AgentVerbContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const store = storeOf(context);
  if (!store.ok) return store.response;
  const versions = request.args["versions"];
  if (
    !Array.isArray(versions) ||
    versions.length !== 2 ||
    !versions.every((version) => typeof version === "string" && version.length > 0)
  ) {
    return failure("INVALID_REQUEST", "perf compare takes --version exactly twice: a, then b.");
  }
  const now = context.now();
  const from = since(request, now);
  if (!from.ok) return from.response;
  const process = processArg(request);
  if (!process.ok) return process.response;
  const by = byArg(request);
  if (!by.ok) return by.response;
  const limit = limitArg(request, PERF_GROUP_LIMITS);
  if (!limit.ok) return limit.response;
  return answer({
    ...(await perfCompare(store.value, {
      versions: [versions[0] as string, versions[1] as string],
      since: from.value,
      until: now,
      process: process.value,
      by: by.value,
      limit: limit.value,
    })),
    store: store.value.stats(),
  });
}
