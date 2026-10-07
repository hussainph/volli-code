#!/usr/bin/env node
/** Capture at the checked-out release commit. No Electron process or provider access. */
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const CAPTURE_LANES = [
  {
    cwd: "apps/desktop",
    files: [
      "src/main/session-rpc-wire-compatibility.test.ts",
      "src/main/sign-ins-wire-compatibility.test.ts",
      "src/main/session-listing-wire-compatibility.test.ts",
    ],
  },
  {
    cwd: "packages/session-rpc",
    files: ["src/board-wire-compatibility.test.ts", "src/queue-websocket.test.ts"],
  },
];
export const REQUIRED_RECORDINGS = [
  "session-ipc",
  "session-websocket",
  "board-ipc",
  "board-websocket",
  "sign-ins-websocket",
  "listing-websocket",
  "queue-ipc",
  "queue-websocket",
];
const git = (args, root) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

export function releaseProvenance(tag, commit, root = ROOT) {
  if (!tag || !/^[a-f0-9]{40}$/.test(commit ?? ""))
    throw new Error("--tag and a full --commit SHA are required");
  if (git(["rev-parse", "HEAD"], root) !== commit)
    throw new Error("Recorder commit does not match checkout HEAD");
  const distributed = !tag.startsWith("dry-run-");
  if (!distributed && tag !== `dry-run-${commit}`)
    throw new Error("Dry-run tag must be dry-run-<full HEAD sha>");
  if (distributed) {
    if (!/^v\d+\.\d+\.\d+-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(tag))
      throw new Error("Expected a prerelease tag");
    if (git(["rev-parse", `${tag}^{commit}`], root) !== commit)
      throw new Error("Release tag does not match recorder commit");
    if (git(["status", "--porcelain", "--untracked-files=no"], root))
      throw new Error("Release capture requires a clean tracked checkout");
  }
  return { tag, commit, distributed };
}

export function assembleBundle(provenance, schema, captures) {
  if (!schema.tiers?.public) throw new Error("Committed public protocol schema is missing");
  const recordings = {};
  for (const name of REQUIRED_RECORDINGS) {
    const capture = captures[name];
    if (!capture?.exchanges?.length) throw new Error(`Adapter did not capture ${name}`);
    for (const exchange of capture.exchanges)
      if (!schema.tiers.public[exchange.procedure])
        throw new Error(`Captured non-public procedure ${exchange.procedure}`);
    recordings[name] = {
      ...capture,
      provenance: {
        ...provenance,
        how: `${name}: deterministic test harness through production ${capture.transport === "ipc" ? "IPC server/link (structured clone)" : "WebSocket listener/client (JSON)"}; see CAPTURE_LANES in scripts/record-canary-peer.mjs; application payloads, transport-local ids omitted`,
      },
    };
  }
  return {
    format: "volli-canary-peer-v1",
    provenance,
    schema: { ...schema, tiers: { public: schema.tiers.public } },
    recordings,
    followups: schema.tiers.public["protocol.hostWelcome"]
      ? (() => {
          throw new Error(
            "VC-722 A is present: implement host-scope capture before recording this release",
          );
        })()
      : [
          "VC-722 PR A was not present: record protocol.hostWelcome, workspaces.list and workspaces.create after A merges.",
        ],
  };
}

export function recordCanaryPeer({ tag, commit, out, root = ROOT }) {
  const provenance = releaseProvenance(tag, commit, root);
  if (!out) throw new Error("--out is required");
  const output = resolve(root, out);
  if (existsSync(output)) throw new Error("Refusing to overwrite an immutable peer bundle");
  // Deliberately read the committed artifact, not a schema generated after the release.
  const schema = JSON.parse(git(["show", `${commit}:docs/protocol/protocol.schema.json`], root));
  const staging = mkdtempSync(join(root, ".canary-peer-capture-"));
  try {
    for (const lane of CAPTURE_LANES) {
      const args = ["test", "run", ...lane.files];
      if (process.env.VOLLI_CONCURRENCY_HINT)
        args.push(`--maxWorkers=${process.env.VOLLI_CONCURRENCY_HINT}`);
      const run = spawnSync(join(root, "node_modules/.bin/vp"), args, {
        cwd: join(root, lane.cwd),
        stdio: "inherit",
        env: {
          ...process.env,
          VOLLI_CANARY_CAPTURE_DIR: staging,
          VOLLI_CANARY_PEER_BUNDLE: "",
          UPDATE_BOARD_WIRE_FIXTURES: "0",
          VOLLI_RECORD_SESSION_LISTING_WIRE: "0",
          VOLLI_RECORD_SIGN_IN_WIRE: "0",
        },
      });
      if (run.error) throw run.error;
      if (run.status !== 0)
        throw new Error(`Canary capture lane ${lane.cwd} failed (${run.status})`);
    }
    const captures = Object.fromEntries(
      readdirSync(staging)
        .filter((name) => name.endsWith(".json"))
        .map((name) => [name.slice(0, -5), JSON.parse(readFileSync(join(staging, name), "utf8"))]),
    );
    const bundle = assembleBundle(provenance, schema, captures);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(bundle, null, 2)}\n`, { flag: "wx" });
    console.log(
      `Recorded ${provenance.distributed ? "distributed" : "NONDISTRIBUTED dry-run"} canary peer: ${output}`,
    );
    return bundle;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--tag", "--commit", "--out"].includes(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw new Error(
        "Usage: node scripts/record-canary-peer.mjs --tag <tag> --commit <HEAD sha> --out <path>",
      );
    options[args[i].slice(2)] = args[i + 1];
  }
  recordCanaryPeer(options);
}
