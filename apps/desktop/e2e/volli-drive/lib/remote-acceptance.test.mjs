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
  snapshotSubtree,
  projectCreationOutcome,
  acceptanceHostAddState,
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
const selfAddQuestion = `- paragraph: This is the Mac you’re using. Its projects already run here. Add it anyway (for testing)?
- button "Add anyway" [ref=e1]
- button "Cancel" [ref=e2]`;
test("host add tolerates pre-VC-724 readiness and handles the optional self-add question first", () => {
  assert.equal(acceptanceHostAddState("Installing…", "box"), "pending");
  assert.equal(acceptanceHostAddState("box is ready", "box"), "ready");
  assert.equal(acceptanceHostAddState("another host is ready", "box"), "pending");
  assert.equal(acceptanceHostAddState(selfAddQuestion, "box"), "self-add");
  assert.equal(
    acceptanceHostAddState(`box is ready\n${selfAddQuestion}`, "box"),
    "self-add",
    "a background ready label cannot skip the visible confirmation",
  );
  const smoke = read("../remote-acceptance-smoke.mjs");
  assert.match(smoke, /acceptanceHostAddState\(current\.text, REMOTE_HOST\)/u);
  assert.match(smoke, /await shot\("step-1-self-add-question"\)/u);
  assert.match(smoke, /await click\("button", "Add anyway"\)/u);
});
test("self-add requires the full visible question and enabled unambiguous answers", () => {
  assert.throws(
    () => acceptanceHostAddState(selfAddQuestion.replace("you’re", "you're"), "box"),
    /confirmation text/u,
    "ASCII apostrophe cannot substitute for the exact production copy",
  );
  assert.throws(
    () =>
      acceptanceHostAddState(selfAddQuestion.replace("Its projects already run here. ", ""), "box"),
    /confirmation text/u,
  );
  for (const tree of [
    selfAddQuestion.replace("[ref=e1]", "[disabled]"),
    selfAddQuestion.replace('- button "Add anyway" [ref=e1]', ""),
    `${selfAddQuestion}\n- button "Add anyway" [ref=e3]`,
  ])
    assert.throws(() => acceptanceHostAddState(tree, "box"), /enabled Add anyway/u);
  for (const tree of [
    selfAddQuestion.replace("[ref=e2]", "[disabled]"),
    selfAddQuestion.replace('- button "Cancel" [ref=e2]', ""),
    `${selfAddQuestion}\n- button "Cancel" [ref=e3]`,
  ])
    assert.throws(() => acceptanceHostAddState(tree, "box"), /enabled Cancel/u);
});
test("host selection is scoped to the switcher, excluding background rename controls", () => {
  const tree = `- generic:\n  - button "volli-acceptance Rename" [ref=e1]\n- dialog "Switch host" [ref=e2]:\n  - group "Hosts":\n    - button "volli-acceptance 0 projects" [ref=e3]\n- button "More for volli-acceptance" [ref=e4]`;
  const scope = snapshotSubtree(tree, "dialog", "Switch host");
  const hits = visibleControls(scope, "button", "volli-acceptance", { contains: true });
  assert.equal(hits.length, 1);
  assert.equal(controlLabel(hits[0]), "volli-acceptance 0 projects");
  assert.throws(() => snapshotSubtree(tree, "dialog", "Missing"), /found 0/u);
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
test("VC-722 XFAIL is narrow and unexpected creation success is fatal", () => {
  const options = { hostName: "box", projectName: "App", expectedTicket: "VC-722" };
  const refusal = "box runs Volli as your login, so this Mac can't add projects to it.";
  assert.deepEqual(projectCreationOutcome(refusal, options), {
    status: "XFAIL",
    detail: `VC-722: ${refusal}`,
  });
  assert.equal(projectCreationOutcome("Connection failed", options), null);
  assert.throws(() => projectCreationOutcome("Opened App on box", options), /XPASS VC-722/u);
  assert.throws(
    () => projectCreationOutcome(`Opened App on box\n${refusal}`, options),
    /XPASS VC-722/u,
    "success outranks a stale refusal",
  );
  assert.deepEqual(
    projectCreationOutcome("Opened App on box", { ...options, expectedTicket: null }),
    { status: "PASS" },
  );
  assert.throws(
    () => projectCreationOutcome(refusal, { ...options, expectedTicket: null }),
    /Unexpected project refusal/u,
  );
});
test("journey arranges only benign Git state and narrowly XFAILs pending VC-722", () => {
  const smoke = read("../remote-acceptance-smoke.mjs");
  assert.doesNotMatch(smoke, /window\.api|createHostLink|page\.evaluate|setState|lab\//);
  for (const label of [
    "SSH destination",
    "Paired devices",
    "This Mac",
    "Create and open",
    "Status: Backlog",
    "Status: Todo",
    "Signed in on",
    "Stop turn",
    "Waiting for you",
    "Search",
  ])
    assert.ok(smoke.includes(label), label);
  assert.match(smoke, /ticket: "VC-722", steps: \[2\]/u);
  assert.doesNotMatch(
    smoke,
    /VC-721|EXPECTED_QUESTION_FAILURE/u,
    "VC-721 is merged: questions have no independent waiver",
  );
  assert.ok(
    smoke.includes("projectCreationOutcome(current.text"),
    "unexpected project creation must use the tested fatal-XPASS classifier",
  );
  assert.ok(
    smoke.includes(
      'record(n, "BLOCKED", "Requires remote project", EXPECTED_PROJECT_FAILURE.ticket)',
    ),
  );
  const fixture = read("./remote-acceptance.mjs");
  assert.doesNotMatch(fixture, /project add|operator-token|arrangeProject/u);
  assert.ok(fixture.includes("git init --bare --initial-branch=main"));
  assert.ok(fixture.includes("Arrange benign Git state over fixture SSH"));
  assert.ok(smoke.includes('call("acceptance-arrange-box")'));
  assert.ok(smoke.includes("can't add projects to it."));
  assert.ok(
    smoke.includes('row.status === "PASS"'),
    "canary completion is all-PASS, not process exit zero",
  );
  assert.doesNotMatch(read("../supervisor.mjs"), /VOLLI_SMOKE_MENU_BAR_HOST|volliMenuBarHost/);
});
