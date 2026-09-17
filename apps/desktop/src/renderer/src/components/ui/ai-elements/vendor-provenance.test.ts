/**
 * That the AI Elements attribution is still attached to the code it describes.
 *
 * Three files here are Vercel's, under Apache-2.0, and the license asks two
 * things of us that live in source rather than in a build artifact: §4(b), that
 * a modified file says it was modified, and §4(a), that a recipient gets a copy
 * of the license. Both are discharged by text — a header block in each file, and
 * `PROVENANCE.md` pointing at the repository's own root `LICENSE` instead of
 * duplicating 11KB of it. Text has no type checker, so this is the only thing
 * standing between a refactor and a quiet compliance regression.
 *
 * WHAT IS ACTUALLY AT RISK HERE, in the order it is likely to happen:
 *
 * 1. A header is dropped while rewriting a file. The file keeps working, the
 *    diff looks like cleanup, and the notice is gone.
 * 2. The headers and `PROVENANCE.md` disagree about the upstream revision. The
 *    revision was not recorded at vendoring time and had to be reconstructed
 *    from content (see `PROVENANCE.md`); once four copies of it exist, a
 *    partial update leaves a provenance claim that points at the wrong commit,
 *    which is worse than no claim at all. So the revision is asserted to be one
 *    value everywhere rather than merely present.
 * 3. The repository stops being Apache-2.0. `PROVENANCE.md` discharges §4(a) by
 *    saying "the full text ships at the root", which is true only while it is.
 *    Relicensing Volli is a thing someone could do without ever opening this
 *    directory, and it would silently break the discharge — so the root LICENSE
 *    is asserted from here, where the claim that depends on it lives.
 *
 * `reasoning.tsx` and `shimmer.tsx` came from the same vendoring and are NOT in
 * the list below. Nothing of upstream's survives in them (two import lines
 * each), so attributing them would misstate who wrote them. That is a judgement
 * recorded in `PROVENANCE.md`, not an omission.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

/** The upstream revision every notice in this directory must agree on. */
const REVISION = "9310a1d3a8ddc881244e7c48ec0f5d215df92e70";

const UPSTREAM = "https://github.com/vercel/ai-elements";

/**
 * Files still carrying enough of upstream's expression to need a notice, each
 * with the upstream file it descends from. Measured, not guessed — see the
 * table in `PROVENANCE.md`.
 */
const ATTRIBUTED = {
  "prompt-input.tsx": "packages/elements/src/prompt-input.tsx",
  "conversation.tsx": "packages/elements/src/conversation.tsx",
  "message.tsx": "packages/elements/src/message.tsx",
} as const;

const HERE = import.meta.dirname;
const REPO_ROOT = path.resolve(HERE, "../../../../../../../..");

function read(relative: string): string {
  return readFileSync(path.join(HERE, relative), "utf8");
}

/** A file's leading block comment — a notice below the imports is not a notice. */
function header(source: string): string {
  const end = source.indexOf("*/");
  return end === -1 ? "" : source.slice(0, end);
}

describe("AI Elements vendor provenance", () => {
  for (const [file, upstreamPath] of Object.entries(ATTRIBUTED)) {
    describe(file, () => {
      it("names the upstream project, file and revision in its header", () => {
        const head = header(read(file));
        expect(head).toContain(UPSTREAM);
        expect(head).toContain(upstreamPath);
        expect(head).toContain(REVISION);
      });

      it("states the license and that the file was modified (Apache-2.0 §4(b))", () => {
        const head = header(read(file));
        expect(head).toContain("Apache-2.0");
        expect(head).toContain("Copyright 2023 Vercel, Inc.");
        // The §4(b) notice itself. Upper-case in every header so that deleting
        // it is a visible edit rather than a stray word lost in a reflow.
        expect(head).toContain("MODIFIED");
      });

      it("points at the record instead of restating it", () => {
        expect(header(read(file))).toContain("PROVENANCE.md");
      });
    });
  }

  it("records the same revision in PROVENANCE.md as the files claim", () => {
    const provenance = read("PROVENANCE.md");
    expect(provenance).toContain(REVISION);
    expect(provenance).toContain(UPSTREAM);
    for (const upstreamPath of Object.values(ATTRIBUTED)) {
      expect(provenance).toContain(upstreamPath);
    }
  });

  it("does not attribute the files upstream no longer wrote", () => {
    // The inverse guard: re-adding a notice to a rewritten file would claim
    // Vercel's authorship of Volli's work, which is its own misstatement.
    for (const file of ["reasoning.tsx", "shimmer.tsx"]) {
      expect(header(read(file))).not.toContain(UPSTREAM);
    }
  });

  it("still ships the Apache-2.0 text PROVENANCE.md defers §4(a) to", () => {
    const license = readFileSync(path.join(REPO_ROOT, "LICENSE"), "utf8");
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0, January 2004");
    // Not just present — reachable by the relative link PROVENANCE.md prints.
    expect(read("PROVENANCE.md")).toContain("../../../../../../../../LICENSE");
  });
});
