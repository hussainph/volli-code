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
pnpm -C apps/desktop run check:licenses        # the gate, plus its own self-test
pnpm -C apps/desktop run licenses:report       # every installed package, grouped by license
pnpm -C apps/desktop run check:notice-inputs   # docs/licensing/notice-inputs.md is current
pnpm -C apps/website run check:licenses        # GSAP notices survived into the built site
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

**What only runs on macOS.** Two assertions need the darwin binaries: the Mach-O dynamic-linking
check, and the notice-inputs generator (which reads the shipped libvips package). Both say out loud
that they skipped rather than passing quietly, so a green CI run on Linux is not mistaken for
having checked them. Everything else — the store scan, manifests, imports, and electron-builder's
packaging lists — runs everywhere.

---

## Summary

| Dependency | License | Where it lives | State |
| --- | --- | --- | --- |
| `@img/sharp-libvips-*` | LGPL-3.0-or-later | Shipped inside the packaged desktop app | **Blocked** — notice and relink obligations need a decision |
| `apca-w3` | Bespoke "Limited W3 License" | Test-only oracle | **Blocked** — scope and commercial-use reading need a decision |
| `colorparsley` | AGPL v3 | Transitive under `apca-w3` | Contained; contingent on `apca-w3` staying test-only |
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

What did **not** change: no dependency was removed, no license was accepted on anyone's behalf, and
the two blockers below are still blockers.

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
| 4(a) | Prominent notice that the library is used and is LGPL-covered | Text generated in `notice-inputs.md` §1a. **Shipping it is the notices ticket's job.** |
| 4(b) | Ship a copy of the GNU GPL *and* of the LGPL | Named in `notice-inputs.md` §1b. **Neither file is in this repository.** See blocker B1. |
| 4(c) | Name the library among copyright notices shown during execution | **Engaged.** See below. |
| 4(d) | Let the user relink against a modified library | Structurally available, practically obstructed. See blocker B2. |
| 4(e) | Installation Information, where GPLv3 §6 would require it | Depends on B2. |

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
- The addon still names `@rpath/libvips-cpp` in its load commands. If a future `sharp` statically
  linked libvips, the obligation would jump from 4(d)(1)'s shared-library mechanism to 4(d)(0)'s
  much heavier "convey relinkable object code" duty — with nothing else in the build saying so.

The dynamic-linking check reads the Mach-O load-command strings directly. It runs on macOS arm64
and reports that it skipped on other platforms (Linux CI does not install the darwin binaries), so a
skip is visible rather than silent.

### Blocker B1 — the GPL and LGPL texts are not in the repository

Section 4(b) is unambiguous and unmet: the packaged app must be accompanied by a copy of both
license documents, and the upstream package supplies neither.

They are deliberately **not** generated by any script here. A copy of the GPL has to be the
canonical text byte-for-byte; a reflowed or paraphrased one is not a copy of it, and assembling one
programmatically would produce exactly that. `notice-inputs.md` §1b names the two files and their
canonical sources.

**Needs:** someone to add verbatim `GPL-3.0.txt` and `LGPL-3.0.txt` from <https://www.gnu.org/licenses/>
to the packaged app's resources. That is a notices-ticket change, which this ticket is scoped out of.

### Blocker B2 — the relink freedom collides with macOS code signing

This is the real decision, and it cannot be settled by code.

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
| B2-a | Publish the Minimal Corresponding Source for libvips and its seven LGPL components (the exact upstream tarballs `sharp-libvips` builds from), plus a written offer, alongside each release | A release-process step and hosting; no product change | The 4(d)(0) source half. Leaves the practical relink still blocked by signing |
| B2-b | Add `com.apple.security.cs.disable-library-validation` to the entitlements | Gives up a hardening property for the whole app, including every Electron helper | Lets a user-built dylib load once the bundle is re-signed |
| B2-c | Publish relink Installation Information: how to rebuild libvips, replace the dylib, and re-sign the app ad-hoc (`codesign --force --deep --sign -`) | Documentation only | Arguably discharges 4(e); relies on the reader having Xcode tools |
| B2-d | Drop `sharp`/libvips and downscale images another way | Real engineering; the read path already degrades gracefully, so the failure mode is known | Removes the obligation entirely |

