import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { parse as parseYaml } from "yaml";

import {
  runnerCloudInit,
  runnerInstallCommand,
  type RunnerInstallOptions,
  type RunnerInstallVariant,
} from "./runner-install-command";

const VERSION = "0.3.0";
const TOKEN = "vrt_2f9c0d7a4b1e6358a0c4f9d2b7e81536a9d4c0f2b6e8a1d3f";
const SERVER = "https://app.volli.cloud";
const SCRIPT_URL = `https://github.com/hussainph/volli-code/releases/download/v${VERSION}/volli-runner-install.sh`;
const base: RunnerInstallOptions = { appVersion: VERSION, token: TOKEN, name: "hetzner-1" };

/**
 * Stands in for curl: records the environment it was given and where a `-o`
 * pointed, then serves the installer fixture over stdout (or into that file).
 */
const FAKE_CURL = [
  "#!/bin/sh",
  'printf "%s" "${VOLLI_RUNNER_TOKEN-<unset>}" > "$VOLLI_TEST_CURL_TOKEN"',
  "target=",
  "previous=",
  'for argument in "$@"; do',
  '  if [ "$previous" = "-o" ]; then target=$argument; fi',
  "  previous=$argument",
  "done",
  'if [ -n "$target" ]; then',
  '  printf "%s" "$target" > "$VOLLI_TEST_CURL_TARGET"',
  '  cat "$VOLLI_TEST_INSTALLER" > "$target"',
  "else",
  '  cat "$VOLLI_TEST_INSTALLER"',
  "fi",
  "",
].join("\n");

/**
 * The installer the fake curl serves: it says what reached it, and how. An
 * installer handed the token as an argument and one given it in the
 * environment look different here, which is the point of the fixture.
 */
const FAKE_INSTALLER = [
  "#!/bin/sh",
  'printf "installer-token: %s\\n" "${VOLLI_RUNNER_TOKEN-<unset>}"',
  'printf "installer-arg: %s\\n" "$@"',
  "",
].join("\n");

let sandbox: string;
let curlTokenFile: string;
let curlTargetFile: string;
let runEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "volli-runner-install-"));
  const installer = join(sandbox, "installer.sh");
  writeFileSync(installer, FAKE_INSTALLER);
  writeFileSync(join(sandbox, "curl"), FAKE_CURL);
  chmodSync(join(sandbox, "curl"), 0o755);
  curlTokenFile = join(sandbox, "curl-token");
  curlTargetFile = join(sandbox, "curl-target");
  runEnv = {
    ...process.env,
    PATH: `${sandbox}:${process.env.PATH ?? ""}`,
    VOLLI_TEST_CURL_TOKEN: curlTokenFile,
    VOLLI_TEST_CURL_TARGET: curlTargetFile,
    VOLLI_TEST_INSTALLER: installer,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(sandbox, { recursive: true, force: true });
});

/** Runs a generated command the way a box's shell would, with curl replaced. */
function runShell(script: string): string {
  return execFileSync("/bin/sh", ["-c", script], { env: runEnv, encoding: "utf8" });
}

/** The message of the refusal `run` makes, so it can be inspected for a secret. */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a refusal, and got none");
}

