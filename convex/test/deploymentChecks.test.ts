import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { internal } from "../functions/_generated/api";
import { checkDeployment, describeProblems } from "../functions/lib/deploymentChecks";
import schema from "../functions/schema";

const modules = import.meta.glob("../functions/**/*.ts");

const DEPLOYMENT_URL_VARIABLE = "CONVEX_CLOUD_URL";
const TEST_JWKS_VARIABLE = "VOLLI_TEST_JWKS";
/** The list in `README.md` ("Deployments"): a change here is a change there. */
const REQUIRED_VARIABLES = [
  "WORKOS_CLIENT_ID",
  "VOLLI_RUNNER_SIGNING_KEY",
  "VOLLI_RUNNER_JWKS",
  "VOLLI_SECRETS_ROOT_KEYS",
  "VOLLI_S3_ENDPOINT",
  "VOLLI_S3_BUCKET",
  "VOLLI_S3_ACCESS_KEY_ID",
  "VOLLI_S3_SECRET_ACCESS_KEY",
];

/** The GitHub App's six variables (`README.md`, "GitHub App"): all set or none. */
const GITHUB_APP_VARIABLES = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRETS",
];

/** Every GitHub App variable set, as overrides for `cloudEnv`. */
function githubEnv(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {};
  for (const name of GITHUB_APP_VARIABLES) env[name] = `value-of-${name}`;
  return { ...env, ...overrides };
}

const CLOUD_URL = "https://happy-otter-123.convex.cloud";
const LOCAL_URL = "http://127.0.0.1:3210";

/** Every required variable set, on a cloud URL: what a ready cloud deployment holds. */
function cloudEnv(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = { [DEPLOYMENT_URL_VARIABLE]: CLOUD_URL };
  for (const name of REQUIRED_VARIABLES) env[name] = `value-of-${name}`;
  return { ...env, ...overrides };
}

const reader = (env: Record<string, string | undefined>) => (name: string) => env[name];

describe("the loopback fence", () => {
  const deployment = (url: string | undefined) =>
    checkDeployment("test", reader({ [DEPLOYMENT_URL_VARIABLE]: url })).deployment;

  test("is http(s) on 127.0.0.1, localhost and ::1 only", () => {
    for (const url of [
      "http://127.0.0.1:3210",
      "https://localhost",
      "http://[::1]:8000/",
      "http://LOCALHOST:1",
    ]) {
      expect(deployment(url), url).toBe("loopback");
    }
    for (const url of [
      undefined,
      "",
      "not a url",
      CLOUD_URL,
      "http://127.0.0.2",
      "http://127.0.0.1.example.com",
      "ws://127.0.0.1:3210",
      "file://localhost/etc",
    ]) {
      expect(deployment(url), String(url)).toBe("remote");
    }
  });
});

describe("checkDeployment, cloud", () => {
  test("passes a deployment with every required variable and no test issuer", () => {
    expect(checkDeployment("cloud", reader(cloudEnv()))).toEqual({
      ok: true,
      mode: "cloud",
      deployment: "remote",
      problems: [],
    });
  });

  test("refuses the test issuer, even whitespace (auth.config trusts any non-empty value)", () => {
    for (const value of ["data:application/json;base64,e30=", " "]) {
      expect(checkDeployment("cloud", reader(cloudEnv({ [TEST_JWKS_VARIABLE]: value })))).toEqual(
        expect.objectContaining({
          ok: false,
          problems: [{ variable: TEST_JWKS_VARIABLE, code: "forbidden" }],
        }),
      );
    }
    expect(checkDeployment("cloud", reader(cloudEnv({ [TEST_JWKS_VARIABLE]: "" }))).ok).toBe(true);
  });

  test("names every required variable that is unset, empty or blank", () => {
    const report = checkDeployment(
      "cloud",
      reader(
        cloudEnv({ WORKOS_CLIENT_ID: undefined, VOLLI_S3_BUCKET: "", VOLLI_RUNNER_JWKS: "  " }),
      ),
    );
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      { variable: "WORKOS_CLIENT_ID", code: "missing" },
      { variable: "VOLLI_RUNNER_JWKS", code: "missing" },
      { variable: "VOLLI_S3_BUCKET", code: "missing" },
    ]);
  });

  test("checks a loopback deployment as cloud when cloud is asked", () => {
    const report = checkDeployment(
      "cloud",
      reader({ [DEPLOYMENT_URL_VARIABLE]: LOCAL_URL, [TEST_JWKS_VARIABLE]: "jwks" }),
    );
    expect(report).toMatchObject({ ok: false, mode: "cloud", deployment: "loopback" });
    expect(report.problems.map((problem) => problem.code)).toEqual([
      "forbidden",
      ...REQUIRED_VARIABLES.map(() => "missing"),
    ]);
  });
});

