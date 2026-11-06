#!/usr/bin/env node
/** The launcher is driven through volli-drive refs; CDP below only reads DOM.
 * Each case gets a fresh guarded fixture with one unavailable Browser member
 * and one real neighbouring chat. Fixture setup is not launcher proof. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const app = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const output = resolve(process.argv[2] ?? join(app, ".scratch/empty-pane-acceptance"));
mkdirSync(output, { recursive: true });
const results = [];
const drive = (...args) =>
  execFileSync(process.execPath, [join(app, "e2e/volli-drive/cli.mjs"), ...args], {
    cwd: app,
    encoding: "utf8",
    timeout: 120000,
  });
function act(id, snapshot, name, kind = "click", text) {
  const row = snapshot
    .split("\n")
    .find((line) => line.includes(`[ref=`) && line.includes(`"${name}"`));
  assert.ok(row, `missing ${name}`);
  const gen = snapshot.match(/generation: (\d+)/)?.[1],
    ref = row.match(/\[ref=([^\]]+)\]/)?.[1];
  return drive(
    "act",
    id,
    "--gen",
    gen,
    "--ref",
    ref,
    "--kind",
    kind,
    ...(text === undefined ? [] : ["--text", text]),
  );
}
const paneRead = () =>
  Array.from(document.querySelectorAll('[data-slot="split-view-pane"]'))
    .filter((node) => node.checkVisibility())
    .map((node) => ({
      id: node.getAttribute("data-pane-id"),
      focused: node.getAttribute("data-focused") === "true",
      selected:
        node.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("aria-label") ??
        null,
      kind: node.querySelector('[data-slot="pane-empty-state"]')
        ? "empty"
        : node.querySelector('[data-slot="browser-pane-anchor"]')
          ? "browser"
          : node.querySelector('[data-slot="terminal-pane-anchor"]')
            ? "terminal"
            : node.querySelector("[data-monaco-status],[data-monaco-fallback]")
              ? "file"
              : node.querySelector('[aria-label="Message"]')
                ? "chat"
                : "unknown",
      text: node.textContent,
    }));
for (const side of ["left", "right"])
  for (const [label, kind] of [
    ["New chat", "chat"],
    ["New terminal", "terminal"],
    ["New browser", "browser"],
    ["Open file…", "file"],
    ["Close pane", "close"],
  ]) {
    if (process.argv[3] && process.argv[3] !== `${side}:${kind}`) continue;
    let id, browser;
    const result = { side, label, pass: false };
    try {
      const launch = drive("launch", "--no-build", "--fixture", `empty-pane-${side}`);
      id = launch.match(/instance: (vd-[a-f0-9]+)/)?.[1];
      assert.ok(id, launch);
      result.id = id;
      const dir = launch.match(/^evidence: (.+)$/m)?.[1];
      assert.ok(dir, "launch did not report its evidence directory");
      const spec = JSON.parse(readFileSync(join(dir, "spec.json"), "utf8"));
      const [port, ws] = readFileSync(join(spec.scratch, "ud/DevToolsActivePort"), "utf8")
        .trim()
        .split("\n");
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${ws}`);
      const page = browser
        .contexts()[0]
        .pages()
        .find((candidate) => candidate.url().startsWith("volli-app:"));
      assert.ok(page);
      await page.waitForFunction(
        () => document.querySelector('[data-pane-id="empty-launcher"]')?.checkVisibility(),
        undefined,
        { timeout: 15000 },
      );
      result.before = await page.evaluate(paneRead);
      const neighbour = result.before.find((pane) => pane.id === "neighbour");
      assert.ok(neighbour);
      assert.equal(neighbour.kind, "chat");
      let snapshot = drive("snapshot", id);
      snapshot = act(id, snapshot, label);
      if (kind === "file") {
        const field = snapshot.split("\n").find((line) => line.includes("combobox "));
        assert.ok(field, "file picker did not open");
        snapshot = drive(
          "act",
          id,
          "--gen",
          snapshot.match(/generation: (\d+)/)[1],
          "--ref",
          field.match(/\[ref=([^\]]+)\]/)[1],
          "--kind",
          "type",
          "--text",
          "README",
        );
        drive(
          "act",
          id,
          "--gen",
          snapshot.match(/generation: (\d+)/)[1],
          "--kind",
          "press",
          "--key",
          "Enter",
        );
      }
      await page.waitForFunction(
        (expectedKind) => {
          const panes = Array.from(
            document.querySelectorAll('[data-slot="split-view-pane"]'),
          ).filter((node) => node.checkVisibility());
          if (expectedKind === "close") return panes.length === 1;
          const target = panes.find(
            (node) => node.getAttribute("data-pane-id") === "empty-launcher",
          );
          const selector =
            expectedKind === "chat"
              ? '[aria-label="Message"]'
              : expectedKind === "browser"
                ? '[data-slot="browser-pane-anchor"]'
                : expectedKind === "terminal"
                  ? '[data-slot="terminal-pane-anchor"]'
                  : "[data-monaco-status],[data-monaco-fallback]";
          return Boolean(target?.querySelector(selector));
        },
        kind,
        { timeout: 15000 },
      );
      result.after = await page.evaluate(paneRead);
      if (kind === "close") {
        assert.equal(result.after.length, 1);
        assert.equal(result.after[0].kind, "chat");
        assert.ok(result.after[0].text.includes("Keep this neighbouring chat unchanged."));
      } else {
        const destination = result.after.find((pane) => pane.id === "empty-launcher");
        assert.equal(destination?.kind, kind);
        assert.equal(destination?.focused, true);
        const afterNeighbour = result.after.find((pane) => pane.id === "neighbour");
        assert.equal(afterNeighbour?.selected, neighbour.selected);
        assert.equal(afterNeighbour?.text, neighbour.text);
        assert.equal(afterNeighbour?.focused, false);
      }
      result.workspace = JSON.parse(
        drive("state", id, "sql", "SELECT value FROM app_state WHERE key='volli:workspace'"),
      );
      result.screenshot = drive("screenshot", id, "--name", `${side}-${kind}`).trim();
      result.doctor = drive("doctor", id);
      result.pass = true;
    } catch (error) {
      result.error = String(error?.stack ?? error);
    } finally {
      await browser?.close();
      if (id) result.stop = drive("stop", id);
      results.push(result);
      writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2));
      console.log(
        `${result.pass ? "PASS" : "FAIL"} ${side}: ${label}${result.error ? ` — ${result.error}` : ""}`,
      );
    }
  }
assert.ok(
  results.every((result) => result.pass),
  `${results.filter((result) => !result.pass).length}/${results.length} launcher cases failed; ${output}/results.json`,
);
