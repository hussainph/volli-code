/**
 * VC-376 — the usage-limits button, redrawn so it answers before it is opened.
 *
 * Today the button wears a Phosphor Gauge that draws the same picture whether
 * 95% or 2% of the quota is left, and the same Gauge is the effort picker in
 * the composer and in the activity bar — one shape, two unrelated meanings.
 * The redesign takes Apple's foldable-cover-screen idea (one small shape
 * carries the state, colour is the verdict, the detail is one click away)
 * without taking its layout, because Apple has three facts of three different
 * kinds and we have up to six of exactly one kind.
 *
 * THE FOUR QUESTIONS THIS SCRATCH EXISTS TO SETTLE, in the order they decide
 * whether the redesign is worth building at all:
 *
 *  1. DOES THE NUMBER FIT? The proposal puts the remaining percentage in the
 *     middle of the ring. The glyph box is 14px and the ring's inner diameter
 *     is about ten device pixels, so two digits are being asked to live in a
 *     space smaller than the `⌘K` keycap's letter. "The band at real size" is
 *     the panel that answers this, and it is the only panel that can — every
 *     magnified view on this page flatters the number.
 *
 *     Note what the centre costs and what it buys, because the reference gets
 *     this trade the other way round. Apple's figure sits in a GAP AT THE TOP
 *     of the ring, which it can afford because its middle already holds the
 *     Wi-Fi fan — and that gap, with the one at the bottom for the dots,
 *     leaves its arc only 180° to say 0–100 in. Our middle is empty, so
 *     putting the figure there closes the ring over the top and hands the arc
 *     290° back. `Apple, transposed` is kept on the page purely so that
 *     difference can be seen rather than asserted.
 *
 *  2. WHAT HAPPENS BETWEEN ONE AND THREE WINDOWS? Codex meters a session and a
 *     week, Copilot only a month, OpenCode Go three spans at once, Claude Code
 *     two that we read and a third we do not. A glyph that is beautiful with
 *     two arcs and broken with one has not survived contact. "The walk" moves
 *     between those counts under its own animation rather than between page
 *     loads, which is where a variant that only works in still frames fails.
 *
 *  3. WHAT HAPPENS WITH SIX ACCOUNTS AT ONCE? The dots cap at three and the
 *     nested arcs cap at three, so both are lossy by construction. The
 *     question is not whether they lose facts — it is whether what survives
 *     still answers "am I about to hit a wall".
 *
 *  4. AND WHEN EVERYTHING IS CRITICAL? This is Apple's own recorded failure:
 *     when all the readings are low at once the combined icon turns into a
 *     smudge and you have to look twice. `all-critical` reproduces it with six
 *     accounts under a tenth. Look at that state hardest; it is the one that
 *     decides between "the ring reports one account" and "the ring reports
 *     them all".
 *
 * WHAT THIS SCRATCH DELIBERATELY DOES NOT DO is fetch anything. Where fresh
 * numbers come from is the ticket's open question and its own decision (re-read
 * at launch/focus/turn-end is the recommendation); the drawing has to be
 * settled first, because an icon nobody would want is not worth plumbing. Every
 * fixture here is a fixed snapshot at a fixed `now`, and the states that stand
 * in for staleness — `unread`, `failed` — are drawn, not simulated.
 *
 * THE POPOVER IS NOT REDESIGNED HERE. It stays the full breakdown, the way the
 * phone shows three separate icons once it is unfolded. The one thing the last
 * panel proposes adding to it is a PIN, because the glyph has to choose one
 * window out of as many as fourteen and "nearest to running out" is the right
 * choice roughly always and the wrong one exactly when someone is nursing a
 * particular window through a long Session.
 */

import { GaugeIcon } from "@phosphor-icons/react/dist/csr/Gauge";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { PushPinSlashIcon } from "@phosphor-icons/react/dist/csr/PushPinSlash";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { PauseIcon } from "@phosphor-icons/react/dist/csr/Pause";
import * as React from "react";
import type { UsageTone } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

import { NOW, STATES, STATE_BY_ID, WALK, type IconState } from "../usage-icon/fixtures";
import { iconLabel, iconReading, type IconReading, type PinnedWindow } from "../usage-icon/reading";
import { AppleRing, CANDIDATES, type Candidate } from "../usage-icon/variants";

