import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { parseHostdReleasePin, resolveArtifact, type ArtifactRequest } from "./artifact";
import { CHECKLIST_ROWS, describeFailure, STEP_ORDER, type ProvisionFailure } from "./failures";
import { recordingLogger } from "./testing/fake-process";

/** An artifact failure exactly as the app's own `resolveArtifact` answers it. */
const artifactFailure = async (request: Omit<ArtifactRequest, "logger">) => {
  const answered = await resolveArtifact({ ...request, logger: recordingLogger().logger });
  if (!("kind" in answered)) throw new Error("expected the artifact to be unavailable");
  return answered;
};

const EVERY: ProvisionFailure[] = [
  { code: "unreachable", step: "connect", detail: "" },
  { code: "unresolvable", step: "connect", detail: "" },
  { code: "host-key-changed", step: "connect", detail: "" },
  { code: "host-key-rejected", step: "connect" },
  { code: "password-only", step: "connect", detail: "" },
  { code: "key-refused", step: "connect", detail: "" },
  { code: "ssh-missing", step: "connect", detail: "" },
  { code: "ssh-failed", step: "connect", detail: "" },
  { code: "connection-lost", step: "install", detail: "" },
  { code: "probe-failed", step: "probe", detail: "" },
  { code: "unsupported-system", step: "probe", system: "Darwin" },
  { code: "unsupported-arch", step: "probe", arch: "aarch64" },
  { code: "target-unavailable", step: "probe", target: "darwin-arm64" },
  { code: "target-unavailable", step: "probe", target: "plan9-mips" },
  { code: "no-systemd", step: "probe" },
  { code: "no-user-manager", step: "probe" },
  { code: "glibc-too-old", step: "probe", glibc: "2.31" },
  { code: "disk-full", step: "probe", freeBytes: 96 * 1024 ** 2, needBytes: 420 * 1024 ** 2 },
  { code: "host-newer", step: "probe", version: "9.0.0" },
  { code: "needs-sudo", step: "probe", version: "0.2.4" },
  { code: "artifact-unavailable", step: "deliver", detail: "" },
  { code: "artifact-checksum", step: "deliver", detail: "" },
  { code: "artifact-fetch-failed", step: "deliver", detail: "" },
  { code: "upload-failed", step: "deliver", detail: "" },
  { code: "remote-checksum", step: "deliver", detail: "" },
  { code: "unpack-failed", step: "deliver", detail: "" },
  {
    code: "hostd-refused",
    step: "start",
    hostd: "start-failed",
    message: "volli-hostd did not start.",
    detail: [],
  },
  {
    code: "hostd-refused",
    step: "enroll",
    hostd: "no-answer",
    message: "Volli host is missing on box. Try again to put it back.",
    detail: [],
  },
  { code: "tunnel-failed", step: "link", detail: "" },
  { code: "host-key-unverifiable", step: "connect", detail: "1 keys, 0 fingerprints" },
  {
    code: "linger-needs-admin",
    step: "start",
    user: "deploy",
    command: "sudo loginctl enable-linger 'deploy'",
  },
  { code: "unexpected-state", step: "install", detail: "no delivered release to install" },
];

describe("every failure's line and recovery", () => {
  it("has one line and one recovery, retrying from the step that broke", () => {
    for (const failure of EVERY) {
      const { line, recovery } = describeFailure(failure, "box");
      expect(line.length).toBeGreaterThan(0);
      if (recovery.action === "retry") expect(STEP_ORDER).toContain(recovery.from);
    }
    expect(describeFailure(EVERY[17]!, "box")).toEqual({
      line: "96 MB free · needs 420 MB",
      recovery: { action: "retry", label: "Check again", from: "probe" },
    });
    expect(describeFailure(EVERY[11]!, "pi").recovery).toEqual({
      action: "back",
      label: "Choose another host",
    });
    expect(describeFailure(EVERY[26]!, "box").line).toBe("volli-hostd did not start.");
    expect(describeFailure(EVERY[12]!, "mac").line).toBe(
      "Apple silicon Mac hosts aren’t supported by this build yet",
    );
    expect(describeFailure(EVERY[13]!, "x").line).toMatch(/^plan9-mips hosts/u);
  });

  it("hands an administrator's command over, and starts over from the probe when lost", () => {
    expect(describeFailure(EVERY.at(-3)!, "box")).toEqual({
      line: "Couldn’t compute box’s host key fingerprints to show you, so they can’t be checked",
      recovery: { action: "retry", label: "Try again", from: "connect" },
    });
    expect(describeFailure(EVERY.at(-2)!, "box")).toEqual({
      line: "box stops Volli host when deploy logs out. Ask an administrator to run: sudo loginctl enable-linger 'deploy'",
      recovery: { action: "retry", label: "Check again", from: "start" },
    });
    expect(describeFailure(EVERY.at(-1)!, "box")).toEqual({
      line: "Adding box lost track of where it was",
      recovery: { action: "retry", label: "Check again", from: "probe" },
    });
  });

  it("says this Mac could not keep the host, and runs the link again", () => {
    expect(
      describeFailure({ code: "save-failed", step: "link", detail: "disk full" }, "box"),
    ).toEqual({
      line: "Couldn’t save box on this Mac",
      recovery: { action: "retry", label: "Try again", from: "link" },
    });
  });

  it("maps the lab's five rows onto the steps, each step once", () => {
    expect(Object.values(CHECKLIST_ROWS).flat()).toEqual([...STEP_ORDER]);
  });
});

