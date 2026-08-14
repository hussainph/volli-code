/**
 * The real login path, against real providers, with no network and no account.
 *
 * `sign-in.test.ts` scripts a fake `Models` and proves the wiring. This proves
 * the thing a fake cannot: that pi-ai's actual api-key flows ask what this code
 * expects them to ask, and that a credential answered into one lands in the
 * `auth.json` Volli reads back. An api-key login is entirely local — the
 * provider prompts and returns a credential, and `Models.login` persists it —
 * so this costs nothing and reaches nobody.
 *
 * OAuth is deliberately absent. Those flows open browsers and exchange tokens
 * against live endpoints, which makes them manual, paid evidence like the Pi
 * smokes rather than a test.
 *
 * `PI_CODING_AGENT_DIR` points at a fresh temp directory per test, so nothing
 * here can read or write a developer's own credentials.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { piOwnedModelAccess } from "./models";
import { piSignIn, type PiSignInSteps } from "./sign-in";

let agentDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "volli-sign-in-"));
});

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

/** Answers every step with a canned value and records what was asked. */
function scriptedSteps(answer: string): PiSignInSteps & { transcript: unknown[] } {
  const transcript: unknown[] = [];
  let ids = 0;
  return {
    transcript,
    newId: () => `p${++ids}`,
    ask: async (prompt) => {
      transcript.push({ ask: prompt });
      return prompt.kind === "select" ? (prompt.options[0]?.id ?? "") : answer;
    },
    say: (event) => {
      transcript.push({ say: event });
    },
  };
}

async function storedCredentials(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
}

describe("a real api-key sign-in", () => {
  const KEY = "sk-volli-integration-not-a-real-key";

  it("asks for the key as a secret step and stores what it is given", async () => {
    const { models, credentials } = piOwnedModelAccess({ agentDir });
    const pi = piSignIn(models);
    const steps = scriptedSteps(KEY);

    await pi.login("groq", "api-key", new AbortController().signal, steps);

    // The one prompt the generic api-key helper raises, and the reason the
    // renderer must mask this field rather than the others.
    expect(steps.transcript).toEqual([
      { ask: expect.objectContaining({ kind: "secret", promptId: "p1" }) },
    ]);
    expect(await storedCredentials()).toEqual({ groq: { type: "api_key", key: KEY } });
    expect(await credentials.list()).toEqual([{ providerId: "groq", type: "api_key" }]);
  });

  it("removes only the provider signed out of", async () => {
    const { models, credentials } = piOwnedModelAccess({ agentDir });
    const pi = piSignIn(models);

    await pi.login("groq", "api-key", new AbortController().signal, scriptedSteps(KEY));
    await pi.login("mistral", "api-key", new AbortController().signal, scriptedSteps(KEY));
    await pi.logout("groq");

    expect(Object.keys(await storedCredentials())).toEqual(["mistral"]);
    expect(await credentials.list()).toEqual([{ providerId: "mistral", type: "api_key" }]);
  });

  it("writes nothing when the person abandons the step", async () => {
    const { models } = piOwnedModelAccess({ agentDir });
    const pi = piSignIn(models);
    const steps: PiSignInSteps = {
      newId: () => "p1",
      ask: () => Promise.reject(new Error("Sign-in cancel.")),
      say: () => undefined,
    };

    await expect(
      pi.login("groq", "api-key", new AbortController().signal, steps),
    ).rejects.toThrow();
    // Not "an empty map" but no file at all: the store only reaches the disk
    // inside `modify`, and a flow that rejected before returning a credential
    // never gets there. An abandoned sign-in leaves nothing behind to explain.
    await expect(readFile(join(agentDir, "auth.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("what the shipped providers actually ask for", () => {
  /**
   * The doc's open question, answered here so it cannot rot: every OAuth flow
   * pi-ai ships expresses itself in the four prompt kinds and four event kinds
   * this UI renders. Read statically from the flow modules rather than by
   * running them, since running them is what costs an account.
   */
  it("offers an interactive method for every provider it lists", () => {
    const { models } = piOwnedModelAccess({ agentDir });
    const pi = piSignIn(models);
    const unreachable = models
      .getProviders()
      .filter((provider) => !pi.offers(provider.id, "api-key") && !pi.offers(provider.id, "oauth"))
      .map((provider) => provider.id);

    // A provider with neither would render a row with no button. None ship
    // today; if one appears, the row is right to offer nothing and this test is
    // the record of when that stopped being hypothetical.
    expect(unreachable).toEqual([]);
  });

  it("refuses a method a provider does not offer, rather than guessing one", () => {
    const { models } = piOwnedModelAccess({ agentDir });
    const pi = piSignIn(models);

    // OpenAI Codex is subscription-only: it has no api-key auth at all.
    expect(pi.offers("openai-codex", "oauth")).toBe(true);
    expect(pi.offers("openai-codex", "api-key")).toBe(false);
    expect(pi.offers("not-a-provider", "api-key")).toBe(false);
  });
});