export const title = "Usage limits icon (VC-376)";
export const note =
  "Arc for the amount, figure in the middle, beads below — at 14px, across every state the always-mounted button has to survive";

/** The real glyph size in the chrome band: `size-3.5` inside a `size-6` button. */
const REAL = 14;
/** Big enough to judge the drawing's geometry, and honest about being a lie. */
const LOUPE = 44;

/**
 * The variant the pin panel demonstrates with — looked up by id rather than by
 * position, so reordering the registry cannot silently change which drawing
 * that panel is arguing about.
 */
const PIN_CANDIDATE = CANDIDATES.find((candidate) => candidate.id === "centre-windows");

export default function UsageLimitsIconScratch() {
  return (
    <div className="flex flex-col gap-6 pb-12">
      <FidelityPanel />
      <BandPanel />
      <WalkPanel />
      <MatrixPanel />
      <PinPanel />
    </div>
  );
}

/* ------------------------------------------------------- 0. against the source */

/**
 * The transposed geometry beside the numbers the reference itself shows.
 *
 * Apple's own screenshot gives two data points, and both are checkable rather
 * than a matter of taste: at **50** the left arc is exactly full and the right
 * exactly empty, and at **16** the ink is a short stub at the BOTTOM of the
 * left arc. If our 50 does not land on the nine-o'clock-to-twelve half, the
 * fill is being distributed across the two arcs wrongly; if our 16 appears
 * anywhere but just above the bottom-left arc end, the fill is running the
 * wrong way round the circle.
 *
 * Drawn at 96px, which is the one place on this page where a magnified view is
 * the right tool: this panel is about whether the drawing is CORRECT, not
 * about whether it can be read.
 */
function FidelityPanel() {
  return (
    <Panel
      label="Against the reference"
      hint="Apple's own two frames, redrawn with our tokens. 50 should fill exactly the left arc; 16 should be a stub at its bottom end."
    >
      <div className="flex flex-wrap items-end gap-8">
        {[
          { remaining: 50, tone: "normal" as const, dots: 4 },
          { remaining: 16, tone: "critical" as const, dots: 4 },
          { remaining: 88, tone: "normal" as const, dots: 2 },
          { remaining: 4, tone: "critical" as const, dots: 0 },
        ].map((sample) => (
          <figure key={sample.remaining} className="flex flex-col items-center gap-2">
            <AppleRing
              reading={syntheticReading(sample.remaining, sample.tone, sample.dots)}
              size={96}
              label={`${sample.remaining}% left`}
            />
            <figcaption className="text-label text-muted-foreground">
              {sample.remaining}% left · {sample.dots} other accounts
            </figcaption>
          </figure>
        ))}
      </div>
    </Panel>
  );
}

/**
 * A reading built by hand rather than from a fixture.
 *
 * Only the fidelity panel uses this, and only because it needs the reference's
 * exact figures rather than a plausible account. Everywhere else on this page
 * the reading comes from real provider rows through the app's own
 * `usageLimitAccounts`, which is what keeps the glyph and the popover honest
 * about each other.
 */
function syntheticReading(remaining: number, tone: UsageTone, others: number): IconReading {
  const window = { id: "w", kind: "session" as const, label: "Session", remaining, tone };
  const account = {
    providerId: "sample",
    label: "Sample",
    windows: [window],
    binding: window,
  };
  return {
    kind: "read",
    lead: account,
    reported: window,
    pinned: false,
    others: Array.from({ length: others }, (_, index) => ({
      providerId: `other-${index}`,
      label: `Other ${index}`,
      windows: [],
      binding: null,
    })),
    othersTone: null,
  };
}

/* ------------------------------------------------- 1. the band, at real size */

/**
 * The only panel that decides anything.
 *
 * Every candidate sits in a real `size-6` ghost button, in a mock of the
 * chrome band's command cluster, beside a real ⌘K pill and the Gauge it would
 * replace. The neighbours are here so the comparison is the one that matters —
 * not "is this ring nice" but "does this ring belong in this row", which is a
 * question about optical weight and height, not about the drawing.
 */
