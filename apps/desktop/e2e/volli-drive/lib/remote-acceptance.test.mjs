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
  hasActionableControl,
  stableWaitingLabel,
  visibleServingRow,
  visibleAnswerReceipt,
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
test("project success toast cannot make navigation actionable during dialog exit", () => {
  const exiting = [
    "- button [ref=f2e931]:",
    "  - generic [ref=f2e187]: Home",
    '- region "Notifications alt+T":',
    "  - generic: Opened Remote acceptance on volli-acceptance",
    "- dialog [ref=f2e1016]:",
    '  - button "Close" [ref=f2e953]',
  ].join("\n");
  assert.equal(hasActionableControl(exiting, "button", "Home"), false);
  const ready = '- button "Home" [ref=f2e1020]';
  assert.equal(hasActionableControl(ready, "button", "Home"), true);
  assert.equal(hasActionableControl('- button "Home" [disabled]', "button", "Home"), false);
  assert.equal(hasActionableControl('- button "Home"', "button", "Home"), false);
  assert.equal(hasActionableControl(`${ready}\n${ready}`, "button", "Home"), false);
  assert.equal(hasActionableControl('- button "Home page" [ref=e1]', "button", "Home"), false);
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
test("native question selection observes the checked radio, not decorative text", () => {
  const tree = '- radio "Proceed" [checked] [ref=e1]\n- generic: Proceed\n- radio "Stop" [ref=e2]';
  assert.match(visibleControls(tree, "radio", "Proceed")[0], /\[checked\]/u);
  assert.doesNotMatch(visibleControls(tree, "radio", "Stop")[0], /\[checked\]/u);
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
test("durable answer proof uses the real titled trailer and the same question's receipt row", () => {
  // Exact gen0265 shape from ed7bf9e79, not an invented text-suffix snapshot.
  const receipt = `                    - generic [ref=f2e2075]:
                      - generic [ref=f2e2078]: You answered
                      - code [ref=f2e2079]: Continue the remote acceptance run?
                      - generic "Proceed"`;
  assert.equal(visibleAnswerReceipt(receipt, ANSWER_QUESTION, "Proceed"), true);
  assert.equal(visibleAnswerReceipt(receipt, REOPEN_QUESTION, "Proceed"), false);
  assert.equal(visibleAnswerReceipt(receipt, ANSWER_QUESTION, "Stop"), false);
  assert.equal(
    visibleAnswerReceipt(
      receipt.replace("You answered", "Request pending"),
      ANSWER_QUESTION,
      "Proceed",
    ),
    false,
  );
  assert.equal(
    visibleAnswerReceipt(
      receipt.replace('generic "Proceed"', 'radio "Proceed" [checked]'),
      ANSWER_QUESTION,
      "Proceed",
    ),
    false,
  );
  assert.equal(
    visibleAnswerReceipt(
      receipt.replace('- generic "Proceed"', '  - generic "Proceed"'),
      ANSWER_QUESTION,
      "Proceed",
    ),
    false,
  );
  assert.equal(
    visibleAnswerReceipt(
      `${receipt.replace('generic "Proceed"', 'generic "Stop"')}\n- generic "Proceed"`,
      ANSWER_QUESTION,
      "Proceed",
    ),
    false,
  );
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
test("an unchanged host chip is not writable readiness after a daemon restart", () => {
  const outage =
    '- button "Host: volli-acceptance" [ref=e1]\n- button "New ticket" [disabled]\n- generic: Reconnecting to volli-acceptance';
  assert.equal(hasActionableControl(outage, "button", "New ticket"), false);
  assert.equal(
    hasActionableControl(outage.replace("[disabled]", "[ref=e2]"), "button", "New ticket"),
    true,
  );
});

function liftedKeepaliveRetirement(started, quitAttempted, tools) {
  const smoke = read("../remote-acceptance-smoke.mjs");
  const body = smoke.slice(
    smoke.indexOf("async function stopLocalKeepalive()"),
    smoke.indexOf("async function step("),
  );
  return new Function(
    "tools",
    `
    let localKeepaliveStarted = ${started};
    let nativeQuitAttempted = ${quitAttempted};
    const LOCAL_KEEPALIVE = "[slow:120000] local-menu-bar-keepalive";
    const { call, selectHost, click, wait } = tools;
    ${body}
    return { run: stopLocalKeepalive, active: () => localKeepaliveStarted };
  `,
  )(tools);
}
test("keepalive retirement reopens normally and stops only the named local synthetic Session", async () => {
  const calls = [];
  const tools = Object.fromEntries(
    ["call", "selectHost", "click", "wait"].map((name) => [
      name,
      async (...args) => calls.push([name, ...args]),
    ]),
  );
  const inactive = liftedKeepaliveRetirement(false, false, tools);
  await inactive.run();
  assert.equal(calls.length, 0);
  const active = liftedKeepaliveRetirement(true, true, tools);
  await active.run();
  assert.deepEqual(calls, [
    ["call", "native-reopen"],
    ["selectHost", "This Mac"],
    ["click", "button", "local-menu-bar-keepalive No ticket", { contains: true }],
    ["wait", "[slow:120000] local-menu-bar-keepalive"],
    ["click", "button", "Stop turn"],
    ["call", "wait", { text: "Stop turn", gone: true }],
  ]);
  assert.equal(active.active(), false);
});
test("failed local interruption remains pending for cleanup retry, never claims a retired turn", async () => {
  const active = liftedKeepaliveRetirement(true, false, {
    call: async () => {
      throw new Error("turn still stopping");
    },
    selectHost: async () => {},
    click: async () => {},
    wait: async () => {},
  });
  await assert.rejects(active.run(), /turn still stopping/u);
  assert.equal(active.active(), true);
});

test("native Quit dispatches the real macOS action instead of no-op JS role.click", () => {
  const native = read("native-window-lifecycle.mjs");
  const begin = "app.evaluate(({ Menu }) => {";
  const body = native.slice(native.indexOf(begin) + begin.length, native.indexOf("}),"));
  const actions = [];
  const result = new Function("Menu", body)({
    getApplicationMenu: () => ({
      items: [
        {
          submenu: {
            items: [
              {
                role: "quit",
                label: "Quit Volli",
                click: () => {
                  throw new Error("native macOS role.click is not a Quit");
                },
              },
            ],
          },
        },
      ],
    }),
    sendActionToFirstResponder: (action) => actions.push(action),
  });
  assert.deepEqual(result, { label: "Quit Volli" });
  assert.deepEqual(actions, ["terminate:"]);
});
test("keepalive target cannot select its Close tab control", () => {
  const tree = `- button "Close [slow:120000] local-menu-bar-keepalive" [ref=e1]
- button "Chat [slow:120000] local-menu-bar-keepalive Working · now" [ref=e2]
- button "azure-openai-responses · Working [slow:120000] local-menu-bar-keepalive No ticket · just now" [ref=e3]`;
  const targets = visibleControls(tree, "button", "local-menu-bar-keepalive No ticket", {
    contains: true,
  });
  assert.equal(targets.length, 1);
  assert.ok(targets[0].includes("[ref=e3]"));
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
  assert.match(
    smoke,
    /action\("press", "radio", "Proceed", \{ key: "Space" \}\)/u,
    "a visually hidden native radio is selected by genuine keyboard activation",
  );
  assert.doesNotMatch(smoke, /click\("radio"|force:\s*true/u);
  assert.match(
    smoke,
    /click\("button", "Submit", \{ scope: \{ role: "form", name: question \} \}\)/u,
    "the declared-stop card submits through its own real form control",
  );
  for (const receiptAssertion of [
    'visibleAnswerReceipt((await snap()).text, question, "Proceed")',
    "await submitProceed(ANSWER_QUESTION)",
    "await submitProceed(REOPEN_QUESTION)",
  ])
    assert.ok(smoke.includes(receiptAssertion), receiptAssertion);
  assert.doesNotMatch(
    smoke,
    /Send answer|Sent: Proceed/u,
    "the verdict card has a durable receipt rather than an ask-user transient receipt",
  );
  assert.equal(
    (smoke.match(/await selectProceed\(\);/gu) ?? []).length,
    2,
    "both live and reopened questions use the native input and checked-state assertion",
  );
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
  assert.match(
    smoke,
    /hasActionableControl\(\(await snap\(\)\)\.text, "button", "New ticket"\)/u,
    "the daemon's operator restart must rejoin before the first ticket write, not just keep its chip name",
  );
  assert.ok(smoke.includes("can't add projects to it."));
  assert.match(smoke, /assertAcceptanceCleanup\(manifest\);\s*cleanupVerified = true;/u);
  assert.match(
    smoke,
    /complete:\s*!failed &&\s*cleanupVerified &&\s*results.length === 8 &&\s*results.every\(\(row\) => row.status === "PASS"\)/u,
    "eight PASS rows alone cannot claim completion without verified disposal",
  );
  const supervisor = read("../supervisor.mjs");
  assert.doesNotMatch(supervisor, /VOLLI_SMOKE_MENU_BAR_HOST|volliMenuBarHost/);
  assert.match(supervisor, /await quitNativeWindow\(app, page\)/u);
  const lifecycle = read("./native-window-lifecycle.mjs");
  assert.match(
    lifecycle,
    /windows\.filter\(\(window\) => window\.isVisible\(\)\)\.length/u,
    "quit observes real native visibility, not the retained Playwright Page count",
  );
  assert.match(lifecycle, /assert\.equal\(nativeWindows\.visible, 0/u);
  assert.match(smoke, /assert\.equal\(quit\.nativeWindows\.visible, 0\)/u);
  assert.match(
    smoke,
    /await call\("native-reopen"\);\s*nativeQuitAttempted = false;[\s\S]*?await selectHost\(REMOTE_HOST\);[\s\S]*?stableWaitingLabel\(line\) === rowLabel/u,
    "a fresh renderer navigates back through the host switcher before proving the same Session row",
  );
  assert.match(smoke, /await stopLocalKeepalive\(\);\s*await selectHost\(REMOTE_HOST\)/u);
  assert.match(
    smoke,
    /await stopLocalKeepalive\(\)\.catch[\s\S]*?\[cli, "stop", instance\.id\]/u,
    "failure cleanup also retires this journey's local turn before strict app close",
  );
  const retirement = smoke.slice(
    smoke.indexOf("async function stopLocalKeepalive()"),
    smoke.indexOf("async function step("),
  );
  assert.match(retirement, /await selectHost\("This Mac"\)/u);
  assert.match(retirement, /click\("button", "local-menu-bar-keepalive No ticket"/u);
  assert.match(retirement, /await click\("button", "Stop turn"\)/u);
  assert.match(retirement, /text: "Stop turn", gone: true/u);
  assert.doesNotMatch(retirement, /REMOTE_HOST|session\.command|invoke|window\.api/u);
});
