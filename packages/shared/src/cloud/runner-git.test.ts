import { describe, expect, test } from "vite-plus/test";

import {
  githubHostOf,
  githubInstalledOn,
  githubRepoOfRemote,
  githubNoreplyEmail,
  githubRemoteUrl,
  normalizeGitRemoteUrl,
  parseRunnerGithubTokenGrant,
  parseRunnerGithubTokenRequest,
  readRunnerGithubTokenError,
  runnerGithubRefusalLine,
  runnerGithubTokenBody,
  type RunnerGithubTokenError,
  type RunnerGithubTokenRequest,
} from "./runner-git";
import type { JobId, ProjectRepoId, SessionId } from "./ids";
import { RunnerWireError } from "./runners";

const SESSION = "11111111-1111-4111-8111-111111111111" as SessionId;
const JOB = "22222222-2222-4222-8222-222222222222" as JobId;
const REPO = "33333333-3333-4333-8333-333333333333" as ProjectRepoId;

describe("normalizeGitRemoteUrl", () => {
  test("GitHub remotes in any spelling become the canonical https clone URL", () => {
    for (const raw of [
      "git@github.com:Octo-Cat/hello.world.git",
      "git@GitHub.com:Octo-Cat/hello.world",
      "ssh://git@github.com/Octo-Cat/hello.world.git",
      "git+ssh://git@github.com/Octo-Cat/hello.world.git/",
      "https://github.com/Octo-Cat/hello.world",
      "https://x-access-token:ghs_secret@github.com/Octo-Cat/hello.world.git",
      "https://ghp_secret@GITHUB.COM/Octo-Cat/hello.world.git?ref=1#frag",
      "  https://github.com/Octo-Cat/hello.world.git  ",
    ]) {
      expect(normalizeGitRemoteUrl(raw)).toBe("https://github.com/Octo-Cat/hello.world.git");
    }
  });

  test("other hosts keep their transport and lose every secret", () => {
    expect(normalizeGitRemoteUrl("https://alice:pw@GitLab.example.com/group/sub/repo.git")).toBe(
      "https://gitlab.example.com/group/sub/repo.git",
    );
    expect(normalizeGitRemoteUrl("http://git.example.com:8080/repo.git")).toBe(
      "http://git.example.com:8080/repo.git",
    );
    expect(normalizeGitRemoteUrl("ssh://deploy:pw@Example.com:2222/srv/repo.git")).toBe(
      "ssh://deploy@example.com:2222/srv/repo.git",
    );
    expect(normalizeGitRemoteUrl("ssh://example.com/srv/repo.git")).toBe(
      "ssh://example.com/srv/repo.git",
    );
    expect(normalizeGitRemoteUrl("ssh+git://example.com/repo")).toBe("ssh://example.com/repo");
    expect(normalizeGitRemoteUrl("git://example.com/repo.git")).toBe("git://example.com/repo.git");
    expect(normalizeGitRemoteUrl("deploy@Box.example.com:repos/x.git")).toBe(
      "deploy@box.example.com:repos/x.git",
    );
    expect(normalizeGitRemoteUrl("box:/srv/x.git")).toBe("box:/srv/x.git");
    // A GitHub-hosted path that is no owner/repo stays as it was written.
    expect(normalizeGitRemoteUrl("https://github.com/only-owner")).toBe(
      "https://github.com/only-owner",
    );
    expect(normalizeGitRemoteUrl("git@github.com:o/..")).toBe("git@github.com:o/..");
  });

  test("the deployment's GitHub host is canonicalized too, and the result is stable", () => {
    const hosts = ["github.test:8443"];
    expect(normalizeGitRemoteUrl("https://github.test:8443/o/r", hosts)).toBe(
      "https://github.test:8443/o/r.git",
    );
    expect(normalizeGitRemoteUrl("https://github.com/o/r", hosts)).toBe("https://github.com/o/r");
    for (const raw of ["git@github.com:o/r.git", "ssh://a@b.example:22/x", "box:p", "git://h/x"]) {
      const once = normalizeGitRemoteUrl(raw)!;
      expect(normalizeGitRemoteUrl(once)).toBe(once);
    }
  });

  test("refuses anything a box must not clone or that could not be a remote", () => {
    for (const raw of [
      "",
      "   ",
      "/srv/repo.git",
      "./repo",
      "../repo",
      "repo",
      "file:///srv/repo.git",
      "ext::sh -c touch% /tmp/pwned",
      "ext::helper",
      "fd::17",
      "-uhelp",
      "--upload-pack=touch /tmp/x",
      "C:\\repos\\x",
      "C:/repos/x",
      "https://github.com/o/r\nevil",
      "https://exa mple.com/r",
      "https://example.com",
      "https://example.com/",
      "ssh://bad_host!/r",
      "bad_host!:r",
      "https://[::1]/r",
      "https://%zz/r",
      "ftp://example.com/r",
      "http://localhost:8080/x.git",
      "https://LOCALHOST/x.git",
      "https://dev.localhost/x.git",
      "http://127.0.0.1/x.git",
      "http://0.0.0.0/x.git",
      "http://169.254.169.254/latest/meta-data",
      "git@127.0.0.1:x.git",
      "ssh://-oProxyCommand%3Did@example.com/p",
      "-oProxyCommand=id@example.com:p",
      `https://example.com/${"a".repeat(1100)}`,
    ]) {
      expect(normalizeGitRemoteUrl(raw), raw).toBeNull();
    }
  });
});

