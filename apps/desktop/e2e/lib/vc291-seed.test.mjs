/**
 * VC-291 seed shape — run with `node --test apps/desktop/e2e/lib/`.
 *
 * The point of these tests is that the seed is checked against REAL SHELL
 * OUTPUT, not against another copy of the same assumption. The first pass at
 * this investigation shipped a seed whose `-END` was eaten as a printf option
 * by every shell, ran the entire matrix on the 33-line wreckage, and reported
 * it as a clean negative result. So: execute the script, and verify what came
 * out of the shell.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  REQUIRED_EXPECTED_KEYS,
  SEED_LINE_COUNT,
  SEED_LONG_FILL,
  copiedRunMatchesReference,
  expectedSeedLines,
  findExpectedLines,
  longLine,
  parseBaselinePointer,
  seedScript,
  shortLine,
  unwrapCopiedText,
  verifySeedReference,
} from "./vc291-seed.mjs";

/** Shells the seed can land on: `sh` runs the script, the rest are the PTY's. */
const SHELLS = ["/bin/sh", "/bin/zsh", "/bin/bash", "/bin/dash"].filter((s) => existsSync(s));

async function runSeed(shell) {
  const dir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "vc291-seed-test-")));
  const pointer = join(dir, "pointer.txt");
  const script = join(dir, "seed.sh");
  const token = "tok1234";
  await fs.writeFile(script, seedScript({ pointerPath: pointer, token }));
  const stdout = execFileSync(shell, [script], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 22 });
  const pointed = parseBaselinePointer(await fs.readFile(pointer, "utf8"), token);
  assert.equal(pointed.ok, true, `pointer unusable: ${pointed.reason}`);
  const reference = await fs.readFile(pointed.path, "utf8");
  return { dir, stdout, reference, referencePath: pointed.path, token };
}

for (const shell of SHELLS) {
  test(`seed produces the intended ${SEED_LINE_COUNT}-line sequence under ${shell}`, async () => {
    const { stdout, reference, dir } = await runSeed(shell);

    const verdict = verifySeedReference(reference);
    assert.deepEqual(verdict.problems, [], `seed malformed under ${shell}`);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.lineCount, SEED_LINE_COUNT);
    assert.equal(verdict.shortsSeen, 30);
    assert.equal(verdict.longsSeen, 30);
    assert.equal(verdict.pwd, dir);

    // The terminal sees the same bytes the reference file does (tee), plus the
    // trailing REFLOW-BASELINE= line the harness reads the path from.
    assert.ok(stdout.startsWith(reference), "terminal output and reference file disagree");
    assert.match(
      stdout.slice(reference.length),
      /^REFLOW-BASELINE=\/tmp\/volli-reflow-tok1234-\d+\.txt\n$/,
    );

    // The regression that started all this: no shell may treat `-END` as an option.
    assert.doesNotMatch(stdout, /invalid option|printf:/);
  });

  test(`every long line has exactly ${SEED_LONG_FILL} x's and its own -END under ${shell}`, async () => {
    const { reference } = await runSeed(shell);
    const lines = reference.trimEnd().split("\n");
    const longs = lines.filter((l) => l.startsWith("REFLOW-LONG-"));
    assert.equal(longs.length, 30);
    for (const [i, line] of longs.entries()) {
      assert.equal(line, longLine(i + 1));
      assert.equal(/^REFLOW-LONG-\d\d-(x*)-END$/.exec(line)[1].length, SEED_LONG_FILL);
    }
    // And every SHORT line stands alone rather than riding a long line's tail.
    for (let n = 1; n <= 30; n += 1)
      assert.ok(lines.includes(shortLine(n)), `${shortLine(n)} not standalone`);
  });
}

test("expectedSeedLines interleaves SHORT and LONG and is the same length as the seed", () => {
  const lines = expectedSeedLines("/tmp/x");
  assert.equal(lines.length, SEED_LINE_COUNT);
  assert.deepEqual(lines.slice(0, 5), [
    "REFLOW-BEGIN",
    shortLine(1),
    longLine(1),
    shortLine(2),
    longLine(2),
  ]);
  assert.deepEqual(lines.slice(-4), [
    shortLine(30),
    longLine(30),
    "REFLOW-PWD-/tmp/x",
    "REFLOW-END",
  ]);
});