function BandPanel() {
  const [stateId, setStateId] = React.useState("six-accounts");
  const active = STATE_BY_ID.get(stateId) ?? STATES[0];
  if (active === undefined) return null;
  const reading = iconReading(active.kind, active.accounts, NOW);

  return (
    <Panel
      label="The band, at real size"
      hint="24px button, 14px glyph — the same box every other control in this row gets. If a variant only works below, it does not work."
    >
      <StatePicker value={stateId} onChange={setStateId} />
      <p className="text-ui text-muted-foreground">{active.note}</p>

      {/* A stand-in for `CommandCluster`: same gap-1, same 22px pill, same
          ghost icon buttons, on a band-coloured strip. */}
      <div
        data-testid="band-strip"
        className="flex h-[38px] items-center justify-center gap-1 rounded-md border border-border/50 bg-background"
      >
        <MockCommandPill />
        <BandButton label="Usage limits (today)">
          <GaugeIcon className="size-3.5" />
        </BandButton>
        <span className="mx-1 h-4 w-px bg-border" />
        {/* Tightly wrapped so a screenshot can crop to just the glyphs: a clip
            of the whole band is mostly ⌘K pill, and shrinks the one thing
            worth looking at to nothing. */}
        <span data-testid="real-size-row" className="flex items-center gap-1">
          {CANDIDATES.map((candidate) => (
            <InBand key={candidate.id} candidate={candidate} reading={reading} />
          ))}
        </span>
      </div>

      {/* The same seven, at 44px. Everything here is a flattering lie about
          legibility and an honest account of geometry — use it to see what a
          shape IS, never to decide whether it can be read. */}
      <div data-testid="band-loupe" className="flex flex-wrap gap-4">
        {CANDIDATES.map((candidate) => (
          <figure key={candidate.id} className="flex w-44 flex-col gap-2">
            <div className="flex h-14 items-center justify-center rounded-md border border-border bg-background">
              {candidate.render({ reading, size: LOUPE, label: iconLabel(reading) })}
            </div>
            <figcaption className="flex flex-col gap-1">
              <span className="text-ui font-medium">{candidate.name}</span>
              <span className="text-label leading-snug text-muted-foreground">{candidate.bet}</span>
            </figcaption>
          </figure>
        ))}
      </div>

      <p className="text-label text-muted-foreground">
        Accessible name for this state:{" "}
        <code className="text-foreground">{iconLabel(reading)}</code>
      </p>
    </Panel>
  );
}

function MockCommandPill() {
  return (
    <span className="flex h-[22px] w-[280px] items-center gap-1 rounded-md border border-border/50 bg-foreground/10 px-2 text-ui text-muted-foreground">
      <MagnifyingGlassIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Search tickets and sessions</span>
      <kbd className="shrink-0 rounded-sm border border-border/70 bg-background/10 px-1 py-px font-sans text-label leading-none">
        ⌘K
      </kbd>
      <CaretDownIcon aria-hidden className="size-3 shrink-0" weight="bold" />
    </span>
  );
}

/** The real `Button` in the real size the chrome band gives it. */
function BandButton({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} title={label}>
      {children}
    </Button>
  );
}

/**
 * One candidate as the band would actually mount it.
 *
 * A `pill` candidate is not a glyph in the standard icon button — it IS the
 * control, wider than 24px — so wrapping it in `size-icon-sm` would hide the
 * exact thing it is here to show. It gets a ghost button sized to its content
 * instead, which is what adopting it would really mean.
 */
function InBand({ candidate, reading }: { candidate: Candidate; reading: IconReading }) {
  const label = iconLabel(reading);
  const glyph = candidate.render({ reading, size: REAL, label });
  if (candidate.chrome === "pill") {
    return (
      <Button variant="ghost" size="sm" className="h-6 px-0.5" aria-label={label} title={label}>
        {glyph}
      </Button>
    );
  }
  return <BandButton label={label}>{glyph}</BandButton>;
}

/* --------------------------------------------------------------- 2. the walk */

/**
 * The states, in motion.
 *
 * Question 2 from the header: a glyph does not only have to look right in each
 * state, it has to get between them without flickering — a window appearing,
 * an account signing out, an arc crossing from primary through amber to red.
 * The walk crosses every one of those boundaries on a timer so the transitions
 * are watched rather than imagined.
 *
 * The movement is 300ms of ease-out on the arc's own length, which is about as
 * much as window chrome may ask for, and it is off under `prefers-reduced-
 * motion` like the rest of the app. Toggle Reduce Motion in the OS and the
 * numbers still change; only the tweening stops.
 */
