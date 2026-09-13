/**
 * VC-291 — the seeded REFLOW sequence, shared by the reflow matrix and the
 * accessibility harness.
 *
 * The ticket's seed block is 63 logical lines:
 *
 *   REFLOW-BEGIN
 *   REFLOW-SHORT-01 .. REFLOW-SHORT-30                (30 standalone lines)
 *   REFLOW-LONG-01-<240 x>-END .. REFLOW-LONG-30-…    (30 long lines)
 *   REFLOW-PWD-<cwd>
 *   REFLOW-END
 *
 * SHORT-nn and LONG-nn interleave, so the file order is BEGIN, SHORT-01,
 * LONG-01, SHORT-02, LONG-02, … , SHORT-30, LONG-30, PWD, END.
 *
 * WHY THIS MODULE EXISTS, AND WHY THE SEED IS NOT THE TICKET'S LITERAL TEXT
 * ------------------------------------------------------------------------
 * The ticket's block ends each long line with a bare `printf '-END\n'`. Every
 * shell this harness can land on (`/bin/sh`, `bash`, `zsh`, `dash`) parses that
 * leading `-E` as a printf OPTION, not as text: the call fails with
 * `printf: -E: invalid option`, prints nothing, and — critically — emits no
 * newline. The next iteration's `REFLOW-SHORT-nn` is then appended to the tail
 * of the long line. The observable damage is a 33-line seed instead of 63:
 * SHORT-02..30 swallowed into long lines, no `-END` tail anywhere, and
 * `REFLOW-PWD-` welded onto LONG-30. A first pass at this investigation ran its
 * whole matrix on that malformed seed without noticing, because the marker
 * check looked for the substring `-END`, which `REFLOW-END` satisfies for free.
 *
 * So: the `-END` tail moves into a `%s` argument, where no shell can read it as
 * an option, and every caller validates the produced reference file against
 * `verifySeedReference()` BEFORE it is allowed to draw a conclusion from the
 * pane. `seedScript()` is the only place the sequence is written, and
 * `expectedSeedLines()` is the only place it is described, so the two cannot
 * drift apart again.
 */

export const SEED_SHORT_COUNT = 30;
export const SEED_LONG_COUNT = 30;
/** Exactly this many `x` characters between `REFLOW-LONG-nn-` and `-END`. */
export const SEED_LONG_FILL = 240;
/** BEGIN + 30 SHORT + 30 LONG + PWD + END = 63. */
export const SEED_LINE_COUNT = 3 + SEED_SHORT_COUNT + SEED_LONG_COUNT;

const pad2 = (n) => String(n).padStart(2, "0");

/** `REFLOW-SHORT-07` */
export const shortLine = (n) => `REFLOW-SHORT-${pad2(n)}`;
/** `REFLOW-LONG-07-xxx…xxx-END`, with exactly SEED_LONG_FILL x's. */
export const longLine = (n) => `REFLOW-LONG-${pad2(n)}-${"x".repeat(SEED_LONG_FILL)}-END`;

/**
 * Every logical line the seed must produce, in order.
 *
 * `pwd` is the directory the seed ran in. Callers that do not know it yet pass
 * nothing and get the `REFLOW-PWD-` prefix alone, which is what a marker probe
 * needs; `verifySeedReference` learns the real value from the file.
 */
export function expectedSeedLines(pwd = "") {
  const lines = ["REFLOW-BEGIN"];
  for (let n = 1; n <= SEED_SHORT_COUNT; n += 1) {
    lines.push(shortLine(n));
    lines.push(longLine(n));
  }
  lines.push(`REFLOW-PWD-${pwd}`);
  lines.push("REFLOW-END");
  return lines;
}

