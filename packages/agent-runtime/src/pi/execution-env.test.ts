import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT,
  executeShellWithCapture,
  type ExecutionEnv,
  type ShellCaptureOptions,
} from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vite-plus/test";
import { piExecutionEnv, scopedEnvironment, sessionCommandEnvironment } from "./execution-env";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "volli-pi-env-"));
}

/**
 * What a command printed, and what it exited with.
 *
 * Pi 0.85's `Shell.exec` returns neither: the result is an exit code and
 * truncation metadata, and the text streams out through `capture`/`onUpdate`.
 * `executeShellWithCapture` is the collector Pi ships for callers that want one
 * bounded string back, so it is what these tests read the environment through
 * rather than a shape of Volli's own devising.
 *
 * Stdout and stderr arrive merged, which is 0.85's decision and not this file's.
 * It costs these assertions nothing — every command below prints on stdout
 * alone, and what they are actually about is which variables the child was
 * handed.
 */
async function ran(
  env: ExecutionEnv,
  command: string,
  options?: ShellCaptureOptions,
): Promise<{ output: string; exitCode: number | undefined }> {
  const result = await executeShellWithCapture(env, command, options, BACKGROUND_CONTEXT);
  if (!result.ok) throw result.error;
  return { output: result.value.output, exitCode: result.value.exitCode };
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
        ran(env, "printenv PATH; printenv HOME; printenv SSH_AUTH_SOCK"),
      ).resolves.toEqual({
        output: `${process.env.PATH}\n${process.env.HOME}\n/tmp/volli-test-agent.sock\n`,
        exitCode: 0,
      });
    } finally {
      restore();
      await env.cleanup(BACKGROUND_CONTEXT);
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
        ran(env, "printenv VOLLI_TEST_FAKE_CREDENTIAL; printenv GITHUB_TOKEN; echo done"),
      ).resolves.toEqual({ output: "done\n", exitCode: 0 });
    } finally {
      restore();
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  });

  it("still gives a command the variables its caller asked for", async () => {
    const env = await piExecutionEnv(workspace());
    try {
      await expect(
        ran(env, "printenv VOLLI_TEST_FLAG", { env: { VOLLI_TEST_FLAG: "yes" } }),
      ).resolves.toEqual({ output: "yes\n", exitCode: 0 });
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
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
      await expect(ran(env, "printenv VOLLI_SESSION; printenv VOLLI_TICKET")).resolves.toEqual({
        output: "session-uuid-1\nVC-51\n",
        exitCode: 0,
      });
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
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
      await expect(ran(env, "printenv VOLLI_SESSION_TOKEN")).resolves.toEqual({
        output: "tok-abc\n",
        exitCode: 0,
      });
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  });

  it("runs the attachment cleanup hook exactly once", async () => {
    let cleanups = 0;
    const env = await piExecutionEnv(workspace(), {
      onCleanup: () => {
        cleanups += 1;
      },
    });

    await env.cleanup(BACKGROUND_CONTEXT);
    await env.cleanup(BACKGROUND_CONTEXT);

    expect(cleanups).toBe(1);
  });

  it("exports no token variable when the host minted none", async () => {
    const env = await piExecutionEnv(workspace(), {
      identity: { sessionId: "session-uuid-1", ticketDisplayId: null },
    });
    try {
      await expect(ran(env, "printenv VOLLI_SESSION_TOKEN; echo done")).resolves.toEqual({
        output: "done\n",
        exitCode: 0,
      });
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  });

  it("omits VOLLI_TICKET for a ticketless session rather than inventing one", async () => {
    const env = await piExecutionEnv(workspace(), {
      identity: { sessionId: "session-uuid-1", ticketDisplayId: null },
    });
    try {
      await expect(ran(env, "printenv VOLLI_TICKET; printenv VOLLI_SESSION")).resolves.toEqual({
        output: "session-uuid-1\n",
        exitCode: 0,
      });
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
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
        ran(env, "printenv VOLLI_SESSION; printenv VOLLI_TICKET; echo done"),
      ).resolves.toEqual({ output: "done\n", exitCode: 0 });
    } finally {
      restore();
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  });

  it("still lets a tool call's own env override the identity, like any variable", async () => {
    const env = await piExecutionEnv(workspace(), {
      identity: { sessionId: "session-uuid-1", ticketDisplayId: "VC-51" },
    });
    try {
      await expect(
        ran(env, "printenv VOLLI_SESSION", { env: { VOLLI_SESSION: "caller-says" } }),
      ).resolves.toEqual({ output: "caller-says\n", exitCode: 0 });
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
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
      await expect(ran(env, "printenv PATH")).resolves.toEqual({
        output: `/volli/bin:${process.env.PATH}\n`,
        exitCode: 0,
      });
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  });

  it("prepends multiple prefixes in order, skipping empty entries", async () => {
    const env = await piExecutionEnv(workspace(), {
      pathPrefixes: ["/volli/bin", "", "/another/bin"],
    });
    try {
      await expect(ran(env, "printenv PATH")).resolves.toEqual({
        output: `/volli/bin:/another/bin:${process.env.PATH}\n`,
        exitCode: 0,
      });
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  });

  it("does not duplicate a prefix already at the front of PATH", async () => {
    const originalPath = process.env.PATH;
    const restore = hostVariables({ PATH: `/volli/bin:${originalPath}` });
    const env = await piExecutionEnv(workspace(), { pathPrefixes: ["/volli/bin"] });
    try {
      await expect(ran(env, "printenv PATH")).resolves.toEqual({
        output: `/volli/bin:${originalPath}\n`,
        exitCode: 0,
      });
    } finally {
      restore();
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  });

  it("still prepends onto a caller-supplied PATH rather than letting it wipe the prefixes", async () => {
    const env = await piExecutionEnv(workspace(), { pathPrefixes: ["/volli/bin"] });
    try {
      // A real, minimal PATH — proving the override REPLACES the sanitized
      // default, while the session's prefixes still land in front. Without
      // that, a caller-supplied PATH would hide `<userData>/bin` and `volli`
      // would resolve to another install's shim.
      await expect(ran(env, "printenv PATH", { env: { PATH: "/usr/bin:/bin" } })).resolves.toEqual({
        output: "/volli/bin:/usr/bin:/bin\n",
        exitCode: 0,
      });
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  });

  it("puts prefixes into a caller-supplied empty PATH", async () => {
    const env = await piExecutionEnv(workspace(), { pathPrefixes: ["/volli/bin"] });
    try {
      await expect(ran(env, "/usr/bin/printenv PATH", { env: { PATH: "" } })).resolves.toEqual({
        output: "/volli/bin\n",
        exitCode: 0,
      });
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
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
      await expect(ran(env, "env | grep '^OTEL_' || true; echo done")).resolves.toEqual({
        output: "done\n",
        exitCode: 0,
      });
    } finally {
      restore();
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  });

  it("gives a command an empty PATH when neither host nor caller supplies one", async () => {
    const restore = hostVariables({ PATH: undefined });
    const env = await piExecutionEnv(workspace());
    try {
      await expect(ran(env, "/usr/bin/printenv PATH")).resolves.toEqual({
        output: "\n",
        exitCode: 0,
      });
    } finally {
      restore();
      await env.cleanup(BACKGROUND_CONTEXT);
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

describe("sessionCommandEnvironment", () => {
  // VC-270: a background shell needs the environment RECORD — `spawn` with
  // pipes, not `exec` — so the record is built by one exported function that
  // both `SanitizedEnvExecutionEnv.exec` and the shell host call. Two copies
  // would drift, and the symptom would be an unattributed `volli` call from
  // inside a background shell.
  it("builds the same environment exec hands a command: sanitized set, identity, prefixed PATH", async () => {
    const restore = hostVariables({
      GITHUB_TOKEN: "host-secret",
      VOLLI_SESSION: "host-session",
      SSH_AUTH_SOCK: "/tmp/volli-test-agent.sock",
    });
    const options = {
      pathPrefixes: ["/opt/volli/bin"],
      identity: {
        sessionId: "session-uuid-1",
        ticketDisplayId: "VC-270",
        sessionToken: "tok-shared",
      },
    };
    const env = await piExecutionEnv(workspace(), options);
    try {
      const record = sessionCommandEnvironment(process.env, options);
      // The record carries the identity, the shared token and the prefixed
      // PATH, and the host's secret and its own VOLLI_SESSION in neither.
      expect(record["PATH"]?.startsWith("/opt/volli/bin:")).toBe(true);
      expect(record["VOLLI_SESSION"]).toBe("session-uuid-1");
      expect(record["VOLLI_TICKET"]).toBe("VC-270");
      expect(record["VOLLI_SESSION_TOKEN"]).toBe("tok-shared");
      expect(record["SSH_AUTH_SOCK"]).toBe("/tmp/volli-test-agent.sock");
      expect(record["GITHUB_TOKEN"]).toBeUndefined();
      // The whole record, not a subset: every name the record carries is one
      // exec's child could print, and there are no others.
      const all = await ran(env, "printenv | sort");
      const fromRecord = Object.entries(record)
        .map(([name, value]) => `${name}=${value}`)
        .toSorted()
        .join("\n");
      const observed = all.output
        .split("\n")
        .filter((line) => line.length > 0 && !/^(PWD|SHLVL|_|OLDPWD)=/.test(line))
        .toSorted()
        .join("\n");
      expect(observed).toBe(fromRecord);
    } finally {
      restore();
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  });

  it("lets a caller's own variables win over the sanitized set, identity included", () => {
    const record = sessionCommandEnvironment(
      { PATH: "/usr/bin", LANG: "C.UTF-8", HOME: "/Users/me" },
      {
        pathPrefixes: ["/opt/volli/bin"],
        identity: { sessionId: "session-uuid-1", ticketDisplayId: null },
        overrides: { VOLLI_SESSION: "stated-explicitly", PATH: "/custom/bin" },
      },
    );
    expect(record).toEqual({
      PATH: "/opt/volli/bin:/custom/bin",
      LANG: "C.UTF-8",
      HOME: "/Users/me",
      VOLLI_SESSION: "stated-explicitly",
    });
  });
});
