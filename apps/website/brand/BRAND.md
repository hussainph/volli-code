# Volli — brand, from first principles

This is the brief volli.app and docs.volli.app are built from. It exists because
the 0.2 pass (VC-217) grew the homepage one reasonable section at a time — a
feature grid, a storyboard, a trust grid, a closing band — until the page read
like every other SaaS site and lost what the first one had. The first site was
built on one idea borrowed from Sky: **show the thing, floating in a world, and
then talk like a person.** Everything below re-derives that idea for Volli and
turns it into rules, so the next release adds a chapter instead of a component.

## 1. What Volli is

**Volli is the quiet place where you run loud work.** Many coding agents at
once, each on its own ticket, in its own worktree, on your Mac. You plan on a
board, hand work off, and review what comes back.

The thing a visitor should feel is not "AI" and not "productivity". It is
**calm command**: dozens of agents running, and you are not their switchboard.

Three facts carry the trust, and they are said once, plainly, in prose:

- **It's yours.** Local-first. Projects, chats and history live on your Mac. No
  Volli account. Each worktree is an ordinary Git checkout.
- **It's open.** Apache-2.0, on GitHub.
- **It's your models.** Requests go to the provider and account you configure.

## 2. The idea: the world

Sky put its product in a sky. Volli's version is already in the product: every
Volli theme is **a canvas** — a few colours of light that the app derives its
whole palette from. On the site, that canvas becomes **the world**: soft pools
of light and grain behind the window, at the scale of the page.

- **The product floats in the world.** It is never a screenshot in a bordered
  card or a device mock-up. It has a shadow and it has light behind it.
- **Each chapter wears a different canvas**, exactly as the 0.2 film does
  (VC-464): ember, lagoon, cobalt, rose, gold. The colour lives in the world,
  never in the UI chrome, the type, or the buttons.
- **Ember is home.** The shipped default canvas opens and closes every page.
- **Everything else is black.** The page is the night; the work is lit.

## 3. Voice

Marketing speaks outcomes; the docs speak nouns. Copy follows the
`developer-copy` rules (`.agents/skills/developer-copy`, drafted in VC-472):
plain words, short sentences, active voice, facts a skeptic can check.

- **Nothing above a headline.** No eyebrows, kickers, section labels or mono
  tag lines — anywhere on the site. A section is a headline, then its words.
- **Outcomes, not features.** A headline says what the reader gets ("Never
  lose the thread"), and its one or two sentences say how. Seven seconds: a
  visitor who reads only the headlines should still know why to download.
- **Product first, release last.** A first-time visitor wants to know what
  Volli is, what it does, and why they would use it over the agent app they
  already have. The release number appears at most once, quietly.
- **Two beats per line.** A light clause, then a bold one: *Hand off work*
  **in one drag.** This is the super, and it is the only headline shape.
- **Short, declarative, second person.** No exclamation marks, no "supercharge",
  no "seamless", no "powerful", no "AI-powered".
- **Product nouns stay in the docs.** The homepage never says Runtime, Trigger,
  Board Session, Unbound Run, Change Set. It says *agents*, *tickets*, *your
  board*, *a schedule*. The link to the docs is where the nouns start.
- **Say it once.** A fact appears in one place on a page. The old page named
  "local-first" four times and the 0.2 Triggers three times.
- **Honest about the stage.** It is an alpha for Apple silicon; the download
  button says *Download for Mac* and the page says *alpha* once, near it.

The essay under the hero is the one place for more than a line. It is written
like the Sky essay: short paragraphs, first principles, no bullets.

## 4. The mark

Three rounded bars and one ember card: a board with a card on the move. It is
drawn, not photographed — `apps/desktop/build/icon-source.svg` is the source.

- Bone bars (`#F2EAE0`) and the ember card (`#E8652A`). Nothing else.
- On the site it appears small in the header and large, alone, at the close.
- The word is **Volli**. Never "Volli Code" in a sentence (the repository and
  the package keep the long name).

## 5. Type

One family, used with range: **Mona Sans Variable**, loaded from its full
variable file so the width axis is available.

| Role | Setting |
|---|---|
| Super, light beat | wght 300 · wdth 100 · tracking −0.035em |
| Super, bold beat | wght 780 · wdth 110 · tracking −0.04em |
| Essay | wght 380 · 1.25rem/1.6 · measure ≤ 36em |
| UI (buttons, nav) | wght 520 · 0.9375rem |

The two-weight line is the brand's signature, shared with the film's supers.

## 6. Colour

| Token | Value | Use |
|---|---|---|
| `--night` | `#07070a` | The page. |
| `--ink` | `#f5f2ee` | Headlines and body — warm, like the mark's bone. |
| `--ink-2` | `rgb(245 242 238 / 0.62)` | Secondary copy. |
| `--ink-3` | `rgb(245 242 238 / 0.4)` | The note under a button, footer. |
| `--hairline` | `rgb(245 242 238 / 0.1)` | The only border. |
| `--ember` | `#e8652a` | The primary button and the mark's card. Nowhere else. |

Chapter canvases are the film's (`apps/desktop/src/flute/kit/world.tsx`).

## 7. Components — the whole vocabulary

A page is built from these and nothing else. A new need is argued here first.

1. **World** — a full-bleed band painted from one canvas: light pools, grain,
   a slow drift, a bloom behind the subject. Pure CSS; still under reduced
   motion.
2. **Window** — the product, floating in a World: the live demo or a still of
   the real app captured from the UI lab's real components.
3. **Super** — one two-beat headline and an optional one-line sub. Nothing
   above it.
4. **Essay** — the mark and name on the left, prose on the right.
5. **Button** — *primary* (ember pill, one per view) and *quiet* (text with an
   arrow). No outlined pills, no icon soup.
6. **Header / Footer** — the mark and name; four links; the download.
7. **Feed** — a Window drawn in the page's own type: a few of the sidebar's
   session rows on dark glass (glyph, title, "No ticket · just now", a working
   ring). Used once, where a still can't show many agents at once. The rows
   arrive in turn when the card is revealed, then run together; the ring turns
   slowly, as it does in the app, and is still under reduced motion. Invented,
   public-safe titles only.

There are no cards, icon grids, numbered feature lists, badges, pills, glyph
illustrations or accordions.

## 8. Motion

Slow and physical, never decorative for its own sake.

- The world drifts on long, incommensurate periods (tens of seconds).
- A super rises into place once as it enters (240–400ms, ease-out). The bold
  beat lands a beat after the light one.
- The hero's bold beat is the one exception. It is set in italic and arrives
  at speed from the left, leaning forward, with two blurred afterimages (bone,
  then ember), then brakes into place (760ms). After that, speed lines race
  through its letters forever: dark slits and one ember stripe, right to left,
  clipped to the type. Only there; under reduced motion the lines hold still.
- The working-ring motif — the ring a live Session wears in the app — may
  ripple once behind a subject. It never loops forever on screen.
- `prefers-reduced-motion`: the world is still, supers are simply there.

## 9. Page shapes

**Home.** Hero (the outcome in one line, the download and a star, then the real app: the release film's opening shot as a short video that holds on its last frame) → Essay (the
problem it solves, in one paragraph) → one Chapter per core feature, each its
own World: the headline and a few plain sentences at the top, a still of the
real app below them, laid out as a bento → what makes Volli different, said about Volli alone (never naming other tools) →
Close (ember, the mark, the download) → Footer.

**Download.** One World (ember), one Window-sized panel with the build, the
requirements, and the alpha note.

**Docs.** The same night, ink and ember; Mona Sans; no world behind reading
text. The docs are where the product nouns live.
