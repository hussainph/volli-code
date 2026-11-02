import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { BROKEN_PRELUDE, breakRunner, replaceVersionLiteral, restampArchive } from "./restamp.mjs";

const scratch = mkdtempSync(join(tmpdir(), "byo-restamp-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A miniature C4 archive: the layout `package.mjs` writes, minus Node. */
function fakeArchive(version, arch = "x64") {
  const root = `volli-runner-${version}-linux-${arch}`;
  const stage = join(scratch, `stage-${version}-${arch}`);
  mkdirSync(join(stage, root, "lib", "runner"), { recursive: true });
  mkdirSync(join(stage, root, "bin"), { recursive: true });
  writeFileSync(
    join(stage, root, "MANIFEST.json"),
    JSON.stringify({ name: "volli-runner", version, target: `linux-${arch}` }),
  );
  writeFileSync(
    join(stage, root, "lib", "runner", "runner.cjs"),
    `#!/usr/bin/env node\n"use strict";\nconst RUNNER_VERSION = "${version}";\nconst other = "${version}-not-it";\n`,
  );
  writeFileSync(join(stage, root, "lib", "probe-natives.cjs"), "untouched");
  const archive = join(scratch, `${root}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", stage, root]);
  return archive;
}

function unpack(archive) {
  const dir = mkdtempSync(join(scratch, "unpack-"));
  execFileSync("tar", ["-xzf", archive, "-C", dir]);
  return dir;
}

test("a version literal is replaced exactly, never inside a longer string", () => {
  const { text, count } = replaceVersionLiteral(
    'a("1.0.0"); b("1.0.0-rc"); c("1.0.0")',
    "1.0.0",
    "1.0.1",
  );
  assert.equal(count, 2);
  assert.equal(text, 'a("1.0.1"); b("1.0.0-rc"); c("1.0.1")');
});

test("a broken runner refuses `run` after its shebang and directive", () => {
  const broken = breakRunner('#!/usr/bin/env node\n"use strict";\nmain();\n');
  assert.equal(broken, `#!/usr/bin/env node\n"use strict";\n${BROKEN_PRELUDE}main();\n`);
  assert.equal(breakRunner("main();"), `${BROKEN_PRELUDE.trimEnd()}\nmain();`);
});

test("a re-stamp renames the root, the manifest and the baked version, and nothing else", () => {
  const out = mkdtempSync(join(scratch, "out-"));
  const made = restampArchive({
    archive: fakeArchive("0.3.0"),
    from: "0.3.0",
    to: "0.3.1-e2e.1",
    arch: "x64",
    outDir: out,
  });
  assert.equal(made.path, join(out, "volli-runner-0.3.1-e2e.1-linux-x64.tar.gz"));
  assert.equal(made.baked, 1);
  assert.equal(
    readFileSync(`${made.path}.sha256`, "utf8"),
    `${made.sha256}  volli-runner-0.3.1-e2e.1-linux-x64.tar.gz\n`,
  );
  const root = join(unpack(made.path), "volli-runner-0.3.1-e2e.1-linux-x64");
  const manifest = JSON.parse(readFileSync(join(root, "MANIFEST.json"), "utf8"));
  assert.deepEqual([manifest.version, manifest.restampedFrom], ["0.3.1-e2e.1", "0.3.0"]);
  const bundle = readFileSync(join(root, "lib", "runner", "runner.cjs"), "utf8");
  assert.match(bundle, /RUNNER_VERSION = "0\.3\.1-e2e\.1"/u);
  assert.match(bundle, /"0\.3\.0-not-it"/u);
  assert.doesNotMatch(bundle, /broken on purpose/u);
  assert.equal(readFileSync(join(root, "lib", "probe-natives.cjs"), "utf8"), "untouched");
});

test("a broken re-stamp still stages but its runner refuses to run", () => {
  const out = mkdtempSync(join(scratch, "out-"));
  const made = restampArchive({
    archive: fakeArchive("0.3.0", "arm64"),
    from: "0.3.0",
    to: "0.3.1-e2e.2",
    arch: "arm64",
    outDir: out,
    broken: true,
  });
  const root = join(unpack(made.path), "volli-runner-0.3.1-e2e.2-linux-arm64");
  assert.match(
    readFileSync(join(root, "lib", "runner", "runner.cjs"), "utf8"),
    /broken on purpose/u,
  );
});

test("a manifest of another version, or a bundle with no baked version, is refused", () => {
  const out = mkdtempSync(join(scratch, "out-"));
  // The root says 0.4.0 but the packager's manifest says otherwise.
  const archive = fakeArchive("0.4.0");
  const stage = unpack(archive);
  const root = join(stage, "volli-runner-0.4.0-linux-x64");
  writeFileSync(join(root, "MANIFEST.json"), JSON.stringify({ version: "0.3.9" }));
  const lying = join(scratch, "lying.tar.gz");
  execFileSync("tar", ["-czf", lying, "-C", stage, "volli-runner-0.4.0-linux-x64"]);
  assert.throws(
    () => restampArchive({ archive: lying, from: "0.4.0", to: "0.4.1", arch: "x64", outDir: out }),
    /is 0\.3\.9, not 0\.4\.0/u,
  );
  writeFileSync(join(root, "MANIFEST.json"), JSON.stringify({ version: "0.4.0" }));
  writeFileSync(join(root, "lib", "runner", "runner.cjs"), "no version here\n");
  const unbaked = join(scratch, "unbaked.tar.gz");
  execFileSync("tar", ["-czf", unbaked, "-C", stage, "volli-runner-0.4.0-linux-x64"]);
  assert.throws(
    () =>
      restampArchive({ archive: unbaked, from: "0.4.0", to: "0.4.1", arch: "x64", outDir: out }),
    /no baked "0\.4\.0"/u,
  );
});
