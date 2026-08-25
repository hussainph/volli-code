import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { piExecutionEnv, scopedEnvironment } from "./execution-env";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "volli-pi-env-"));
}

/** Restores exactly what the host had, including a name it did not set at all. */
function hostVariables(values: Record<string, string | undefined>): () => void {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
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

  // VC-51: the identity option is what lets `volli session done` /
  // `session blocked` resolve their context inside a structured Session's
  // shell, and what makes socket writes attribute to the Session — the same
  // contract a Volli-spawned PTY gets from `agentSessionEnv`.
  it("tells a command which Volli session and ticket it runs for", async () => {
    const env = await piExecutionEnv(workspace(), {
      identity: { sessionId: "session-uuid-1", ticketDisplayId: "VC-51" },
    });
    try {
      await expect(env.exec("printenv VOLLI_SESSION; printenv VOLLI_TICKET")).resolves.toEqual({
        ok: true,
        value: { stdout: "session-uuid-1\nVC-51\n", stderr: "", exitCode: 0 },
      });
    } finally {
      await env.cleanup();
    }
  });

  // VC-163: a structured Session's shell authenticates like a PTY's does. The
  // token is what makes `volli ticket comment` from inside a turn a Session
  // write rather than an unauthenticated one that may only read.
  it("carries the attachment's session token beside the identity", async () => {
    const env = await piExecutionEnv(workspace(), {
      identity: {
        sessionId: "session-uuid-1",
        ticketDisplayId: "VC-51",
        sessionToken: "tok-abc",
      },
    });
    try {
      await expect(env.exec("printenv VOLLI_SESSION_TOKEN")).resolves.toEqual({
        ok: true,
        value: { stdout: "tok-abc\n", stderr: "", exitCode: 0 },
      });
    } finally {
      await env.cleanup();
    }
  });

  it("exports no token variable when the host minted none", async () => {
    const env = await piExecutionEnv(workspace(), {
      identity: { sessionId: "session-uuid-1", ticketDisplayId: null },
    });
    try {
      await expect(env.exec("printenv VOLLI_SESSION_TOKEN; echo done")).resolves.toEqual({
        ok: true,
        value: { stdout: "done\n", stderr: "", exitCode: 0 },
      });
    } finally {
      await env.cleanup();
    }
  });

  it("omits VOLLI_TICKET for a ticketless session rather than inventing one", async () => {
    const env = await piExecutionEnv(workspace(), {
      identity: { sessionId: "session-uuid-1", ticketDisplayId: null },
    });
    try {
      await expect(env.exec("printenv VOLLI_TICKET; printenv VOLLI_SESSION")).resolves.toEqual({
        ok: true,
        value: { stdout: "session-uuid-1\n", stderr: "", exitCode: 0 },
      });
    } finally {
      await env.cleanup();
    }
  });

  it("never carries the host's own VOLLI_SESSION into an unidentified environment", async () => {
    // Identity is host-minted per Session, not an inherited variable: a
    // `VOLLI_SESSION` sitting in main's own environment names the wrong
    // session for every attachment but one, so it must not leak through.
    const restore = hostVariables({ VOLLI_SESSION: "host-session", VOLLI_TICKET: "VC-0" });
    const env = await piExecutionEnv(workspace());
    try {
      await expect(
        env.exec("printenv VOLLI_SESSION; printenv VOLLI_TICKET; echo done"),
      ).resolves.toEqual({
        ok: true,
        value: { stdout: "done\n", stderr: "", exitCode: 0 },
      });
    } finally {
      restore();
      await env.cleanup();
    }
  });

  it("still lets a tool call's own env override the identity, like any variable", async () => {
    const env = await piExecutionEnv(workspace(), {
      identity: { sessionId: "session-uuid-1", ticketDisplayId: "VC-51" },
    });
    try {
      await expect(
        env.exec("printenv VOLLI_SESSION", { env: { VOLLI_SESSION: "caller-says" } }),
      ).resolves.toEqual({
        ok: true,
        value: { stdout: "caller-says\n", stderr: "", exitCode: 0 },
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

  it("puts prefixes into a caller-supplied empty PATH", async () => {
    const env = await piExecutionEnv(workspace(), { pathPrefixes: ["/volli/bin"] });
    try {
      await expect(env.exec("/usr/bin/printenv PATH", { env: { PATH: "" } })).resolves.toEqual({
        ok: true,
        value: { stdout: "/volli/bin\n", stderr: "", exitCode: 0 },
      });
    } finally {
      await env.cleanup();
    }
  });

  /**
   * The containment half of VC-119's export boundary.
   *
   * Volli's exporter runs in Electron main and is configured from a Settings
   * row rather than from the environment — but a developer debugging a
   * collector will have `OTEL_*` in the shell that launched the app, and the
   * app's own process environment is what a tool call would otherwise inherit.
   * Nothing a model runs may see where telemetry goes, be able to redirect it,
   * or read a collector credential out of the environment.
   *
   * It holds by construction rather than by a filter: this environment is an
   * allowlist ({@link UNSANDBOXED_VARIABLES}), so a variable is absent unless
   * somebody names it. The test is here to make removing that allowlist a test
   * failure rather than a silent leak.
   */
  it("never hands a command the host's OpenTelemetry configuration", async () => {
    const restore = hostVariables({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer host-secret",
      OTEL_SERVICE_NAME: "volli",
      OTEL_SDK_DISABLED: "false",
      OTEL_TRACES_EXPORTER: "otlp",
    });
    const env = await piExecutionEnv(workspace());
    try {
      // `env | grep` prints nothing when no name matches, so anything before
      // `done` is telemetry configuration reaching a model's shell.
      await expect(env.exec("env | grep '^OTEL_' || true; echo done")).resolves.toEqual({
        ok: true,
        value: { stdout: "done\n", stderr: "", exitCode: 0 },
      });
    } finally {
      restore();
      await env.cleanup();
    }
  });

  it("gives a command an empty PATH when neither host nor caller supplies one", async () => {
    const restore = hostVariables({ PATH: undefined });
    const env = await piExecutionEnv(workspace());
    try {
      await expect(env.exec("/usr/bin/printenv PATH")).resolves.toEqual({
        ok: true,
        value: { stdout: "\n", stderr: "", exitCode: 0 },
      });
    } finally {
      restore();
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
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer host-secret",
      }),
    ).toEqual({ PATH: "/usr/local/bin:/bin", LANG: "C.UTF-8" });
  });

  it("uses the system PATH fallback when the host supplies no PATH", () => {
    expect(scopedEnvironment({})).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
  });
});
