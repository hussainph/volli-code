import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { refusingCredentialReads } from "@volli/agent-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  answerGitCredential,
  appendGitConfig,
  fileGitCredentialStore,
  GIT_CREDENTIALS_FILE,
  gitCredentialHelperEnv,
  parseGitCredentialRequest,
  shellWord,
} from "./git-credentials";

const TOKEN = "ghp_PUSHTOKEN0123456789abcdef";
let dataDir: string;

/** One handle per question, so nothing is judged from a path checked earlier. */
async function modeOf(path: string): Promise<number> {
  const handle = await open(path, "r");
  try {
    return (await handle.stat()).mode & 0o777;
  } finally {
    await handle.close();
  }
}

async function textOf(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "vc702-git-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("the push-credential file", () => {
  it("keeps one credential per host, 0600 in a 0700 directory, and lists hosts only", async () => {
    const path = join(dataDir, GIT_CREDENTIALS_FILE);
    const store = fileGitCredentialStore(path);
    expect(await store.hosts()).toEqual([]);
    await store.set("GitHub.com", { username: "x-access-token", password: TOKEN });
    await store.set("git.example.com:8443", { username: "me", password: "other" });
    expect(await store.hosts()).toEqual(["git.example.com:8443", "github.com"]);
    expect(await store.get("github.com")).toEqual({ username: "x-access-token", password: TOKEN });
    expect(await modeOf(path)).toBe(0o600);
    expect(await modeOf(join(dataDir, "credentials"))).toBe(0o700);
    await store.clear("github.com");
    await store.clear("github.com");
    expect(await store.get("github.com")).toBeNull();
    expect(await textOf(path)).not.toContain(TOKEN);
    // The agent's structured read tools refuse the file by its location.
    const tools = refusingCredentialReads(
      { readTextFile: async () => "read" } as unknown as Parameters<
        typeof refusingCredentialReads
      >[0],
      dataDir,
    );
    const read = tools.readTextFile as unknown as (path: string) => Promise<unknown>;
    await expect(read(path)).rejects.toThrow("refuses credential-file reads");
  });

  it("refuses a line break in a value and a host that is not a host", async () => {
    const store = fileGitCredentialStore(join(dataDir, GIT_CREDENTIALS_FILE));
    await expect(store.set("github.com", { username: "x", password: "a\nb" })).rejects.toThrow(
      "one line",
    );
    await expect(store.set("*.github.com", { username: "x", password: "p" })).rejects.toThrow();
  });

  it("serializes concurrent writes so none loses another's host", async () => {
    const store = fileGitCredentialStore(join(dataDir, GIT_CREDENTIALS_FILE));
    await Promise.all(
      ["a.test", "b.test", "c.test"].map((host) =>
        store.set(host, { username: "u", password: "p" }),
      ),
    );
    expect(await store.hosts()).toEqual(["a.test", "b.test", "c.test"]);
  });

  it("reads a damaged file as a failure that never quotes it", async () => {
    const path = join(dataDir, GIT_CREDENTIALS_FILE);
    await fileGitCredentialStore(path).set("github.com", { username: "x", password: TOKEN });
    await writeFile(path, `{"version":1,"hosts":${TOKEN}`);
    const failure = await fileGitCredentialStore(path)
      .hosts()
      .catch((error: Error) => error.message);
    expect(failure).toBe("The git push-credential store is not valid JSON.");
  });
});

describe("the helper's protocol", () => {
  const store = {
    get: async (host: string) =>
      host === "github.com" ? { username: "x-access-token", password: TOKEN } : null,
  };

  it("answers `get` for https to a stored host, and nothing else", async () => {
    const request = parseGitCredentialRequest("protocol=https\nhost=github.com\n\n");
    expect(await answerGitCredential("get", request, store)).toBe(
      `username=x-access-token\npassword=${TOKEN}\n`,
    );
    expect(await answerGitCredential("store", request, store)).toBe("");
    expect(await answerGitCredential("erase", request, store)).toBe("");
    for (const text of [
      "protocol=http\nhost=github.com\n",
      "protocol=https\nhost=gitlab.com\n",
      "protocol=https\nhost=github.com\nusername=someone-else\n",
      "host=github.com\n",
    ]) {
      expect(await answerGitCredential("get", parseGitCredentialRequest(text), store)).toBe("");
    }
  });

  it("installs itself as command-scope configuration, quoted for git's shell", () => {
    const helper = `!${["/opt/volli hostd/node", "it's.cjs"].map(shellWord).join(" ")}`;
    expect(helper).toBe(`!'/opt/volli hostd/node' 'it'\\''s.cjs'`);
    expect(gitCredentialHelperEnv(helper)).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: helper,
    });
  });

  it("appends after configuration a layer before it already set, never over it", () => {
    // A platform's reset of the helper list (an empty value clears it), then Volli's.
    const reset = appendGitConfig({ PATH: "/usr/bin" }, [["credential.helper", ""]]);
    expect(reset).toEqual({
      PATH: "/usr/bin",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
    });
    expect(gitCredentialHelperEnv("!volli", reset)).toEqual({
      ...reset,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "!volli",
    });
    expect(appendGitConfig({ GIT_CONFIG_COUNT: "nonsense" }, [["a.b", "c"]])).toMatchObject({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "a.b",
    });
  });
});
