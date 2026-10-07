import { describe, expect, it } from "vite-plus/test";
import { statusEvidence, sshFailureLine } from "./remote-hosts-health";
import { HOST_ID, OTHER_ID } from "./testing/remote-hosts-harness";

const result = (said: unknown, code = 0, stderr = "") => ({
  code,
  stdout: JSON.stringify(said),
  stderr,
});
const serving = {
  v: 1,
  verdict: "serving",
  running: { state: "serving", hostId: HOST_ID, version: "1.2.3" },
};

describe("host-scoped status evidence", () => {
  it("believes only the serving enrolled identity and running version, not the installed binary", () => {
    expect(
      statusEvidence(result({ ...serving, binary: { version: "9.0.0" } }), HOST_ID, "box"),
    ).toEqual({ state: { status: "ready" }, version: "1.2.3", sshFailure: null });
    for (const running of [
      null,
      "invalid",
      {},
      { ...serving.running, state: "starting" },
      { ...serving.running, hostId: null },
      { ...serving.running, version: null },
      { ...serving.running, version: "" },
      { ...serving.running, version: "x".repeat(129) },
    ]) {
      expect(statusEvidence(result({ ...serving, running }), HOST_ID, "box").state.status).toBe(
        "unreachable",
      );
    }
    expect(
      statusEvidence(
        result({ ...serving, running: { ...serving.running, hostId: OTHER_ID } }),
        HOST_ID,
        "box",
      ).state,
    ).toMatchObject({ error: { reason: "host-identity-changed" } });
    expect(statusEvidence(result(serving, 1), HOST_ID, "box").version).toBeNull();
  });
  it("names down, refusing and unavailable status without inventing a welcome", () => {
    for (const [verdict, reason] of [
      ["not-serving", "hostd-not-serving"],
      ["refusing", "hostd-refusing"],
      ["future", "host-status-unavailable"],
    ]) {
      expect(statusEvidence(result({ v: 1, verdict }), HOST_ID, "box").state).toMatchObject({
        error: { reason },
      });
    }
    expect(
      statusEvidence(
        result(
          { v: 1, verdict: "not-serving", detail: "status file unreadable", running: null },
          3,
        ),
        HOST_ID,
        "box",
      ).state,
    ).toMatchObject({
      error: { reason: "host-status-unavailable", message: "Host status isn't available on box." },
    });
    expect(statusEvidence(result(null), HOST_ID, "box").state).toMatchObject({
      error: { reason: "host-status-unavailable" },
    });
    expect(
      statusEvidence(result({ v: 1, running: { hostId: HOST_ID } }), HOST_ID, "box").state.status,
    ).toBe("unreachable");
  });
  it("carries SSH's classification and provisioning's human line", () => {
    const evidence = statusEvidence(
      result(serving, 255, "Permission denied (publickey)."),
      HOST_ID,
      "box",
    );
    expect(evidence).toMatchObject({
      version: null,
      sshFailure: { code: "key-refused" },
      state: { error: { reason: "key-refused" } },
    });
    expect(evidence.state.status === "unreachable" && evidence.state.error.message).toBe(
      evidence.sshFailure!.line,
    );
    expect(sshFailureLine({ kind: "host-key-unknown", detail: "not known" }, "box")).toEqual({
      code: "host-key-unknown",
      line: "You didn’t accept box’s host key",
    });
  });
});
