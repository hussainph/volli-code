/** Host-scoped evidence over the existing SSH transport: no Workspace is invented. */
import type { RemoteHostLinkState } from "@volli/shared";

import { readHostdJson } from "./contract";
import { describeFailure } from "./failures";
import { classifySshFailure, type SshExecResult, type SshFailure } from "./ssh";

/** The same failure copy used by the provisioning engine. */
export function sshFailureLine(failure: SshFailure, host: string): { code: string; line: string } {
  const code = failure.kind;
  const provisionCode = code === "host-key-unknown" ? "host-key-rejected" : code;
  const { line } = describeFailure(
    provisionCode === "host-key-rejected"
      ? { code: provisionCode, step: "connect" }
      : { code: provisionCode, step: "connect", detail: failure.detail },
    host,
  );
  return { code, line };
}

export function statusEvidence(
  result: SshExecResult,
  hostId: string,
  name: string,
): {
  state: RemoteHostLinkState;
  version: string | null;
  sshFailure: { code: string; line: string } | null;
} {
  const ssh = classifySshFailure(result);
  const sshFailure = ssh === null ? null : sshFailureLine(ssh, name);
  const said = readHostdJson(result.stdout);
  const running = said?.running;
  const facts =
    typeof running === "object" && running !== null ? (running as Record<string, unknown>) : null;
  const version = facts?.version;
  if (
    ssh === null &&
    result.code === 0 &&
    said?.verdict === "serving" &&
    facts?.state === "serving" &&
    facts.hostId === hostId &&
    typeof version === "string" &&
    version.length <= 128 &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)
  ) {
    return { state: { status: "ready" }, version, sshFailure: null };
  }
  const identityChanged = facts?.hostId != null && facts.hostId !== hostId;
  // A system data directory is private. Permission/corruption is unknown,
  // not evidence that hostd is down, even though hostd exits not-serving.
  const verdict = said?.detail === "status file unreadable" ? null : said?.verdict;
  const reason =
    sshFailure?.code ??
    (identityChanged
      ? "host-identity-changed"
      : verdict === "not-serving"
        ? "hostd-not-serving"
        : verdict === "refusing"
          ? "hostd-refusing"
          : "host-status-unavailable");
  const message =
    sshFailure?.line ??
    (identityChanged
      ? `${name}'s host identity changed. Add it again.`
      : verdict === "not-serving"
        ? `Volli isn't answering on ${name}.`
        : verdict === "refusing"
          ? `Volli isn't serving on ${name}.`
          : `Host status isn't available on ${name}.`);
  const error = { code: "SERVICE_UNAVAILABLE", reason, message };
  return {
    state: { status: "unreachable", attempt: 0, retryAt: 0, closeCode: null, error },
    version: null,
    sshFailure,
  };
}