function WalkPanel() {
  const [index, setIndex] = React.useState(0);
  const [playing, setPlaying] = React.useState(true);

  React.useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setIndex((current) => (current + 1) % WALK.length), 1_500);
    return () => clearInterval(timer);
  }, [playing]);

  const stateId = WALK[index] ?? WALK[0] ?? "";
  const active = STATE_BY_ID.get(stateId);
  if (active === undefined) return null;
  const reading = iconReading(active.kind, active.accounts, NOW);

  return (
    <Panel
      label="The walk"
      hint="Nothing → one window → two → three → six accounts → down to spent → back to nothing. Watch the segment count change under its own animation."
    >
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => setPlaying((p) => !p)}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <div className="flex flex-wrap gap-1">
          {WALK.map((id, position) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setPlaying(false);
                setIndex(position);
              }}
              aria-pressed={position === index}
              className="rounded-full px-2 py-0.5 text-label text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
            >
              {STATE_BY_ID.get(id)?.name ?? id}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        {CANDIDATES.map((candidate) => (
          <figure key={candidate.id} className="flex w-32 flex-col items-center gap-2">
            <div className="flex h-12 w-full items-center justify-center rounded-md border border-border bg-background">
              {candidate.render({ reading, size: 36, label: iconLabel(reading), animate: true })}
            </div>
            {/* And the same frame at the size it will actually ship at, so the
                motion is judged where it will be seen and not only where it is
                comfortable to look at. */}
            <div className="flex h-8 w-full items-center justify-center rounded-md border border-border bg-background">
              {candidate.render({ reading, size: REAL, label: iconLabel(reading), animate: true })}
            </div>
            <figcaption className="text-label text-muted-foreground">{candidate.name}</figcaption>
          </figure>
        ))}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------- 3. the matrix */

/**
 * Every candidate against every state, at the size that ships.
 *
 * The three rows to read before any other: `unread` and `spent` next to each
 * other (a thin ring means "not measured", a fat empty track means "nothing
 * left" — if those two are hard to tell apart the notation is broken at its
 * root), and `all-critical`, which is Apple's smudge.
 */
