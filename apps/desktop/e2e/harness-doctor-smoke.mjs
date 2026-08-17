/**
 * E2e probe: `volli doctor` inside a real Volli PTY.
 *
 * This is the test the branch needed and did not have. Every unit test and
 * every other smoke asserted a component's own configuration — that the bin dir
 * was prepended, that a wrapper was written, that a hook command was rendered —
 * and all of them passed throughout an outage in which no wrapper ever ran,
 * because a macOS login shell had already pushed Volli's bin dir to position 20
 * of 30 and every harness resolved to the user's own install.
 *
 * So this asserts the OUTCOME, from inside the environment that has to hold it:
 * boot the app, open a real PTY, and ask `volli doctor` — which measures its own
 * PATH and resolves each harness name the way the shell would — whether the
 * whole chain actually works. A single failed check fails the smoke.
 *
 * Deliberately does NOT pin ZDOTDIR to a neutral rc, unlike the other PTY
 * smokes. The developer's real dotfiles ARE the adversary here: a scratch rc
 * that never touches PATH is exactly the condition under which the original
 * defect was invisible, so neutralizing them would neutralize the test.
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/harness-doctor-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { makeShortScratch } from "./lib/agent-kit.mjs";
import { createRunner, launch, makeGitRepo, seedProjects, waitUntil } from "./lib/smoke-kit.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeShortScratch("doc");
const { attempt, summarize } = createRunner();

async function main() {
  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { VOLLI_SKIP_CLOSE_CONFIRM: "1" },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // Nothing below needs the shim's path — only that it EXISTS, since a doctor
    // run that beat the generator would report an install that was merely late.
    // Both candidates are tried because the app may or may not have nested a
    // product directory under the profile it was handed.
    await waitUntil("the generated shim", async () => {
      for (const candidate of [userDataDir, join(userDataDir, "Volli Code")]) {
        try {
          await fs.stat(join(candidate, "bin", "volli"));
          return true;
        } catch {
          /* try the next candidate */
        }
      }
      return false;
    });

    const projectPath = await makeGitRepo(scratch, "doc-");
    await seedProjects(page, [
      { id: "doc-project", name: "Doctor Project", path: projectPath, prefix: "DR" },
    ]);
    const created = await page.evaluate(
      async ({ cwd }) =>
        window.api.terminal.create({ workspaceId: "doc-project", cwd, cols: 100, rows: 30 }),
      { cwd: projectPath },
    );
    if (!created?.ok) throw new Error(`terminal.create failed: ${created?.error}`);

    // Run doctor in the PTY and write its report to a file rather than scraping
    // the terminal stream: the report is multi-line and the point is its
    // content, not how it renders.
    const out = join(scratch, "out");
    await fs.mkdir(out, { recursive: true });
    await page.evaluate(
      ({ id, d }) =>
        window.api.terminal.write(
          id,
          `volli doctor --json > '${d}/report.json' 2>'${d}/err'; printf done > '${d}/ready'\n`,
        ),
      { id: created.sessionId, d: out },
    );
    await waitUntil(
      "doctor to finish",
      async () =>
        fs
          .readFile(join(out, "ready"), "utf8")
          .then((text) => text === "done")
          .catch(() => false),
      { timeout: 30000 },
    );

    const raw = await fs.readFile(join(out, "report.json"), "utf8").catch(() => "");
    const stderr = await fs.readFile(join(out, "err"), "utf8").catch(() => "");
    let report = null;
    try {
      report = JSON.parse(raw);
    } catch {
      /* reported as check 1's failure */
    }

    // === 1. doctor ran at all ==============================================
    // If `volli` itself does not resolve inside the PTY, nothing below can run —
    // and that is one of the very failures being tested for.
    await attempt(1, "`volli doctor` runs inside a Volli PTY and reports checks", async () => {
      const ok = report !== null && Array.isArray(report.checks) && report.checks.length > 0;
      return {
        ok,
        detail: ok
          ? `${report.checks.length} checks — ${report.summary}`
          : `stdout=${JSON.stringify(raw.slice(0, 200))} stderr=${JSON.stringify(stderr.slice(0, 200))}`,
      };
    });
    if (report === null || !Array.isArray(report.checks)) return;

    const byId = (id) => report.checks.find((check) => check.id === id);

    // === 2. the bin dir actually wins ======================================
    await attempt(2, "Volli's bin dir is FIRST on the session PATH", async () => {
      const check = byId("path-position");
      return { ok: check?.status === "ok", detail: `${check?.status}: ${check?.detail}` };
    });

    // === 3. a typed harness name reaches the wrapper =======================
    // The property the whole event design rests on, asserted for every harness
    // that has a wrapper on this host rather than for one hand-picked name.
    await attempt(3, "every wrapped harness resolves to Volli's wrapper", async () => {
      const resolution = report.checks.filter((check) => check.id.startsWith("resolves-"));
      const bad = resolution.filter((check) => check.status !== "ok");
      return {
        ok: resolution.length > 0 && bad.length === 0,
        detail:
          resolution.length === 0
            ? "no harness wrappers on this host — install one to make this meaningful"
            : `${resolution.length} checked, ${bad.length} wrong${bad.length ? `: ${bad.map((c) => c.detail).join("; ")}` : ""}`,
      };
    });

    // === 4. the shell integration is live in THIS shell ====================
    await attempt(4, "the generated zsh chain is active in this session", async () => {
      const check = byId("shell-init");
      // A non-zsh developer shell warns rather than fails, and that is correct.
      const ok = check?.status === "ok" || check?.status === "warn";
      return { ok, detail: `${check?.status}: ${check?.detail}` };
    });

    // === 5. nothing at all is failing ======================================
    await attempt(5, "no check reports a failure", async () => {
      const failed = report.checks.filter((check) => check.status === "fail");
      return {
        ok: failed.length === 0,
        detail:
          failed.length === 0
            ? report.summary
            : failed.map((check) => `${check.id}: ${check.detail}`).join("; "),
      };
    });

    await page.evaluate((id) => window.api.terminal.kill(id), created.sessionId).catch(() => {});
  } finally {
    await app.close().catch(() => {});
  }
}

try {
  await main();
} finally {
  await cleanup().catch(() => {});
}
summarize();
