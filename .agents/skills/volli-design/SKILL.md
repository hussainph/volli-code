---
name: volli-design
description: Fidelity-first Volli Glass design. Use for any Volli desktop UI creation, restyling, interaction change, mock port, or visual review; includes Empty / Normal / Extreme stress testing before review.
---

# Design with Volli Glass

## 1. Establish the contract

Read [DESIGN.md](../../../docs/DESIGN.md), the affected production components, their tests
and callers. Renderer paths below start at `apps/desktop/src/renderer/src/`.

Identify the surface's purpose, scope, neighbours, frequency and reading/workbench role.
Pin the current main revision as the **feature floor**. Inventory its actions, states,
shortcuts, identity marks and permissions before changing anatomy.

For a port, the approved mock is the visual and layout spec. AppKit informs material,
metrics and state semantics where the mock is silent; it is not a replacement composition.
Apply explicit owner overrides on top, with later decisions winning. Keep each override
local to its named surface: removing decorative 3D icons does not authorize removing logos;
an inspector pill does not make every toggle a pill. Code/tests describe implemented
behaviour, not approval of a visual departure.

**Done when:** every touched surface has a named purpose, pinned floor, visual target and
explicit deviations. Surface a missing decision rather than silently choosing a new target.

## 2. Choose references and foundations

Use [volli-design-references](../volli-design-references/SKILL.md) before proposing a new
pattern. For an approved port, research resolves gaps; it does not reopen settled choices.

Read [FOUNDATIONS.md](FOUNDATIONS.md) for material, control, icon and density decisions.
Read [MOTION.md](MOTION.md) when changing an interaction, pane, overlay, tab or animation.
Use [volli-copy](../volli-copy/SKILL.md) for every changed visible or accessible string.

Choose the shared primitive before drawing markup. `components/ui/` owns materials,
control shapes, icons, empty compositions, menus and tabs; composition owns stores and
commands. Extend one primitive for a missing capability instead of creating a local lookalike.
Primitives use CSS variables and UI peers, without app/domain/host imports.

**Done when:** each changed object maps to a shared primitive and each new pattern has an
inspected reference, intended adaptation and explicit scope.

## 3. Port component by component

Work from foundations to controls to the composed page. Match structure, proportions and
alignment before tuning paint; token substitution alone cannot repair the wrong anatomy.
Swap each component into its real page and compare it there before continuing. A gallery
proves the primitive, not the page. Finish the migration within the touched view so old and
new recipes do not coexist accidentally.

Preserve the feature floor. What leaves the resting view moves one click deeper into a
real menu, disclosure or editor. Keep commands, focus return, drafts, read-only gates and
live subtree identity; do not implement decorative mock controls as invented features.

**Done when:** every old capability has a tested new path, each component matches in page
context, and every remaining visual gap is fixed or explicitly approved.

## 4. Stress before review: Empty / Normal / Extreme

Every new or changed UI takes this matrix, including a small control inside a large page:

| Axis | Required cases |
|---|---|
| Population | Zero, one, 3–10, thousands; overloaded single group as well as distributed data |
| Content | Long names, unbroken paths/URLs, duplicate basenames, long errors, CJK, RTL and emoji |
| Identity | Real provider/vendor marks and missing/unknown mark fallbacks |
| Space | Narrow and wide panes, compact window, expanded disclosures and nested overlays |
| Appearance | Light/dark, warm/cool/custom canvases, reduced transparency and stronger contrast |
| Reads | Initial pending, successful empty, filtered zero, failed initial read, retained refresh failure |
| Scale | Mount/open/search/scroll cost, mounted row count, keyboard reach beyond the visible window |

Bound or virtualise presentation while keeping the full model addressable. Test the last
record by search, paging and keyboard, not only the first screen. Expose real omitted counts
for safety caps; a search over a capped subset is not whole-collection search. Keep submit
controls reachable with many attachments, and metadata from burying primary sections.
Use [VERIFICATION.md](VERIFICATION.md) for concrete failure probes and evidence requirements.

**Done when:** each matrix row has evidence or a named unverified case; clipping, silent
caps, unreachable records and unbounded mounts are fixed before requesting review.

## 5. Verify fidelity and parity

Follow [VERIFICATION.md](VERIFICATION.md) and [verify-volli](../verify-volli/SKILL.md).
Compare actual main, candidate and approved mock side by side. Motion needs consecutive
frames and pixels, not just endpoints or bounding boxes. Keep evidence outside tracked source.

**Done when:** the per-surface floor audit, stress results, relevant live paths and exact
checks are reported with revision labels. Report failed budgets and missing native/cloud
coverage as open; a passing screenshot, unit suite or lab simulation cannot stand in for them.