describe("runnerInstallCommand", () => {
  it("pins one immutable release script and spells each variant's flags", () => {
    expect(runnerInstallCommand(base)).toBe(
      `curl -fsSL ${SCRIPT_URL} | sh -s -- --token '${TOKEN}' --name 'hetzner-1' --user`,
    );
    expect(runnerInstallCommand({ ...base, variant: "environment" })).toBe(
      `curl -fsSL ${SCRIPT_URL} | VOLLI_RUNNER_TOKEN='${TOKEN}' sh -s -- --name 'hetzner-1' --user`,
    );
    expect(runnerInstallCommand({ ...base, variant: "sudo" })).toBe(
      `curl -fsSL ${SCRIPT_URL} | sudo sh -s -- --token '${TOKEN}' --name 'hetzner-1' --system`,
    );
  });

  it("keeps every variant to one line and one mention of the token", () => {
    const variants: readonly RunnerInstallVariant[] = ["token", "environment", "sudo"];
    for (const variant of variants) {
      const command = runnerInstallCommand({ ...base, variant });
      expect(command, variant).not.toContain("\n");
      expect(command.split(TOKEN), variant).toHaveLength(2);
    }
  });

  it("keeps a root install carrying the token, with --system and never --user", () => {
    const command = runnerInstallCommand({ ...base, variant: "sudo", server: SERVER });
    expect(command).toContain("| sudo sh -s -- ");
    expect(command).toContain(`--token '${TOKEN}'`);
    expect(command).toContain(`--server '${SERVER}'`);
    expect(command).toContain("--system");
    expect(command).not.toContain("--user");
  });

  it("adds --server only off the packaged default and --name only when someone typed one", () => {
    const withName = (name: string) => runnerInstallCommand({ ...base, name });
    const withServer = (server: string | null) => runnerInstallCommand({ ...base, server });
    expect(withName("")).toBe(`curl -fsSL ${SCRIPT_URL} | sh -s -- --token '${TOKEN}' --user`);
    expect(withName("   ")).toBe(withName(""));
    expect(withServer(null)).not.toContain("--server");
    expect(withServer("   ")).not.toContain("--server");
    expect(withServer(SERVER)).toContain(`--server '${SERVER}'`);
    for (const loopback of ["http://127.0.0.1:3210", "http://localhost:3210", "http://[::1]:1"]) {
      expect(withServer(loopback), loopback).toContain(`--server '${loopback}'`);
    }
  });

  it("refuses what it cannot prove safe, and never quotes the token back in the refusal", () => {
    const cases: ReadonlyArray<readonly [string, RunnerInstallOptions]> = [
      ["version with a path", { ...base, appVersion: "0.3.0/../x" }],
      ["version with a v", { ...base, appVersion: "v0.3.0" }],
      ["empty version", { ...base, appVersion: "" }],
      ["two-part version", { ...base, appVersion: "0.3" }],
      ["version with a newline", { ...base, appVersion: "0.3.0\n" }],
      ["empty token", { ...base, token: "" }],
      ["token with a newline", { ...base, token: `${TOKEN}\n` }],
      ["token with a space", { ...base, token: "vrt_a b" }],
      ["name with a newline", { ...base, name: "box\nrm -rf /" }],
      ["name past the input limit", { ...base, name: "n".repeat(81) }],
      ["bare host as server", { ...base, server: "app.volli.cloud" }],
      ["plain http off loopback", { ...base, server: "http://a.b" }],
      ["file scheme", { ...base, server: "file:///etc/passwd" }],
      ["credentials in the url", { ...base, server: "https://m:p@a.b" }],
      ["fragment", { ...base, server: "https://a.b/#x" }],
      ["server with a space", { ...base, server: "https://a.b/ c" }],
      ["server with a newline", { ...base, server: "https://a.b\n" }],
    ];
    for (const [label, options] of cases) {
      const message = refusal(() => runnerInstallCommand(options));
      expect(message, label).toMatch(/^Runner install: /);
      expect(message, label).not.toContain(TOKEN);
    }
    const refusalOf = (options: RunnerInstallOptions) =>
      refusal(() => runnerInstallCommand(options));
    expect(refusalOf({ ...base, appVersion: "0.3" })).toContain("not a release version");
    expect(refusalOf({ ...base, server: "http://a.b" })).toContain("must be https");
    expect(refusalOf({ ...base, token: "" })).toContain("token is empty");
  });

  it("hands the installer what was typed, and the environment token to its shell alone", () => {
    const quoteTrap = join(sandbox, "pwned-quote");
    const subshellTrap = join(sandbox, "pwned-subshell");
    const name = `box'; touch ${quoteTrap}; echo '`;
    // A URL cannot hold a space, so the payload names its own separator: were
    // the quotes lost, the shell would run the substitution and leave the file.
    const server = `https://box.example/a$(touch\${IFS}${subshellTrap})b`;
    const hostile = { ...base, name, server };

    const viaToken = runShell(runnerInstallCommand(hostile));
    expect(viaToken).toContain(`installer-arg: ${name}\n`);
    expect(viaToken).toContain(`installer-arg: ${server}\n`);
    expect(viaToken).toContain(`installer-arg: ${TOKEN}\n`);
    expect(viaToken).toContain("installer-token: <unset>\n");

    const viaEnvironment = runShell(runnerInstallCommand({ ...hostile, variant: "environment" }));
    expect(viaEnvironment).toContain(`installer-token: ${TOKEN}\n`);
    expect(viaEnvironment).toContain(`installer-arg: ${name}\n`);
    expect(viaEnvironment).toContain(`installer-arg: ${server}\n`);
    // The token is the installer's environment, and no argument carries it.
    expect(viaEnvironment).not.toContain(`installer-arg: ${TOKEN}`);

    // curl sits on the left of the pipe: the token is never in its environment.
    expect(readFileSync(curlTokenFile, "utf8")).toBe("<unset>");
    for (const path of [quoteTrap, subshellTrap]) expect(existsSync(path), path).toBe(false);
  });

  it("keeps a backtick substitution in the name literal", () => {
    const trap = join(sandbox, "pwned-backtick");
    const name = `box\`touch ${trap}\``;
    const output = runShell(runnerInstallCommand({ ...base, name }));
    expect(output).toContain(`installer-arg: ${name}\n`);
    expect(existsSync(trap)).toBe(false);
  });
});

