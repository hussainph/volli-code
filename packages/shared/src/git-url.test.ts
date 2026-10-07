import { describe, expect, it } from "vite-plus/test";
import { gitUrlProblem } from "./git-url";

describe("clone URL admission before transport", () => {
  it.each([
    ["https://github.com/me/acme.git", null],
    ["ssh://git@github.com/me/acme.git", null],
    ["ssh://deploy@github.com/me/acme.git", null],
    [`https://x.io/${"a".repeat(2035)}`, null],
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
    ["ssh:///repo", "not-a-repository"],
    ["https://x.io/a\u0000b", "characters"],
    ["https://x.io/r.git", null],
    ["https://x.io/acme.git?access_token=t0k", "query"],
    ["https://x.io/acme.git#t0k", "query"],
    ["https://x.io/acme.git%3Faccess_token%3Dt0k", "query"],
  ])("judges the git URL %j: %s", (url, problem) => {
    expect(gitUrlProblem(url)).toBe(problem);
  });
});
