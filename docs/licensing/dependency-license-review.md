# Dependency license review (VC-409)

Volli Code ships under Apache-2.0. Almost everything it depends on is permissive too — 990 MIT
packages, 91 Apache-2.0, and so on down a long tail. This document is about the handful that are
not, what their licenses actually say, what has been made mechanically true about them, and which
questions still need a person with authority to answer.

**Read this before adding an entry to `apps/desktop/scripts/dependency-license-policy.json`.** That
file is the machine-checked half; this one is the reasoning. Neither is legal advice, and nothing
here should be read as a sign-off.

## How to re-run the evidence

```
pnpm -C apps/desktop run check:licenses            # the gate, plus its own self-test
pnpm -C apps/desktop run licenses:report           # every installed package, grouped by license
pnpm -C apps/desktop run check:notice-inputs       # docs/licensing/notice-inputs.md is current
pnpm -C apps/desktop run check:lgpl-source         # the SHIPPED LGPL notice is current
pnpm -C apps/desktop run check:library-validation  # the shipped relink instructions still hold
pnpm -C apps/desktop run licenses:verify-sources   # every source address still resolves (network)
pnpm -C apps/website run check:licenses            # GSAP notices survived into the built site
```

`docs/licensing/notice-inputs.md` is generated from the installed tree and holds the exact
attribution text the centralized notice files need. It is an input handoff: this ticket does not
edit `apps/desktop/THIRD-PARTY-NOTICES` or the website's static notices, which other tickets own.

### Two things to know before reading a failure

**Per-platform families.** pnpm installs only the native sibling matching the current os/cpu, so
the LGPL library is `@img/sharp-libvips-darwin-arm64` on a developer Mac and
`@img/sharp-libvips-linux-x64` on CI. Three families in this tree are non-permissive and are
therefore keyed with a trailing `*` in the policy — the libvips binaries (LGPL), the lightningcss
binaries (MPL-2.0), and the yuku bindings (no license field). Every other platform-specific package
in the tree is MIT or Apache-2.0.

**What only runs on macOS.** Four assertions need a Mac: the Mach-O dynamic-linking check, the
notice-inputs generator and the LGPL source offer (both read the shipped libvips package), and
`check:library-validation`, which compiles and signs a probe and therefore needs `clang` and
`codesign`. All of them say out loud that they skipped rather than passing quietly, so a green CI
run on Linux is not mistaken for having checked them — and CI runs them for real on the `macos-15`
boot-tier lane, so they are enforced rather than left to a developer Mac. Everything else — the
store scan, manifests, imports, electron-builder's packaging lists, the shipped-compliance files
and the entitlements assertion — runs everywhere.

**What fails rather than skips.** A skip is only honest when the reason is a fact about the
*machine* the reviewer already accounted for. An unreadable or renamed `electron-builder.yml` is a
fact about the *repository*, so it fails: the two assertions it gates are what keep the LGPL
library unpacked and shipped, and a gate that cannot read the packaging config has not checked it.

---

## Summary

| Dependency | License | Where it lives | State |
| --- | --- | --- | --- |
| `@img/sharp-libvips-*` | LGPL-3.0-or-later | Shipped inside the packaged desktop app | **Resolved** — the library is kept, the hardening is kept; notice, licence texts, source directions and relink instructions all ship |
| ~~`apca-w3`~~ | Bespoke "Limited W3 License" | — | **Removed** by VC-412; §B3 is moot |
| ~~`colorparsley`~~ | AGPL v3 | — | **Removed** with `apca-w3`; the AGPL is out of the tree |
| `gsap` | GreenSock Standard License | Marketing website bundle | **Fixed** — notices were being stripped; one product question left open |
| `lightningcss*` | MPL-2.0 | Build-time only | No action; recorded |
| `dompurify`, `node-forge`, `json-schema` | Dual-licensed | Various | No action; elected half recorded |
| `khroma`, `@yuku-*/binding-*` | MIT, but not in the manifest | Various | No action; source of the license recorded |

What changed in this ticket, in one line each:

- The website stopped stripping GSAP's copyright banners, and a build gate keeps them there.
- Every non-permissive license in the tree is now recorded, and CI fails when the tree drifts from
  that record — including a relicense, an unreviewed version bump, or a containment rule breaking.
