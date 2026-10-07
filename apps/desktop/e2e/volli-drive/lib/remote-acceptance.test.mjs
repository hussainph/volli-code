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
  assertAcceptanceCleanup,
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
test("CLI source guards remote acceptance before build/reservation/spawn (no CLI execution)", () => {
  const cli = read("../cli.mjs");
  const launch = cli.slice(cli.indexOf("async function launch(flags)"));
  const guard = launch.indexOf("assertAcceptanceRunner();");
  assert.ok(guard > 0);
  for (const boundary of ["await ensureBuilt(flags)", "await registry.reserve(", "spawn("])
    assert.ok(launch.indexOf(boundary) > guard, boundary);
  const smoke = read("../remote-acceptance-smoke.mjs");
  assert.ok(smoke.indexOf("assertAcceptanceRunner();") < smoke.indexOf("await journey();"));
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
test("folder project must open; the old user-install refusal is a failure, never a waiver", () => {
  const options = { hostName: "box", projectName: "App" };
  const refusal = "box runs Volli as your login, so this Mac can't add projects to it.";
  assert.throws(() => projectCreationOutcome(refusal, options), /Unexpected project refusal/u);
  assert.equal(projectCreationOutcome("Connection failed", options), null);
  assert.equal(projectCreationOutcome("Opened Other on box", options), null);
  assert.equal(projectCreationOutcome("Opened App on other", options), null);
  assert.deepEqual(projectCreationOutcome("Opened App on box", options), { status: "PASS" });
});
const cleanManifest = () => ({
  electron: {
    close: {
      kind: "graceful",
      exit: { code: 0, signal: null },
      closeFailures: [],
    },
  },
  scratchRemoved: true,
  keychainViolations: [],
  keychainViolationExit: false,
  leftovers: [],
  remoteCleanupError: null,
});
test("completion cleanup uses the supervisor's graceful close and scratch removal fields", () => {
  assert.doesNotThrow(() => assertAcceptanceCleanup(cleanManifest()));
  for (const manifest of [null, undefined, false, "stopped"])
    assert.throws(() => assertAcceptanceCleanup(manifest), /cleanup manifest/u);
  for (const scratchRemoved of [undefined, false, "true", 1])
    assert.throws(
      () => assertAcceptanceCleanup({ ...cleanManifest(), scratchRemoved }),
      /scratchRemoved:true/u,
    );
  for (const electron of [undefined, {}, { close: null }])
    assert.throws(
      () => assertAcceptanceCleanup({ ...cleanManifest(), electron }),
      /close gracefully/u,
    );
});
test("forced, errored or unverified Electron shutdown cannot complete acceptance", () => {
  for (const kind of [
    undefined,
    "sigterm",
    "sigkill",
    "error",
    "already-exited",
    "natural-after-close",
    "natural-after-sigterm",
  ]) {
    const manifest = cleanManifest();
    manifest.electron.close.kind = kind;
    assert.throws(() => assertAcceptanceCleanup(manifest), /close gracefully/u);
  }
  for (const exit of [undefined, {}, { code: 1, signal: null }, { code: 0, signal: "SIGTERM" }]) {
    const manifest = cleanManifest();
    manifest.electron.close.exit = exit;
    assert.throws(() => assertAcceptanceCleanup(manifest), /close gracefully/u);
  }
  for (const closeFailures of [undefined, ["app.close timed out"]]) {
    const manifest = cleanManifest();
    manifest.electron.close.closeFailures = closeFailures;
    assert.throws(() => assertAcceptanceCleanup(manifest), /close gracefully/u);
  }
});
test("missing guard fields, keychain violations, leftovers and remote cleanup errors fail closed", () => {
  for (const [field, invalid] of [
    ["keychainViolations", [[{ method: "security" }], undefined]],
    ["keychainViolationExit", [true, undefined]],
    ["leftovers", [[{ pid: 123, signal: "SIGKILL" }], undefined]],
    ["remoteCleanupError", ["Fixture hostd did not stop cleanly", undefined]],
  ])
    for (const value of invalid)
      assert.throws(
        () => assertAcceptanceCleanup({ ...cleanManifest(), [field]: value }),
        /manifest failed/u,
      );
});
test("journey arranges only benign Git state and runs all eight real assertions without waivers", () => {
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
  assert.doesNotMatch(smoke, /EXPECTED_PROJECT_FAILURE|XFAIL|XPASS|expectedFailure/u);
  assert.doesNotMatch(
    smoke,
    /VC-721|EXPECTED_QUESTION_FAILURE/u,
    "VC-721 is merged: questions have no independent waiver",
  );
  assert.ok(
    smoke.includes("projectCreationOutcome(current.text"),
    "project creation must use the tested real-open classifier",
  );
  assert.ok(smoke.includes('record(number, "FAIL", assertion, error.message)'));
  assert.ok(smoke.includes('record(n, "BLOCKED", "Not run"'));
  assert.match(
    smoke,
    /await action\("scroll", "button", "Forget…", \{ direction: "down" \}\);\s*await shot\("step-1-paired-device"\)/u,
    "pairing evidence is framed at the bottom of the host pane before the viewport screenshot",
  );
  assert.doesNotMatch(smoke, /click\("button", "Forget…"/u);
  const fixture = read("./remote-acceptance.mjs");
  assert.doesNotMatch(fixture, /project add|operator-token|arrangeProject/u);
  assert.ok(fixture.includes("git init --bare --initial-branch=main"));
  assert.ok(fixture.includes("Arrange benign Git state over fixture SSH"));
  assert.ok(smoke.includes('call("acceptance-arrange-box")'));
  assert.ok(smoke.includes("can't add projects to it."));
  assert.match(smoke, /assertAcceptanceCleanup\(manifest\);\s*cleanupVerified = true;/u);
  assert.match(
    smoke,
    /complete:\s*!failed &&\s*cleanupVerified &&\s*results.length === 8 &&\s*results.every\(\(row\) => row.status === "PASS"\)/u,
    "eight PASS rows alone cannot claim completion without verified disposal",
  );
  assert.doesNotMatch(read("../supervisor.mjs"), /VOLLI_SMOKE_MENU_BAR_HOST|volliMenuBarHost/);
});
