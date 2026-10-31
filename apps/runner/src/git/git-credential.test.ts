import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createGitCredentialBroker, serveGitCredentials } from "@volli/host-core/cloud-runner";

import { COMMANDS } from "../commands";
import { parseRunnerArgv } from "../args";
import { testContext } from "../testing/context";
import {
  gitCredentialHelperCommand,
  gitCredentialSocketPath,
  readAll,
  runGitCredential,
} from "./git-credential";

const SESSION = "00000000-0000-4000-8000-000000000301";
const REPO = "00000000-0000-4000-8000-000000000302";

let root: string;
const closers: (() => Promise<void>)[] = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "runner-git-credential-")));
});
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  rmSync(root, { recursive: true, force: true });
});

/** A running runner's helper socket: a real broker over a scripted backend answer. */
async function runnerServing(dataDir: string) {
  const asked: unknown[] = [];
  const broker = createGitCredentialBroker({
    verifySession: (token) => (token === "session-token" ? SESSION : null),
    repositoryOf: async () => REPO,
    tokens: {
      github: () => null,
      get: async (request) => {
        asked.push(request);
        return {
          ok: true,
          grant: {
            token: "ghu_box",
            useUntil: 2_000_000_000_000,
            host: "github.com",
            login: "dana",
            identity: { name: "Dana", email: "1+dana@users.noreply.github.com" },
          },
        };
      },
    },
  });
  const served = await serveGitCredentials({
    socketPath: gitCredentialSocketPath(dataDir),
    broker,
  });
  closers.push(() => served.close());
  return { asked };
}

describe("volli-runner git-credential", () => {
  it("answers git's request from the running runner, for the Session in its environment", async () => {
    const dataDir = join(root, "data");
    mkdirSync(dataDir);
    const { asked } = await runnerServing(dataDir);
    const context = testContext({
      root,
      env: { VOLLI_SESSION: SESSION, VOLLI_SESSION_TOKEN: "session-token" },
      stdin: "protocol=https\nhost=github.com\n\n",
    });
    // As git runs it: the helper command, then the action.
    const routed = parseRunnerArgv(["git-credential", "--data-dir", dataDir, "get"], COMMANDS);
    expect(routed.kind).toBe("command");
    const { command, input } = routed as Extract<typeof routed, { kind: "command" }>;
    expect(command.name).toBe("git-credential");
    const code = await command.run(input, context);
    expect(code).toBe(0);
    expect(context.stdout()).toBe(
      "username=x-access-token\npassword=ghu_box\npassword_expiry_utc=2000000000\n",
    );
    expect(context.stderr()).toBe("");
    expect(asked).toEqual([
      { claim: { kind: "session", sessionId: SESSION }, projectRepoId: REPO },
    ]);
  });

  it("is silent and exits 0 when the runner is down, the action is missing or paths fail", async () => {
    const down = testContext({ root, stdin: "protocol=https\nhost=github.com\n\n" });
    expect(
      await runGitCredential(
        { values: { "data-dir": join(root, "nowhere") }, positionals: ["get"] },
        down,
      ),
    ).toBe(0);
    expect(down.stdout()).toBe("");
    expect(down.stderr()).toBe("");
    const bare = testContext({ root });
    expect(await runGitCredential({ values: {}, positionals: [] }, bare)).toBe(0);
    const broken = testContext({
      root,
      stdin: async () => {
        throw new Error("stdin closed");
      },
    });
    expect(await runGitCredential({ values: {}, positionals: ["get"] }, broken)).toBe(0);
    expect(broken.stderr()).toBe("");
  });

  it("names its helper command and socket for a data directory", () => {
    expect(gitCredentialSocketPath("/var/lib/volli-runner")).toBe(
      "/var/lib/volli-runner/git-credential.sock",
    );
    expect(gitCredentialHelperCommand("/opt/volli runner/bin/volli-runner", "/var/lib/it's")).toBe(
      "!'/opt/volli runner/bin/volli-runner' git-credential --data-dir '/var/lib/it'\\''s'",
    );
  });

  it("reads stdin to its end", async () => {
    expect(await readAll(Readable.from(["protocol=", Buffer.from("https\n")]))).toBe(
      "protocol=https\n",
    );
  });
});
