import { describe, expect, it } from "vite-plus/test";

import { HOST } from "../testing/context";
import { doctorReport, type DoctorCheck } from "./checks";
import { describeHost, renderDoctor } from "./render";

const GIT: DoctorCheck = { id: "git", title: "git", status: "ok", detail: "git 2.43.0" };

describe("a doctor report on a terminal", () => {
  it("names the box, then one line per check, with its fix beneath it", () => {
    const text = renderDoctor(
      doctorReport(HOST, [
        GIT,
        {
          id: "disk",
          title: "disk",
          status: "fail",
          detail: "120 MB free on /var/lib/volli-runner; 1 GB is needed",
          fix: "Remove old working copies under /var/lib/volli-runner",
        },
      ]),
    );
    expect(text).toContain("volli-runner doctor — hetzner-1 · debian 12 · x64 · glibc 2.36");
    expect(text).toMatch(/^ {2}ok {7}git {3}git 2\.43\.0$/mu);
    expect(text).toContain("  fail     disk");
    expect(text).toContain("fix: Remove old working copies under /var/lib/volli-runner");
    expect(text).toContain(
      `1 of 2 checks failed. Fix the lines marked "fix:" above, then run \`volli-runner doctor\` again.`,
    );
  });

  it("counts a warning without calling the box failed", () => {
    const text = renderDoctor(
      doctorReport(HOST, [
        GIT,
        { id: "models", title: "models", status: "warn", detail: "nothing signed in", fix: "x" },
      ]),
    );
    expect(text).toContain("No failed checks (1 ok, 1 warning).");
    expect(text).not.toContain("failed.");
  });

  it("counts warnings, unknowns and infos in the plural", () => {
    const text = renderDoctor(
      doctorReport(HOST, [
        GIT,
        { id: "a", title: "a", status: "warn", detail: "" },
        { id: "b", title: "b", status: "warn", detail: "" },
        { id: "c", title: "c", status: "unknown", detail: "", fix: "run something" },
        { id: "d", title: "d", status: "info", detail: "" },
      ]),
    );
    expect(text).toContain("No failed checks (1 ok, 2 warnings, 1 unknown, 1 info).");
  });

  it("describes a box with no distribution name and no glibc", () => {
    expect(
      describeHost({
        hostname: "box",
        platform: { os: "linux", distro: null, kernel: "6.1.0", arch: "arm64", glibc: null },
        installMode: "system",
      }),
    ).toBe("box · linux · arm64");
  });
});