describe("checkDeployment, the GitHub App", () => {
  test("passes with none of its variables (GitHub stays off) or all six", () => {
    expect(checkDeployment("cloud", reader(cloudEnv())).ok).toBe(true);
    expect(checkDeployment("cloud", reader(cloudEnv(githubEnv()))).ok).toBe(true);
  });

  test("names each variable a partial set is missing, unset, empty or blank", () => {
    const report = checkDeployment(
      "cloud",
      reader(
        cloudEnv(
          githubEnv({
            GITHUB_APP_SLUG: undefined,
            GITHUB_APP_CLIENT_SECRET: "",
            GITHUB_APP_PRIVATE_KEY: " \n ",
          }),
        ),
      ),
    );
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      { variable: "GITHUB_APP_SLUG", code: "incomplete" },
      { variable: "GITHUB_APP_CLIENT_SECRET", code: "incomplete" },
      { variable: "GITHUB_APP_PRIVATE_KEY", code: "incomplete" },
    ]);
  });

  test("one variable alone names the other five", () => {
    for (const name of GITHUB_APP_VARIABLES) {
      const report = checkDeployment("cloud", reader(cloudEnv({ [name]: `value-of-${name}` })));
      expect(report.problems, name).toEqual(
        GITHUB_APP_VARIABLES.filter((other) => other !== name).map((variable) => ({
          variable,
          code: "incomplete",
        })),
      );
    }
  });

  test("webhook secrets with no secret in them count as unset, as readGithubConfig reads them", () => {
    expect(
      checkDeployment("cloud", reader(cloudEnv(githubEnv({ GITHUB_WEBHOOK_SECRETS: " , ," }))))
        .problems,
    ).toEqual([{ variable: "GITHUB_WEBHOOK_SECRETS", code: "incomplete" }]);
    expect(checkDeployment("cloud", reader(cloudEnv({ GITHUB_WEBHOOK_SECRETS: "," }))).ok).toBe(
      true,
    );
    expect(
      checkDeployment("cloud", reader(cloudEnv(githubEnv({ GITHUB_WEBHOOK_SECRETS: "new,old" }))))
        .ok,
    ).toBe(true);
  });

  test("the optional URLs alone are not a partial set", () => {
    expect(
      checkDeployment(
        "cloud",
        reader(cloudEnv({ GITHUB_API_URL: "http://fake", GITHUB_WEB_URL: "http://fake" })),
      ).ok,
    ).toBe(true);
  });

  test("a test check on the local backend skips it", () => {
    expect(
      checkDeployment("test", reader({ [DEPLOYMENT_URL_VARIABLE]: LOCAL_URL, GITHUB_APP_ID: "1" }))
        .ok,
    ).toBe(true);
  });
});

describe("checkDeployment, test mode", () => {
  test("allows the test issuer and unset variables on a loopback deployment", () => {
    expect(
      checkDeployment(
        "test",
        reader({ [DEPLOYMENT_URL_VARIABLE]: LOCAL_URL, [TEST_JWKS_VARIABLE]: "jwks" }),
      ),
    ).toEqual({ ok: true, mode: "test", deployment: "loopback", problems: [] });
  });

  test("cannot bypass the cloud check: refused off loopback, where the cloud check runs", () => {
    const report = checkDeployment(
      "test",
      reader(cloudEnv({ [TEST_JWKS_VARIABLE]: "jwks", VOLLI_SECRETS_ROOT_KEYS: undefined })),
    );
    expect(report).toEqual({
      ok: false,
      mode: "test",
      deployment: "remote",
      problems: [
        { variable: DEPLOYMENT_URL_VARIABLE, code: "test_mode_refused" },
        { variable: TEST_JWKS_VARIABLE, code: "forbidden" },
        { variable: "VOLLI_SECRETS_ROOT_KEYS", code: "missing" },
      ],
    });
  });

  test("treats an unknown deployment URL as remote, and refuses the test check there", () => {
    for (const url of [undefined, "garbage"]) {
      const report = checkDeployment("test", reader(cloudEnv({ [DEPLOYMENT_URL_VARIABLE]: url })));
      expect(report.deployment).toBe("remote");
      expect(report.problems).toEqual([
        { variable: DEPLOYMENT_URL_VARIABLE, code: "test_mode_refused" },
      ]);
    }
  });
});