interface CloudInitDocument {
  package_update?: boolean;
  packages?: string[];
  runcmd?: string[];
}

describe("runnerCloudInit", () => {
  it("writes a #cloud-config whose runcmd runs the pinned script without the token in argv", () => {
    const document = runnerCloudInit({ ...base, name: "hetzner 1", server: SERVER });
    expect(document.startsWith("#cloud-config\n")).toBe(true);
    const parsed = parseYaml(document) as CloudInitDocument;
    expect(parsed.package_update).toBe(true);
    expect(parsed.packages).toEqual(["curl"]);
    const runcmd = parsed.runcmd ?? [];
    expect(runcmd).toHaveLength(1);
    const script = runcmd[0] ?? "";
    expect(script).toContain("set -eu\n");
    expect(script).toContain("umask 077\n");
    expect(script).toContain("script=$(mktemp)\n");
    expect(script).toContain(`trap 'rm -f "$script"' 0\n`);
    expect(script).toContain(`curl -fsSL ${SCRIPT_URL} -o "$script"\n`);
    const install =
      `VOLLI_RUNNER_TOKEN='${TOKEN}' sh "$script"` +
      ` --name 'hetzner 1' --server '${SERVER}' --system`;
    expect(script).toContain(`${install}\n`);
    expect(script).not.toContain("--token");
    expect(script).not.toContain("--user");
    expect(script).not.toContain("sudo");
    expect(script).not.toMatch(/\bset -[a-z]*x/);
    expect(document.split(TOKEN)).toHaveLength(2);
  });

  it("omits a blank name and a null server, and always installs for the whole machine", () => {
    const document = runnerCloudInit({ ...base, name: "", server: null });
    expect(document).toContain(`sh "$script" --system\n`);
    expect(document).not.toContain("--name");
    expect(document).not.toContain("--server");
    expect(document).not.toContain("--user");
  });

  it("runs its own runcmd: root install, token in its environment, download removed", () => {
    const document = runnerCloudInit({ ...base, name: "hetzner 1" });
    const parsed = parseYaml(document) as CloudInitDocument;
    const output = runShell((parsed.runcmd ?? [])[0] ?? "");
    expect(output).toBe(
      [
        `installer-token: ${TOKEN}`,
        "installer-arg: --name",
        "installer-arg: hetzner 1",
        "installer-arg: --system",
        "",
      ].join("\n"),
    );
    expect(readFileSync(curlTokenFile, "utf8")).toBe("<unset>");
    const download = readFileSync(curlTargetFile, "utf8");
    expect(download).not.toBe("");
    expect(existsSync(download)).toBe(false);
  });

  it("refuses invalid input through the same rules, and says nothing about the token", () => {
    const message = refusal(() => runnerCloudInit({ ...base, token: `${TOKEN}\n` }));
    expect(message).toMatch(/^Runner install: /);
    expect(message).not.toContain(TOKEN);
    expect(refusal(() => runnerCloudInit({ ...base, appVersion: "latest" }))).toContain(
      "not a release version",
    );
  });
});

describe("runner install generation", () => {
  it("logs nothing, so no secret can reach a log through this module", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level),
    );
    runnerInstallCommand(base);
    runnerInstallCommand({ ...base, variant: "environment" });
    runnerInstallCommand({ ...base, variant: "sudo" });
    runnerCloudInit(base);
    refusal(() => runnerInstallCommand({ ...base, token: "" }));
    refusal(() => runnerCloudInit({ ...base, appVersion: "latest" }));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