- The LGPL library's replaceability is asserted mechanically rather than assumed.
- The exact notice text the LGPL requires is generated from the installed package.
- **§B2 was ruled on and implemented.** libvips stays, the hardened runtime stays, and the LGPL's
  source and relink obligations are discharged by material that ships inside the app — verified
  against a real signed build rather than reasoned about. See §B2 below.
- **§B1 is closed.** The verbatim GPL and LGPL texts section 4(b) requires now ship, hash-pinned
  so they cannot be edited or reformatted into something that is no longer a copy of them.
  Section 4 of the LGPL is now fully discharged for the packaged app.

What did **not** change: no dependency was removed, no security property was weakened, no license
was accepted on anyone's behalf. §B3 did not need a ruling in the end: VC-412 removed `apca-w3`
and its AGPL dependency outright, which is why that section now reads as history.

---

<a id="lgpl-libvips"></a>

## 1. LGPL — libvips inside the desktop app

### What is actually shipped

`sharp` reaches its image codecs through two optional packages: `@img/sharp-darwin-arm64`
(Apache-2.0, the `.node` addon) and `@img/sharp-libvips-darwin-arm64` (**LGPL-3.0-or-later**, the
prebuilt `libvips-cpp.8.18.6.dylib`). Both are listed in `apps/desktop/package.json`'s
`optionalDependencies` and both ship in the `.dmg`.

Verified by reading the installed package:

- Its entire file list is `package.json`, `README.md`, `versions.json`, one glib header, and the
  dylib. **It carries no license text at all** — only a markdown table in the README naming each
  bundled component's license.
- Eight of the twenty-nine components are under an LGPL: `fribidi`, `glib`, `libexif`, `libheif`,
  `librsvg`, `pango`, `proxy-libintl`, and `libvips` itself. The README adds that LGPLv3 is reached
  "via the 'any later version' clause of the LGPLv2 or LGPLv2.1".
- The addon reaches the library through the Mach-O load command `@rpath/libvips-cpp.8.18.6.dylib`.
  It is **dynamically linked**, not statically bound.

Where it is used: `packages/agent-runtime/src/pi/read-image-processor.ts`, which resizes and
transcodes images before they go to a model. It is loaded through a dynamic `import("sharp")`, and a
load failure already degrades to `[Image omitted]` rather than failing the runtime.

### What LGPLv3 section 4 asks for, and where each part stands

| Clause | Requirement | State |
| --- | --- | --- |
| 4(a) | Prominent notice that the library is used and is LGPL-covered | **Ships.** `apps/desktop/licensing/LGPL-LIBVIPS.md`, generated from the installed package and copied into the bundle. The centralized-notice wording is still the notices ticket's job. |
| 4(b) | Ship a copy of the GNU GPL *and* of the LGPL | **Ships.** Verbatim from gnu.org, hash-pinned, in `apps/desktop/licensing/`. See §B1. |
| 4(c) | Name the library among copyright notices shown during execution | **Engaged.** See below. |
| 4(d) | Let the user relink against a modified library | **Discharged**, by B2-a + B2-c. Corresponding Source directions ship; the relink procedure ships and was verified end to end. |
| 4(e) | Installation Information, where GPLv3 §6 would require it | **Discharged.** `apps/desktop/licensing/RELINK-LIBVIPS.md` and `relink-libvips.sh`. |

**4(c) is engaged, and that is a finding, not a formality.** `apps/desktop/src/main/menu.ts` builds
the menu with `{ role: "appMenu" }` and never calls `setAboutPanelOptions`, so the app gets macOS's
standard About panel, which displays the copyright string from `Info.plist`. The app therefore does
"display copyright notices during execution", which is exactly the condition 4(c) attaches to: the
libvips copyright and a pointer to the license copies belong in that panel. This is an input for
the notices ticket — it means the About surface, not only a text file.

### Mechanically held, so it cannot regress quietly

`check:licenses` now fails if any of these stop being true:

- `@img/sharp-libvips-darwin-arm64` is pinned in `@volli/desktop`'s `optionalDependencies`.
- `electron-builder.yml` still keeps `@img` in its `files` allowlist — without it the packaged app
  ships no libvips at all.