/**
 * The shell script that writes the sequence to the terminal AND to a reference
 * file, then reports that file's path through `pointerPath`.
 *
 * `token` makes both the log name and the reported path unique per seeded pane.
 * The first pass keyed the log on `date +%s` alone and never cleared the
 * pointer, so a second run inside the same second — or any run whose pointer
 * write had not landed yet — silently adopted the PREVIOUS run's reference
 * file. Two of every three committed reference files were another run's. The
 * token is echoed back inside the pointer so a reader can prove which pane a
 * reference belongs to instead of assuming it.
 */
export function seedScript({ pointerPath, token }) {
  if (!pointerPath) throw new Error("seedScript: pointerPath is required");
  if (!token || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error(`seedScript: token must be [A-Za-z0-9_-]+, got ${JSON.stringify(token)}`);
  }
  // `-END` rides in a %s argument: as a format string its leading `-E` is a
  // printf option in every shell here, which is the bug this module exists for.
  return `#!/bin/sh
log="/tmp/volli-reflow-${token}-$(date +%s).txt"
xs=$(printf '%*s' ${SEED_LONG_FILL} '' | tr ' ' x)
{
  printf 'REFLOW-BEGIN\\n'
  for n in $(seq -w 1 ${SEED_SHORT_COUNT}); do
    printf 'REFLOW-SHORT-%s\\n' "$n"
    printf 'REFLOW-LONG-%s-%s-END\\n' "$n" "$xs"
  done
  printf 'REFLOW-PWD-%s\\n' "$(pwd)"
  printf 'REFLOW-END\\n'
} | tee "$log"
printf 'REFLOW-BASELINE=%s\\n' "$log"
printf '${token}=%s' "$log" > ${pointerPath}
`;
}

/** Read a pointer file written by `seedScript` and confirm it is THIS run's. */
export function parseBaselinePointer(raw, token) {
  const text = String(raw ?? "").trim();
  if (text === "") return { ok: false, reason: "pointer file empty" };
  const prefix = `${token}=`;
  if (!text.startsWith(prefix)) {
    return {
      ok: false,
      reason: `pointer is not this run's (want ${prefix}…, got ${text.slice(0, 80)})`,
    };
  }
  const path = text.slice(prefix.length).trim();
  if (path === "") return { ok: false, reason: "pointer carries no path" };
  return { ok: true, path };
}

/**
 * Validate a produced reference file against the intended sequence, exactly.
 *
 * Returns `{ ok, lineCount, pwd, problems[] }`. `problems` is capped so one
 * broken seed cannot bury a report, but the counts are always exact.
 */
