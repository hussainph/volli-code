/**
 * The theming engine, on the front end — a live switcher over the shipped
 * catalog plus any seed you type, with the generator's own readability claims
 * re-measured against whatever is currently on screen.
 *
 * This is a *test*, not a swatch board, and the distinction is the point.
 * Volli's themes are generated, not authored (CLAUDE.md; decisions #66–#78):
 * `generateThemeTokens()` derives every color from one seed, and the whole
 * value of that design rests on a claim — that no theme can come out less
 * readable than any other, because the solver hits a contrast floor for each
 * foreground rather than trusting a palette. A grid of pretty swatches cannot
 * check that claim. Re-solving the APCA scores from the applied tokens can, and
 * it does it for seeds nobody has ever tried.
 *
 * The floors below are read off `theme/generate.ts` (steps 5–7), so this table
 * says what that module says. Two honest caveats it will show you rather than
 * hide:
 *
 *   • Authored `overrides` land AFTER every floor, on purpose — a theme is
 *     allowed to break its own contrast, because the guards exist to stop the
 *     math producing something unreadable, not to overrule a person. An
 *     overridden token that fails here is not a bug; it is the override.
 *   • Border tokens are absent by design. APCA low-clips below Lc ~10 and
 *     cannot score a hairline, so measuring them would produce a number that
 *     means nothing.
 *
 * What you pick here STAYS picked. It becomes the lab's standing theme (see
 * theme-choice.ts) rather than a preview that unwinds on unmount, so you can
 * choose a seed here and then go look at it on the App shell, the Board and
 * the Chrome band — which is where a theme is actually judged. A picker that
 * reverted on exit could only ever be judged against its own swatches.
 */
import * as React from "react";
import {
  apcaLc,
  DEFAULT_THEME,
  generateThemeTokens,
  isHexColor,
  THEME_TOKEN_NAMES,
  type ThemeDefinition,
  type ThemeTokenName,
  type ThemeTokens,
} from "@volli/shared";

import { TicketCardContent } from "@renderer/components/board/ticket-card";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { BUILTIN_THEMES } from "@renderer/theme/catalog";

import { project, ticketById } from "../fixtures";
import { appApi, seedApp } from "../seed";
import { labTheme, setLabTheme } from "../theme-choice";

export const title = "Theming";
export const note = "Live theme switch + the generator's contrast floors, re-measured";

export const seed = seedApp;
export const api = appApi;

/**
 * The generator's declared floors, as pairs of {text token, surface token}.
 * Each row restates one solve in `generateThemeTokens` — if a floor moves
 * there, this table is wrong until it moves here too, which is the intended
 * failure mode: a silent disagreement would be a test that passes for the
 * wrong reason.
 */
const CONTRAST_FLOORS: readonly {
  text: ThemeTokenName;
  surface: ThemeTokenName;
  floor: number;
  what: string;
}[] = [
  { text: "--foreground", surface: "--background", floor: 90, what: "Body copy" },
  { text: "--muted-foreground", surface: "--background", floor: 60, what: "Secondary copy" },
  { text: "--sidebar-foreground", surface: "--sidebar", floor: 75, what: "Sidebar nav" },
  { text: "--primary-text", surface: "--background", floor: 60, what: "Accent as text" },
  { text: "--primary-foreground", surface: "--primary", floor: 60, what: "Button label" },
];

/** A theme built from a raw seed — everything else stays the shipped defaults. */
function seedTheme(seedHex: string): ThemeDefinition {
  return { ...DEFAULT_THEME, name: `Seed ${seedHex}`, slug: "lab-seed", seed: seedHex };
}

