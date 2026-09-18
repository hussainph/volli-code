#!/usr/bin/env node
/**
 * Holds the two macOS facts the shipped LGPL relink instructions depend on.
 *
 *     node apps/desktop/scripts/check-library-validation.mjs             # the gate
 *     node apps/desktop/scripts/check-library-validation.mjs --self-test # its matchers' tests
 *
 * WHY THIS EXISTS (VC-409). `apps/desktop/licensing/RELINK-LIBVIPS.md` is the
 * Installation Information LGPLv3 section 4(e) asks for. It ships inside the
 * app and tells a user how to run their own build of libvips, and it rests on
 * exactly two claims about how macOS behaves:
 *
 *   1. Under the hardened runtime WITHOUT
 *      `com.apple.security.cs.disable-library-validation`, a library whose
 *      code signature carries a different Team ID than the running process
 *      cannot load. This is why a user's own libvips does not work in the
 *      build we sign, and therefore why we owe them instructions at all.
 *   2. Re-signing the app WITH that entitlement lets the same library load.
 *      This is what the instructions actually tell the user to do.
 *
 * Both are properties of the operating system, not of this repository — which
 * is precisely why they need a test. If Apple tightens (1) or changes (2), the
 * document we ship inside the application becomes false instructions for
 * discharging a license obligation, and nothing else in this tree would
 * notice. This gate compiles a two-file probe, signs it both ways, and asserts
 * each claim still holds.
 *
 * It does NOT test the packaged app: that needs a signed 330 MB bundle and a
 * full build. The probe reproduces the same kernel refusal verbatim ("mapping
 * process and mapped file (non-platform) have different Team IDs"), which is
 * the mechanism the instructions are about. The end-to-end run against a real
 * signed Volli Code.app is recorded in docs/licensing/dependency-license-review.md.
 *
 * Like the Mach-O assertion in check-dependency-licenses.mjs, this is macOS
 * only and PRINTS that it did not run elsewhere, rather than passing quietly.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** dlopen a path named on the command line and say which way it went. */
const HOST_SOURCE = `#include <dlfcn.h>
#include <stdio.h>
int main(int argc, char **argv) {
  void *handle = dlopen(argv[1], RTLD_NOW);
  if (!handle) { printf("BLOCKED %s\\n", dlerror()); return 1; }
  printf("LOADED\\n");
  return 0;
}
`;

const LIBRARY_SOURCE = `int volli_library_validation_probe(void) { return 42; }\n`;