export function verifySeedReference(text) {
  // Bucketed so one broken category cannot crowd the others out of the
  // report: a seed that loses all 30 SHORT lines also loses all 30 -END tails,
  // and a reader needs to see both to recognise the printf-option failure.
  const buckets = new Map();
  const push = (p, bucket = "shape") => {
    const list = buckets.get(bucket) ?? [];
    if (list.length < 4) list.push(p);
    else if (list.length === 4) list.push(`… and more ${bucket} problems`);
    buckets.set(bucket, list);
  };
  const body = String(text ?? "").replace(/\r\n/g, "\n");
  const lines = body.split("\n");
  // A trailing newline is expected; anything after it is not.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  if (lines.length !== SEED_LINE_COUNT) {
    push(`expected ${SEED_LINE_COUNT} lines, got ${lines.length}`);
  }
  if (lines[0] !== "REFLOW-BEGIN")
    push(`line 1 is not REFLOW-BEGIN: ${JSON.stringify(lines[0] ?? null)}`);
  if (lines[lines.length - 1] !== "REFLOW-END") {
    push(`last line is not REFLOW-END: ${JSON.stringify(lines[lines.length - 1] ?? null)}`);
  }

  const pwdLines = lines.filter((l) => l.startsWith("REFLOW-PWD-"));
  if (pwdLines.length !== 1) push(`expected exactly 1 REFLOW-PWD- line, got ${pwdLines.length}`);
  const pwd = pwdLines.length === 1 ? pwdLines[0].slice("REFLOW-PWD-".length) : null;
  if (pwdLines.length === 1 && pwd === "") push("REFLOW-PWD- line carries no directory");

  // Standalone means the whole line is the marker — the malformed seed's
  // failure mode was SHORT-nn welded onto the tail of the previous long line,
  // which a substring test would have called present.
  let shortsSeen = 0;
  for (let n = 1; n <= SEED_SHORT_COUNT; n += 1) {
    if (lines.includes(shortLine(n))) shortsSeen += 1;
    else push(`missing standalone ${shortLine(n)}`, "short");
  }

  let longsSeen = 0;
  for (let n = 1; n <= SEED_LONG_COUNT; n += 1) {
    const want = longLine(n);
    if (lines.includes(want)) {
      longsSeen += 1;
      continue;
    }
    const actual = lines.find((l) => l.startsWith(`REFLOW-LONG-${pad2(n)}-`));
    if (actual === undefined) push(`missing REFLOW-LONG-${pad2(n)} line`, "long");
    else {
      const fill = /^REFLOW-LONG-\d\d-(x*)/.exec(actual)?.[1]?.length ?? 0;
      push(
        `REFLOW-LONG-${pad2(n)} malformed: ${fill} x's (want ${SEED_LONG_FILL}), ` +
          `${actual.endsWith("-END") ? "has" : "MISSING"} -END tail, length ${actual.length}`,
        "long",
      );
    }
  }

  if (body.includes("invalid option") || body.includes("printf:")) {
    push("reference file contains a shell printf error — the seed script did not run cleanly");
  }

  const problems = [...buckets.values()].flat();
  return {
    ok: problems.length === 0,
    lineCount: lines.length,
    shortsSeen,
    longsSeen,
    pwd,
    problems,
  };
}

/**
 * The expected lines a marker probe must find, and how each is proved.
 *
 * `exact` lines are compared byte-for-byte where real bytes exist (the
 * reference file, the clipboard). `contiguous` lines are proved from OCR of a
 * canvas, where the glyph run's exact length is not trustworthy but its
 * STRUCTURE is: `REFLOW-LONG-15-`, then an unbroken run of x's, then `-END`,
 * with nothing in between. That is what makes LONG-15 and its own `-END` one
 * logical line rather than two substrings that any `REFLOW-END` elsewhere on
 * screen would satisfy.
 */
export const REQUIRED_EXPECTED_LINES = Object.freeze([
  { key: "begin", kind: "exact", text: "REFLOW-BEGIN" },
  { key: "short01", kind: "exact", text: shortLine(1) },
  { key: "short15", kind: "exact", text: shortLine(15) },
  { key: "short30", kind: "exact", text: shortLine(30) },
  {
    key: "long15",
    kind: "contiguous",
    head: "REFLOW-LONG-15-",
    tail: "-END",
    fill: SEED_LONG_FILL,
  },
  { key: "pwd", kind: "prefix", text: "REFLOW-PWD-" },
  { key: "end", kind: "exact", text: "REFLOW-END" },
]);

export const REQUIRED_EXPECTED_KEYS = REQUIRED_EXPECTED_LINES.map((l) => l.key);

/**
 * Rebuild logical lines from text copied out of a terminal.
 *
 * A terminal copies what the GRID holds, so a 259-character seed line that
 * wrapped over three 86-column rows arrives as three physical lines. A
 * physical line exactly `cols` wide is a wrap, not a line ending — that is the
 * only signal the copied text carries, and it is the rule terminals use.
 *
 * Without this, comparing a clipboard with the reference file can only ever be
 * a substring test, which is how a copy of a malformed seed was read as
 * "matching the reference exactly".
 */
export function unwrapCopiedText(text, cols) {
  const physical = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const logical = [];
  let current = "";
  let carrying = false;
  for (const row of physical) {
    current = carrying ? current + row : row;
    if (cols > 0 && row.length === cols) {
      carrying = true;
    } else {
      logical.push(current);
      current = "";
      carrying = false;
    }
  }
  if (carrying) logical.push(current);
  while (logical.length > 0 && logical[logical.length - 1] === "") logical.pop();
  return logical;
}

