/**
 * A remote host's projects (VC-710): the scripts, run by a real `sh` against
 * a fake `volli` (and, for clones, real git with its config isolated); the
 * readers; and the engine's `projects`, `createProject` and `closeWorkspace`
 * over the fake SSH runner.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REMOTE_HOST_PROJECT_TEXT_MAX, REMOTE_HOST_PROJECTS_MAX } from "@volli/shared";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  cliError,
  createFailure,
  createProjectScript,
  gitUrlProblem,
  lastJsonObject,
  oneLine,
  operatorTokenCommand,
  projectsListScript,
  readProject,
  readProjectList,
  repositoryName,
  scriptFacts,
} from "./remote-hosts-projects";
import type { SshExecResult } from "./ssh";
import {
  harness,
  HOST_ID,
  hostEntry,
  OTHER_ID,
  ready,
  registry,
  WS1,
  WS2,
  type Handler,
} from "./testing/remote-hosts-harness";

const PROJECT = {
  id: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
  name: "Acme",
  prefix: "AC",
  path: "/srv/volli/acme",
  tickets: 3,
  archived: 1,
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/* ── The scripts, in a real shell ──────────────────────────────────────── */

/**
 * A home with a user install's fake `volli`: it prints its arguments, the
 * socket it was given and any Session variable it still sees, as one JSON
 * line, or `answer` when set.
 */
function fakeUserHome(answer: string | null = null) {
  const home = mkdtempSync(join(tmpdir(), "vc710-home-"));
  dirs.push(home);
  const bin = join(home, ".local/share/volli-hostd/current/bin");
  mkdirSync(bin, { recursive: true });
  const volli = join(bin, "volli");
  const said =
    answer === null
      ? `printf '{"args":"%s","socket":"%s","session":"%s","stdin":"%s"}\\n' "$*" "$VOLLI_SOCKET" "\${VOLLI_SESSION:-}\${VOLLI_SESSION_TOKEN:-}" "$(cat)"`
      : `printf '%s\\n' '${answer}'`;
  writeFileSync(volli, `#!/bin/sh\n${said}\n`);
  chmodSync(volli, 0o755);
  return home;
}