describe("GitHub remotes and identities", () => {
  test("githubHostOf reads the host of an http(s) web URL", () => {
    expect(githubHostOf("https://GitHub.com/")).toBe("github.com");
    expect(githubHostOf("http://127.0.0.1:9000")).toBe("127.0.0.1:9000");
    expect(githubHostOf("ftp://github.com")).toBeNull();
    expect(githubHostOf("not a url")).toBeNull();
    expect(githubHostOf("https://")).toBeNull();
  });

  test("githubRemoteUrl derives the clone URL from owner and name", () => {
    expect(githubRemoteUrl("https://github.com", "octo", "hello")).toBe(
      "https://github.com/octo/hello.git",
    );
    expect(githubRemoteUrl("http://127.0.0.1:9000/", "octo", "hello.git")).toBe(
      "http://127.0.0.1:9000/octo/hello.git",
    );
    expect(githubRemoteUrl("https://github.com", "bad owner", "hello")).toBeNull();
    expect(githubRemoteUrl("nope", "octo", "hello")).toBeNull();
  });

  test("githubNoreplyEmail is GitHub's id+login form", () => {
    expect(githubNoreplyEmail("501", "dana")).toBe("501+dana@users.noreply.github.com");
  });
});

describe("the /runner/github-token wire", () => {
  test("a request names exactly one claim and round-trips through its body", () => {
    const session: RunnerGithubTokenRequest = {
      claim: { kind: "session", sessionId: SESSION },
      projectRepoId: REPO,
    };
    const job: RunnerGithubTokenRequest = {
      claim: { kind: "job", jobId: JOB },
      projectRepoId: REPO,
    };
    expect(runnerGithubTokenBody(session)).toEqual({ sessionId: SESSION, projectRepoId: REPO });
    expect(parseRunnerGithubTokenRequest(runnerGithubTokenBody(session))).toEqual(session);
    expect(parseRunnerGithubTokenRequest(runnerGithubTokenBody(job))).toEqual(job);
  });

  test("a malformed request is a wire error", () => {
    for (const body of [
      null,
      [],
      "x",
      { sessionId: SESSION },
      { projectRepoId: "nope", sessionId: SESSION },
      { projectRepoId: REPO },
      { projectRepoId: REPO, sessionId: SESSION, jobId: JOB },
      { projectRepoId: REPO, sessionId: "nope" },
      { projectRepoId: REPO, jobId: 7 },
    ]) {
      expect(() => parseRunnerGithubTokenRequest(body)).toThrow(RunnerWireError);
    }
  });

  test("a grant is read strictly", () => {
    const grant = {
      token: "ghu_x",
      useUntil: 10,
      host: "github.com",
      login: "dana",
      identity: { name: "Dana Doe", email: "501+dana@users.noreply.github.com" },
      extra: true,
    };
    const { extra: _extra, ...expected } = grant;
    expect(parseRunnerGithubTokenGrant(grant)).toEqual(expected);
    for (const broken of [
      { ...grant, token: "" },
      { ...grant, token: "a\nb" },
      { ...grant, useUntil: Number.NaN },
      { ...grant, useUntil: "10" },
      { ...grant, identity: null },
      { ...grant, identity: { name: "x" } },
      { ...grant, host: 5 },
    ]) {
      expect(() => parseRunnerGithubTokenGrant(broken)).toThrow(RunnerWireError);
    }
  });

  test("a refusal is read tolerantly", () => {
    expect(
      readRunnerGithubTokenError({
        error: { code: "github_rate_limited", message: "slow down", resetAt: 99 },
      }),
    ).toEqual({ code: "github_rate_limited", message: "slow down", resetAt: 99, account: null });
    expect(readRunnerGithubTokenError({ error: { code: "from_the_future" } })).toEqual({
      code: "github_unavailable",
      message: "GitHub is unavailable.",
      resetAt: null,
      account: null,
    });
    for (const odd of [null, [], { error: [] }, { error: null }, "x"]) {
      expect(readRunnerGithubTokenError(odd).code).toBe("github_unavailable");
    }
    expect(
      readRunnerGithubTokenError({ error: { code: "not_claimed", message: "m".repeat(2000) } })
        .message,
    ).toHaveLength(1024);
  });
});

