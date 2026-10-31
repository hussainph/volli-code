import { PassThrough } from "node:stream";
import type { PiSignIn, PiSignInSteps } from "@volli/agent-runtime";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderLogin, type LoginTerminal } from "./renderer";
import { bufferedTerminal } from "./terminal";

const prompt = (steps: PiSignInSteps, kind: "manual-code" | "secret" = "manual-code") => ({
  promptId: steps.newId(),
  kind,
  message: "Paste the redirect URL",
  placeholder: null,
  options: [],
});
function pi(flow: (steps: PiSignInSteps, signal: AbortSignal) => Promise<void>): PiSignIn {
  return {
    offers: () => true,
    login: (_id, _type, signal, steps) => flow(steps, signal),
    logout: async () => {},
  };
}
function terminal() {
  const input = new PassThrough();
  let text = "";
  const release = vi.fn();
  const term = bufferedTerminal(
    input,
    false,
    (line) => {
      text += line;
    },
    release,
  );
  return { input, term, text: () => text, release };
}

describe("terminal sign-in conversation", () => {
  it("renders device flows, progress and informational links without asking for a code", async () => {
    const t = terminal();
    const result = await renderLogin(
      pi(async (steps) => {
        steps.say({
          kind: "device-code",
          userCode: "GHUB-0000",
          verificationUri: "https://github.com/login/device",
          intervalSeconds: 5,
          expiresInSeconds: 900,
        });
        steps.say({
          kind: "info",
          message: "Approve in your browser",
          links: [{ url: "https://example.com", label: "Help" }],
        });
        steps.say({ kind: "progress", message: "Waiting for approval" });
      }),
      "github-copilot",
      "oauth",
      t.term,
      new AbortController().signal,
    );
    expect(result).toBe(0);
    expect(t.text()).toContain("enter code GHUB-0000");
    expect(t.text()).toContain("Waiting for approval");
    expect(t.text()).toContain("https://example.com");
    expect(t.release).toHaveBeenCalledOnce();
  });

  it("accepts a piped final URL, renders the SSH tip, and never echoes the answer", async () => {
    const t = terminal();
    const secret = "http://localhost:1455/auth/callback?code=secret-code";
    const result = renderLogin(
      pi(async (steps) => {
        steps.say({ kind: "auth-url", url: "https://example.com/oauth", instructions: "Sign in" });
        expect(await steps.ask(prompt(steps), undefined)).toBe(secret);
      }),
      "openai",
      "oauth",
      t.term,
      new AbortController().signal,
    );
    t.input.end(`${secret}\n`);
    expect(await result).toBe(0);
    expect(t.text()).toContain("ssh -L 1455:localhost:1455");
    expect(t.text()).not.toContain(secret);
  });

  it("withdraws a loopback-raced prompt and ignores its late answer", async () => {
    let answer!: (value: string) => void;
    const read = vi.fn(
      (_prompt, signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          answer = resolve;
          expect(signal.aborted).toBe(false);
        }),
    );
    const close = vi.fn();
    const t: LoginTerminal = { write: vi.fn(), read, close };
    expect(
      await renderLogin(
        pi(async (steps) => {
          steps.say({ kind: "auth-url", url: "https://example.com", instructions: null });
          const withdrawn = new AbortController();
          const pending = steps.ask(prompt(steps), withdrawn.signal).catch(() => "withdrawn");
          withdrawn.abort();
          expect(await pending).toBe("withdrawn");
        }),
        "anthropic",
        "oauth",
        t,
        new AbortController().signal,
      ),
    ).toBe(0);
    expect(read.mock.calls[0]![1].aborted).toBe(true);
    answer("late-secret");
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
  });

  it("aborts pending input on SIGTERM and returns 130", async () => {
    const t = terminal();
    const abort = new AbortController();
    const result = renderLogin(
      pi(async (steps) => {
        await steps.ask(prompt(steps), undefined);
      }),
      "x",
      "oauth",
      t.term,
      abort.signal,
    );
    abort.abort();
    expect(await result).toBe(130);
    expect(t.text()).toContain("cancelled");
  });

  it("handles an already-aborted process and an unavailable sign-in method", async () => {
    const abort = new AbortController();
    abort.abort();
    const t = terminal();
    expect(
      await renderLogin(
        pi(async (steps) => {
          await steps.ask(prompt(steps), undefined);
        }),
        "x",
        "oauth",
        t.term,
        abort.signal,
      ),
    ).toBe(130);
    const unavailable = { ...pi(async () => {}), offers: () => false };
    const other = terminal();
    expect(
      await renderLogin(unavailable, "x", "oauth", other.term, new AbortController().signal),
    ).toBe(1);
    expect(other.text()).toContain("does not offer");
  });

  it("cancels on EOF, and withholds provider failures even for short secrets", async () => {
    const t = terminal();
    t.input.end();
    expect(
      await renderLogin(
        pi(async (steps) => {
          await steps.ask(prompt(steps), undefined);
        }),
        "x",
        "oauth",
        t.term,
        new AbortController().signal,
      ),
    ).toBe(1);
    const failing = terminal();
    const run = renderLogin(
      pi(async (steps) => {
        const answer = await steps.ask(prompt(steps, "secret"), undefined);
        throw new Error(`bad key ${answer}`);
      }),
      "x",
      "api-key",
      failing.term,
      new AbortController().signal,
    );
    failing.input.end("tiny\n");
    expect(await run).toBe(1);
    expect(failing.text()).not.toContain("tiny");
    expect(failing.text()).toContain("Sign-in failed");
  });
});

describe("buffered terminal input", () => {
  const p = {
    promptId: "p",
    kind: "select" as const,
    message: "Choose",
    placeholder: null,
    options: [
      { id: "a", label: "One", description: "first" },
      { id: "b", label: "Two", description: null },
    ],
  };
  it("preserves multiple piped answers, including blank input, and reports EOF", async () => {
    const t = terminal();
    t.input.end("a\n\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(await t.term.read(p, new AbortController().signal)).toBe("a");
    expect(await t.term.read(p, new AbortController().signal)).toBe("");
    await expect(t.term.read(p, new AbortController().signal)).rejects.toThrow("ended");
    expect(t.text()).toContain("a: One — first");
    expect(t.text()).toContain("b: Two");
    t.term.close();
  });
  it("cancels an outstanding read, then allows the next prompt", async () => {
    const t = terminal();
    const abort = new AbortController();
    const read = t.term.read(p, abort.signal);
    abort.abort();
    await expect(read).rejects.toThrow("withdrawn");
    const next = t.term.read(p, new AbortController().signal);
    t.input.write("b\n");
    expect(await next).toBe("b");
    t.term.close();
  });
  it("does not echo input even in terminal mode and handles Ctrl-C/input errors", async () => {
    const input = new PassThrough();
    const output = vi.fn();
    const t = bufferedTerminal(input, true, output, vi.fn());
    const read = t.read(p, new AbortController().signal);
    input.write("hidden-key\r");
    expect(await read).toBe("hidden-key");
    expect(output.mock.calls.flat().join("")).not.toContain("hidden-key");
    const interrupted = t.read(p, new AbortController().signal);
    input.write("\u0003");
    await expect(interrupted).rejects.toThrow("ended");
    const failed = t.read(p, new AbortController().signal);
    input.emit("error", new Error("broken input"));
    await expect(failed).rejects.toThrow("ended");
    t.close();
  });
});