- `electron-builder.yml` still lists `**/node_modules/@img/**` under `asarUnpack`, so the dylib
  lands on disk as an ordinary replaceable file rather than sealed inside `app.asar`.
- Every shipped compliance file (`LGPL-LIBVIPS.md`, `RELINK-LIBVIPS.md`, `relink-libvips.sh`) still
  exists, and `electron-builder.yml` still copies `licensing/` into the bundle. Compliance material
  that does not reach the user discharges nothing.
- `build/entitlements.mac.plist` still does **not** grant
  `com.apple.security.cs.disable-library-validation`. That is the security half of the §B2 ruling,
  and it is also what makes the shipped relink instructions correct. The matcher distinguishes a
  grant from a mention — the plist names the entitlement in a comment explaining why it is omitted,
  and the first version of the rule failed the build over that sentence.
- The addon still names `@rpath/libvips-cpp` in its load commands. If a future `sharp` statically
  linked libvips, the obligation would jump from 4(d)(1)'s shared-library mechanism to 4(d)(0)'s
  much heavier "convey relinkable object code" duty — with nothing else in the build saying so.

The dynamic-linking check reads the Mach-O load-command strings directly. It runs on macOS arm64
and reports that it skipped on other platforms (Linux CI does not install the darwin binaries), so a
skip is visible rather than silent.

### §B1 — the GPL and LGPL texts (CLOSED)

Section 4(b) is unambiguous: the packaged app must be accompanied by a copy of both license
documents, and the upstream package supplies neither. **Both now ship.**

They are deliberately **not** generated by any script here. A copy of the GPL has to be the
canonical text byte-for-byte; a reflowed or paraphrased one is not a copy of it, and assembling one
programmatically would produce exactly that. So they were downloaded verbatim from gnu.org
straight to disk — never retyped, never round-tripped through a tool that reflows text, which is
the way a “copy of the GPL” quietly stops being one:

| File | Bytes | Lines | sha256 |
| --- | --- | --- | --- |
| `apps/desktop/licensing/GPL-3.0.txt` | 35,149 | 674 | `3972dc97…` |
| `apps/desktop/licensing/LGPL-3.0.txt` | 7,652 | 165 | `e3a994d8…` |

**Corroborated, because “I downloaded it” is not by itself evidence.** 74 of 77 distinctive GPL
paragraphs and 17 of 18 LGPL ones appear verbatim in the copy Chromium vendors independently
(`electron/dist/LICENSES.chromium.html`). The only difference is the FSF header URL: Chromium’s
older copy says `<http://fsf.org/>`, current gnu.org says `<https://fsf.org/>`. Both files are pure
ASCII with LF endings and no HTML entities or markup artifacts.

`check:licenses` hashes both files against the recorded sha256 on every run, so an edit, a
truncation or a well-meaning reformat fails the build by name rather than shipping a document that
is no longer a copy of the license it claims to be. They are also outside the formatter’s reach
(`vite.config.ts` ignores `apps/desktop/licensing`), because a formatter is exactly the kind of
well-meaning reformat that would break them.

If either file ever needs restoring, restore it from its canonical URL rather than editing it:

```sh
curl -o apps/desktop/licensing/GPL-3.0.txt  https://www.gnu.org/licenses/gpl-3.0.txt
curl -o apps/desktop/licensing/LGPL-3.0.txt https://www.gnu.org/licenses/lgpl-3.0.txt
```

The record and the filesystem are held to each other in both directions: with the state at
`shipped`, losing a file fails; had it stayed at `missing`, the files appearing would have failed
and said to flip it. It cannot sit at `shipped` over an empty directory, which is the failure mode
that would publish a false compliance claim.

**What this does not settle:** the *wording and placement* of the centralized notices
(`apps/desktop/THIRD-PARTY-NOTICES`, and the About panel 4(c) engages) still belong to the notices
work — VC-407, now landed, owns `apps/desktop/notices/`. This ticket ships the license texts that
section 4(b) requires accompany the binary; it does not rewrite VC-407's generated notice.

### §B2 — the relink freedom collides with macOS code signing (RULED, and implemented)