describe("describeProblems", () => {
  test("names variables and codes, one per line", () => {
    expect(
      describeProblems([
        { variable: TEST_JWKS_VARIABLE, code: "forbidden" },
        { variable: "WORKOS_CLIENT_ID", code: "missing" },
        { variable: DEPLOYMENT_URL_VARIABLE, code: "test_mode_refused" },
        { variable: "GITHUB_APP_SLUG", code: "incomplete" },
      ]).split("\n"),
    ).toEqual([
      expect.stringMatching(/^VOLLI_TEST_JWKS set; .*test issuer/),
      expect.stringMatching(/^WORKOS_CLIENT_ID unset; .*requires it/),
      expect.stringMatching(/^CONVEX_CLOUD_URL not loopback; /),
      expect.stringMatching(/^GITHUB_APP_SLUG unset while other GitHub App variables are set; /),
    ]);
  });
});

describe("health.deploymentChecks", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function stub(env: Record<string, string | undefined>) {
    for (const name of [
      DEPLOYMENT_URL_VARIABLE,
      TEST_JWKS_VARIABLE,
      ...REQUIRED_VARIABLES,
      ...GITHUB_APP_VARIABLES,
    ]) {
      vi.stubEnv(name, env[name] ?? "");
    }
  }

  test("returns the report for a safe deployment, as cloud by default", async () => {
    stub(cloudEnv());
    const t = convexTest(schema, modules);
    await expect(t.query(internal.health.deploymentChecks, {})).resolves.toEqual({
      ok: true,
      mode: "cloud",
      deployment: "remote",
      problems: [],
    });
  });

  test("throws deployment_unsafe with the report, and never a value", async () => {
    const secret = "sk-very-secret-value";
    stub(cloudEnv({ [TEST_JWKS_VARIABLE]: "jwks", VOLLI_S3_SECRET_ACCESS_KEY: undefined }));
    vi.stubEnv("VOLLI_S3_ACCESS_KEY_ID", secret);
    const t = convexTest(schema, modules);
    const error = await t.query(internal.health.deploymentChecks, {}).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      data: {
        code: "deployment_unsafe",
        message: expect.stringContaining("VOLLI_TEST_JWKS set"),
        report: {
          ok: false,
          problems: [
            { variable: TEST_JWKS_VARIABLE, code: "forbidden" },
            { variable: "VOLLI_S3_SECRET_ACCESS_KEY", code: "missing" },
          ],
        },
      },
    });
    expect(JSON.stringify((error as { data: unknown }).data)).not.toContain(secret);
    expect(JSON.stringify((error as { data: unknown }).data)).not.toContain("value-of-");
  });

  test("refuses a partial GitHub App set by name, and never a value", async () => {
    const privateKey = "-----BEGIN PRIVATE KEY-----secret";
    stub(cloudEnv({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: privateKey }));
    const t = convexTest(schema, modules);
    const error = await t.query(internal.health.deploymentChecks, {}).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      data: {
        code: "deployment_unsafe",
        message: expect.stringContaining("GITHUB_APP_SLUG unset while other GitHub App"),
        report: {
          ok: false,
          problems: [
            "GITHUB_APP_SLUG",
            "GITHUB_APP_CLIENT_ID",
            "GITHUB_APP_CLIENT_SECRET",
            "GITHUB_WEBHOOK_SECRETS",
          ].map((variable) => ({ variable, code: "incomplete" })),
        },
      },
    });
    const data = JSON.stringify((error as { data: unknown }).data);
    expect(data).not.toContain(privateKey);
    expect(data).not.toContain("123");
  });

  test("an explicit test check passes on the local backend and is refused elsewhere", async () => {
    stub({ [DEPLOYMENT_URL_VARIABLE]: LOCAL_URL, [TEST_JWKS_VARIABLE]: "jwks" });
    const t = convexTest(schema, modules);
    await expect(t.query(internal.health.deploymentChecks, { mode: "test" })).resolves.toEqual(
      expect.objectContaining({ ok: true, mode: "test", deployment: "loopback" }),
    );
    vi.stubEnv(DEPLOYMENT_URL_VARIABLE, CLOUD_URL);
    await expect(t.query(internal.health.deploymentChecks, { mode: "test" })).rejects.toThrow(
      /CONVEX_CLOUD_URL not loopback/,
    );
  });
});
