import { describe, expect, it } from "vite-plus/test";
import { runCli } from "./run";

/** Same JSON payload encoded by the host from the real engine tail. The
 * engine/host tests prove acceptance; this proves its CLI command-path label. */
async function peek(delivery: unknown, json = false) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const data = JSON.parse(
    JSON.stringify({
      session: "abcdef12",
      status: "working",
      turns: 1,
      turnDepth: 1,
      lastActivityAgeMs: 1000,
      transcript: [{ role: "user", ageMs: 1000, text: "focus here", tools: [], delivery }],
    }),
  );
  const code = await runCli(["session", "peek", "abcdef12", ...(json ? ["--json"] : [])], {
    env: { VOLLI_SOCKET: "/socket" },
    cwd: "/work",
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    readText: async () => "",
    observe: async () => ({}),
    request: async () => ({ v: 1, ok: true, data }),
    launch: async () => ({ alreadyRunning: true }),
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("session peek delivery proof", () => {
  it.each(["Pending", "Delivered", "Not delivered", "Delivery unconfirmed"])(
    "prints %s without inferring acceptance from user prose",
    async (label) => {
      const result = await peek(label);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`user [${label}]  focus here`);
    },
  );
  it("keeps legacy and malformed optional hints out of text", async () => {
    for (const label of [undefined, null, 5])
      expect((await peek(label)).stdout).toContain("user  focus here");
  });
  it("preserves the additive delivery field in JSON", async () => {
    const result = await peek("Pending", true);
    expect(JSON.parse(result.stdout).transcript[0]).toMatchObject({
      delivery: "Pending",
      text: "focus here",
    });
  });
});