function run(script: string, home: string, env: Record<string, string> = {}) {
  const result = spawnSync("/bin/sh", ["-c", script], {
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: home,
      // Git reads none of this machine's configuration.
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      VOLLI_SESSION: "s-1",
      VOLLI_SESSION_TOKEN: "t-1",
      ...env,
    },
    encoding: "utf8",
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("the project scripts, in a real shell", () => {
  it("lists through the user install's volli and socket, with no Session's evidence", () => {
    const home = fakeUserHome();
    const result = run(projectsListScript("user"), home);
    expect(result.code).toBe(0);
    const facts = scriptFacts(result.stdout);
    expect(facts.token).toBe(false);
    expect(facts.login).toMatch(/\S/u);
    expect(lastJsonObject(result.stdout)).toEqual({
      args: "project list --json",
      socket:
        process.platform === "darwin"
          ? `${home}/Library/Application Support/volli-hostd/volli.sock`
          : `${home}/.local/state/volli-hostd/volli.sock`,
      session: "",
      stdin: "",
    });
  });

  it("says when the login holds an operator token", () => {
    const home = fakeUserHome();
    mkdirSync(join(home, ".config/volli"), { recursive: true });
    writeFileSync(join(home, ".config/volli/operator-token"), "token\n");
    expect(scriptFacts(run(projectsListScript("user"), home).stdout).token).toBe(true);
  });

  it("adds a folder by its path, `~/` read as the login's home, the name quoted", () => {
    const home = fakeUserHome();
    const result = run(
      createProjectScript({ mode: "user", path: "~/code/it's", name: "Acme 'x'", gitUrl: null }),
      home,
    );
    expect(lastJsonObject(result.stdout)?.["args"]).toBe(
      `project add ${home}/code/it's --name Acme 'x' --json`,
    );
    expect(scriptFacts(result.stdout).fail).toBeNull();
    const plain = run(
      createProjectScript({ mode: "user", path: "/srv/a", name: null, gitUrl: null }),
      home,
    );
    expect(lastJsonObject(plain.stdout)?.["args"]).toBe("project add /srv/a --json");
  });

  it("clones first, then adds; a checkout already there is added as it is", () => {
    const home = fakeUserHome();
    const origin = join(home, "origin");
    mkdirSync(origin);
    const git = (args: string[], cwd: string) =>
      execFileSync("git", args, {
        cwd,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          HOME: home,
        },
      });
    git(["init", "-q", "-b", "main"], origin);
    git(
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one"],
      origin,
    );
    mkdirSync(join(home, "checkouts"));
    const into = join(home, "checkouts/acme");
    // Only https and ssh: a local path is refused, so the clone fails, and nothing is added.
    const refused = run(
      createProjectScript({ mode: "user", path: into, name: null, gitUrl: origin }),
      home,
    );
    expect(scriptFacts(refused.stdout).fail).toBe("clone-failed");
    expect(lastJsonObject(refused.stdout)).toBeNull();
    expect(refused.stderr).toMatch(/transport 'file' not allowed/u);
    // Cloned by hand: a retry adds it without cloning again.
    git(["clone", "-q", origin, into], home);
    const retried = run(
      createProjectScript({ mode: "user", path: into, name: null, gitUrl: origin }),
      home,
    );
    expect(lastJsonObject(retried.stdout)?.["args"]).toBe(`project add ${into} --json`);
  });

  it("never clones over a folder that is not a checkout, or into one it cannot write", () => {
    const home = fakeUserHome();
    mkdirSync(join(home, "taken"));
    const url = "https://example.invalid/acme.git";
    const taken = run(
      createProjectScript({ mode: "user", path: join(home, "taken"), name: null, gitUrl: url }),
      home,
    );
    expect(scriptFacts(taken.stdout).fail).toBe("destination-exists");
    const nowhere = run(
      createProjectScript({
        mode: "user",
        path: join(home, "no/such/acme"),
        name: null,
        gitUrl: url,
      }),
      home,
    );
    expect(scriptFacts(nowhere.stdout).fail).toBe("destination-unwritable");
  });

  it("on a system install: the system CLI and socket, and a clone as hostd's account, never a password", () => {
    const list = projectsListScript("system");
    expect(list).toContain("v='/opt/volli-hostd/current/bin/volli'");
    expect(list).toContain(`[ -x "$v" ] || v='/opt/volli-hostd/bin/volli'`);
    expect(list).toContain("VOLLI_SOCKET='/run/volli-hostd.sock'");
    const create = createProjectScript({
      mode: "system",
      path: "/srv/volli/acme",
      name: "Acme",
      gitUrl: "git@github.com:me/acme.git",
    });
    expect(create).toContain(
      "if sudo -n -u volli true </dev/null 2>/dev/null; then set -- sudo -n -u volli -H",
    );
    expect(create).toContain("  fail needs-password");
    expect(create).not.toContain("sudo -S");
    expect(create).toContain(`c="!'$b' git-credential --data-dir '/var/lib/volli-hostd'"`);
    expect(create).toContain("GIT_ALLOW_PROTOCOL=https:ssh");
    expect(create).toContain(`exec "$v" project add "$d" --name 'Acme' --json </dev/null`);
    expect(spawnSync("/bin/sh", ["-n", "-c", create]).status).toBe(0);
    const withPassword = createProjectScript({
      mode: "system",
      path: "/srv/volli/acme",
      name: null,
      gitUrl: "https://github.com/me/acme",
      sudoPassword: true,
    });
    expect(withPassword).toContain("  set -- sudo -S -p '' -u volli -H");
    expect(withPassword).toContain("h='github.com'");
  });

  it("clones with Volli's credential helper for that command only: the token never on a command line", () => {
    const home = fakeUserHome();
    const bin = join(home, "fake-bin");
    mkdirSync(bin);
    // git as the box would run it: it says what it was asked, and makes the folder.
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/git-args"\nfor last; do :; done\nmkdir -p "$last/.git"\n`,
    );
    // Volli's helper: a token for example.invalid, and nothing for anything else.
    writeFileSync(
      join(bin, "helper"),
      `#!/bin/sh\ncat > "$HOME/helper-asked"\ngrep -q 'host=example.invalid' "$HOME/helper-asked" && printf 'username=x-access-token\\npassword=SECRET-TOKEN\\n'\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    chmodSync(join(bin, "helper"), 0o755);
    mkdirSync(join(home, "checkouts"));
    const into = join(home, "checkouts/acme");
    const result = run(
      createProjectScript({
        mode: "user",
        path: into,
        name: null,
        gitUrl: "https://example.invalid/me/acme.git",
        credentialHelper: `!'${join(bin, "helper")}'`,
      }),
      home,
      { PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}` },
    );
    expect(scriptFacts(result.stdout)).toMatchObject({ credential: true, fail: null });
    expect(lastJsonObject(result.stdout)?.["args"]).toBe(`project add ${into} --json`);
    const args = readFileSync(join(home, "git-args"), "utf8").trim().split("\n");
    expect(args).toEqual([
      "-c",
      `credential.helper=!'${join(bin, "helper")}'`,
      "clone",
      "--quiet",
      "--no-recurse-submodules",
      "--",
      "https://example.invalid/me/acme.git",
      into,
    ]);
    expect(readFileSync(join(home, "helper-asked"), "utf8")).toBe(
      "protocol=https\nhost=example.invalid\n\n",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain("SECRET-TOKEN");
    // An ssh URL asks for no token: there is no https host to ask about.
    const ssh = run(
      createProjectScript({
        mode: "user",
        path: join(home, "checkouts/other"),
        name: null,
        gitUrl: "git@example.invalid:me/other.git",
        credentialHelper: `!'${join(bin, "helper")}'`,
      }),
      home,
      { PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}` },
    );
    expect(scriptFacts(ssh.stdout).credential).toBe(false);
  });

  it("on a system install, runs the clone as volli: sudo -n, else the password on sudo -S, else stops", () => {
    const home = fakeUserHome();
    const bin = join(home, "fake-bin");
    mkdirSync(bin);
    // sudo as a box would answer: $SUDO is nopasswd, password (takes "pw" on -S), or none.
    writeFileSync(
      join(bin, "sudo"),
      [
        "#!/bin/sh",
        'echo "$*" >> "$HOME/sudo-calls"',
        'if [ "$SUDO" = none ]; then echo "sudo: deploy is not in the sudoers file" >&2; exit 1; fi',
        'case "$1" in',
        '  -n) [ "$SUDO" = nopasswd ] || { echo "sudo: a password is required" >&2; exit 1; }; shift 4 ;;',
        '  -S) IFS= read -r p; [ "$p" = pw ] || { echo "Sorry, try again." >&2; echo "sudo: 1 incorrect password attempt" >&2; exit 1; }; shift 6 ;;',
        "esac",
        '[ "$1" = -H ] && shift',
        'exec "$@"',
      ].join("\n"),
    );
    writeFileSync(join(bin, "git"), `#!/bin/sh\nfor last; do :; done\nmkdir -p "$last/.git"\n`);
    chmodSync(join(bin, "sudo"), 0o755);
    chmodSync(join(bin, "git"), 0o755);
    mkdirSync(join(home, "checkouts"));
    const env = (sudo: string) => ({
      SUDO: sudo,
      PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    });
    const script = (path: string, sudoPassword: boolean) =>
      createProjectScript({
        mode: "system",
        path: join(home, "checkouts", path),
        name: null,
        gitUrl: "https://example.invalid/me/acme.git",
        sudoPassword,
      });
    const facts = (result: { stdout: string }) => scriptFacts(result.stdout);

    // Passwordless: cloned as volli (the system CLI is not on this machine, so the add says nothing).
    const free = run(script("a", false), home, env("nopasswd"));
    expect(free.stdout).toContain("volli-cloned=yes");
    expect(facts(free).fail).toBeNull();
    // A password needed, none given: the sheet asks.
    expect(facts(run(script("b", false), home, env("password"))).fail).toBe("needs-password");
    // Given, on stdin only.
    const given = spawnSync("/bin/sh", ["-c", script("c", true)], {
      env: { HOME: home, ...env("password") },
      input: "pw\n",
      encoding: "utf8",
    });
    expect(given.stdout).toContain("volli-cloned=yes");
    const wrong = spawnSync("/bin/sh", ["-c", script("d", true)], {
      env: { HOME: home, ...env("password") },
      input: "nope\n",
      encoding: "utf8",
    });
    expect(facts({ stdout: wrong.stdout }).fail).toBe("sudo-failed");
    expect(
      createFailure("box", facts({ stdout: wrong.stdout }), null, wrong.stderr, {
        path: "/srv/volli/d",
        gitUrl: "https://example.invalid/me/acme.git",
      }).code,
    ).toBe("wrong-password");
    // No sudo at all: the command to run by hand, whatever was typed.
    expect(facts(run(script("e", true), home, env("none"))).fail).toBe("needs-sudo");
    expect(readFileSync(join(home, "sudo-calls"), "utf8")).not.toContain("pw");
  });

  it("issues an operator token with one quoted command", () => {
    expect(operatorTokenCommand("alice")).toBe("sudo volli-hostd operator-token --for 'alice'");
  });
});

/* ── Reading the answers ───────────────────────────────────────────────── */

describe("reading what the host said", () => {
  it.each([
    ["https://github.com/me/acme.git", null],
    ["ssh://git@github.com/me/acme.git", null],
    ["git@github.com:me/acme.git", null],
    ["", "length"],
    [`https://x.io/${"a".repeat(2048)}`, "length"],
    ["https://x.io/a b", "characters"],
    ["-uhttps://x.io/a", "characters"],
    ["not a url at all", "characters"],
    ["github.com/me/acme", "not-a-url"],
    ["file:///srv/acme", "transport"],
    ["ext::sh -c id", "characters"],
    ["http://x.io/acme", "transport"],
    ["https://me:secret@x.io/acme", "credentials"],
    ["https://me@x.io/acme", "credentials"],
    ["ssh://me:pw@x.io/acme", "credentials"],
    ["https://x.io/", "not-a-repository"],
  ])("judges the git URL %j: %s", (url, problem) => {
    expect(gitUrlProblem(url)).toBe(problem);
  });

  it.each([
    ["https://github.com/me/acme.git", "acme"],
    ["https://github.com/me/acme/", "acme"],
    ["git@github.com:me/acme.git", "acme"],
    ["ssh://git@x.io/team/tool.js", "tool.js"],
    ["https://x.io/..", null],
    ["https://x.io/%20", null],
    ["not a url", null],
  ])("names a clone of %j for its repository: %s", (url, name) => {
    expect(repositoryName(url)).toBe(name);
  });

  it("reads the login, the token and a stop; an unlikely login is none", () => {
    expect(
      scriptFacts(
        "volli-login=alice\nvolli-token=yes\nvolli-credential=no\nvolli-fail=clone-failed\n",
      ),
    ).toEqual({ login: "alice", token: true, fail: "clone-failed", credential: false });
    expect(scriptFacts("volli-credential=yes\n").credential).toBe(true);
    const none = { login: null, token: false, fail: null, credential: null };
    expect(scriptFacts("volli-login=a;b\n")).toEqual(none);
    expect(scriptFacts("")).toEqual(none);
  });

  it("finds the last JSON object, and the CLI's error in it", () => {
    expect(lastJsonObject('{"a":1}\n{"b":2}\n[3]\n{nope\nplain\n')).toEqual({ b: 2 });
    expect(lastJsonObject("")).toBeNull();
    expect(cliError('{"error":{"code":"X","reason":"why\\nnot","message":"m"}}')).toEqual({
      code: "X",
      reason: "why not",
    });
    expect(cliError('{"error":{"code":"X","message":"m"}}')).toEqual({ code: "X", reason: "m" });
    expect(cliError('{"error":{"code":"X"}}')).toEqual({ code: "X", reason: "" });
    expect(cliError('{"error":{"reason":"r"}}')).toBeNull();
    expect(cliError('{"error":"X"}')).toBeNull();
    expect(cliError("")).toBeNull();
  });

  it("makes a host's words one bounded line", () => {
    expect(oneLine(" a\n\tb\u0007c ")).toBe("a b c");
    expect(oneLine("x".repeat(10), 5)).toBe("xxxx…");
  });

  it("believes a project row only whole and bounded", () => {
    expect(readProject(PROJECT)).toEqual({
      id: PROJECT.id,
      name: "Acme",
      prefix: "AC",
      path: "/srv/volli/acme",
      tickets: 3,
    });
    expect(readProject({ ...PROJECT, tickets: -1 })?.tickets).toBe(0);
    expect(readProject({ ...PROJECT, tickets: "3" })?.tickets).toBe(0);
    expect(readProject(null)).toBeNull();
    expect(readProject({ ...PROJECT, id: "" })).toBeNull();
    expect(readProject({ ...PROJECT, name: 3 })).toBeNull();
    expect(readProject({ ...PROJECT, prefix: undefined })).toBeNull();
    expect(
      readProject({ ...PROJECT, path: "p".repeat(REMOTE_HOST_PROJECT_TEXT_MAX + 1) }),
    ).toBeNull();
  });

  it("believes a list only whole, bounded, and with ids", () => {
    expect(readProjectList({ projects: [PROJECT] })).toHaveLength(1);
    expect(readProjectList({ projects: [] })).toEqual([]);
    const { id: _, ...old } = PROJECT;
    expect(readProjectList({ projects: [old] })).toBe("outdated");
    expect(readProjectList({ projects: [PROJECT, 3] })).toBeNull();
    expect(readProjectList({ projects: {} })).toBeNull();
    expect(readProjectList(null)).toBeNull();
    expect(
      readProjectList({
        projects: Array.from({ length: REMOTE_HOST_PROJECTS_MAX + 1 }, () => PROJECT),
      }),
    ).toBeNull();
  });

  it("words every way a create stops, each with its one line and, where one helps, a command", () => {
    const facts = { login: "alice", token: false, fail: null, credential: null };
    const context = { path: "/srv/volli/acme", gitUrl: "https://x.io/acme.git" };
    const failure = (
      fail: string | null,
      error: { code: string; reason: string } | null,
      stderr = "",
      login: string | null = "alice",
    ) => createFailure("box", { ...facts, login, fail }, error, stderr, context);
    expect(failure("needs-sudo", null)).toEqual({
      code: "needs-sudo",
      message:
        "Cloning on box needs sudo, which this login can’t use: clone it there, then add it by its path.",
      command: "sudo -u volli -H git clone -- 'https://x.io/acme.git' '/srv/volli/acme'",
    });
    expect(
      createFailure("box", { ...facts, fail: "needs-sudo" }, null, "", { ...context, gitUrl: null })
        .command,
    ).toBe("sudo -u volli -H git clone -- '' '/srv/volli/acme'");
    expect(failure("destination-exists", null)).toMatchObject({ code: "destination-exists" });
    expect(failure("destination-unwritable", null)).toEqual({
      code: "refused",
      message: "box can’t write to the folder above /srv/volli/acme.",
      command: null,
    });
    expect(failure("clone-failed", null, "Cloning…\nfatal: unable to access: timed out\n")).toEqual(
      {
        code: "clone-failed",
        message: "git couldn’t clone it on box: fatal: unable to access: timed out",
        command: null,
      },
    );
    expect(failure("clone-failed", null).message).toBe("git couldn’t clone it on box.");
    expect(failure(null, { code: "FORBIDDEN_ACTOR", reason: "no token" })).toEqual({
      code: "not-operator",
      message: "This Mac can’t add projects on box yet. Run this there once, then try again.",
      command: "sudo volli-hostd operator-token --for 'alice'",
    });
    expect(failure(null, { code: "FORBIDDEN_ACTOR", reason: "" }, "", null).command).toBe(
      "sudo volli-hostd operator-token --for '<your login>'",
    );
    expect(failure(null, { code: "APP_UNREACHABLE", reason: "" })).toMatchObject({
      code: "hostd-unreachable",
      message: "Volli isn’t answering on box.",
    });
    expect(failure(null, { code: "INVALID_REQUEST", reason: "no such folder" })).toMatchObject({
      code: "refused",
      message: "box didn’t add it: no such folder",
    });
    expect(failure(null, { code: "INVALID_REQUEST", reason: "" }).message).toBe(
      "box didn’t add it.",
    );
    expect(failure("something-new", null)).toMatchObject({ code: "unavailable" });
    expect(failure(null, null)).toEqual({
      code: "unavailable",
      message: "box didn’t answer.",
      command: null,
    });
    const refusedBy = (gitUrl: string, credential: boolean | null, stderr: string) =>
      createFailure("box", { ...facts, fail: "clone-failed", credential }, null, stderr, {
        ...context,
        gitUrl,
      });
    expect(refusedBy("https://github.com/me/acme", false, "remote: Repository not found.")).toEqual(
      {
        code: "needs-credential",
        message: "Add a GitHub token in Sign-ins on box, then try again.",
        command: null,
      },
    );
    expect(
      refusedBy("https://git.example.com:8443/me/acme", null, "fatal: Authentication failed"),
    ).toMatchObject({
      message: "Add a token for git.example.com:8443 in Sign-ins on box, then try again.",
    });
    expect(
      refusedBy("https://github.com/me/acme", true, "fatal: Authentication failed"),
    ).toMatchObject({
      code: "needs-credential",
      message:
        "github.com refused the token on box: replace it in Sign-ins on box, then try again.",
    });
    expect(refusedBy("https://github.com/me/acme", false, "Could not resolve host")).toMatchObject({
      code: "clone-failed",
      message: "git couldn’t clone it on box: Could not resolve host",
    });
    expect(
      refusedBy(
        "git@github.com:me/acme.git",
        null,
        "git@github.com: Permission denied (publickey).",
      ),
    ).toEqual({
      code: "clone-failed",
      message:
        "box has no SSH key its git host accepts: use the https URL, with a token in Sign-ins on box.",
      command: null,
    });
    expect(
      createFailure("box", { ...facts, fail: "clone-failed" }, null, "", {
        ...context,
        gitUrl: null,
      }).message,
    ).toBe("git couldn’t clone it on box.");
    expect(refusedBy("git@github.com:me/acme.git", null, "fatal: early EOF")).toMatchObject({
      code: "clone-failed",
      message: "git couldn’t clone it on box: fatal: early EOF",
    });
    expect(failure("needs-password", null)).toEqual({
      code: "needs-password",
      message: "Cloning on box runs as its volli account: enter your password on box to go on.",
      command: null,
    });
    expect(
      failure("sudo-failed", null, "Sorry, try again.\nsudo: 1 incorrect password attempt\n"),
    ).toEqual({
      code: "wrong-password",
      message: "That password didn’t work on box.",
      command: null,
    });
    expect(failure("sudo-failed", null, "sudo: unknown user volli\n")).toMatchObject({
      code: "unavailable",
      message: "sudo didn’t run the clone on box.",
    });
  });
});

/* ── The engine ────────────────────────────────────────────────────────── */

/** A box whose project scripts answer `answer`. */
const projectScripts =
  (answer: (script: string) => Partial<SshExecResult> | undefined): Handler =>
  (script, options) =>
    options.label === "projects" || options.label === "create-project" ? answer(script) : undefined;

const said = (facts: string, json: unknown, stderr = "", code = 0): Partial<SshExecResult> => ({
  code,
  stdout: `${facts}\n${JSON.stringify(json)}\n`,
  stderr,
});

describe("a host's projects", () => {
  it("lists a system host's projects over SSH, and says it can add one", async () => {
    const h = harness({
      registry: registry(hostEntry()),
      overrides: [
        projectScripts(() => said("volli-login=deploy\nvolli-token=yes", { projects: [PROJECT] })),
      ],
    });
    expect(await h.engine.projects(HOST_ID)).toEqual({
      hostId: HOST_ID,
      projects: [readProject(PROJECT)],
      adds: { kind: "ready" },
    });
    const ran = h.box.scripts.at(-1)!.script;
    expect(ran).toBe(projectsListScript("system"));
    expect(h.box.transports.at(-1)?.closed).toBe(true);
    expect(h.log.lines).toContainEqual(
      expect.objectContaining({
        msg: "listed projects",
        fields: expect.objectContaining({ projects: 1, operator: true, hostId: HOST_ID }),
      }),
    );
  });

  it("names the command a login with no operator token runs once", async () => {
    const h = harness({
      registry: registry(hostEntry()),
      overrides: [
        projectScripts(() => said("volli-login=deploy\nvolli-token=no", { projects: [] })),
      ],
    });
    expect((await h.engine.projects(HOST_ID)).adds).toEqual({
      kind: "needs-operator",
      command: "sudo volli-hostd operator-token --for 'deploy'",
    });
    const unnamed = harness({
      registry: registry(hostEntry()),
      overrides: [projectScripts(() => said("", { projects: [] }))],
    });
    expect((await unnamed.engine.projects(HOST_ID)).adds).toEqual({
      kind: "needs-operator",
      command: "sudo volli-hostd operator-token --for '<your login>'",
    });
  });

  it("says a user install takes no project from this Mac, and lists through its own CLI", async () => {
    const h = harness({
      registry: registry(hostEntry({ mode: "user" })),
      overrides: [projectScripts(() => said("volli-token=no", { projects: [PROJECT] }))],
    });
    expect((await h.engine.projects(HOST_ID)).adds).toEqual({ kind: "user-install" });
    expect(h.box.scripts.at(-1)!.script).toBe(projectsListScript("user"));
  });

  it.each([
    [
      "ssh refused",
      { code: 255, stderr: "ssh: connect to host box port 22: Connection refused\n" },
    ],
  ])("is unreachable when %s, its connection closed", async (_, answer) => {
    const h = harness({
      registry: registry(hostEntry()),
      overrides: [projectScripts(() => answer)],
    });
    await expect(h.engine.projects(HOST_ID)).rejects.toMatchObject({
      code: "host-unreachable",
      message: "Couldn't reach box.",
    });
    expect(h.box.transports.at(-1)?.closed).toBe(true);
  });

  it("is unreachable when ssh throws, and logs a close that failed", async () => {
    const h = harness({
      registry: registry(hostEntry()),
      overrides: [
        projectScripts(() => {
          throw new Error("spawn ssh EACCES");
        }),
      ],
    });
    h.box.closeFails = 1;
    await expect(h.engine.projects(HOST_ID)).rejects.toMatchObject({ code: "host-unreachable" });
    expect(h.log.lines.map((line) => line.msg)).toEqual(
      expect.arrayContaining(["projects: ssh failed", "projects: ssh did not close cleanly"]),
    );
  });

  it("does not believe a host that predates listing, or answers no list", async () => {
    const { id: _, ...old } = PROJECT;
    const outdated = harness({
      registry: registry(hostEntry()),
      overrides: [projectScripts(() => said("", { projects: [old] }))],
    });
    await expect(outdated.engine.projects(HOST_ID)).rejects.toMatchObject({
      code: "projects-unavailable",
      message: "box's Volli is too old to list its projects here: add it again to update it.",
    });
    const down = harness({
      registry: registry(hostEntry()),
      overrides: [
        projectScripts(() => ({
          code: 3,
          stdout: "volli-login=deploy\n",
          stderr: '{"error":{"code":"APP_UNREACHABLE","reason":"no socket"}}\n',
        })),
      ],
    });
    await expect(down.engine.projects(HOST_ID)).rejects.toMatchObject({
      code: "projects-unavailable",
      message: "Volli isn't answering on box.",
    });
    expect(down.log.lines).toContainEqual(
      expect.objectContaining({
        msg: "listing projects: no project list believed",
        fields: expect.objectContaining({ cli: "APP_UNREACHABLE", reason: "no socket" }),
      }),
    );
    const garbled = harness({
      registry: registry(hostEntry()),
      overrides: [projectScripts(() => ({ code: 1, stdout: "", stderr: "a\nb\nc\nd\n" }))],
    });
    await expect(garbled.engine.projects(HOST_ID)).rejects.toMatchObject({
      message: "box didn't list its projects.",
    });
    expect(garbled.log.lines).toContainEqual(
      expect.objectContaining({ fields: expect.objectContaining({ stderr: "b c d" }) }),
    );
  });

  it("refuses an unknown host and a flag that is off", async () => {
    const h = harness({ registry: registry(hostEntry()) });
    await expect(h.engine.projects(OTHER_ID)).rejects.toMatchObject({ code: "unknown-host" });
    const off = harness({ registry: registry(hostEntry()), enabled: () => false });
    await expect(off.engine.projects(HOST_ID)).rejects.toThrow(
      "Remote hosts are not available in this build.",
    );
    await expect(off.engine.createProject({ hostId: HOST_ID, path: "/a" })).rejects.toThrow(
      "Remote hosts are not available in this build.",
    );
    expect(() => off.engine.closeWorkspace(HOST_ID, WS1)).toThrow(
      "Remote hosts are not available in this build.",
    );
  });
});

describe("creating a project on a host", () => {
  const added = (created = true) =>
    projectScripts(() =>
      said("volli-login=deploy\nvolli-token=yes", {
        created,
        project: { ...PROJECT, tickets: undefined, baseBranch: "main" },
      }),
    );

  it("adds a folder by its path, and answers the project", async () => {
    const h = harness({ registry: registry(hostEntry()), overrides: [added()] });
    expect(
      await h.engine.createProject({ hostId: HOST_ID, path: " /srv/volli/acme ", name: " Acme " }),
    ).toEqual({ ok: true, created: true, project: { ...readProject(PROJECT)!, tickets: 0 } });
    expect(h.box.scripts.at(-1)!.script).toBe(
      createProjectScript({ mode: "system", path: "/srv/volli/acme", name: "Acme", gitUrl: null }),
    );
    expect(h.log.lines.map((line) => line.msg)).toEqual(
      expect.arrayContaining(["adding a project", "added a project"]),
    );
  });

  it("answers a folder that was already a project as it is", async () => {
    const h = harness({ registry: registry(hostEntry()), overrides: [added(false)] });
    const result = await h.engine.createProject({ hostId: HOST_ID, path: "~/acme" });
    expect(result).toMatchObject({ ok: true, created: false });
    expect(h.log.lines.at(-1)?.msg).toBe("the folder was already a project");
  });

  it("clones a URL into the host's projects folder unless told where", async () => {
    const h = harness({ registry: registry(hostEntry()), overrides: [added()] });
    await h.engine.createProject({ hostId: HOST_ID, gitUrl: "git@github.com:me/acme.git" });
    expect(h.box.scripts.at(-1)!.script).toBe(
      createProjectScript({
        mode: "system",
        path: "/srv/volli/acme",
        name: null,
        gitUrl: "git@github.com:me/acme.git",
      }),
    );
    await h.engine.createProject({
      hostId: HOST_ID,
      gitUrl: "https://github.com/me/acme",
      path: "/srv/volli/other",
      name: "",
    });
    expect(h.box.scripts.at(-1)!.script).toContain("d='/srv/volli/other'");
  });

  it("refuses, before SSH, what it would not ask a host to do", async () => {
    const h = harness({ registry: registry(hostEntry()), overrides: [added()] });
    const refused = async (input: Record<string, string>) => {
      const result = await h.engine.createProject({ hostId: HOST_ID, ...input });
      return result.ok ? null : result.failure;
    };
    expect(await refused({ gitUrl: "file:///etc" })).toEqual({
      code: "bad-url",
      message: "That isn't a git URL this Mac can clone: use https or ssh.",
      command: null,
    });
    expect(await refused({ gitUrl: "https://x.io/%20" })).toMatchObject({
      code: "bad-url",
      message: "Name the folder to clone it into: the URL names none.",
    });
    expect(await refused({})).toMatchObject({ code: "refused", message: "Name a folder on box." });
    expect(await refused({ path: "  " })).toMatchObject({ code: "refused" });
    expect(await refused({ path: "relative/acme" })).toMatchObject({
      message: "A folder on box is a full path, like /srv/volli/app.",
    });
    expect(await refused({ path: "/a\u0007b" })).toMatchObject({ code: "refused" });
    expect(await refused({ path: `/${"a".repeat(REMOTE_HOST_PROJECT_TEXT_MAX)}` })).toMatchObject({
      code: "refused",
    });
    expect(await refused({ path: "/a", name: "x".repeat(121) })).toMatchObject({
      message: "A project's name is 1 to 120 characters, with no control characters.",
    });
    expect(await refused({ path: "/a", name: "a\nb" })).toMatchObject({ code: "refused" });
    expect(h.box.scripts.filter((entry) => entry.script.includes("project add"))).toEqual([]);
  });

  it("refuses a user install at once: its login is never an operator", async () => {
    const h = harness({ registry: registry(hostEntry({ mode: "user" })) });
    expect(await h.engine.createProject({ hostId: HOST_ID, path: "/a" })).toEqual({
      ok: false,
      failure: {
        code: "user-install",
        message: "box runs Volli as your login, so this Mac can't add projects to it.",
        command: null,
      },
    });
    expect(h.box.scripts).toEqual([]);
  });

  it("answers the host's refusal in one line, with the command that fixes it", async () => {
    const h = harness({
      registry: registry(hostEntry()),
      overrides: [
        projectScripts(() =>
          said(
            "volli-login=deploy\nvolli-token=no",
            {},
            '{"error":{"code":"FORBIDDEN_ACTOR","reason":"no operator token"}}',
            1,
          ),
        ),
      ],
    });
    expect(await h.engine.createProject({ hostId: HOST_ID, path: "/srv/volli/acme" })).toEqual({
      ok: false,
      failure: {
        code: "not-operator",
        message: "This Mac can’t add projects on box yet. Run this there once, then try again.",
        command: "sudo volli-hostd operator-token --for 'deploy'",
      },
    });
    expect(h.log.lines.at(-1)).toMatchObject({
      level: "warn",
      msg: "adding a project failed",
      fields: expect.objectContaining({ failure: "not-operator", code: 1 }),
    });
  });

  it("stops where the script stopped, even beside a project-looking line", async () => {
    const h = harness({
      registry: registry(hostEntry()),
      overrides: [
        projectScripts(() => ({
          stdout: `volli-fail=clone-failed\n${JSON.stringify({ project: PROJECT })}\n`,
          stderr: "fatal: could not read Username\n",
        })),
      ],
    });
    expect(
      await h.engine.createProject({ hostId: HOST_ID, gitUrl: "https://github.com/me/acme" }),
    ).toMatchObject({
      ok: false,
      failure: {
        code: "needs-credential",
        message: "Add a GitHub token in Sign-ins on box, then try again.",
      },
    });
  });

  it("sends a sudo password only on the script's stdin, and only for a clone", async () => {
    const h = harness({ registry: registry(hostEntry()), overrides: [added()] });
    const secret = "hunter2-sudo-secret";
    await h.engine.createProject({
      hostId: HOST_ID,
      gitUrl: "https://github.com/me/acme",
      sudoPassword: secret,
    });
    const cloned = h.box.scripts.at(-1)!;
    expect(cloned.stdin).toBe(`${secret}\n`);
    expect(cloned.script).toContain("set -- sudo -S -p '' -u volli -H");
    expect(cloned.script).not.toContain(secret);
    // A folder needs no sudo: a password given anyway goes nowhere.
    await h.engine.createProject({ hostId: HOST_ID, path: "/srv/volli/a", sudoPassword: secret });
    expect(h.box.scripts.at(-1)!.stdin).toBeNull();
    expect(JSON.stringify(h.log.lines)).not.toContain(secret);
  });

  it("is unreachable when SSH is, in one line", async () => {
    const h = harness({
      registry: registry(hostEntry()),
      overrides: [projectScripts(() => ({ code: 255, stderr: "Connection timed out\n" }))],
    });
    expect(await h.engine.createProject({ hostId: HOST_ID, path: "/a" })).toEqual({
      ok: false,
      failure: { code: "host-unreachable", message: "Couldn't reach box.", command: null },
    });
    await expect(h.engine.createProject({ hostId: OTHER_ID, path: "/a" })).rejects.toMatchObject({
      code: "unknown-host",
    });
  });
});

describe("a project script at quit", () => {
  it("is waited for within the grace, then its ssh is killed", async () => {
    const held = Promise.withResolvers<Partial<SshExecResult>>();
    const h = harness({
      registry: registry(hostEntry()),
      quitGraceMs: 20,
      overrides: [
        (_script, options) => (options.label === "create-project" ? held.promise : undefined),
      ],
    });
    const killed: string[] = [];
    const open = h.ports.ssh;
    (h.ports as { ssh: typeof open }).ssh = (target) => ({
      ...open(target),
      kill: async () => void killed.push("create-project"),
    });
    const creating = h.engine.createProject({ hostId: HOST_ID, path: "/srv/volli/acme" });
    await h.engine.close();
    expect(killed).toEqual(["create-project"]);
    held.resolve({ code: 255, stderr: "Connection closed by remote host\n" });
    expect(await creating).toMatchObject({ ok: false, failure: { code: "host-unreachable" } });
    await expect(h.engine.projects(HOST_ID)).rejects.toThrow("not available");
  });
});

describe("closing a Workspace on this Mac", () => {
  it("closes its link and forgets it here; the project on the host is untouched", () => {
    const h = harness({
      registry: registry(
        hostEntry({ workspaceIds: [WS1, WS2] }),
        hostEntry({ id: OTHER_ID, name: "two" }),
      ),
    });
    const [one, two] = h.links.made;
    one!.set(ready());
    h.engine.closeWorkspace(HOST_ID, WS1);
    expect(one!.closed).toBe(true);
    expect(two!.closed).toBe(false);
    expect(Object.keys(h.engine.snapshot().projects)).toEqual([WS2]);
    expect(h.store.saves.at(-1)?.hosts.map((host) => host.workspaceIds)).toEqual([[WS2], []]);
    // Its state changes are no longer heard.
    one!.set({ status: "closed" });
    expect(Object.keys(h.engine.snapshot().projects)).toEqual([WS2]);
    expect(h.box.scripts).toEqual([]);
    expect(h.log.lines.at(-1)).toMatchObject({
      msg: "closed a workspace",
      fields: { workspaceId: WS1, hostId: HOST_ID },
    });
    const saves = h.store.saves.length;
    h.engine.closeWorkspace(HOST_ID, WS1);
    expect(h.store.saves).toHaveLength(saves);
  });

  it("links the one past the cap that moves under it, once the tunnel is up", () => {
    const ids = Array.from(
      { length: 25 },
      (_, index) => `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    const h = harness({ registry: registry(hostEntry({ workspaceIds: ids })) });
    expect(h.links.made).toHaveLength(24);
    h.engine.closeWorkspace(HOST_ID, ids[0]!);
    expect(h.links.made).toHaveLength(25);
    expect(h.links.made.at(-1)?.workspaceId).toBe(ids[24]);
    expect(h.engine.snapshot().projects[ids[24]!]?.link.status).toBe("connecting");
  });

  it("with the tunnel down, links nothing until it is up", () => {
    const ids = Array.from(
      { length: 25 },
      (_, index) => `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    const h = harness({ tunnelMode: "hold", registry: registry(hostEntry({ workspaceIds: ids })) });
    h.engine.closeWorkspace(HOST_ID, ids[0]!);
    expect(h.links.made).toHaveLength(0);
    expect(Object.keys(h.engine.snapshot().projects)).toHaveLength(24);
  });

  it("refuses on a read-only hosts file, an unknown host, and a save that failed", () => {
    const readOnly = harness({ registry: { v: 2, hosts: [] } });
    expect(() => readOnly.engine.closeWorkspace(HOST_ID, WS1)).toThrow(
      expect.objectContaining({ code: "registry-read-only" }),
    );
    const h = harness({ registry: registry(hostEntry({ workspaceIds: [WS1] })) });
    expect(() => h.engine.closeWorkspace(OTHER_ID, WS1)).toThrow(
      expect.objectContaining({ code: "unknown-host" }),
    );
    h.store.state.saveFails = true;
    expect(() => h.engine.closeWorkspace(HOST_ID, WS1)).toThrow(
      expect.objectContaining({ code: "registry-unwritable" }),
    );
    expect(h.links.made[0]!.closed).toBe(false);
    expect(Object.keys(h.engine.snapshot().projects)).toEqual([WS1]);
  });
});
