#!/usr/bin/env node
/**
 * Counts Session RPC round trips for five routine desktop interactions.
 *
 * The profile MUST be a disposable fixture: normal app boot migrates it and
 * may append recovery facts. Build the desktop before running.
 *
 *   cd apps/desktop && vp run build
 *   node e2e/session-rpc-interaction-bench.mjs \
 *     --label before --profile /tmp/volli-perf-real --ticket-query PERF-1
 *
 * Run once with `--label before` against the baseline build and once with
 * `--label after` against the changed build. Each run emits the same stable
 * sentinel artifact shape; the label identifies which dynamic run produced it.
 *
 * `ticket-query` must return both a ticket and a Session in the command
 * palette. The first result of each kind is used as the representative pair.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { argument } from "./bench/session-rpc/helpers.cjs";

const label = argument("label");
const profile = argument("profile");
const ticketQuery = argument("ticket-query");
if (label !== "before" && label !== "after") {
  throw new Error("--label must be before or after");
}
if (!profile || !ticketQuery) {
  throw new Error("--profile DISPOSABLE_PROFILE and --ticket-query QUERY are required");
}

function summarize(samples) {
  return {
    roundTrips: samples.filter((sample) => sample.kind === "round-trip").length,
    procedures: samples
      .filter((sample) => sample.kind === "round-trip")
      .map((sample) => sample.procedure),
    pushFrames: samples.filter((sample) => sample.kind === "push").length,
    maxPreAckBacklog: Math.max(
      0,
      ...samples.filter((sample) => sample.kind === "push").map((sample) => sample.bufferedFrames),
    ),
  };
}

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronApp = await electron.launch({
  cwd: appDirectory,
  args: ["dist-electron/main.cjs", `--user-data-dir=${resolve(profile)}`],
  env: {
    ...process.env,
    VOLLI_QUIET_WINDOWS: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
  },
});

try {
  await electronApp.context().addInitScript(() => {
    globalThis["__VOLLI_SESSION_RPC_PERFORMANCE_SAMPLES__"] = [];
    globalThis["__VOLLI_SESSION_RPC_PERFORMANCE__"] = {
      record(sample) {
        globalThis["__VOLLI_SESSION_RPC_PERFORMANCE_SAMPLES__"].push(sample);
      },
    };
  });
  const page = await electronApp.firstWindow();
  const drain = () =>
    page.evaluate(() => globalThis["__VOLLI_SESSION_RPC_PERFORMANCE_SAMPLES__"].splice(0));
  const openPalette = async () => {
    await page.keyboard.press("Meta+k");
    const search = page.getByRole("combobox");
    await search.fill(ticketQuery);
    await page.waitForTimeout(300);
  };
  const results = {};

  // Includes restored-chat connection and catalog reads, whose slower replies
  // can land several seconds after first paint on the real-scale fixture.
  await page.waitForTimeout(12_000);
  results.appBoot = summarize(await drain());

  await openPalette();
  await page.locator("[cmdk-item]").filter({ hasText: "Open ticket" }).first().click();
  await page.waitForTimeout(2_000);
  results.openTicket = summarize(await drain());

  await openPalette();
  await page.locator("[cmdk-item]").filter({ hasText: "Open session" }).first().click();
  await page.waitForTimeout(8_000);
  results.openLongChat = summarize(await drain());

  const tabs = page.getByRole("tab");
  if ((await tabs.count()) < 2) throw new Error("Expected ticket and Session tabs after open");
  await tabs.first().click();
  await page.waitForTimeout(1_000);
  await drain();
  await tabs.nth(1).click();
  await page.waitForTimeout(5_000);
  results.switchTabs = summarize(await drain());

  await page.keyboard.press("Meta+b");
  await page.waitForTimeout(700);
  await drain();
  await page.keyboard.press("Meta+b");
  await page.waitForTimeout(1_500);
  results.openSidebar = summarize(await drain());

  const artifact = { schemaVersion: 1, label, results };
  console.log(
    `__SESSION_RPC_INTERACTIONS__${JSON.stringify(artifact)}__SESSION_RPC_INTERACTIONS__`,
  );
} finally {
  await electronApp.close();
}
