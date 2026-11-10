---
name: volli-design-references
description: References before reinvention for Volli. Use before proposing a new desktop pattern, comparing design options, researching native macOS behaviour, or when another skill needs visual precedent for a design decision.
---

# References before reinvention

## 1. Frame the question

Load [volli-design](../volli-design/SKILL.md) for the feature floor and visual contract.
Name the surface's job, frequency, data scale, input paths and unanswered decision. For an
approved port, preserve the mock's composition; references resolve omissions, not override it.
AppKit is evidence for control/material intent, not an instruction to clone its whole layout.

**Done when:** the research question identifies what a reference must settle and which
already-approved choices it must leave alone.

## 2. Inspect the right precedents

Start with the closest native pattern, then broaden only for a concrete gap:

| Need | Where to look / what to observe |
|---|---|
| Platform behaviour | [Apple HIG](https://developer.apple.com/design/human-interface-guidelines/): hierarchy, input, focus, accessibility, sidebars, menus, materials and feedback |
| Source navigation | Xcode/Finder/Mail: command chrome versus content rows, groups, selection, disclosures and overflow |
| Documents and preferences | Notes/System Settings: reading hierarchy, grouped values, scope, compact edits and recovery |
| Tabs and grouping | Safari and Rex: selected capsules, grouped identities, hover inventory, close-width hold, compression and overflow |
| Dense work tools | Linear/Codex: scanning, primary versus secondary actions, workbench density and history |
| Search / commands | Raycast and ChatGPT/Claude search UIs: query retention, result identity, keyboard movement and scoped empty recovery |
| Metrics / optics | Real AppKit captures: requested versus effective control size, states on paper/glass, light/dark; measure screenshots with DPR and distinguish configured geometry from system defaults |
| Broader alternatives | Mobbin-style screen/flow galleries and original design portfolios: composition, density and state hierarchy, not proof of native behaviour |

Open the actual source. Search snippets, titles and gallery metadata are discovery, not
inspection. Check the returned app and screen: a result for Raycast may depict another app;
a loading frame may not show a usable pattern. Inspect an adjacent flow/state where behaviour
matters. Use official documentation for semantics if a screenshot is unavailable, and label
that evidence as textual. State coverage gaps instead of claiming you studied an unseen UI.

**Done when:** each chosen precedent was inspected, its app/state is identified, and observation
is separated from inference. A query's intent never substitutes for the returned evidence.

## 3. Judge fit, not fashion

For each candidate, record **Observed → Take → Leave → Adapt**:

- Does it solve this job at this frequency with the same input method and scale? A multi-step
  integration wizard is a poor precedent for editing one saved trigger.
- Does a familiar native pattern already solve it? Prefer that over invented navigation or
  symbolic legends that need explanatory prose.
- Is its hierarchy useful in the whole page? Small empty compositions can preserve filter
  context; a copied three-tile fan everywhere cannot describe different collections well.
- Which semantics belong to that product alone? Preserve Volli's actual commands, local/cloud
  gates, history facts and manual/automatic distinctions. A reference cannot add a backend.
- Which details conflict with Volli Glass? Translate materials, type, icons, controls and
  copy through shared primitives. Borrow intent, not reference-app colour palettes,
  skeletons, onboarding paragraphs or unsupported actions.

**Done when:** every borrowed idea has a named benefit, rejected mismatches and a concrete
translation into Volli's existing anatomy and capabilities.

## 4. Turn evidence into options

When a decision is open, make several **structurally distinct** options, not colour variants.
Keep the surrounding frame/materials/fixtures constant. Show each in page context across
empty, first-item and populated states, narrow/wide, light/dark and a relevant custom canvas.
If behaviour changes over time, use a storyboard with truthful event/time semantics.

Describe each option's command placement, navigation/focus cost, scale limits, parity and
trade-offs. Recommend one with reasoning tied to the original question. Label prototypes
**Simulated wiring** and distinguish an observed native rule from your adaptation/inference.
Keep review controls/captions outside the product drawing. Await the actual blocking choice;
a recommendation alone does not authorize a product departure.

**Done when:** a reviewer can compare the options at the same states, understand their costs,
and choose without reconstructing hidden behaviour from a resting screenshot.

## 5. Cite without redistributing

Evidence names the app, screen/flow, source URL, inspected state, date/version when available,
and what was observed versus inferred. Record native capture environment, DPR, requested and
effective metrics; do not present fitted radii or private shader guesses as framework constants.
Keep reference captures and review notes outside tracked source; attach appropriate visual
evidence to review rather than committing screenshots or internal research.

Study does not grant redistribution rights. Draw original compositions; do not trace gallery
artwork or ship reference-app assets. A vendor/provider mark is a separate identity requirement:
verify its exact upstream artwork and licence, retain required text and register notice
coverage under the repository policy. Regenerate/check notices when assets change; an old
source entry naming fewer marks can be stale even if the licence itself is unchanged. See
[identity and provenance](../volli-design/FOUNDATIONS.md#symbols-and-identity-are-separate-systems).
Unknown rights remain unresolved, never guessed from a search result.

**Done when:** every recommendation is traceable to inspected evidence, any shipped material
has verified redistribution provenance, and simulation/coverage/licensing limits are explicit.