const accountRead = (account: unknown) =>
  readRunnerGithubTokenError({ error: { code: "github_not_installed", message: "m", account } })
    .account;

describe("a refusal's account", () => {
  test("is kept only when it is a plain GitHub login", () => {
    expect(accountRead("Octo-Org")).toBe("Octo-Org");
    for (const odd of [
      undefined,
      7,
      "",
      "-leading",
      "a".repeat(40),
      "two words",
      "evil\u001b[2Jlogin",
      "line\nbreak",
      "owner/repo",
    ]) {
      expect(accountRead(odd)).toBeNull();
    }
  });
});

describe("githubRepoOfRemote", () => {
  test("reads the owner and name of a canonical GitHub remote on that host", () => {
    expect(githubRepoOfRemote("https://github.com/Octo-Org/hello.world.git", "github.com")).toEqual(
      { owner: "Octo-Org", name: "hello.world" },
    );
    expect(githubRepoOfRemote("http://ghe.example:8443/team/app.git", "GHE.example:8443")).toEqual({
      owner: "team",
      name: "app",
    });
  });

  test("answers null for anything else", () => {
    for (const remote of [
      "not a url",
      "ssh://git@github.com/o/r.git",
      "https://gitlab.com/o/r.git",
      "https://github.com/o/r",
      "https://github.com/group/sub/r.git",
      "https://github.com/-o/r.git",
    ]) {
      expect(githubRepoOfRemote(remote, "github.com")).toBeNull();
    }
  });
});

describe("githubInstalledOn", () => {
  test("a live installation on the owner's account, in any case, counts", () => {
    expect(githubInstalledOn([{ accountLogin: "Octo-Org", suspended: false }], "octo-org")).toBe(
      true,
    );
  });

  test("a suspended installation, another account, or none does not", () => {
    expect(githubInstalledOn([{ accountLogin: "octo-org", suspended: true }], "octo-org")).toBe(
      false,
    );
    expect(githubInstalledOn([{ accountLogin: "someone", suspended: false }], "octo-org")).toBe(
      false,
    );
    expect(githubInstalledOn([], "octo-org")).toBe(false);
  });
});

describe("runnerGithubRefusalLine", () => {
  const NOW = 1_000_000;
  const line = (error: Partial<RunnerGithubTokenError> & Pick<RunnerGithubTokenError, "code">) =>
    runnerGithubRefusalLine({ resetAt: null, account: null, ...error }, NOW);

  test("each refusal the person can fix gets one line naming the fix", () => {
    expect(line({ code: "github_not_connected" })).toBe(
      "volli: GitHub isn't connected. Connect it in Volli → Settings → Account.",
    );
    expect(line({ code: "github_needs_reconnect" })).toBe(
      "volli: GitHub needs reconnecting. Reconnect it in Volli → Settings → Account.",
    );
    expect(line({ code: "github_not_installed", account: "Octo-Org" })).toBe(
      "volli: Volli can't reach this repository. Install Volli on Octo-Org on GitHub.",
    );
    expect(line({ code: "github_not_installed" })).toBe(
      "volli: Volli can't reach this repository. Install Volli on the repository's owner on GitHub.",
    );
  });

  test("a rate limit says when to try again", () => {
    expect(line({ code: "github_rate_limited" })).toBe(
      "volli: GitHub is rate limiting Volli. Try again in a few minutes.",
    );
    expect(line({ code: "github_rate_limited", resetAt: NOW + 30_000 })).toBe(
      "volli: GitHub is rate limiting Volli. Try again in 1 minute.",
    );
    expect(line({ code: "github_rate_limited", resetAt: NOW - 5_000 })).toBe(
      "volli: GitHub is rate limiting Volli. Try again in 1 minute.",
    );
    expect(line({ code: "github_rate_limited", resetAt: NOW + 4 * 60_000 + 1 })).toBe(
      "volli: GitHub is rate limiting Volli. Try again in 5 minutes.",
    );
  });

  test("other refusals add nothing", () => {
    for (const code of [
      "invalid_request",
      "unauthenticated",
      "not_a_runner",
      "revoked",
      "preview_access_required",
      "not_claimed",
      "not_your_runner",
      "not_found",
      "not_a_member",
      "invalid_repo",
      "github_unavailable",
    ] as const) {
      expect(line({ code })).toBeNull();
    }
  });
});
