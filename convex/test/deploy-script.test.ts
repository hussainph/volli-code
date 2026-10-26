import { describe, expect, test } from "vite-plus/test";

import { deployChecked } from "../scripts/deploy.ts";

const KEY = {
  CONVEX_DEPLOY_KEY: "prod:happy-otter-123|redacted",
  CONVEX_DEPLOYMENT: "dev:other-456",
  CONVEX_URL: "https://other-456.convex.cloud",
  CONVEX_SELF_HOSTED_URL: "https://from-an-env-file.example",
};
const LOCAL = {
  CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3210",
  CONVEX_SELF_HOSTED_ADMIN_KEY: "volli-test|redacted",
};

type Step = { args: string[]; env: NodeJS.ProcessEnv; capture: boolean };

/** A stand-in CLI: answers each command by its first word, and records every call. */
async function run(
  argv: string[],
  env: NodeJS.ProcessEnv,
  answers: Record<string, { code: number; stdout?: string }> = {},
) {
  const steps: Step[] = [];
  const lines: string[] = [];
  const code = await deployChecked(
    argv,
    env,
    async (args, stepEnv, capture) => {
      steps.push({ args, env: stepEnv, capture });
      const answer = answers[args[0] as string] ?? { code: 0 };
      return { code: answer.code, stdout: answer.stdout ?? "" };
    },
    (line) => lines.push(line),
  );
  return { code, steps, lines };
}

describe("scripts/deploy.ts", () => {
  test("cloud: preflight, push without codegen, check, all on the key's deployment", async () => {
    const { code, steps, lines } = await run([], KEY);
    expect(code).toBe(0);
    expect(lines).toEqual([]);
    expect(steps.map((step) => [step.args, step.capture])).toEqual([
      [["env", "get", "VOLLI_TEST_JWKS"], true],
      [["deploy", "--codegen", "disable"], false],
      [["run", "health:deploymentChecks", '{"mode":"cloud"}'], false],
    ]);
    for (const step of steps) {
      expect(step.env).toMatchObject({
        CONVEX_DEPLOY_KEY: KEY.CONVEX_DEPLOY_KEY,
        CONVEX_DEPLOYMENT: "",
        CONVEX_URL: "",
        CONVEX_SELF_HOSTED_URL: "",
        CONVEX_SELF_HOSTED_ADMIN_KEY: "",
      });
    }
    // An unset variable is a stderr notice and exit 0: no output, so the push goes ahead.
    const dev = { ...KEY, CONVEX_DEPLOY_KEY: "dev:x|y" };
    expect((await run([], dev, { env: { code: 0, stdout: "" } })).code).toBe(0);
  });

  test("test: a loopback self-hosted backend, no preflight, the test check", async () => {
    const { code, steps } = await run(["--test"], { ...LOCAL, CONVEX_DEPLOY_KEY: " " });
    expect(code).toBe(0);
    expect(steps.map((step) => step.args)).toEqual([
      ["deploy", "--codegen", "disable"],
      ["run", "health:deploymentChecks", '{"mode":"test"}'],
    ]);
    for (const step of steps) {
      expect(step.env).toMatchObject({ ...LOCAL, CONVEX_DEPLOY_KEY: "", CONVEX_DEPLOYMENT: "" });
    }
  });

  test("never pushes over the test issuer, even blank, or when it cannot tell", async () => {
    for (const stdout of ["data:application/json,{}\n", " \n"]) {
      const set = await run([], LOCAL, { env: { code: 0, stdout } });
      expect(set).toMatchObject({ code: 1, lines: [expect.stringMatching(/sets VOLLI_TEST/)] });
      expect(set.lines.join("")).not.toContain("data:");
      expect(set.steps).toHaveLength(1);
    }
    const unreadable = await run([], KEY, { env: { code: 1 } });
    expect(unreadable).toMatchObject({ code: 1, lines: [expect.stringMatching(/Could not read/)] });
    expect(unreadable.steps).toHaveLength(1);
  });

  test("stops at a failed push, and fails on a refused self-check", async () => {
    const pushed = await run([], KEY, { deploy: { code: 3 } });
    expect(pushed.code).toBe(3);
    expect(pushed.steps.map((step) => step.args[0])).toEqual(["env", "deploy"]);
    const checked = await run([], KEY, { run: { code: 1 } });
    expect(checked).toMatchObject({
      code: 1,
      lines: [expect.stringMatching(/self-check refused/)],
    });
  });

  test("takes no deploy flags: the target is the environment's alone", async () => {
    for (const argv of [["--prod"], ["--", "--url", "https://elsewhere"], ["--test", "--yes"]]) {
      expect(await run(argv, KEY)).toMatchObject({ code: 2, steps: [], lines: [/^usage:/] });
    }
  });

  test("names exactly one target, never a preview key", async () => {
    for (const env of [
      {},
      { ...LOCAL, CONVEX_DEPLOY_KEY: KEY.CONVEX_DEPLOY_KEY },
      { ...LOCAL, CONVEX_SELF_HOSTED_ADMIN_KEY: "" },
      { CONVEX_SELF_HOSTED_URL: "", CONVEX_SELF_HOSTED_ADMIN_KEY: "key" },
    ]) {
      expect(await run([], env)).toMatchObject({ code: 2, steps: [], lines: [/one target/] });
    }
    for (const key of ["preview:team:project|secret", "project:team:project|secret", "secret"]) {
      expect(await run([], { CONVEX_DEPLOY_KEY: key })).toMatchObject({
        code: 2,
        steps: [],
        lines: [/prod: or dev:/],
      });
    }
  });

  test("runs the test check only against a loopback self-hosted backend", async () => {
    for (const env of [
      KEY,
      { ...LOCAL, CONVEX_SELF_HOSTED_URL: "https://convex.example.com" },
      { ...LOCAL, CONVEX_SELF_HOSTED_URL: "not a url" },
    ]) {
      expect(await run(["--test"], env)).toMatchObject({ code: 2, steps: [], lines: [/loopback/] });
    }
  });
});
