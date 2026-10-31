/** Durable, coalesced machine observations. Session preparation never waits for the backend. */
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { WORKING_COPY_STATES } from "@volli/shared/cloud";

import type { BackendLink } from "../cloud-runner/backend-link";
import { getAppState, setAppState } from "../db/app-state-repo";
import { prepared } from "../db/prepared";
import { withTransaction } from "../db/transaction-gate";
import type { CloudLocationReports, CloudWorkingCopyReport } from "./location";
import type { RunnerPathRegistry, WorkingCopyPath } from "./paths";

type CheckoutReport = Parameters<CloudLocationReports["checkout"]>[0];
interface Block {
  code: string;
  message: string;
}
type Report = { version: 1; revision: string; blocked: Block | null } & (
  | { kind: "checkout"; args: CheckoutReport }
  | { kind: "workingCopy"; args: CloudWorkingCopyReport; copyStamp: string | null }
);
interface StoredRow {
  key: string;
  value: string;
}

const STOP_CODES = new Set([
  "unauthenticated",
  "no_viewer",
  "account_deleted",
  "account_deletion_pending",
  "identity_conflict",
  "not_a_person",
  "not_a_runner",
  "revoked",
  "not_your_runner",
  "not_found",
  "not_a_member",
  "forbidden",
  "fenced",
  "invalid_request",
  "invalid_repo",
  "invalid_config",
  "configuration_error",
  "quota_exceeded",
  "invalid_report_reply",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const requiredString = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error("Invalid report identity.");
  return value;
};
const gitValue = (value: unknown): string | null => {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    value.includes("\u0000") ||
    /[\r\n]/.test(value)
  )
    throw new Error("Invalid report git metadata.");
  return value;
};
function checkoutArgs(input: unknown): CheckoutReport {
  if (!record(input) || (input.kind !== "main" && input.kind !== "managed_clone"))
    throw new Error("Invalid checkout report.");
  // Enumerating fields here and on decode prevents paths or Session facts from
  // entering either the durable buffer or the remote call, even from untyped callers.
  return {
    projectId: requiredString(input.projectId),
    projectRepoId: requiredString(input.projectRepoId),
    kind: input.kind,
    headBranch: gitValue(input.headBranch),
    headSha: gitValue(input.headSha),
    // Absent on reports buffered by older builds; sent only when known. A
    // backend older than `projectCheckouts.report`'s `remoteUrl` refuses it,
    // so the backend deploys before an app that sends it.
    ...(typeof input.remoteUrl === "string" ? { remoteUrl: gitValue(input.remoteUrl) } : {}),
  };
}
function copyArgs(input: unknown): CloudWorkingCopyReport {
  if (
    !record(input) ||
    (input.kind !== "worktree" && input.kind !== "main_checkout") ||
    !(WORKING_COPY_STATES as readonly unknown[]).includes(input.state)
  )
    throw new Error("Invalid Working copy report.");
  return {
    ticketId: requiredString(input.ticketId),
    projectRepoId: requiredString(input.projectRepoId),
    kind: input.kind,
    state: input.state as CloudWorkingCopyReport["state"],
    branch: gitValue(input.branch),
    baseBranch: gitValue(input.baseBranch),
    headSha: gitValue(input.headSha),
  };
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
/** A local equality fence, not a machine path or a backend argument. Excludes the backend-minted id. */
const copyStamp = (copy: WorkingCopyPath | null): string | null =>
  copy === null
    ? null
    : digest(
        JSON.stringify([
          copy.runnerId,
          copy.ticketId,
          copy.projectRepoId,
          copy.absPath,
          copy.kind,
          copy.branch,
          copy.baseBranch,
          copy.headSha,
          copy.adoptedFromFrozen,
        ]),
      );

function refusal(error: unknown): Block | null {
  if (!record(error) || !record(error.data) || typeof error.data.code !== "string") return null;
  if (!STOP_CODES.has(error.data.code)) return null;
  return {
    code: error.data.code,
    message:
      typeof error.data.message === "string" ? error.data.message.slice(0, 1024) : error.data.code,
  };
}

export function createCloudReportPublisher(options: {
  db: Database.Database;
  ownerUserId: string;
  runnerId: string;
  currentLink(): BackendLink | null;
  registry: RunnerPathRegistry;
  onError?(error: unknown): void;
}) {
  const { db, ownerUserId, runnerId, registry } = options;
  if (!ownerUserId || !runnerId || registry.runnerId !== runnerId)
    throw new Error("Machine reports need their owner and matching runner registry.");
  // This encoding and separator placement are durable. Distinct owners/runners
  // (including ids with ':' or SQL wildcard characters) never share a prefix.
  const prefix =
    `volli:runner-report:${encodeURIComponent(ownerUserId)}:${encodeURIComponent(runnerId)}:` as const;
  const keyFor = (report: Report) =>
    `${prefix}${report.kind === "checkout" ? "checkout" : `copy:${encodeURIComponent(report.args.ticketId)}`}:${encodeURIComponent(report.args.projectRepoId)}` as const;
  const rows = () =>
    prepared<[string, string], StoredRow>(
      db,
      "SELECT key, value FROM app_state WHERE key >= ? AND key < ? ORDER BY key",
    ).all(prefix, `${prefix}\uffff`);
  const corrupt = new Set<string>();
  let stopped = false;
  let scheduled = false;
  let rescan = false;
  let flight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryMs = 250;

  function diagnostic(error: unknown) {
    // A diagnostic sink must not turn a queued observation into a failed Session start.
    try {
      options.onError?.(error);
    } catch {
      /* The durable row remains observable through pending(). */
    }
  }
  function decode(row: StoredRow): Report | null {
    try {
      const value: unknown = JSON.parse(row.value);
      if (
        !record(value) ||
        value.version !== 1 ||
        typeof value.revision !== "string" ||
        !(
          value.blocked === null ||
          (record(value.blocked) &&
            typeof value.blocked.code === "string" &&
            typeof value.blocked.message === "string")
        )
      )
        throw new Error("Invalid machine report.");
      const base = {
        version: 1 as const,
        revision: value.revision,
        blocked: value.blocked as Block | null,
      };
      let report: Report;
      if (value.kind === "checkout")
        report = { ...base, kind: "checkout", args: checkoutArgs(value.args) };
      else if (
        value.kind === "workingCopy" &&
        (value.copyStamp === null || typeof value.copyStamp === "string")
      )
        report = {
          ...base,
          kind: "workingCopy",
          args: copyArgs(value.args),
          copyStamp: value.copyStamp,
        };
      else throw new Error("Invalid machine report.");
      if (keyFor(report) !== row.key) throw new Error("Invalid machine report key.");
      return report;
    } catch {
      const stamp = digest(row.key + row.value);
      if (!corrupt.has(stamp)) {
        corrupt.add(stamp);
        diagnostic(
          new Error("A runner-local machine report is corrupt; it was retained, not sent."),
        );
      }
      return null;
    }
  }
  function cancelTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function retry() {
    if (stopped || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, retryMs);
    timer.unref?.();
    retryMs = Math.min(5000, retryMs * 2);
  }
  function schedule() {
    if (scheduled || stopped || timer !== null) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void flush();
    });
  }
  function enqueue(report: Report) {
    if (stopped) throw new Error("The machine report publisher is stopped.");
    setAppState(db, keyFor(report), JSON.stringify(report), Date.now());
    rescan = true;
    // A new observation replaces a blocked report; reconnect/flush alone never
    // unblocks auth, membership or configuration refusals.
    schedule();
  }
  async function drain(): Promise<void> {
    rescan = false;
    const attempted = new Set<string>();
    let transient = false;
    for (;;) {
      if (stopped) return;
      const link = options.currentLink();
      if (link?.status.state !== "connected") return;
      rescan = false;
      // Scope in SQL BEFORE decoding: foreign raw values never reach the codec,
      // diagnostic sink or transport, including corrupt foreign rows.
      let next: { row: StoredRow; report: Report } | undefined;
      for (const row of rows()) {
        const report = decode(row);
        if (report !== null && report.blocked === null && !attempted.has(report.revision)) {
          next = { row, report };
          break;
        }
      }
      if (next === undefined) break;
      const { row, report } = next;
      attempted.add(report.revision);
      try {
        // BackendLink.call uses the connection's shared control-priority gate.
        const answer = await link.call(
          report.kind === "checkout" ? "projectCheckouts:report" : "workingCopies:report",
          { ...report.args },
        );
        if (stopped) return;
        if (
          report.kind === "workingCopy" &&
          (!record(answer) ||
            typeof answer.workingCopyId !== "string" ||
            answer.workingCopyId.length === 0)
        ) {
          throw Object.assign(new Error("Volli Cloud returned an invalid Working copy identity."), {
            data: {
              code: "invalid_report_reply",
              message: "Volli Cloud returned an invalid Working copy identity.",
            },
          });
        }
        withTransaction(db, () => {
          // Exact payload equality includes a fresh revision per observation.
          // An old in-flight ack must not delete or mutate a newer observation.
          if (getAppState(db, keyFor(report)) !== row.value) return;
          if (report.kind === "workingCopy") {
            const current = registry.workingCopies.get(
              report.args.ticketId,
              report.args.projectRepoId,
            );
            if (
              current !== null &&
              report.copyStamp !== null &&
              copyStamp(current) === report.copyStamp &&
              (current.workingCopyId === null ||
                current.workingCopyId === (answer as { workingCopyId: string }).workingCopyId)
            ) {
              registry.workingCopies.register({
                ...current,
                workingCopyId: (answer as { workingCopyId: string }).workingCopyId,
              });
            }
          }
          prepared(db, "DELETE FROM app_state WHERE key = ? AND value = ?").run(row.key, row.value);
        });
      } catch (error) {
        if (stopped) return;
        const block = refusal(error);
        if (block !== null) {
          prepared(
            db,
            "UPDATE app_state SET value = ?, updated_at = ? WHERE key = ? AND value = ?",
          ).run(JSON.stringify({ ...report, blocked: block }), Date.now(), row.key, row.value);
        } else transient = true;
        diagnostic(error);
      }
    }
    if (transient) retry();
    else retryMs = 250;
  }
  function flush(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (flight !== null) {
      // A reconnect can arrive after an offline pass returned but before its
      // promise's finally ran. Joining it must still arrange a connected pass.
      rescan = true;
      return flight;
    }
    cancelTimer();
    // Defer the drain until flight is assigned, including synchronous failures.
    flight = Promise.resolve()
      .then(drain)
      .catch((error: unknown) => {
        if (!stopped) {
          diagnostic(error);
          retry();
        }
      })
      .finally(() => {
        flight = null;
        // A producer can run after the drain's last scan but before this promise
        // settles. Its microtask may have joined that completed flight.
        if (rescan) schedule();
      });
    return flight;
  }
  return {
    reports: {
      async checkout(input: CheckoutReport): Promise<unknown> {
        enqueue({
          version: 1,
          revision: randomUUID(),
          blocked: null,
          kind: "checkout",
          args: checkoutArgs(input),
        });
        return undefined;
      },
      async workingCopy(input: CloudWorkingCopyReport): Promise<{ workingCopyId: string | null }> {
        const args = copyArgs(input);
        const current = registry.workingCopies.get(args.ticketId, args.projectRepoId);
        const matches =
          current !== null &&
          current.kind === args.kind &&
          current.branch === args.branch &&
          current.baseBranch === args.baseBranch &&
          current.headSha === args.headSha;
        enqueue({
          version: 1,
          revision: randomUUID(),
          blocked: null,
          kind: "workingCopy",
          args,
          copyStamp: matches ? copyStamp(current) : null,
        });
        return { workingCopyId: current?.workingCopyId ?? null };
      },
    },
    flush,
    stop() {
      stopped = true;
      cancelTimer();
    },
    /** Blocked and corrupt rows remain visible, but never include another owner/runner. */
    pending: (): number =>
      prepared<[string, string], { n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM app_state WHERE key >= ? AND key < ?",
      ).get(prefix, `${prefix}\uffff`)!.n,
  };
}