describe("the vague strings, replaced (VC-720)", () => {
  it("says why the host’s identity changed, and what to do about it", () => {
    expect(describeFailure(EVERY[2]!, "box")).toEqual({
      line: "box’s identity changed since you last connected. If you rebuilt it, remove the old key, then try again.",
      recovery: { action: "retry", label: "Try again", from: "connect" },
    });
  });

  it("tells a dev build with no hostd tarball how to provide one, instead of looping on a release", async () => {
    // Each detail below is resolveArtifact's own answer (artifact.ts): the
    // words failures.ts classifies on are pinned to the real producer.
    const cache = join(tmpdir(), "vc720-failures-cache");
    const wanted = "volli-hostd-1.1.0-linux-x64.tar.gz";
    const nothing = await artifactFailure({
      version: "1.1.0",
      target: "linux-x64",
      cacheDir: cache,
      pin: null,
      devTarballs: [],
    });
    expect(nothing.detail).toContain("no hostd release assets");
    expect(
      describeFailure({ code: nothing.kind, step: "deliver", detail: nothing.detail }, "box"),
    ).toEqual({
      line: "Adding box needs a matching hostd tarball and its .sha256 from CI. Restart this dev build with VOLLI_HOSTD_DEV_TARBALLS set to the tarball’s full path.",
      recovery: { action: "back", label: "Back" },
    });
    // Named by VOLLI_HOSTD_DEV_TARBALLS, but gone, or with no .sha256 beside it.
    const empty = mkdtempSync(join(tmpdir(), "vc720-failures-"));
    writeFileSync(join(empty, `${wanted}.sha256`), "a".repeat(64));
    try {
      for (const devTarballs of [[`/no/such/${wanted}`], [join(empty, wanted)]]) {
        const missing = await artifactFailure({
          version: "1.1.0",
          target: "linux-x64",
          cacheDir: cache,
          pin: null,
          devTarballs,
        });
        expect(missing.detail).toMatch(/ is missing\.$/u);
        expect(
          describeFailure({ code: missing.kind, step: "deliver", detail: missing.detail }, "box"),
        ).toEqual({
          line: "The Volli host tarball VOLLI_HOSTD_DEV_TARBALLS names is missing or unverified. Restore it, then check again.",
          recovery: { action: "retry", label: "Check again", from: "deliver" },
        });
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    // A pinned release that is not published yet still says so, and a retry may find it.
    const pin = parseHostdReleasePin({
      schemaVersion: 1,
      version: "1.1.0",
      releaseTag: "v1.1.0",
      assets: [{ platform: "linux", arch: "x64", name: wanted, sha256: "a".repeat(64) }],
    });
    expect(pin).not.toBeNull();
    const unpublished = await artifactFailure({
      version: "1.1.0",
      target: "linux-x64",
      cacheDir: cache,
      pin,
      fetch: async () => new Response(null, { status: 404 }),
    });
    expect(unpublished.detail).toBe(`${wanted} is not published at v1.1.0.`);
    expect(
      describeFailure(
        { code: unpublished.kind, step: "deliver", detail: unpublished.detail },
        "box",
      ),
    ).toEqual({
      line: "This version’s host download isn’t published yet",
      recovery: { action: "retry", label: "Try again", from: "deliver" },
    });
  });

  it("retries a refusal where hostd said it, and a silence from a fresh probe that can repair changed facts", () => {
    expect(
      describeFailure(
        {
          code: "hostd-refused",
          step: "install",
          hostd: "bad-release",
          message: "Not a release.",
          detail: [],
        },
        "box",
      ).recovery,
    ).toEqual({ action: "retry", label: "Try again", from: "install" });
    const noAnswer: ProvisionFailure = {
      code: "hostd-refused",
      step: "enroll",
      hostd: "no-answer",
      message: "Volli host is missing on box. Try again to put it back.",
      detail: [],
    };
    expect(describeFailure(noAnswer, "box")).toEqual({
      line: "Volli host is missing on box. Try again to put it back.",
      recovery: { action: "retry", label: "Try again", from: "probe" },
    });
  });
});