B2-a and B2-c are additive and compatible with each other; B2-b is a security trade; B2-d is a
product decision about image handling.

**Needs:** a product/legal ruling on whether Volli keeps LGPL libvips at all, and if so which of
B2-a…B2-c it relies on. **Until that ruling exists, the LGPL obligations for the packaged desktop
app are NOT discharged.** What this ticket has done is make the facts true, checked, and
regression-proof — not resolved.

---

<a id="apca-w3"></a>

## 2. `apca-w3` — a bespoke license on a test-only oracle

### What the license says

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

### How Volli uses it

As the independent oracle the theme generator's own APCA math is cross-checked against, in
`packages/shared/src/theme/color.test.ts`, `generate.test.ts`, and the desktop
`e2e/canvas-theming-smoke.mjs`. The design rule it serves is that the generator must never be
verified against its own math.

### Mechanically held

`check:licenses` fails if:

- `apca-w3` appears anywhere other than `devDependencies` of `@volli/desktop` and `@volli/shared`.
  Promoting it to a runtime dependency is what would put it — and AGPL `colorparsley` — inside a
  distributed artifact.
- `colorparsley` becomes a direct dependency of any workspace package, or is imported by any source
  file at all.
- Any source file outside `packages/shared/src/theme/*.test.ts` and `apps/desktop/e2e/*.mjs` imports
  it. The matcher distinguishes a real import from a mention, so the `declare module "apca-w3"`
  ambient types and the prose in `color.ts` are correctly not treated as uses.
- The version range stops being a caret range. `^0.1.9` resolves across `0.1.x`, which is what makes
  the "stay on the latest non-breaking branch" duty satisfiable by an ordinary `pnpm update`.

### Blocker B3 — two readings that only a person can choose between

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

Options, if the ruling goes against keeping it:

| # | Option | Note |
| --- | --- | --- |
| B3-a | Keep it, dev-only, as enforced today | Zero work; accepts readings 1 and 2 |
| B3-b | Obtain a commercial license from Myndex | Removes the question; needs a counterparty |
| B3-c | Re-implement APCA from the published spec as the oracle | Defeats the purpose — the oracle's value is being an *independent* implementation, and the license separately restricts naming a reimplementation "APCA" unless it tracks the current algorithm |
| B3-d | Drop the oracle and pin the tests to fixture values from the design doc | Cheapest to do, and the weakest tests: the generator would no longer be checked against any second implementation |

**Needs:** a legal reading of 1 and 2. **Do not treat the containment work as having answered them.**

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
  guessing.
- **`khroma` (MIT).** No `license` field in its manifest, so scanners report it unlicensed. Its
  `license` file is the plain MIT text.
- **`@yuku-codegen/binding-*`, `@yuku-parser/binding-*` (MIT).** Generated napi platform packages
  with neither a `license` field nor a license file. Their parents `yuku-codegen@0.5.48` and
  `yuku-parser@0.5.48` declare MIT and publish from the same repository and release.
- **`@img/sharp-libvips-darwin-arm64@1.3.1`.** A second copy in the store, pulled by Astro's own
  `sharp@0.35.2` while building the website. Build-time only; the desktop app ships 1.3.3. Recorded
  because a license scan reports both and the difference matters.

## 5. What a reviewer should check next

1. Rule on **B2** (keep LGPL libvips, and on what terms) — it gates the desktop release story.
2. Rule on **B3** (`apca-w3` scope and commercial use).
3. Hand `docs/licensing/notice-inputs.md` to the notices tickets, including the 4(c) finding that
   the About panel — not only a text file — is in scope.
4. Answer **Q1** if and when a no-code animation surface is ever proposed.
