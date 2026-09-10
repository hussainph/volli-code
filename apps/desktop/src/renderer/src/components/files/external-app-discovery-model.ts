/**
 * What one external-app scan MEANS for the app-wide discovery state — pure,
 * beside `external-app-discovery.tsx`, which owns the request and the context.
 *
 * Three states, and the rules that follow from them are the point:
 *
 *   scanning — a look is in flight; `apps` is whatever a previous scan confirmed
 *   ready    — a COMPLETED scan; `apps` is the whole truth, empty included
 *   failed   — the look could not run; `apps` is the last confirmed list
 *
 * `apps` only ever changes on `scanned`. That single rule keeps a confirmed
 * menu on screen across a failed refresh and keeps a failure from ever
 * reading as "this Mac has no supported apps" — a claim only `ready` earns.
 */
import type { ExternalApp } from "../../../../ipc/contract";

export type ExternalAppDiscovery =
  | { status: "scanning"; apps: readonly ExternalApp[] }
  | { status: "ready"; apps: readonly ExternalApp[] }
  | { status: "failed"; apps: readonly ExternalApp[]; message: string };

/** What one scan can report back. */
export type ExternalAppScanOutcome =
  | { kind: "started" }
  | { kind: "scanned"; apps: readonly ExternalApp[] }
  | { kind: "failed"; message: string };

const NO_EXTERNAL_APPS: readonly ExternalApp[] = [];

/** Before the first scan answers: a look is in flight and nothing is confirmed. */
export const UNSCANNED_EXTERNAL_APPS: ExternalAppDiscovery = {
  status: "scanning",
  apps: NO_EXTERNAL_APPS,
};

/** The whole state machine. */
export function nextExternalAppDiscovery(
  current: ExternalAppDiscovery,
  outcome: ExternalAppScanOutcome,
): ExternalAppDiscovery {
  switch (outcome.kind) {
    case "started": {
      return { status: "scanning", apps: current.apps };
    }
    case "scanned": {
      return { status: "ready", apps: outcome.apps };
    }
    case "failed": {
      return { status: "failed", apps: current.apps, message: outcome.message };
    }
  }
}
