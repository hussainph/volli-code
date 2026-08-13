import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { piExecutionEnv, scopedEnvironment } from "./execution-env";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "volli-pi-env-"));
}

/** Restores exactly what the host had, including a name it did not set at all. */
function hostVariables(values: Record<string, string>): () => void {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

describe("piExecutionEnv", () => {
  it("gives a command the host's own PATH, HOME, and SSH agent", async () => {
    const restore = hostVariables({ SSH_AUTH_SOCK: "/tmp/volli-test-agent.sock" });
    const env = await piExecutionEnv(workspace());
    try {
      // Unfiltered: a Session's nvm, pyenv and cargo toolchains are on this
      // `PATH` or they are nowhere.
      await expect(
        env.exec("printenv PATH; printenv HOME; printenv SSH_AUTH_SOCK"),
      ).resolves.toEqual({
        ok: true,
        value: {
          stdout: `${process.env.PATH}\n${process.env.HOME}\n/tmp/volli-test-agent.sock\n`,
          stderr: "",
          exitCode: 0,
        },
      });
    } finally {
      restore();
      await env.cleanup();
    }
  });

  it("runs a command without the host's own variables", async () => {
    const restore = hostVariables({
      VOLLI_TEST_FAKE_CREDENTIAL: "host-secret",
      GITHUB_TOKEN: "host-secret",
    });
    const env = await piExecutionEnv(workspace());
    try {
      // Each `printenv` prints nothing for a variable the child was not given,
      // so anything before `done` is a leak of the host's environment.
      await expect(
        env.exec("printenv VOLLI_TEST_FAKE_CREDENTIAL; printenv GITHUB_TOKEN; echo done"),
      ).resolves.toEqual({
        ok: true,
        value: { stdout: "done\n", stderr: "", exitCode: 0 },
      });
    } finally {
      restore();
      await env.cleanup();
    }
  });

  it("still gives a command the variables its caller asked for", async () => {
    const env = await piExecutionEnv(workspace());
    try {
      await expect(
        env.exec("printenv VOLLI_TEST_FLAG", { env: { VOLLI_TEST_FLAG: "yes" } }),
      ).resolves.toEqual({
        ok: true,
        value: { stdout: "yes\n", stderr: "", exitCode: 0 },
      });
    } finally {
      await env.cleanup();
    }
  });

  // A Finder/Dock launch of main inherits launchd's bare PATH
  // (/usr/bin:/bin:/usr/sbin:/sbin), which has never had `volli`'s own shim
  // dir on it. `pathPrefixes` is how a caller — main, handing in the CLI's
  // bin dir — puts something in front of that PATH before a command ever
  // sees it.
  it("prepends the given path prefixes onto the sanitized PATH", async () => {
    const env = await piExecutionEnv(workspace(), { pathPrefixes: ["/volli/bin"] });
    try {
      await expect(env.exec("printenv PATH")).resolves.toEqual({
        ok: true,
        value: { stdout: `/volli/bin:${process.env.PATH}\n`, stderr: "", exitCode: 0 },
      });
    } finally {
      await env.cleanup();
    }
  });

  it("prepends multiple prefixes in order, skipping empty entries", async () => {
    const env = await piExecutionEnv(workspace(), {
      pathPrefixes: ["/volli/bin", "", "/another/bin"],
    });
    try {
      await expect(env.exec("printenv PATH")).resolves.toEqual({
        ok: true,
        value: {
          stdout: `/volli/bin:/another/bin:${process.env.PATH}\n`,
          stderr: "",
          exitCode: 0,
        },
      });
    } finally {
      await env.cleanup();
    }
  });

  it("does not duplicate a prefix already at the front of PATH", async () => {
    const originalPath = process.env.PATH;
    const restore = hostVariables({ PATH: `/volli/bin:${originalPath}` });
    const env = await piExecutionEnv(workspace(), { pathPrefixes: ["/volli/bin"] });
    try {
      await expect(env.exec("printenv PATH")).resolves.toEqual({
        ok: true,
        value: { stdout: `/volli/bin:${originalPath}\n`, stderr: "", exitCode: 0 },
      });
    } finally {
      restore();
      await env.cleanup();
    }
  });

  it("still prepends onto a caller-supplied PATH rather than letting it wipe the prefixes", async () => {
    const env = await piExecutionEnv(workspace(), { pathPrefixes: ["/volli/bin"] });
    try {
      // A real, minimal PATH — proving the override REPLACES the sanitized
      // default, while the session's prefixes still land in front. Without
      // that, a caller-supplied PATH would hide `<userData>/bin` and `volli`
      // would resolve to another install's shim.
      await expect(env.exec("printenv PATH", { env: { PATH: "/usr/bin:/bin" } })).resolves.toEqual({
        ok: true,
        value: { stdout: "/volli/bin:/usr/bin:/bin\n", stderr: "", exitCode: 0 },
      });
    } finally {
      await env.cleanup();
    }
  });
});

describe("scopedEnvironment", () => {
  // The contained path keeps the stricter set; `ScopedExecutionEnv`'s own suite
  // proves the same thing through the class.
  it("filters PATH to system roots and withholds HOME and the SSH agent", () => {
    expect(
      scopedEnvironment({
        PATH: "/Users/me/.nvm/versions/node/v22/bin:/usr/local/bin:/bin",
        HOME: "/Users/me",
        SSH_AUTH_SOCK: "/private/tmp/ssh-agent.sock",
        LANG: "C.UTF-8",
        GITHUB_TOKEN: "host-secret",
      }),
    ).toEqual({ PATH: "/usr/local/bin:/bin", LANG: "C.UTF-8" });
  });
});
