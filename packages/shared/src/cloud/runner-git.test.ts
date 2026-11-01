import { describe, expect, test } from "vite-plus/test";

import {
  githubHostOf,
  githubNoreplyEmail,
  githubRemoteUrl,
  normalizeGitRemoteUrl,
  parseRunnerGithubTokenGrant,
  parseRunnerGithubTokenRequest,
  readRunnerGithubTokenError,
  runnerGithubTokenBody,
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
    ).toEqual({ code: "github_rate_limited", message: "slow down", resetAt: 99 });
    expect(readRunnerGithubTokenError({ error: { code: "from_the_future" } })).toEqual({
      code: "github_unavailable",
      message: "GitHub is unavailable.",
      resetAt: null,
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
