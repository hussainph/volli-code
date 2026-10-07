/** VC-718's CI-only fixture configuration; never a replacement for app wiring. */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { userInfo } from "node:os";
import { join, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { processIdentity, killExactly } from "./core.mjs";
import { startSshdFixture, scratchSshEnv } from "./sshd-fixture.mjs";

const exec = promisify(execFile);
export const REMOTE_HOST = "volli-acceptance";
export const REMOTE_PROJECT = "Remote acceptance";
export const ANSWER_QUESTION = "Continue the remote acceptance run?";
export const REOPEN_QUESTION = "Did this question survive reopening Volli?";
export const ANSWER_REPLY = "REMOTE: answer received on the host";
export const REOPEN_REPLY = "REMOTE: reopened question answered on the host";
export const STREAM_REPLY = "REMOTE: scripted turn streamed from the host";

export function assertAcceptanceRunner(env = process.env, platform = process.platform) {
  if (platform !== "darwin" || env.GITHUB_ACTIONS !== "true" || env.RUNNER_OS !== "macOS") {
    throw new Error(
      "Remote acceptance installs a managed host: disposable macOS GitHub runner only",
    );
  }
}

/** Playwright AI snapshots quote YAML keys containing ':'; disabled nodes
 * intentionally have no ref, but remain visible assertions.
 */
export function controlLabel(line) {
  const match = line.match(/^\s*- '?\S+ "((?:\\.|[^"\\])*)"/u);
  return match ? JSON.parse(`"${match[1]}"`) : null;
}
export function visibleControls(tree, role, name, { contains = false } = {}) {
  return tree.split("\n").filter((line) => {
    const actualRole = line.match(/^\s*- '?(\S+) /u)?.[1];
    const label = controlLabel(line);
    return actualRole === role && (contains ? label?.includes(name) : label === name);
  });
}
/** The visible subtree of one named surface, not matching background controls. */
export function snapshotSubtree(tree, role, name) {
  const hits = visibleControls(tree, role, name);
  if (hits.length !== 1) throw new Error(`Expected one ${role} ${name}; found ${hits.length}`);
  const lines = tree.split("\n");
  const start = lines.indexOf(hits[0]);
  const indent = lines[start].search(/\S/u);
  let end = start + 1;
  while (end < lines.length && lines[end].search(/\S/u) > indent) end++;
  return lines.slice(start, end).join("\n");
}

/** VC-724 is optional until it lands; a visible self-add question is never skipped. */
export function acceptanceHostAddState(tree, hostName) {
  const answers = visibleControls(tree, "button", "Add anyway");
  if (answers.length || tree.includes("This is the Mac you’re using")) {
    const question =
      "This is the Mac you’re using. Its projects already run here. Add it anyway (for testing)?";
    if (!tree.includes(question))
      throw new Error("Self-add confirmation text is missing or changed");
    if (answers.length !== 1 || answers[0].includes("[disabled]") || !answers[0].includes("[ref="))
      throw new Error("Expected one enabled Add anyway button");
    const cancel = visibleControls(tree, "button", "Cancel");
    if (cancel.length !== 1 || cancel[0].includes("[disabled]"))
      throw new Error("Expected one enabled Cancel button for self-add");
    return "self-add";
  }
  return tree.includes(`${hostName} is ready`) ? "ready" : "pending";
}

/** Require source, component and message within one visible log list row. */
export function visibleServingRow(tree, host) {
  const lines = tree.split("\n");
  return lines.some((line, i) => {
    if (!/^\s*- listitem(?:[ :]|$)/u.test(line)) return false;
    const indent = line.search(/\S/u);
    let end = i + 1;
    while (end < lines.length && lines[end].search(/\S/u) > indent) end++;
    const row = lines.slice(i, end).join("\n");
    return (
      row.includes(host) &&
      visibleControls(row, "button", "hostd").length === 1 &&
      visibleControls(row, "button", "serving", { contains: true }).length === 1
    );
  });
}

/** Strip only displayed age tokens, never a Session's title/identity/state. */
export function stableWaitingLabel(line) {
  return controlLabel(line)
    ?.replace(/\s*·\s*(?:now|just now|\d+(?:s|m|h|d|w|mo|y)(?: ago)?)$/u, "")
    .trim();
}

export function acceptanceScript(turn) {
  // Auto-titling has no tools and must not consume the scripted conversation.
  if (!turn.body.tools?.length) return undefined;
  if (turn.text.includes("remote-stream-turn")) return { text: STREAM_REPLY, delayMs: 1500 };
  // Never manufacture a tool the production host did not offer.
  if (!turn.body.tools.some((tool) => tool.name === "ask_user")) return undefined;
  const input = turn.body.input ?? [];
  const last = input.at(-1);
  if (last?.type === "function_call_output") {
    if (!String(last.output).includes("proceed"))
      return "REMOTE: expected Proceed answer was not delivered";
    return turn.text.includes("remote-reopen-question") ? REOPEN_REPLY : ANSWER_REPLY;
  }
  if (
    turn.text.includes("remote-answer-question") ||
    turn.text.includes("remote-reopen-question")
  ) {
    return {
      toolCalls: [
        {
          name: "ask_user",
          arguments: {
            question: turn.text.includes("remote-reopen-question")
              ? REOPEN_QUESTION
              : ANSWER_QUESTION,
            options: [
              { id: "proceed", label: "Proceed" },
              { id: "stop", label: "Stop" },
            ],
            allowOther: false,
          },
        },
      ],
    };
  }
  return undefined;
}

/** Classify only visible creation outcomes; arbitrary errors never qualify as XFAIL. */
export function projectCreationOutcome(tree, { hostName, projectName, expectedTicket }) {
  if (tree.includes(`Opened ${projectName} on ${hostName}`)) {
    if (expectedTicket)
      throw new Error(
        `XPASS ${expectedTicket}: remove project expected-failure marker and run the full journey`,
      );
    return { status: "PASS" };
  }
  const refusal = `${hostName} runs Volli as your login, so this Mac can't add projects to it.`;
  if (!tree.includes(refusal)) return null;
  if (!expectedTicket) throw new Error(`Unexpected project refusal: ${refusal}`);
  return { status: "XFAIL", detail: `${expectedTicket}: ${refusal}` };
}

/** Stopped status files retain the old pid; never adopt that possibly reused pid. */
export function acceptanceDaemonPid(status, home) {
  if (status.v !== 1 || status.dataDir !== join(home, "Library/Application Support/volli-hostd"))
    throw new Error("Status did not name this fixture install");
  if (
    !["serving", "refusing"].includes(status.verdict) ||
    !["serving", "refusing"].includes(status.running?.state)
  )
    return null;
  const pid = status.running.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid fixture hostd pid");
  return pid;
}

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const quote = (s) => `"${String(s).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** Escape only a fixture-created absolute path, never a person's SSH config. */
export function sshConfig(fixture) {
  return [
    `Host ${REMOTE_HOST}`,
    "  HostName 127.0.0.1",
    `  Port ${fixture.port}`,
    `  User ${fixture.user}`,
    `  IdentityFile ${quote(fixture.identityFile)}`,
    "  IdentitiesOnly yes",
    "  IdentityAgent none",
    "  UseKeychain no",
    "  AddKeysToAgent no",
    `  UserKnownHostsFile ${quote(fixture.knownHostsFile)}`,
    "  GlobalKnownHostsFile /dev/null",
    "  ForwardAgent no",
    "  ForwardX11 no",
    "",
  ].join("\n");
}

export async function prepareRemoteAcceptance(layout, provider) {
  assertAcceptanceRunner();
  const home = userInfo().homedir;
  // macOS managed installation uses the passwd home, not $HOME. Refuse an
  // existing install/profile BEFORE SSH or Electron can adopt or overwrite it.
  for (const path of [
    join(home, ".local/share/volli-hostd"),
    join(home, "Library/Application Support/volli-hostd"),
    join(home, "Library/LaunchAgents/com.volli.hostd.plist"),
    join(home, ".pi/agent"),
  ]) {
    if (
      await fs.lstat(path).then(
        () => true,
        (e) => {
          if (e.code === "ENOENT") return false;
          throw e;
        },
      )
    ) {
      throw new Error(`Acceptance requires a fresh runner; already exists: ${path}`);
    }
  }
  // sshd StrictModes checks EVERY ancestor of authorized_keys, including
  // macOS's world-writable /private/tmp. Keep the disposable fixture below
  // the fresh CI account's home, never ~/.ssh and never relax StrictModes.
  const dir = await fs.mkdtemp(join(home, ".volli-acceptance-sshd-"));
  const fixture = await startSshdFixture({ dir, runnerAccountHome: true }).catch(async (error) => {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  });
  try {
    const config = join(dir, "ssh_config");
    await fs.writeFile(config, sshConfig(fixture), { flag: "wx", mode: 0o600 });
    // Every production ssh spawn still calls the real system SSH. -F is
    // required: OpenSSH's ~ expansion ignores HOME and uses the passwd home.
    await fs.writeFile(
      join(layout.binDir, "ssh"),
      `#!/bin/sh\nexec /usr/bin/ssh -F '${config.replaceAll("'", "'\\''")}' "$@"\n`,
      { mode: 0o755 },
    );
    const projectPath = await fs.mkdtemp(join(layout.projectsDir, "remote-acceptance-"));
    const originPath = `${projectPath}.origin.git`;
    const hostd = `${home}/.local/share/volli-hostd/current/bin/volli-hostd`;
    const runHostd = (args, timeout = 90_000) =>
      exec("/usr/bin/ssh", [...fixture.sshArgs, `'${hostd}' ${args}`], {
        env: scratchSshEnv(),
        timeout,
      });
    let daemonIdentity = null;
    const captureDaemon = async () => {
      const { stdout } = await runHostd("status --json --user", 10_000).catch((error) => {
        // Managed status prints valid JSON with documented non-serving exits.
        if ([1, 3].includes(error.code) && error.stdout) return { stdout: error.stdout };
        throw error;
      });
      const status = JSON.parse(stdout.trim().split("\n").at(-1));
      const pid = acceptanceDaemonPid(status, home);
      if (pid) daemonIdentity = await processIdentity(pid);
    };
    const stopHostd = async () => {
      // Only a live serving/refusing status can establish ownership. If SSH
      // fails later, still reap the previously recorded pid + start identity.
      let statusError;
      await captureDaemon().catch((error) => {
        statusError = error;
      });
      const signalled = await killExactly([daemonIdentity].filter(Boolean), {
        signal: "SIGTERM",
        graceMs: 10_000,
      });
      if (statusError) throw statusError;
      if (signalled.some((entry) => entry.signal === "SIGKILL"))
        throw new Error("Fixture hostd did not stop cleanly after SIGTERM");
    };
    return {
      ...fixture,
      home,
      projectPath,
      originPath,
      async arrangeBox() {
        assertAcceptanceRunner();
        // Arrange benign box state over fixture SSH: git repo + bare remote.
        // No Volli project registration, operator token, DB seed or fake link.
        // The production UI must create/register the project (VC-722).
        const command = [
          "set -eu",
          `git init --initial-branch=main ${shellQuote(projectPath)}`,
          `printf '%s\\n' 'Remote acceptance fixture' > ${shellQuote(join(projectPath, "README.md"))}`,
          `git -C ${shellQuote(projectPath)} add README.md`,
          `git -c user.name=Acceptance -c user.email=acceptance@volli.test -c commit.gpgsign=false -C ${shellQuote(projectPath)} commit -m fixture`,
          `git init --bare --initial-branch=main ${shellQuote(originPath)}`,
          `git -C ${shellQuote(projectPath)} remote add origin ${shellQuote(originPath)}`,
          `git -c credential.helper= -C ${shellQuote(projectPath)} push --set-upstream origin main`,
        ].join("\n");
        try {
          const result = await exec("/usr/bin/ssh", [...fixture.sshArgs, command], {
            env: scratchSshEnv(),
            timeout: 30_000,
          });
          await fs.writeFile(
            join(layout.logsDir, "arrange-box.log"),
            `Arrange benign Git state over fixture SSH\n${result.stdout}\n${result.stderr}`,
          );
        } catch (error) {
          await fs.writeFile(
            join(layout.logsDir, "arrange-box.log"),
            `Arrange benign Git state over fixture SSH\nexit: ${error.code}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`,
          );
          throw new Error(
            `Benign box Git arrange failed: ${error.stderr || error.stdout || error.message}`,
            { cause: error },
          );
        }
      },
      async stop() {
        try {
          await fs.writeFile(join(layout.logsDir, "sshd.log"), fixture.diagnostics());
          // Save only the daemon's log, never auth/device/key/config files.
          await fs
            .copyFile(join(home, "Library/Logs/volli-hostd.log"), join(layout.logsDir, "hostd.log"))
            .catch((error) => {
              if (error.code !== "ENOENT") throw error;
            });
          // No install until the app's Add flow; a launch/setup failure has none.
          if (
            await fs.lstat(hostd).then(
              () => true,
              (e) => {
                if (e.code === "ENOENT") return false;
                throw e;
              },
            )
          )
            await stopHostd();
        } finally {
          try {
            await fixture.stop();
          } finally {
            await fs.rm(dir, { recursive: true, force: true });
          }
        }
      },
      // Deployment precondition, NOT an acceptance action: a host has a
      // default model configured by its operator. v1 hides the remote picker.
      async configureModel() {
        assertAcceptanceRunner();
        const plist = join(home, "Library/LaunchAgents/com.volli.hostd.plist");
        const gitConfig = join(dir, "gitconfig");
        await fs.writeFile(
          gitConfig,
          "[user]\n name = Acceptance\n email = acceptance@volli.test\n[commit]\n gpgsign = false\n[credential]\n helper =\n",
        );
        // Real launchd deployment config; no model-access/HostLink injected.
        // No key is placed in the daemon environment: step 4 must store it.
        const env = {
          AZURE_OPENAI_BASE_URL: provider.baseUrl,
          AZURE_OPENAI_API_VERSION: "v1",
          HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: gitConfig,
          GIT_TERMINAL_PROMPT: "0",
          NO_PROXY: "127.0.0.1,localhost",
        };
        await exec(
          "python3",
          [
            "-c",
            "import plistlib,json,sys; p=sys.argv[1]; d=plistlib.load(open(p,'rb')); d['EnvironmentVariables'].update(json.loads(sys.argv[2])); plistlib.dump(d,open(p,'wb'))",
            plist,
            JSON.stringify(env),
          ],
          { timeout: 10_000 },
        );
        // `start` is idempotent. Cleanly stop the freshly installed daemon so
        // its next production start re-reads the operator's environment.
        await stopHostd();
        const db = join(home, "Library/Application Support/volli-hostd/volli.db");
        const defaults = JSON.stringify({ global: provider.pin, ticket: provider.pin }).replaceAll(
          "'",
          "''",
        );
        // Same persisted default as volli-drive's standard seedDefaultModel.
        // No tickets, projects, Sessions, answers or logs are seeded here.
        await exec(
          "sqlite3",
          [
            db,
            `PRAGMA busy_timeout=10000; INSERT INTO app_state(key,value,updated_at) VALUES('volli:model-access-defaults','${defaults}',${Date.now()}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;`,
          ],
          { timeout: 15_000 },
        );
        daemonIdentity = null;
        await runHostd("start --user");
        await captureDaemon();
        if (!daemonIdentity) throw new Error("Started fixture hostd has no verified identity");
      },
    };
  } catch (error) {
    await fs.writeFile(join(layout.logsDir, "sshd.log"), fixture.diagnostics());
    try {
      await fixture.stop();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    throw error;
  }
}

export function acceptanceTarballs(value) {
  if (!value || value.split(":").some((path) => !isAbsolute(path) || !path.endsWith(".tar.gz"))) {
    throw new Error(
      "Acceptance needs absolute VOLLI_HOSTD_DEV_TARBALLS paths and adjacent checksums",
    );
  }
  return value;
}