const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>com.apple.security.cs.disable-library-validation</key>
\t<true/>
</dict>
</plist>
`;

// ---------------------------------------------------------------------------
// Pure matchers
// ---------------------------------------------------------------------------

/**
 * Classifies what the probe printed.
 *
 * The distinction that matters is between "blocked BY LIBRARY VALIDATION" and
 * "blocked for some other reason" — a missing file or a bad architecture would
 * also fail to load, and reading that as proof of library validation would
 * turn this gate into one that passes on a broken probe.
 * @param {string} output
 * @returns {"loaded" | "library-validation" | "other-failure"}
 */
export function classifyLoadResult(output) {
  if (/^LOADED$/m.test(output.trim())) return "loaded";
  if (/different Team IDs/.test(output)) return "library-validation";
  return "other-failure";
}

/**
 * The code-signing flags codesign reports, e.g. `adhoc,runtime`.
 *
 * `codesign -dv` writes to stderr and prints `flags=0x10002(adhoc,runtime)`.
 * Returns null when no flags line is present, which is itself a finding: it
 * means the binary is not signed the way this probe requires.
 * @param {string} output
 */
export function parseCodesignFlags(output) {
  const match = /\bflags=0x[\da-f]+\(([^)]*)\)/i.exec(output);
  return match === null ? null : match[1];
}

/**
 * Turns one probe run into problems, notes and a summary line.
 *
 * WHY THIS IS NOT "BLOCKED, THEREFORE PASS" ANY MORE. The first version
 * asserted that a hardened-runtime host refuses a differently-signed library,
 * and it went red on the macOS 15 CI runner while passing on macOS 26. The
 * probe was not modelling the shipped situation on either.
 *
 * The packaged app is signed with an Apple Developer ID, so it HAS a Team ID,
 * and library validation compares that against the library's. This probe signs
 * ad hoc, and an ad-hoc signature has no Team ID at all. macOS 26 treats
 * absent-vs-absent as a mismatch and refuses; macOS 15 does not. Neither
 * answers what the shipped Developer ID build does — and the probe CANNOT
 * answer it, because creating a Team ID needs an Apple-issued certificate that
 * no CI runner has and that a gate must not reach into a keychain for.
 *
 * So the assertion that survives on every version is the one the shipped
 * instructions actually promise: WITH the entitlement, a differently-signed
 * library loads. A refusal without it is recorded as confirmation where the OS
 * happens to give it, and its absence is reported as "not modelled here"
 * rather than as "macOS stopped enforcing this", which is a claim this probe
 * has never been in a position to make.
 * @param {{ hardened: { result: string, flags: string | null }, withEntitlement: { result: string, flags: string | null } }} observation
 */
export function judgeProbe(observation) {
  const problems = [];
  const notes = [];

  // A probe whose host was not signed as asked proves nothing in either
  // direction, so it fails rather than being read as evidence.
  for (const [phase, outcome] of Object.entries(observation)) {
    const flags = outcome.flags ?? "";
    if (!flags.includes("runtime") || !flags.includes("adhoc")) {
      problems.push(
        `the ${phase} probe host was signed as "${outcome.flags ?? "(no flags reported)"}", not ` +
          `as an ad-hoc hardened-runtime binary. The probe did not test what it claims to test, ` +
          `so neither its success nor its failure is evidence about library validation.`,
      );
    }
  }

  if (observation.withEntitlement.result !== "loaded") {
    problems.push(
      "with com.apple.security.cs.disable-library-validation, a differently-signed library still " +
        `did not load (${observation.withEntitlement.result}). That entitlement is exactly what ` +
        "licensing/relink-libvips.sh adds when it re-signs a user's copy, so the shipped " +
        "Installation Information no longer works and LGPLv3 4(e) is no longer discharged by it.",
    );
  }

  if (observation.hardened.result === "other-failure") {
    problems.push(
      "the hardened-runtime probe failed to load the library for a reason unrelated to library " +
        "validation. The probe itself is broken, and a broken probe must not be read as evidence.",
    );
  }

  const blockObserved = observation.hardened.result === "library-validation";
  if (!blockObserved && observation.hardened.result === "loaded") {
    notes.push(
      "this macOS admits a library whose ad-hoc signature differs from the host's, so the " +
        "Team ID mismatch the PACKAGED app produces was not modelled here. The packaged app is " +
        "signed with a Developer ID and therefore has a Team ID; an ad-hoc probe has none, and a " +
        "Team ID cannot be manufactured without an Apple-issued certificate. The refusal is " +
        "recorded against a real signed build in docs/licensing/dependency-license-review.md.",
    );
  }

  return {
    problems,
    notes,
    summary: blockObserved
      ? "hardened runtime blocks a differently-signed library, and disable-library-validation " +
        "admits it — both halves the shipped relink instructions rest on still hold"
      : "disable-library-validation admits a differently-signed library, which is what the " +
        "shipped relink instructions promise; this OS did not reproduce the refusal (see note)",
  };
}

/**
 * Whether a tool is usable, from a `spawnSync` result. Split out so the gate's
 * decision to note-and-skip is testable without a machine lacking Xcode.
 *
 * The probe is `which`, deliberately. Asking each tool to identify itself is
 * the obvious alternative and it is wrong: `codesign --version` is not a
 * supported invocation and exits non-zero on a perfectly working install, so
 * this gate skipped itself on a machine that could have run it — the precise
 * failure it is meant to catch elsewhere.
 * @param {{ error?: unknown, status: number | null }} result
 */
export function toolIsUsable(result) {
  return result.error === undefined && result.status === 0;
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/**
 * Builds the probe, signs it the two ways, and returns how each load went.
 *
 * EACH PHASE GETS ITS OWN FRESHLY COMPILED HOST, in its own directory, and
 * that is load-bearing rather than tidiness. The first draft re-signed one
 * host binary in place and ran it again; macOS serves a cached code signature
 * for a path it has already executed, so the second run did not necessarily
 * reflect the signature just written. Mutation-testing caught it: replacing
 * the entitlement under test with an irrelevant one left the gate GREEN. A
 * separate path per phase is what makes the two runs independent.
 * @param {string} workspace
 */
function runProbe(workspace) {
  const libraryPath = join(workspace, "libprobe.dylib");
  const entitlementsPath = join(workspace, "entitlements.plist");
  const hostSourcePath = join(workspace, "host.c");

  writeFileSync(hostSourcePath, HOST_SOURCE);
  writeFileSync(join(workspace, "lib.c"), LIBRARY_SOURCE);
  writeFileSync(entitlementsPath, ENTITLEMENTS);

  // stderr is captured rather than inherited: codesign narrates every
  // "replacing existing signature" to it, and three lines of that in a passing
  // CI log trains a reader to scroll past this gate's output.
  /** @type {{ stdio: ["ignore", "pipe", "pipe"] }} */
  const quiet = { stdio: ["ignore", "pipe", "pipe"] };

  execFileSync("clang", ["-dynamiclib", "-o", libraryPath, join(workspace, "lib.c")], quiet);

  // Ad-hoc on both sides. An ad-hoc signature carries no Team ID, which is the
  // situation a user's own build of libvips is in: they have no Developer ID
  // matching ours, and cannot get one.
  execFileSync("codesign", ["--force", "--sign", "-", libraryPath], quiet);

  /**
   * One phase: a brand-new host binary at a path nothing has executed before,
   * signed with the given options, asked to load the same library.
   * @param {string} phase
   * @param {string[]} signOptions
   */
  const loadUnder = (phase, signOptions) => {
    const phaseDirectory = join(workspace, phase);
    mkdirSync(phaseDirectory);
    const hostPath = join(phaseDirectory, "host");
    execFileSync("clang", ["-o", hostPath, hostSourcePath], quiet);
    execFileSync("codesign", ["--force", "--sign", "-", ...signOptions, hostPath], quiet);
    // What the host was ACTUALLY signed as, read back rather than assumed. A
    // load that succeeds because the hardening never got applied looks exactly
    // like a load that succeeds because the OS stopped enforcing it, and the
    // difference decides whether a compliance document is wrong.
    const described = spawnSync("codesign", ["-dv", hostPath], { encoding: "utf8" });
    const { stdout } = spawnSync(hostPath, [libraryPath], { encoding: "utf8", timeout: 30_000 });
    return {
      result: classifyLoadResult(stdout ?? ""),
      flags: parseCodesignFlags(`${described.stdout ?? ""}${described.stderr ?? ""}`),
    };
  };

  return {
    hardened: loadUnder("hardened", ["--options", "runtime"]),
    withEntitlement: loadUnder("entitled", [
      "--options",
      "runtime",
      "--entitlements",
      entitlementsPath,
    ]),
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function gate() {
  if (process.platform !== "darwin") {
    console.log(
      "check-library-validation: note — library validation is a macOS mechanism and this is " +
        `${process.platform}, so the two claims RELINK-LIBVIPS.md rests on were NOT checked. ` +
        "They are checked on the macOS CI lane, where the app is built.",
    );
    return;
  }

  for (const tool of ["clang", "codesign"]) {
    if (!toolIsUsable(spawnSync("which", [tool], { encoding: "utf8" }))) {
      console.log(
        `check-library-validation: note — ${tool} is not available, so the two claims ` +
          "RELINK-LIBVIPS.md rests on were NOT checked. Install the Xcode command line tools " +
          "(xcode-select --install) to run this locally; CI runs it on macOS.",
      );
      return;
    }
  }

  const workspace = mkdtempSync(join(tmpdir(), "volli-library-validation-"));
  let observation;
  try {
    observation = runProbe(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  const { problems, notes, summary } = judgeProbe(observation);
  for (const note of notes) console.log(`  note: ${note}`);

  if (problems.length > 0) {
    console.error("\nmacOS no longer behaves the way the shipped relink instructions say:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "\nThe instructions are apps/desktop/licensing/RELINK-LIBVIPS.md; the reasoning and the " +
        "end-to-end evidence are in docs/licensing/dependency-license-review.md.",
    );
    process.exit(1);
  }

  console.log(`check-library-validation (macOS ${release()}): ${summary}.`);
}

function selfTest() {
  const failures = [];
  /** @param {string} what @param {boolean} ok */
  const expect = (what, ok) => {
    if (!ok) failures.push(what);
  };

  expect("reads a successful load", classifyLoadResult("LOADED\n") === "loaded");
  expect(
    "reads the library-validation refusal",
    classifyLoadResult(
      "BLOCKED dlopen(/x/libprobe.dylib, 0x0002): tried: '/x/libprobe.dylib' (code signature " +
        "in <UUID> '/x/libprobe.dylib' not valid for use in process: mapping process and " +
        "mapped file (non-platform) have different Team IDs)",
    ) === "library-validation",
  );
  expect(
    "does not read an unrelated failure as library validation",
    classifyLoadResult("BLOCKED dlopen(/x/libprobe.dylib, 0x0002): tried: (no such file)") ===
      "other-failure",
  );
  expect(
    "does not read a missing-symbol failure as library validation",
    classifyLoadResult("BLOCKED dlopen(...): Symbol not found: _foo") === "other-failure",
  );
  // "LOADED" has to be the whole line: a loader error that quotes the word must
  // not be read as success.
  expect(
    "does not read the word LOADED inside an error as success",
    classifyLoadResult("BLOCKED dlopen: library NOT LOADED, bad image") !== "loaded",
  );
  // --- codesign flag parsing ---
  expect(
    "reads the flags codesign reports",
    parseCodesignFlags("CodeDirectory v=20500 size=434 flags=0x10002(adhoc,runtime) hashes=3+7") ===
      "adhoc,runtime",
  );
  expect(
    "reads a runtime-only binary",
    parseCodesignFlags("CodeDirectory v=20500 flags=0x10000(runtime) hashes=3+7") === "runtime",
  );
  expect("reports no flags line as null", parseCodesignFlags("Signature=adhoc") === null);

  // --- the judgement, including the case that took CI red ---
  const ok = { result: "loaded", flags: "adhoc,runtime" };
  const blocked = { result: "library-validation", flags: "adhoc,runtime" };

  const confirmed = judgeProbe({ hardened: blocked, withEntitlement: ok });
  expect("a refusal plus an admission is clean", confirmed.problems.length === 0);
  expect("and says both halves hold", confirmed.summary.includes("both halves"));
  expect("and needs no note", confirmed.notes.length === 0);

  // macOS 15 loaded here where macOS 26 refuses. Two ad-hoc signatures are not
  // the Team ID mismatch the packaged app produces, so this is NOT evidence
  // that macOS stopped enforcing library validation, and must not fail.
  const notModelled = judgeProbe({ hardened: ok, withEntitlement: ok });
  expect(
    "an OS that admits two ad-hoc signatures does not fail the gate",
    notModelled.problems.length === 0,
  );
  expect(
    "but it says the shipped Team ID case was not modelled",
    notModelled.notes.some((note) => note.includes("not modelled here")),
  );
  expect("and does not claim both halves held", !notModelled.summary.includes("both halves"));

  // The load-bearing assertion, on every version: the entitlement must work.
  expect(
    "the entitlement failing to admit the library is always a failure",
    judgeProbe({ hardened: blocked, withEntitlement: { ...blocked } }).problems.some((p) =>
      p.includes("4(e) is no longer discharged"),
    ),
  );
  expect(
    "an unrelated loader failure is a broken probe, not evidence",
    judgeProbe({
      hardened: { result: "other-failure", flags: "adhoc,runtime" },
      withEntitlement: ok,
    }).problems.some((p) => p.includes("broken probe")),
  );
  // A host that never got hardened would "load" for a reason that says nothing
  // about library validation — the ambiguity that made the CI failure hard to
  // read in the first place.
  expect(
    "a host that was not hardened invalidates the probe",
    judgeProbe({
      hardened: { result: "loaded", flags: "adhoc" },
      withEntitlement: ok,
    }).problems.some((p) => p.includes("did not test what it claims to test")),
  );
  expect(
    "and so does a host codesign reported no flags for",
    judgeProbe({ hardened: { result: "loaded", flags: null }, withEntitlement: ok }).problems
      .length > 0,
  );

  expect("accepts a working tool", toolIsUsable({ status: 0 }));
  expect("rejects a missing tool", !toolIsUsable({ error: new Error("ENOENT"), status: null }));
  expect("rejects a failing tool", !toolIsUsable({ status: 1 }));

  if (failures.length > 0) {
    console.error("check-library-validation --self-test failures:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("check-library-validation --self-test: all assertions pass.");
}

// Guarded like its sibling gates: without this, importing the module to reuse
// `judgeProbe` compiles and signs a probe as a side effect.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else {
    gate();
  }
}