function ContrastTable({ tokens }: { tokens: ThemeTokens }) {
  return (
    <table className="w-full border-collapse text-ui">
      <thead>
        <tr className="border-b border-border text-label uppercase text-muted-foreground">
          <th className="py-2 text-left font-medium">Pair</th>
          <th className="py-2 text-left font-medium">Text on surface</th>
          <th className="py-2 text-right font-medium">Lc</th>
          <th className="py-2 text-right font-medium">Floor</th>
          <th className="py-2 text-right font-medium">Result</th>
        </tr>
      </thead>
      <tbody>
        {CONTRAST_FLOORS.map(({ text, surface, floor, what }) => {
          const textHex = tokens[text];
          const surfaceHex = tokens[surface];
          // APCA returns a signed polarity; the floors are magnitudes.
          const lc = Math.abs(apcaLc(textHex, surfaceHex));
          const passes = lc >= floor;
          return (
            <tr key={`${text}-on-${surface}`} className="border-b border-border/50">
              <td className="py-2 text-foreground">{what}</td>
              <td className="py-2">
                <span
                  className="inline-flex items-center rounded-md px-2 py-1 font-mono text-label"
                  style={{ background: surfaceHex, color: textHex }}
                >
                  {text} on {surface}
                </span>
              </td>
              <td className="py-2 text-right font-mono tabular-nums text-foreground">
                {lc.toFixed(1)}
              </td>
              <td className="py-2 text-right font-mono tabular-nums text-muted-foreground">
                {floor}
              </td>
              <td
                className={`py-2 text-right font-medium ${passes ? "text-foreground" : "text-destructive"}`}
              >
                {passes ? "clears" : "BELOW"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TokenGrid({ tokens }: { tokens: ThemeTokens }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-3">
      {THEME_TOKEN_NAMES.map((name) => (
        <div key={name} className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className="size-4 shrink-0 rounded border border-border"
            style={{ background: tokens[name] }}
          />
          <span className="min-w-0 flex-1 truncate font-mono text-label text-muted-foreground">
            {name}
          </span>
          <span className="shrink-0 font-mono text-label text-muted-foreground/70">
            {tokens[name]}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function ThemingScratch() {
  // Seeded from the standing choice so re-entering the scratch shows what is
  // actually on screen rather than resetting the controls to Ember.
  const stored = labTheme();
  const [seedInput, setSeedInput] = React.useState(
    BUILTIN_THEMES.some((candidate) => candidate.slug === stored.slug) ? "" : stored.seed,
  );
  const [activeSlug, setActiveSlug] = React.useState(stored.slug);

  const customSeed = isHexColor(seedInput) ? seedInput : null;
  const theme = React.useMemo(
    () =>
      customSeed !== null
        ? seedTheme(customSeed)
        : (BUILTIN_THEMES.find((candidate) => candidate.slug === activeSlug) ?? DEFAULT_THEME),
    [customSeed, activeSlug],
  );
  const tokens = React.useMemo(() => generateThemeTokens(theme), [theme]);

  // No cleanup on purpose: this commits the lab's theme rather than previewing
  // it, so leaving the scratch must NOT put the old one back. See the module
  // note — carrying the choice to the other scratches is the point.
  React.useEffect(() => {
    setLabTheme(theme);
  }, [theme]);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-label uppercase text-muted-foreground">Theme</h2>
        <div className="flex flex-wrap items-center gap-2">
          {BUILTIN_THEMES.map((candidate) => (
            <button
              key={candidate.slug}
              type="button"
              onClick={() => {
                setSeedInput("");
                setActiveSlug(candidate.slug);
              }}
              aria-pressed={customSeed === null && candidate.slug === activeSlug}
              className="flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-ui text-muted-foreground transition-colors hover:text-foreground aria-pressed:border-primary aria-pressed:text-foreground"
            >
              <span
                aria-hidden
                className="size-3 rounded-full"
                style={{ background: candidate.seed }}
              />
              {candidate.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Input
            value={seedInput}
            onChange={(event) => setSeedInput(event.target.value)}
            placeholder="#3f9142 — any seed, generated live"
            className="w-64 font-mono"
            spellCheck={false}
          />
          <p className="text-label text-muted-foreground">
            {seedInput.length === 0
              ? "A seed nobody has tried is the case worth testing."
              : (customSeed ?? "not a hex color — showing the selected theme")}
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-label uppercase text-muted-foreground">
          Contrast floors — measured from the applied tokens
        </h2>
        <ContrastTable tokens={tokens} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-label uppercase text-muted-foreground">On real components</h2>
        {/* Swatches agree with every theme. Components are where a seed that
            technically clears its floors still turns out to look wrong. */}
        <div className="flex flex-wrap items-start gap-6">
          <div className="w-72">
            <TicketCardContent ticket={ticketById("tkt-14")} ticketPrefix={project.ticketPrefix} />
          </div>
          <div className="flex flex-col items-start gap-2">
            <Button>Create &amp; start</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Delete</Button>
          </div>
          <div className="flex min-w-56 flex-col gap-1 rounded-lg bg-sidebar p-2">
            <p className="px-2 py-1 text-label uppercase text-muted-foreground">Sidebar</p>
            <p className="rounded-md bg-sidebar-accent px-2 py-1.5 text-ui text-sidebar-accent-foreground">
              Selected row
            </p>
            <p className="px-2 py-1.5 text-ui text-sidebar-foreground">Ordinary row</p>
            <p className="px-2 py-1.5 text-ui text-muted-foreground">Dimmed row</p>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-label uppercase text-muted-foreground">
          Generated token set ({THEME_TOKEN_NAMES.length})
        </h2>
        <TokenGrid tokens={tokens} />
      </section>
    </div>
  );
}