test("verifySeedReference rejects the malformed seed this investigation shipped first", () => {
  // Reproduce the exact damage: `printf '-END\n'` fails, so no newline is
  // emitted and the next SHORT line is welded onto the long line's tail.
  const fill = "x".repeat(SEED_LONG_FILL);
  const broken = [
    "REFLOW-BEGIN",
    shortLine(1),
    ...Array.from(
      { length: 29 },
      (_, i) => `REFLOW-LONG-${String(i + 1).padStart(2, "0")}-${fill}${shortLine(i + 2)}`,
    ),
    `REFLOW-LONG-30-${fill}REFLOW-PWD-/tmp/wd`,
    "REFLOW-END",
  ].join("\n");

  const verdict = verifySeedReference(broken);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.lineCount, 33);
  assert.equal(verdict.shortsSeen, 1);
  assert.equal(verdict.longsSeen, 0);
  assert.ok(verdict.problems.some((p) => p.includes("expected 63 lines, got 33")));
  assert.ok(verdict.problems.some((p) => p.includes("MISSING -END tail")));
});

test("verifySeedReference rejects a blank, a truncated and a printf-error reference", () => {
  assert.equal(verifySeedReference("").ok, false);
  assert.equal(verifySeedReference("REFLOW-BEGIN\nREFLOW-SHORT-01\n").ok, false);
  const withError = `${expectedSeedLines("/tmp/x").join("\n")}\nsh: line 9: printf: -E: invalid option\n`;
  const verdict = verifySeedReference(withError);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => p.includes("printf error")));
});

test("verifySeedReference accepts a well-formed reference with or without a trailing newline", () => {
  const good = expectedSeedLines("/tmp/work").join("\n");
  assert.equal(verifySeedReference(`${good}\n`).ok, true);
  assert.equal(verifySeedReference(good).ok, true);
  assert.equal(verifySeedReference(`${good}\n`).pwd, "/tmp/work");
});

test("parseBaselinePointer refuses another run's pointer", () => {
  assert.deepEqual(parseBaselinePointer("run7=/tmp/volli-reflow-run7-1.txt", "run7"), {
    ok: true,
    path: "/tmp/volli-reflow-run7-1.txt",
  });
  assert.equal(parseBaselinePointer("run6=/tmp/volli-reflow-run6-1.txt", "run7").ok, false);
  assert.equal(parseBaselinePointer("", "run7").ok, false);
  assert.equal(parseBaselinePointer("run7=", "run7").ok, false);
});

test("findExpectedLines needs LONG-15 and its own -END adjacent, not two loose substrings", () => {
  const fill = "x".repeat(SEED_LONG_FILL);

  const whole = findExpectedLines(`REFLOW-LONG-15-${fill}-END`);
  assert.equal(whole.found.long15, true);
  assert.equal(whole.detail.long15.fill, SEED_LONG_FILL);

  // The old check spelled this marker `-END` and let REFLOW-END satisfy it.
  const decoy = findExpectedLines(`REFLOW-LONG-15-${fill}\nREFLOW-END`);
  assert.equal(
    decoy.found.long15,
    false,
    "a separate REFLOW-END must not stand in for the long line's tail",
  );
  assert.equal(decoy.found.end, true);

  // OCR wraps the line across rows; whitespace between rows is not a break.
  const wrapped = findExpectedLines(`REFLOW-LONG-15-${fill.slice(0, 80)}\n${fill.slice(80)}-END`);
  assert.equal(wrapped.found.long15, true);

  // A short fill run is a damaged line, not a found one.
  assert.equal(findExpectedLines(`REFLOW-LONG-15-xxxx-END`).found.long15, false);
});

