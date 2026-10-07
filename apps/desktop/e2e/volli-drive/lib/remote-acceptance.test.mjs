import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  acceptanceScript,
  acceptanceTarballs,
  assertAcceptanceRunner,
  sshConfig,
  ANSWER_QUESTION,
  ANSWER_REPLY,
  REOPEN_QUESTION,
  STREAM_REPLY,
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
  assert.match(smoke, /record\(\s*2,\s*"XFAIL"/u);
  assert.match(smoke, /record\(\s*2,\s*"XPASS"/u);
  assert.match(smoke, /record\(\s*n,\s*"BLOCKED"/u);
  assert.ok(
    smoke.includes('row.status === "PASS"'),
    "canary completion is all-PASS, not process exit zero",
  );
  assert.doesNotMatch(read("../supervisor.mjs"), /VOLLI_SMOKE_MENU_BAR_HOST|volliMenuBarHost/);
});