function MatrixPanel() {
  return (
    <Panel
      label="Every state"
      hint="Real size in a real button, and a loupe beside it. Compare `Nothing read yet` against `Spent`, then look at `Everything critical`."
    >
      <div data-testid="matrix" className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-card p-2 text-label font-normal uppercase text-muted-foreground">
                State
              </th>
              {CANDIDATES.map((candidate) => (
                <th
                  key={candidate.id}
                  className="p-2 text-label font-normal uppercase text-muted-foreground"
                >
                  {candidate.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {STATES.map((entry) => (
              <MatrixRow key={entry.id} state={entry} />
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function MatrixRow({ state }: { state: IconState }) {
  const reading = iconReading(state.kind, state.accounts, NOW);
  const label = iconLabel(reading);
  return (
    <tr className="border-t border-border/60 align-top">
      <th scope="row" className="sticky left-0 z-10 w-56 bg-card p-2 font-normal">
        <span className="block text-ui font-medium">{state.name}</span>
        <span className="block text-label leading-snug text-muted-foreground">{state.note}</span>
      </th>
      {CANDIDATES.map((candidate) => (
        <td key={candidate.id} className="p-2">
          <div className="flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-md border border-dashed border-border/70">
              {candidate.render({ reading, size: REAL, label })}
            </span>
            {candidate.render({ reading, size: 30, label })}
          </div>
        </td>
      ))}
    </tr>
  );
}

/* ---------------------------------------------------------------- 4. the pin */

/**
 * WHICH WINDOW THE GLYPH REPORTS, AND HOW TO OVERRULE IT.
 *
 * With six accounts of two or three windows each there are up to fourteen
 * numbers and one arc, so the glyph must choose. Unpinned it reports whatever
 * is nearest to running out, which `accounts.ts` already computes for the
 * popover's collapsed rows — no new rule, and the glyph and the top row of the
 * popover can never disagree.
 *
 * That default is right nearly always and wrong in one specific, common case:
 * a long Session where the five-hour window is the one you are nursing, while
 * some other account's monthly meter happens to sit lower and therefore owns
 * the arc. The pin is the escape hatch — press the pin on any row and the
 * glyph reports that window until you unpin it.
 *
 * IT IS A LENS, NOT A FACT. Pinning changes which window is DRAWN, never which
 * window is binding, never the sort, never the popover's contents. A pin whose
 * account signs out or whose window the provider stops reporting falls back to
 * the default silently rather than blanking the glyph, because the pin is a
 * preference about a drawing and not a promise the provider made.
 *
 * The rows below are a stand-in for the popover's own, not a redesign of it —
 * the popover is explicitly out of scope, and the only thing this panel
 * proposes adding to it is the pin button at the end of each window row.
 */
function PinPanel() {
  const state = STATE_BY_ID.get("six-accounts");
  const [pin, setPin] = React.useState<PinnedWindow | null>(null);
  if (state === undefined) return null;
  const reading = iconReading(state.kind, state.accounts, NOW, pin);

  return (
    <Panel
      label="Which window the arc reports — and pinning one"
      hint="Six accounts, fourteen numbers, one arc. Unpinned it follows whatever is nearest to running out; a pin overrules it until you take the pin off."
    >
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex flex-col items-center gap-2">
          <div className="flex h-[38px] items-center gap-1 rounded-md border border-border/50 bg-background px-2">
            <BandButton label={iconLabel(reading)}>
              {PIN_CANDIDATE?.render({
                reading,
                size: REAL,
                label: iconLabel(reading),
                animate: true,
              })}
            </BandButton>
          </div>
          {PIN_CANDIDATE?.render({
            reading,
            size: LOUPE,
            label: iconLabel(reading),
            animate: true,
          })}
          <p className="max-w-40 text-center text-label text-muted-foreground">
            {reading.pinned ? "Pinned" : "Nearest to running out"}
            {reading.reported === null ? "" : ` · ${reading.lead?.label} ${reading.reported.label}`}
          </p>
          {pin === null ? null : (
            <Button variant="ghost" size="sm" onClick={() => setPin(null)}>
              <PushPinSlashIcon />
              Unpin
            </Button>
          )}
        </div>

        <ul className="min-w-72 flex-1 divide-y divide-border/60 rounded-md border border-border">
          {state.accounts.map((account) => (
            <li key={account.providerId} className="p-2">
              <p className="pb-1 text-ui font-medium">{account.label}</p>
              <ul className="flex flex-col gap-0.5">
                {account.limits.windows.map((window) => {
                  const pinned =
                    pin?.providerId === account.providerId && pin.windowId === window.id;
                  const reported =
                    reading.lead?.providerId === account.providerId &&
                    reading.reported?.id === window.id;
                  return (
                    <li key={window.id} className="flex items-center gap-2">
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-ui",
                          reported ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {window.label}
                      </span>
                      <span className="shrink-0 text-ui tabular-nums text-muted-foreground">
                        {Math.round(100 - window.usedPercent)}% left
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={pinned ? `Unpin ${window.label}` : `Pin ${window.label}`}
                        aria-pressed={pinned}
                        onClick={() =>
                          setPin(
                            pinned ? null : { providerId: account.providerId, windowId: window.id },
                          )
                        }
                      >
                        <PushPinIcon
                          weight={pinned ? "fill" : "regular"}
                          className={pinned ? "text-foreground" : "text-muted-foreground"}
                        />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ plumbing */

function StatePicker({ value, onChange }: { value: string; onChange(next: string): void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {STATES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => onChange(entry.id)}
          aria-pressed={entry.id === value}
          className="rounded-full px-2.5 py-0.5 text-label text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
        >
          {entry.name}
        </button>
      ))}
    </div>
  );
}

function Panel({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-card p-4 shadow-raised">
      <header className="flex flex-col gap-1">
        <h2 className="font-mono text-label uppercase text-muted-foreground">{label}</h2>
        <p className="text-ui text-muted-foreground">{hint}</p>
      </header>
      {children}
    </section>
  );
}
