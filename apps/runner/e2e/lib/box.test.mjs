import assert from "node:assert/strict";
import { test } from "node:test";

import { BOX_IMAGE, boxRunArgs, systemBooted } from "./box.mjs";

test("the box boots systemd privileged, in its own cgroup namespace, on the host network", () => {
  const args = boxRunArgs({ name: "byo-box-x", hostname: "hetzner-1" });
  assert.deepEqual(args.slice(0, 2), ["run", "--detach"]);
  assert.equal(args.at(-1), BOX_IMAGE);
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value("--name"), "byo-box-x");
  assert.equal(value("--hostname"), "hetzner-1");
  assert.equal(value("--network"), "host");
  assert.ok(args.includes("--privileged"));
  assert.ok(args.includes("--cgroupns=private"));
  for (const mount of ["/run", "/run/lock", "/tmp:exec"]) assert.ok(args.includes(mount), mount);
  // No volume from the checkout: the box gets only what the lane hands it.
  assert.equal(args.includes("--volume") || args.includes("-v"), false);
});

test("a booted box is running or degraded, never starting or offline", () => {
  assert.equal(systemBooted("running"), true);
  assert.equal(systemBooted("degraded"), true);
  for (const state of ["starting", "initializing", "offline", "maintenance", ""]) {
    assert.equal(systemBooted(state), false, state);
  }
});
