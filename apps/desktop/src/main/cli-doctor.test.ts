import { describe, expect, it } from "vite-plus/test";

import { parseDoctorOutput, probeCliDoctor } from "./cli-doctor";

const REPORT = JSON.stringify({
  checks: [
    { id: "volli-cli", title: "`volli` is this app's CLI", status: "ok", detail: "/bin/volli" },
    {
      id: "path-position",
      title: "Volli's bin is first on PATH",
      status: "fail",
      detail: "not on PATH",
      remedy: "Run `volli doctor --fix`.",
    },
  ],
  summary: "1 failed of 2 checks.",
});

describe("parseDoctorOutput", () => {
  it("reads the report after the LAST marker, ignoring interactive-shell chatter", () => {
    // An xtrace shell echoes the command (marker included) before running it,
    // and a profile talks on both sides of the output.
    const stdout = `profile says hi __VOLLI_DOCTOR__; volli doctor --json\n__VOLLI_DOCTOR__${REPORT}`;

    const parsed = parseDoctorOutput(stdout);

    expect(parsed?.summary).toBe("1 failed of 2 checks.");
    expect(parsed?.checks).toHaveLength(2);
    expect(parsed?.checks[1]?.remedy).toBe("Run `volli doctor --fix`.");
  });

  it("answers null for a missing marker, empty output, junk JSON, and mis-shaped checks", () => {
    expect(parseDoctorOutput(`no marker at all\n${REPORT}`)).toBeNull();
    expect(parseDoctorOutput("__VOLLI_DOCTOR__")).toBeNull();
    expect(parseDoctorOutput("__VOLLI_DOCTOR__{not json")).toBeNull();
    expect(parseDoctorOutput('__VOLLI_DOCTOR__"a string"')).toBeNull();
    expect(parseDoctorOutput('__VOLLI_DOCTOR__{"checks":"nope","summary":"s"}')).toBeNull();
    expect(parseDoctorOutput('__VOLLI_DOCTOR__{"checks":[{"id":1}],"summary":"s"}')).toBeNull();
    expect(
      parseDoctorOutput(
        '__VOLLI_DOCTOR__{"checks":[{"id":"a","title":"t","status":"meh","detail":"d"}],"summary":"s"}',
      ),
    ).toBeNull();
  });
});

describe("probeCliDoctor", () => {
  it("runs the login shell interactively and returns the parsed report", async () => {
    const calls: { file: string; args: readonly string[] }[] = [];

    const result = await probeCliDoctor({
      shellFile: "/bin/zsh",
      runShell: async (file, args) => {
        calls.push({ file, args });
        return `__VOLLI_DOCTOR__${REPORT}`;
      },
    });

    expect(calls).toEqual([
      {
        file: "/bin/zsh",
        args: ["-l", "-i", "-c", "printf __VOLLI_DOCTOR__; volli doctor --json 2>/dev/null"],
      },
    ]);
    expect(result).toMatchObject({ ok: true, summary: "1 failed of 2 checks." });
  });

  // VC-157: `volli doctor` decides which tool absences are faults from its
  // own cwd, so the probe has to STAND in the project the pane describes.
  // Inheriting main's cwd (`/` under launchd) would imply no project at all
  // and quietly pass a genuinely missing `git`.
  it("runs the probe in the scoped project, so requirements are judged there", async () => {
    const directories: (string | null)[] = [];

    await probeCliDoctor({
      shellFile: "/bin/zsh",
      cwd: "/work/acme",
      runShell: async (_file, _args, cwd) => {
        directories.push(cwd);
        return `__VOLLI_DOCTOR__${REPORT}`;
      },
    });

    expect(directories).toEqual(["/work/acme"]);
  });

  it("passes no directory when no project is in scope", async () => {
    const directories: (string | null)[] = [];

    await probeCliDoctor({
      shellFile: "/bin/zsh",
      runShell: async (_file, _args, cwd) => {
        directories.push(cwd);
        return `__VOLLI_DOCTOR__${REPORT}`;
      },
    });

    expect(directories).toEqual([null]);
  });

  it("turns an unanswerable shell into the diagnosis it is, not a crash", async () => {
    const silent = await probeCliDoctor({
      shellFile: "/bin/zsh",
      runShell: async () => "command not found chatter\n",
    });
    expect(silent.ok).toBe(false);
    if (!silent.ok) expect(silent.error).toContain("did not answer");

    const broken = await probeCliDoctor({
      shellFile: "/bin/zsh",
      runShell: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toContain("login shell could not be run");
  });
});