/**
 * Is `copied` a contiguous run of `referenceLines`, byte for byte?
 *
 * Returns the reference line it starts at, so a reader can place the selection
 * in the seed rather than take "it matched" on trust.
 */
export function copiedRunMatchesReference(copied, referenceLines) {
  if (copied.length === 0) return { ok: false, reason: "nothing was copied" };
  const start = referenceLines.indexOf(copied[0]);
  if (start < 0) {
    return {
      ok: false,
      reason: `first copied line is not in the reference: ${JSON.stringify(copied[0].slice(0, 60))}`,
    };
  }
  for (const [i, line] of copied.entries()) {
    if (referenceLines[start + i] !== line) {
      return {
        ok: false,
        reason: `copied line ${i + 1} differs from reference line ${start + i + 1}`,
        expected: (referenceLines[start + i] ?? "").slice(0, 80),
        actual: line.slice(0, 80),
      };
    }
  }
  return { ok: true, startsAtReferenceLine: start + 1, lines: copied.length };
}

/**
 * Which expected lines a viewport's OCR text contains.
 *
 * OCR of a canvas returns rows, and a 259-character seed line wraps over
 * several of them, so a logical line is only recoverable from the
 * whitespace-stripped concatenation of a viewport's rows.
 *
 * Two properties of that channel decide how strong a claim this can support:
 *
 *  - Fast-mode Vision OCR drops or duplicates the odd `x` inside a 240-glyph
 *    run, so the fill is checked as "an unbroken run of at least `minFill`"
 *    and its observed length is REPORTED rather than asserted.
 *  - At 86 columns a 259-character line is 86+86+86+1: its last character sits
 *    alone on a row of its own, and Vision skips a one-glyph row, so `-END`
 *    reads back as `-EN`. A tail short by at most one character is therefore
 *    accepted and FLAGGED (`tailTruncated`), never silently swallowed.
 *
 * What is not relaxed is adjacency: the tail must follow this line's own fill
 * run, so a `REFLOW-END` elsewhere on screen cannot stand in for it. That is
 * exactly what the old seven-substring check lacked — it spelled this marker
 * `-END`, which `REFLOW-END` satisfied for free — and it is what makes LONG-15
 * and its own `-END` one verified logical line.
 *
 * The exact 240-character fill and the exact `-END` are proved on real bytes
 * elsewhere: by `verifySeedReference` against the seeded file, and by the
 * clipboard comparison in the accessibility harness.
 */
export function findExpectedLines(ocrText, { minFill = Math.round(SEED_LONG_FILL * 0.75) } = {}) {
  const flat = String(ocrText ?? "").replace(/\s+/g, "");
  const found = {};
  const detail = {};
  for (const line of REQUIRED_EXPECTED_LINES) {
    if (line.kind === "contiguous") {
      const full = new RegExp(`${line.head}(x+)${line.tail}`).exec(flat);
      // One character short, and no shorter: `-EN` is the wrap artefact,
      // `-E` would be a genuinely damaged line.
      const shortTail = line.tail.slice(0, -1);
      const partial =
        full === null && shortTail.length > 1
          ? new RegExp(`${line.head}(x+)${shortTail}`).exec(flat)
          : null;
      const hit = full ?? partial;
      found[line.key] = hit !== null && hit[1].length >= minFill;
      detail[line.key] =
        hit === null
          ? { fill: 0, tailSeen: null }
          : {
              fill: hit[1].length,
              minFill,
              tailSeen: full === null ? shortTail : line.tail,
              tailTruncatedByOcr: full === null,
            };
    } else {
      found[line.key] = flat.includes(line.text.replace(/\s+/g, ""));
      detail[line.key] = {};
    }
  }
  return { found, detail };
}
