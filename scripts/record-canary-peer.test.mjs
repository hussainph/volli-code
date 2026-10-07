import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  assembleBundle,
  releaseProvenance,
  recordCanaryPeer,
  REQUIRED_RECORDINGS,
  CAPTURE_LANES,
  ROOT,
} from "./record-canary-peer.mjs";

function checkout() {
  const root = mkdtempSync(join(ROOT, ".canary-peer-test-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }).trim();
  git("init", "--quiet");
  writeFileSync(join(root, "source"), "release source");
  git("add", "source");
  git(
    "-c",
    "user.name=Recorder test",
    "-c",
    "user.email=recorder@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "test release",
  );
  return {
    root,
    git,
    commit: git("rev-parse", "HEAD"),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("requires HEAD and immutable tag identity; a dry run is explicitly nondistributed", () => {
  const repo = checkout();
  try {
    const { root, commit, git } = repo;
    assert.deepEqual(releaseProvenance(`dry-run-${commit}`, commit, root), {
      tag: `dry-run-${commit}`,
      commit,
      distributed: false,
    });
    assert.throws(() => releaseProvenance(`dry-run-${commit}`, "0".repeat(40), root), /HEAD/);
    assert.throws(() => releaseProvenance("dry-run-fake", commit, root), /full HEAD/);
    git("tag", "v0.3.0-canary.1");
    assert.equal(releaseProvenance("v0.3.0-canary.1", commit, root).distributed, true);
    writeFileSync(join(root, "source"), "changed");
    assert.throws(() => releaseProvenance("v0.3.0-canary.1", commit, root), /clean tracked/);
    git("add", "source");
    git(
      "-c",
      "user.name=Recorder test",
      "-c",
      "user.email=recorder@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "next",
    );
    assert.throws(
      () => releaseProvenance("v0.3.0-canary.1", git("rev-parse", "HEAD"), root),
      /tag does not match/,
    );
  } finally {
    repo.close();
  }
});

test("records every prerelease channel selected by the release workflow", () => {
  const repo = checkout();
  try {
    for (const tag of ["v0.3.0-canary.1", "v0.3.0-beta.2", "v0.3.0-rc.1", "v0.3.0-preview"]) {
      repo.git("tag", tag);
      assert.equal(releaseProvenance(tag, repo.commit, repo.root).distributed, true);
    }
    for (const tag of ["v0.3.0", "v0.3.0-", "v0.3.0-beta..1"])
      assert.throws(() => releaseProvenance(tag, repo.commit, repo.root), /prerelease tag/);
  } finally {
    repo.close();
  }
});

test("bundle is self-contained public-only and every actual capture carries release provenance", () => {
  const provenance = { tag: "v0.3.0-canary.1", commit: "1".repeat(40), distributed: true };
  const schema = {
    protocolVersion: 1,
    tiers: {
      public: { "session.projection": { kind: "query", output: { type: "object" } } },
      desktop: { "local.only": {} },
    },
  };
  const captures = Object.fromEntries(
    REQUIRED_RECORDINGS.map((name) => [
      name,
      {
        transport: name.endsWith("ipc") ? "ipc" : "websocket",
        exchanges: [{ procedure: "session.projection", input: {}, output: {} }],
        recording: { observed: true },
      },
    ]),
  );
  const bundle = assembleBundle(provenance, schema, captures);
  assert.deepEqual(Object.keys(bundle.schema.tiers), ["public"]);
  assert.equal(JSON.stringify(bundle).includes("local.only"), false);
  for (const recording of Object.values(bundle.recordings)) {
    assert.equal(recording.provenance.commit, provenance.commit);
    assert.equal(recording.provenance.tag, provenance.tag);
    assert.match(recording.provenance.how, /production/);
  }
  assert.match(bundle.followups[0], /VC-722 PR A was not present/);
  assert.throws(() => assembleBundle(provenance, schema, {}), /did not capture/);
  captures[REQUIRED_RECORDINGS[0]].exchanges[0].procedure = "local.only";
  assert.throws(() => assembleBundle(provenance, schema, captures), /non-public/);
});

test("dry-run recorder exercises real IPC/WS adapters and captures the real queue without overwriting fixtures", () => {
  const directory = mkdtempSync(join(ROOT, ".canary-peer-test-"));
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    const out = join(directory, "canary-peer.json");
    const bundle = recordCanaryPeer({ tag: `dry-run-${commit}`, commit, out });
    assert.equal(bundle.provenance.distributed, false);
    assert.deepEqual(Object.keys(bundle.schema.tiers), ["public"]);
    assert.deepEqual(Object.keys(bundle.recordings).toSorted(), REQUIRED_RECORDINGS.toSorted());
    const queue = bundle.recordings["queue-websocket"].exchanges.find(
      ({ procedure }) => procedure === "session.subscribeQueue",
    );
    assert.equal(queue.frames[0].data.kind, "queue");
    assert.equal(queue.frames[0].data.queue[0].message.parts[0].text, "original");
    // Exercise the consumers with the freshly produced artifact, not just the
    // synthetic unit bundle: both skew directions across all supported doors.
    for (const lane of CAPTURE_LANES) {
      const args = ["test", "run", ...lane.files];
      if (process.env.VOLLI_CONCURRENCY_HINT)
        args.push(`--maxWorkers=${process.env.VOLLI_CONCURRENCY_HINT}`);
      const replay = spawnSync(join(ROOT, "node_modules/.bin/vp"), args, {
        cwd: join(ROOT, lane.cwd),
        stdio: "inherit",
        env: {
          ...process.env,
          VOLLI_CANARY_PEER_BUNDLE: out,
          VOLLI_CANARY_CAPTURE_DIR: "",
          UPDATE_BOARD_WIRE_FIXTURES: "0",
          VOLLI_RECORD_SESSION_LISTING_WIRE: "0",
          VOLLI_RECORD_SIGN_IN_WIRE: "0",
        },
      });
      assert.ifError(replay.error);
      assert.equal(replay.status, 0, `Recorded peer replay failed in ${lane.cwd}`);
    }
    assert.throws(() => recordCanaryPeer({ tag: `dry-run-${commit}`, commit, out }), /overwrite/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