test("findExpectedLines accepts the one-glyph tail OCR drops, and says so", () => {
  const fill = "x".repeat(SEED_LONG_FILL);

  // At 86 columns the 259-character line is 86+86+86+1: the final `D` sits
  // alone on a row and Vision skips one-glyph rows, so `-END` reads as `-EN`.
  const clipped = findExpectedLines(`REFLOW-LONG-15-${fill}-EN`);
  assert.equal(clipped.found.long15, true);
  assert.equal(clipped.detail.long15.tailSeen, "-EN");
  assert.equal(clipped.detail.long15.tailTruncatedByOcr, true);

  // A complete read is not flagged.
  const whole = findExpectedLines(`REFLOW-LONG-15-${fill}-END`);
  assert.equal(whole.detail.long15.tailTruncatedByOcr, false);
  assert.equal(whole.detail.long15.tailSeen, "-END");

  // Two characters short is a damaged line, not a wrap artefact — and the
  // relaxation must never reach far enough to match a bare `-`.
  assert.equal(findExpectedLines(`REFLOW-LONG-15-${fill}-E`).found.long15, false);
  assert.equal(findExpectedLines(`REFLOW-LONG-15-${fill}`).found.long15, false);

  // Adjacency still holds: a REFLOW-END elsewhere cannot supply the tail.
  assert.equal(
    findExpectedLines(`REFLOW-LONG-15-${fill}\nsomething\nREFLOW-END`).found.long15,
    false,
  );
});

test("findExpectedLines reports every required key, and a blank OCR finds none", () => {
  const blank = findExpectedLines("");
  assert.deepEqual(Object.keys(blank.found).toSorted(), REQUIRED_EXPECTED_KEYS.toSorted());
  assert.deepEqual(
    Object.values(blank.found).filter(Boolean),
    [],
    "an empty OCR result must not report a single expected line",
  );

  const full = findExpectedLines(expectedSeedLines("/tmp/wd").join("\n"));
  assert.deepEqual(
    Object.entries(full.found).filter(([, v]) => !v),
    [],
  );
});

test("unwrapCopiedText rejoins a line the grid wrapped, and keeps real line endings", () => {
  const cols = 86;
  const long = longLine(1); // 259 chars → 86 + 86 + 87 across three rows
  const wrapped = [
    shortLine(1),
    long.slice(0, 86),
    long.slice(86, 172),
    long.slice(172),
    shortLine(2),
  ].join("\n");

  assert.deepEqual(unwrapCopiedText(wrapped, cols), [shortLine(1), long, shortLine(2)]);
  // A short line is never a wrap, whatever the column count.
  assert.deepEqual(unwrapCopiedText(`${shortLine(1)}\n${shortLine(2)}`, cols), [
    shortLine(1),
    shortLine(2),
  ]);
  assert.deepEqual(unwrapCopiedText("", cols), []);
  // A row that is exactly `cols` wide and ends the copy still yields its text.
  assert.deepEqual(unwrapCopiedText("y".repeat(86), cols), ["y".repeat(86)]);
});

test("copiedRunMatchesReference demands an exact contiguous run, not a substring", () => {
  const reference = expectedSeedLines("/tmp/wd");

  const good = copiedRunMatchesReference([shortLine(1), longLine(1), shortLine(2)], reference);
  assert.equal(good.ok, true);
  assert.equal(good.startsAtReferenceLine, 2);

  // The malformed seed's shape: SHORT-02 welded onto the long line's tail.
  const welded = [shortLine(1), `REFLOW-LONG-01-${"x".repeat(SEED_LONG_FILL)}${shortLine(2)}`];
  assert.equal(copiedRunMatchesReference(welded, reference).ok, false);

  // A long line missing its -END tail is not the reference's line.
  const noTail = [shortLine(1), `REFLOW-LONG-01-${"x".repeat(SEED_LONG_FILL)}`];
  assert.equal(copiedRunMatchesReference(noTail, reference).ok, false);

  // Out-of-order or skipped lines are not a contiguous run.
  assert.equal(copiedRunMatchesReference([shortLine(1), shortLine(3)], reference).ok, false);
  assert.equal(copiedRunMatchesReference([], reference).ok, false);
  assert.equal(copiedRunMatchesReference(["not in the seed at all"], reference).ok, false);
});

test("seedScript refuses a token that could escape into the shell", () => {
  assert.throws(() => seedScript({ pointerPath: "/tmp/p", token: "a;rm -rf /" }), /token must be/);
  assert.throws(() => seedScript({ pointerPath: "", token: "ok" }), /pointerPath is required/);
});
