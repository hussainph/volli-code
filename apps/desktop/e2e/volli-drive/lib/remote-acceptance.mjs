/** VC-718's CI-only fixture configuration; never a replacement for app wiring. */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { userInfo } from "node:os";
import { join, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { makeScratchRepo, processIdentity, killExactly } from "./core.mjs";
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
/** Strip only displayed age tokens, never a Session's title/identity/state. */
export function stableWaitingLabel(line) {
  return controlLabel(line)
    ?.replace(/\s*·\s*(?:now|just now|\d+(?:s|m|h|d|w|mo|y)(?: ago)?)$/u, "")
    .trim();
}

export function acceptanceScript(turn) {
  // Auto-titling has no tools and must not consume the scripted conversation.
  if (!turn.body.tools?.some((tool) => tool.name === "ask_user")) return undefined;
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
  if (turn.text.includes("remote-stream-turn")) return { text: STREAM_REPLY, delayMs: 1500 };
  return undefined;
}

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
  const dir = join(layout.scratch, "sshd");
  await fs.mkdir(dir, { mode: 0o700 });
  const fixture = await startSshdFixture({ dir, runnerAccountHome: true });
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
    const repo = await makeScratchRepo(layout.projectsDir, "remote-acceptance");
    const hostd = `${home}/.local/share/volli-hostd/current/bin/volli-hostd`;
    const runHostd = (args, timeout = 90_000) =>
      exec("/usr/bin/ssh", [...fixture.sshArgs, `'${hostd}' ${args}`], {
        env: scratchSshEnv(),
        timeout,
      });
    const stopHostd = async () => {
      // Fresh-runner checks above establish ownership; the management status
      // identifies this install, and signalling still checks pid + start time.
      const { stdout } = await runHostd("status --json --user", 10_000).catch((error) => {
        // Managed status prints valid JSON with documented non-serving exits.
        if ([1, 3].includes(error.code) && error.stdout) return { stdout: error.stdout };
        throw error;
      });
      const status = JSON.parse(stdout.trim().split("\n").at(-1));
      if (
        status.v !== 1 ||
        status.dataDir !== join(home, "Library/Application Support/volli-hostd")
      )
        throw new Error("Status did not name this fixture install");
      const pid = status.running?.pid;
      if (!pid) return;
      const identity = await processIdentity(pid);
      if (!identity) return;
      const signalled = await killExactly([identity], { signal: "SIGTERM", graceMs: 10_000 });
      if (signalled.some((entry) => entry.signal === "SIGKILL"))
        throw new Error("Fixture hostd did not stop cleanly after SIGTERM");
    };
    return {
      ...fixture,
      home,
      projectPath: repo.dir,
      async stop() {
        try {
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
          await fixture.stop();
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
        await runHostd("start --user");
      },
    };
  } catch (error) {
    await fixture.stop();
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