**This was the ticket's open decision. It has been made:** Volli keeps LGPL libvips, does not
weaken the packaged app's hardened runtime, and discharges 4(d)/4(e) with **B2-a + B2-c**.
B2-b (grant `disable-library-validation`) and B2-d (drop the library) were both declined.
The rest of this section is the reasoning and the evidence; what was built is at the end.

LGPLv3 §4(d) offers two ways to preserve the user's ability to run a modified library. Option
**4(d)(1)** — "use a suitable shared library mechanism" — requires a mechanism that "(a) uses at run
time a copy of the Library already present on the user's computer system, and (b) will operate
properly with a modified version". Volli ships its own copy inside the bundle rather than using one
already on the system, so (a) does not hold as written. That points at option **4(d)(0)**: convey
the Minimal Corresponding Source for the library together with application code in a form that
permits relinking.

Two macOS facts sharpen it further:

1. The app is signed with a Developer ID and a hardened runtime, and
   `apps/desktop/build/entitlements.mac.plist` **deliberately omits**
   `com.apple.security.cs.disable-library-validation` (its own comment explains why). Library
   validation therefore refuses to load a dylib not signed by the same Team ID — which is precisely
   a user's own rebuilt libvips.
2. Replacing any file inside a signed bundle invalidates its code signature, so even an
   entitlement change leaves the user needing to re-sign the app.

None of this is an accident to be fixed in passing; the hardening is deliberate, and so is the
distribution model. The options are genuinely different products:

| # | Option | What it costs | What it settles |
| --- | --- | --- | --- |
| # | Option | Ruling |
| --- | --- | --- |
| B2-a | Convey the Minimal Corresponding Source for libvips and its seven LGPL components, plus a written offer | **ADOPTED** |
| B2-b | Add `com.apple.security.cs.disable-library-validation` to the entitlements | **DECLINED** — it would drop a hardening property for every user of the published build, including every Electron helper, to serve the few who relink. The user's freedom is delivered on the user's own copy instead. |
| B2-c | Publish relink Installation Information | **ADOPTED**, as a document *and* a script |
| B2-d | Drop `sharp`/libvips and downscale images another way | **DECLINED** — the library stays |

#### What was actually verified, against a real signed build

The B2-c row above used to read "re-sign the app ad-hoc (`codesign --force --deep --sign -`)".
**That recipe does not work, and shipping it would have been shipping instructions that fail.**
It was tested against a Developer ID-signed, notarized `Volli Code.app` (0.1.2, hardened runtime,
Team `Y54F649NH4`), driving the real `sharp` addon through the packaged Electron binary with
`ELECTRON_RUN_AS_NODE=1` and `process.dlopen`. What the runs showed:

