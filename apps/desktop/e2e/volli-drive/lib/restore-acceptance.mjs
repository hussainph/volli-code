import assert from "node:assert/strict";

/** A restore restart is a real click, not an alternate command door. */
export function assertRestoreRestart(spec, current, args, label = "Restart and restore") {
  assert.ok(
    !spec.cloud && !spec.deployment && !spec.remoteAcceptance,
    "restore-restart requires an isolated local fixture",
  );
  assert.equal(Number(args.gen), current.generation, "stale generation: take a fresh snapshot");
  assert.ok(
    args.ref && current.refs.has(args.ref),
    "restore restart ref was not in the current snapshot",
  );
  assert.equal(
    label.trim(),
    "Restart and restore",
    "the target is not the product's restore restart button",
  );
}
