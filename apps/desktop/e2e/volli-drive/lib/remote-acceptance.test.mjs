import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  acceptanceScript,
  acceptanceTarballs,
  acceptanceDaemonPid,
  assertAcceptanceRunner,
  sshConfig,
  ANSWER_QUESTION,
  ANSWER_REPLY,
  REOPEN_QUESTION,
  STREAM_REPLY,
  REOPEN_REPLY,
  controlLabel,
  visibleControls,
  stableWaitingLabel,
  visibleServingRow,
} from "./remote-acceptance.mjs";

const exec = promisify(execFile);
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const turn = (text, input = []) => ({ text, body: { tools: [{ name: "ask_user" }], input } });
test("managed acceptance refuses local Macs, Linux and incomplete CI identity", () => {
  for (const [env, platform] of [
    [{}, "darwin"],
    [{ CI: "true" }, "darwin"],
    [{ GITHUB_ACTIONS: "true", RUNNER_OS: "Linux" }, "linux"],
  ]) {
    assert.throws(() => assertAcceptanceRunner(env, platform), /disposable macOS/);
  }
  assert.doesNotThrow(() =>
    assertAcceptanceRunner({ GITHUB_ACTIONS: "true", RUNNER_OS: "macOS" }, "darwin"),
  );
});
test("remote acceptance is refused by CLI before a build/reservation/spawn", async () => {
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
  const { GITHUB_ACTIONS: _ci, RUNNER_OS: _os, ...env } = process.env;
  const result = await exec(
    process.execPath,
    [cli, "launch", "--remote-acceptance", "--no-build"],
    { env },
  ).catch((e) => e);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /disposable macOS/);
  assert.doesNotMatch(result.stderr, /building the app|launch failed|Electron is not installed/);
});
test("artifact setting is explicit, absolute and cannot silently fall back to downloads", () => {
  for (const value of ["", undefined, "relative.tar.gz", "/tmp/foo.zip", "/tmp/a.tar.gz:"])
    assert.throws(() => acceptanceTarballs(value));
  assert.equal(acceptanceTarballs("/tmp/a.tar.gz:/tmp/b.tar.gz"), "/tmp/a.tar.gz:/tmp/b.tar.gz");
});
test("SSH fixture config only names loopback and fresh credentials, no ambient keychain or agent", () => {
  const config = sshConfig({
    port: 23456,
    user: "runner",
    identityFile: "/scratch/key",
    knownHostsFile: "/scratch/known hosts",
  });
  for (const text of [
    "HostName 127.0.0.1",
    "Port 23456",
    'IdentityFile "/scratch/key"',
    "IdentityAgent none",
    "UseKeychain no",
    "AddKeysToAgent no",
    "GlobalKnownHostsFile /dev/null",
    'UserKnownHostsFile "/scratch/known hosts"',
  ])
    assert.ok(config.includes(text));
  assert.ok(!config.includes("~/"));
});
test("acceptance SSH keeps StrictModes and uses a fresh CI-home directory, not world-writable tmp", () => {
  assert.match(
    read("./remote-acceptance.mjs"),
    /fs\.mkdtemp\(join\(home, "\.volli-acceptance-sshd-"\)\)/u,
  );
  assert.match(read("./sshd-fixture.mjs"), /"StrictModes yes"/u);
  assert.doesNotMatch(read("./sshd-fixture.mjs"), /"StrictModes no"/u);
});
test("daemon cleanup never adopts the retained pid of a stopped/offline status", () => {
  const home = "/fixture/home";
  const status = {
    v: 1,
    dataDir: `${home}/Library/Application Support/volli-hostd`,
    verdict: "serving",
    running: { state: "serving", pid: 123 },
  };
  assert.equal(acceptanceDaemonPid(status, home), 123);
  assert.equal(
    acceptanceDaemonPid(
      { ...status, verdict: "refusing", running: { ...status.running, state: "refusing" } },
      home,
    ),
    123,
  );
  assert.equal(acceptanceDaemonPid({ ...status, verdict: "not-serving" }, home), null);
  assert.equal(
    acceptanceDaemonPid({ ...status, running: { ...status.running, state: "stopped" } }, home),
    null,
  );
  assert.throws(
    () => acceptanceDaemonPid({ ...status, dataDir: "/someones/install" }, home),
    /fixture install/,
  );
});
test("visible controls handle colon-quoted YAML keys and disabled rows without refs", () => {
  const tree = [
    `  - 'button "Host: This Mac" [ref=f2e12]':`,
    `  - button "Connect" [ref=f2e13]`,
    `  - button "volli-acceptance 0 projects" [disabled]`,
  ].join("\n");
  assert.equal(visibleControls(tree, "button", "Host:", { contains: true }).length, 1);
  assert.equal(
    controlLabel(visibleControls(tree, "button", "Host:", { contains: true })[0]),
    "Host: This Mac",
  );
  assert.equal(visibleControls(tree, "button", "volli-acceptance", { contains: true }).length, 1);
  assert.equal(visibleControls(tree, "button", "Connect").length, 1);
});
test("log proof requires a real row, not search/filter or other-host names", () => {
  const header = `- button "volli-acceptance" [pressed]\n- textbox "Search": serving`;
  const row = `- listitem:\n  - generic: volli-acceptance\n  - button "hostd" [ref=e1]\n  - 'button "serving database: /fixture/db" [ref=e2]'`;
  assert.equal(visibleServingRow(header, "volli-acceptance"), false);
  assert.equal(visibleServingRow(`${header}\n${row}`, "volli-acceptance"), true);
  assert.equal(
    visibleServingRow(
      `${header}\n${row.replace("volli-acceptance", "other-host")}`,
      "volli-acceptance",
    ),
    false,
  );
});
const row = (age) => `- button "Chat · Waiting for you Fix 1h timeout ACC-1 · ${age}" [ref=e5]`;
test("waiting row identity survives a displayed age boundary without erasing title", () => {
  assert.equal(stableWaitingLabel(row("just now")), stableWaitingLabel(row("1m ago")));
  assert.ok(stableWaitingLabel(row("just now")).includes("Fix 1h timeout"));
  assert.equal(stableWaitingLabel(row("now")), stableWaitingLabel(row("2m")));
});
test("script has real ask_user calls, answered continuation and a separate reopen request", () => {
  assert.equal(
    acceptanceScript({ text: "remote-answer-question", body: {} }),
    undefined,
    "auto-title cannot consume a question",
  );
  assert.deepEqual(acceptanceScript(turn("remote-stream-turn")), {
    text: STREAM_REPLY,
    delayMs: 1500,
  });
  assert.equal(
    acceptanceScript({ text: "remote-stream-turn", body: { tools: [{ name: "read" }] } }).text,
    STREAM_REPLY,
  );
  assert.equal(
    acceptanceScript({ text: "remote-answer-question", body: { tools: [{ name: "read" }] } }),
    undefined,
  );
  assert.equal(acceptanceScript({ text: "remote-stream-turn", body: {} }), undefined);
  const question = acceptanceScript(turn("remote-answer-question"));
  assert.equal(question.toolCalls[0].name, "ask_user");
  assert.equal(question.toolCalls[0].arguments.question, ANSWER_QUESTION);
  assert.equal(
    acceptanceScript(
      turn("remote-answer-question", [{ type: "function_call_output", output: "Chose: proceed" }]),
    ),
    ANSWER_REPLY,
  );
  assert.equal(
    acceptanceScript(turn("remote-reopen-question")).toolCalls[0].arguments.question,
    REOPEN_QUESTION,
  );
  assert.equal(
    acceptanceScript(
      turn("remote-reopen-question", [{ type: "function_call_output", output: "Chose: proceed" }]),
    ),
    REOPEN_REPLY,
  );
  assert.notEqual(
    REOPEN_REPLY,
    ANSWER_REPLY,
    "Reopened answer cannot match a previous visible reply",
  );
  assert.equal(acceptanceScript(turn("ordinary turn")), undefined);
});
test("journey never seeds its acceptance actions or injects product links", () => {
  const smoke = read("../remote-acceptance-smoke.mjs");
  assert.doesNotMatch(smoke, /window\.api|createHostLink|page\.evaluate|setState|lab\//);
  for (const label of [
    "SSH destination",
    "Create and open",
    "Status: Backlog",
    "Status: Todo",
    "Signed in on",
    "Stop turn",
    "Waiting for you",
    "Search",
  ])
    assert.ok(smoke.includes(label), label);
  assert.doesNotMatch(
    smoke,
    /XFAIL|XPASS|EXPECTED_FAILURE/u,
    "All four glue tickets are merged: no acceptance waivers remain",
  );
  assert.ok(
    smoke.includes('row.status === "PASS"'),
    "canary completion is all-PASS, not process exit zero",
  );
  assert.doesNotMatch(read("../supervisor.mjs"), /VOLLI_SMOKE_MENU_BAR_HOST|volliMenuBarHost/);
});