1. **Baseline.** The shipped app loads its own libvips: `{"semver":"8.18.3"}`.
2. **The obstruction is real.** Replacing the dylib with an identical one carrying an ad-hoc
   signature (what a user's own build has — no Team ID) fails at the loader with
   `code signature ... not valid for use in process: mapping process and mapped file
   (non-platform) have different Team IDs`.
3. **`--deep` is not enough.** It does not re-sign Mach-O files under `Resources/app.asar.unpacked`
   — exactly where libvips lives — so the library keeps its old signature while the app around it
   gets a new one. Signing must go inside-out: nested Mach-O, then executables, then frameworks,
   then helper apps, then the app.
4. **Ad-hoc alone is not enough either.** With every nested binary re-signed ad-hoc and the
   hardened runtime kept, the load still fails: a teamless process and a teamless library are
   *not* treated as matching. Hardened runtime + ad-hoc is a dead end by itself.
5. **What works**, and is what ships: re-sign the bundle inside-out, keeping the hardened runtime,
   with `com.apple.security.cs.disable-library-validation` added **to the user's own copy**. The
   user-built dylib then loads.
6. **It is genuinely the user's file that runs.** Installing a stub library at the same path
   changes the failure from a signature error to `Symbol not found: __ZTVN4vips7VOptionE ...
   Expected in: .../libvips-cpp.8.18.3.dylib` — dyld maps and resolves against the replacement.
7. **A caching gotcha, found the hard way.** macOS serves a cached code signature for a path it has
   already executed, so a bundle re-signed in place can keep behaving like the old one. The same
   effect made the first version of `check-library-validation.mjs` pass a deliberately broken
   mutant; both the gate and the shipped instructions now account for it.

#### What that turned into

- `apps/desktop/licensing/LGPL-LIBVIPS.md` — **generated** from the installed package: the 4(a)
  notice, the eight LGPL components, and a source address per component. Every URL template is
  read out of `lovell/sharp-libvips`'s own `build/posix.sh` at the tag we ship, not reconstructed
  from project homepages, and the document also names the build recipe and the two external
  patches applied to glib and libvips — without which the tarballs are not the whole Corresponding
  Source. All 11 addresses were fetched and returned 200; `licenses:verify-sources` re-checks them.
- `apps/desktop/licensing/RELINK-LIBVIPS.md` and `relink-libvips.sh` — the 4(e) Installation
  Information, and a script that performs it. Verified end to end: the script was run against a
  pristine signed app with a user-supplied ad-hoc dylib, and the result loads.
- `electron-builder.yml` copies `licensing/` to `Contents/Resources/licensing/`, so the material
  **accompanies the binary** rather than sitting in a repository the user never sees.
- `check:licenses` fails if a compliance file disappears, if the packaging stops shipping the
  directory, or if the entitlements ever grant `disable-library-validation` — the security half of
  this ruling, held mechanically.
- `check:library-validation` compiles and signs a probe on macOS CI and asserts the two OS facts
  the shipped instructions depend on, so an Apple behaviour change surfaces as a failed build
  rather than as false instructions in a released app.

**Legal reading still worth a human's eye:** whether 4(d)(0)'s "in a form that permits relinking"
is fully answered by directions-plus-procedure rather than by shipping relinkable object code.
The position taken here is that GPLv3 §6(d) permits third-party hosting with clear directions, and
that a verified re-signing procedure is what "permits relinking" means on a code-signed platform.
That is a defensible reading, not a certainty, and it is now at least a *documented* one.

---

<a id="apca-w3"></a>

## 2. `apca-w3` — removed from the tree (was: a bespoke license on a test-only oracle)

**Status: gone.** VC-412 removed `apca-w3` and, with it, its AGPL v3 dependency `colorparsley`.
Neither is a dependency of any workspace package, neither is in the lockfile, and
`scripts/check-excluded-dependencies.mjs` (VC-412's gate) fails the build if either returns. The
reviewed entries that used to hold them dev-only have been deleted from
`dependency-license-policy.json` — `check:licenses` refuses a record describing a package that is
not installed, which is how a stale entry gets caught rather than quietly outliving its subject.

The reasoning below is kept as history, because it is what made the removal the right call and
because it is the record of what the license actually said.

### What the license said


Quoting `node_modules/apca-w3/LICENSE.md` directly, because paraphrase loses the teeth:

> Commercial use is prohibited without a written and signed commercial license agreement, except as
> provided by the W3 cooperative agreement for web content only.

> Non-commercial use is permitted only for predicting contrast for web content, no other use case is
> authorized.

> Any files, or use cases of files, not under the W3 cooperative agreement are licensed under the
> AGPU v3 License

(The last is upstream's typo; in context it reads as AGPL v3.) It also forbids altering the
algorithm's constants, restricts the "APCA" name to compliant implementations, and imposes a duty to
track the current version — with an explicit carve-out that a project on a minor or patch release
need not adopt breaking versions but must stay on "the latest non-breaking branch".

Its only dependency, **`colorparsley@0.1.8`, is AGPL v3** — the strongest copyleft in the tree,
triggered by conveying the work *or* by letting users interact with it over a network.

### How Volli used it

As the independent oracle the theme generator's own APCA math was cross-checked against, in
`packages/shared/src/theme/color.test.ts`, `generate.test.ts`, and the desktop
`e2e/canvas-theming-smoke.mjs`. The design rule it served is that the generator must never be
verified against its own math — which is exactly what made removing it a real trade rather than a
free win.

### What used to be mechanically held

Until the removal, `check:licenses` failed if any of these stopped holding. They are recorded
because they are the shape of containment that worked, and the same shape is what now holds GSAP
and libvips:

- `apca-w3` appeared anywhere other than `devDependencies` of `@volli/desktop` and `@volli/shared`.
  Promoting it to a runtime dependency is what would put it — and AGPL `colorparsley` — inside a
  distributed artifact.
- `colorparsley` became a direct dependency of any workspace package, or was imported by any
  source file at all.
- Any source file outside `packages/shared/src/theme/*.test.ts` and `apps/desktop/e2e/*.mjs`
  imported it. The scan covers `apps/`, `packages/` **and the repository root's own files** — `vite.config.ts`
  and `vitest.workers.ts` are first-party code that can import anything, and leaving them out was a
  hole in this rule rather than a tidiness point.
  The matcher distinguishes a real import from a mention, so the `declare module "apca-w3"`
  ambient types and the prose in `color.ts` are correctly not treated as uses.
- The version range stopped being a caret range. `^0.1.9` resolves across `0.1.x`, which is what makes
  the "stay on the latest non-breaking branch" duty satisfiable by an ordinary `pnpm update`.

### §B3 — the two readings that made this worth removing (now moot)

1. **Scope.** The license authorizes use "for predicting contrast for web content ... presented on
   self-illuminated displays" and nothing else. Volli uses it to check the contrast of an Electron
   UI — literally HTML and CSS on a self-illuminated display, but not *web content* in the sense of
   a page a browser fetches. Whether that is inside the grant is a judgment call.
2. **Commercial use.** Commercial use needs a signed agreement except under the W3 cooperative
   agreement for web content. Volli Code is a commercial-intent product, though `apca-w3` is used
   only in its development and never distributed. Whether "commercial use" reaches a test-time tool
   inside a commercial company is a legal reading, not a technical one.

The containment above is what keeps the AGPL fallback dormant — it triggers on conveying or network
interaction, and neither happens. That is the strongest statement available without a ruling.

Options as they stood, for the record:

| # | Option | Note |
| --- | --- | --- |
| B3-a | Keep it, dev-only, as enforced today | Zero work; accepts readings 1 and 2 |
| B3-b | Obtain a commercial license from Myndex | Removes the question; needs a counterparty |
| B3-c | Re-implement APCA from the published spec as the oracle | Defeats the purpose — the oracle's value is being an *independent* implementation, and the license separately restricts naming a reimplementation "APCA" unless it tracks the current algorithm |
| B3-d | Drop the oracle and pin the tests to fixture values from the design doc | Cheapest to do, and the weakest tests: the generator would no longer be checked against any second implementation |

**These no longer need an answer.** The owner ruled for removal, and VC-412 took option **B3-d**:
the oracle is replaced by frozen reference vectors in
`packages/shared/src/theme/apca-reference.ts`, captured from the oracle while it was still
installed. That is honestly weaker than a live second implementation — nothing recomputes APCA
independently any more — and VC-412 mitigates it the way B3-d can be mitigated: each vector is
chosen to sit inside one APCA constant's region of influence, so the table cannot stay green while
a constant moves. The licence questions go away with the dependency; the tests keep a fixed second
opinion rather than a live one.

---

<a id="gsap"></a>

## 3. GSAP — a custom license on the marketing website

### What the license says

Read at <https://gsap.com/standard-license> (effective 2025-04-30, last modified 2025-05-30;
GSAP became free under Webflow in 2025). The operative parts:

- **Permitted Uses** — "the implementation and/or use of GSAP Products on any website, web
  application, or digital interface by any person or entity". Commercial use is explicitly free.
- **Prohibited Uses** — use "in tools that allow users to build visual animations without code that
  encourages, induces, or materially assists in creating a solution that competes with Webflow's
  visual animation building capabilities". The licensor's own FAQ places AI code-generation tools
  (naming ChatGPT, Cursor, Lovable) outside this.
- **III.3** — a licensee may not "Remove or alter any proprietary notices or branding from GSAP
  Products".
- **VI.2** — Webflow may revise the terms; continuing to use versions released after a revision is
  what accepts it, while previous versions stay under the terms in force when they were licensed.

### The violation that was found, and fixed

**III.3 was not being satisfied.** Every GSAP ES module the site bundles opens with a `/*!` banner
carrying the GreenSock copyright and a link to the terms — and the production build stripped all
four of them. A built `dist/` contained ~70 KB of GSAP code and zero occurrences of
`gsap.com/standard-license`.

Fixed in `apps/website/astro.config.mjs` by pinning `build.rollupOptions.output.comments.legal`.
Verified by building both ways: four banners present with the setting, zero without it.

`apps/website/scripts/check-bundled-license-notices.mjs` now runs at the end of `pnpm build` and
fails it if a banner goes missing, if a banner names a version other than the installed one, if a
chunk carries GSAP runtime code without a notice, or if the set of banners stops matching the
reviewed list. It was checked against a deliberately regressed build and reports all four losses by
name.

### Mechanically held

`check:licenses` additionally fails if `gsap` is declared by any workspace package other than
`@volli/website`, or imported from anywhere outside `apps/website/src/components/`. That is the
containment the Prohibited-Uses reading rests on: GSAP stays in the marketing site and does not
enter the desktop product.

### Open question Q1 — a product call, not a blocker today

Volli Code is an agent coding workspace: users write and generate code, and no surface lets anyone
build visual animations without code. On today's product the Prohibited Uses clause is not engaged,
and the licensor's FAQ addresses the AI-codegen case directly. Two things are worth a deliberate
decision rather than a drift:

1. If a future Volli surface ever offers no-code visual animation building, this clause needs
   re-reading before GSAP goes anywhere near it. The containment check is what makes that a
   conscious act.
2. VI.2 lets Webflow change the terms unilaterally. Whether that is acceptable for a dependency on a
   marketing site is a judgment — the honest mitigation is that a version bump is the moment of
   acceptance, and the policy file records the version reviewed, so a bump fails CI until someone
   re-reads the terms.

This is recorded as a question rather than a blocker: nothing in the current product conflicts with
the license, and the III.3 problem that did conflict is fixed.

---

## 4. The rest, recorded for completeness

- **`lightningcss*` (MPL-2.0).** The transformer and its per-platform binary. Weak copyleft at file
  level. Used unmodified, at build time only, by Tailwind and Astro; no MPL-covered code reaches a
  distributed artifact. Forking or patching it would take on MPL §3.2 source availability.
- **`dompurify` `(MPL-2.0 OR Apache-2.0)`, `node-forge` `(BSD-3-Clause OR GPL-2.0)`, `json-schema`
  `(AFL-2.1 OR BSD-3-Clause)`.** Dual-licensed, so the choice is ours. Volli elects Apache-2.0,
  BSD-3-Clause and BSD-3-Clause respectively; the notices must say which, or a reader is left
  guessing. `electedLicense` is the one field in the policy that is copied verbatim into a
  published notice, so the gate now checks it rather than trusting it: the elected half must be one
  of the halves the package is actually published under, it must be on the permissive list, and a
  dependency published under more than one set of terms must record an election at all. Without
  that, a typo — or a relicense that removes the elected half — would have turned this record into
  a false statement about the terms Volli uses a dependency under.
- **`khroma` (MIT).** No `license` field in its manifest, so scanners report it unlicensed. Its
  `license` file is the plain MIT text.
- **`@yuku-codegen/binding-*`, `@yuku-parser/binding-*` (MIT).** Generated napi platform packages
  with neither a `license` field nor a license file. Their parents `yuku-codegen@0.5.48` and
  `yuku-parser@0.5.48` declare MIT and publish from the same repository and release.
- **`@img/sharp-libvips-darwin-arm64@1.3.1`.** A second copy in the store, pulled by Astro's own
  `sharp@0.35.2` while building the website. Build-time only; the desktop app ships 1.3.3. Recorded
  because a license scan reports both and the difference matters.

## 5. What a reviewer should check next

1. ~~Rule on **B2**~~ — ruled and implemented; see §B2.
2. ~~Rule on **B3**~~ — moot: VC-412 removed `apca-w3` and `colorparsley` from the tree.
3. Hand `docs/licensing/notice-inputs.md` to the notices tickets, including the 4(c) finding that
   the About panel — not only a text file — is in scope.
4. Answer **Q1** if and when a no-code animation surface is ever proposed.
