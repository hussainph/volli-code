/**
 * The lab's own chrome: a scratch picker, a width control, and the stage the
 * selected scratch renders into.
 *
 * Two rules keep it from becoming a second app to maintain:
 *
 *  1. It is styled with the app's tokens (so the stage's surroundings do not
 *     lie about contrast) but is visibly *not* the app — the picker is plain,
 *     unbranded chrome. You should never mistake a lab screenshot for a
 *     product screenshot.
 *  2. It owns no product state — but it does own scratch ISOLATION. Each
 *     scratch declares its store seeding and bridge stubs (see scratch.ts) and
 *     the shell applies exactly one scratch's setup at a time, so a scratch can
 *     never leave state behind that changes how the next one renders.
 *
 * The width control exists because most "does this feel right?" questions are
 * really proportion questions: `app` is the app's real default window width,
 * `reading` is the `ContentColumn` measure from docs/DESIGN.md, and `full`
 * is for surfaces that genuinely stretch.
 */
import * as React from "react";

import { installFakeApi } from "./fake-api";
import { isScratchModule, slugFromPath, type ScratchModule } from "./scratch";
import { LabThemeToolbar, useLabThemeController, type LabThemeController } from "./theme-toolbar";

/**
 * Eager, so the picker can list every scratch's title without loading them
 * lazily one navigation at a time, and so a scratch that fails to compile
 * fails loudly at load rather than when you happen to click it. Importing all
 * of them is only safe because setup is declared, not run on import (see
 * scratch.ts) — a scratch must have no module-level side effects.
 */
const modules = import.meta.glob("./scratches/*.tsx", { eager: true });

interface Scratch extends ScratchModule {
  slug: string;
}

const scratches: Scratch[] = Object.entries(modules)
  .flatMap(([path, module]) =>
    isScratchModule(module) ? [{ ...module, slug: slugFromPath(path) }] : [],
  )
  .toSorted((a, b) => a.title.localeCompare(b.title));

const STAGE_WIDTHS = {
  app: { label: "App", width: 1280 },
  reading: { label: "Reading", width: 720 },
  full: { label: "Full", width: null },
} as const;

type StageWidth = keyof typeof STAGE_WIDTHS;

/** Current URL hash, minus the `#`. Subscribed rather than read once so back/forward work. */
function useHashSlug(): string {
  return React.useSyncExternalStore(
    (onChange) => {
      window.addEventListener("hashchange", onChange);
      return () => window.removeEventListener("hashchange", onChange);
    },
    () => window.location.hash.slice(1),
  );
}

/**
 * Applies the active scratch's declared setup — bridge stubs, then store
 * seeding — exactly once per activation.
 *
 * Deliberately during render rather than in an effect: effects run AFTER
 * children mount, so a scratch's components would fire their first data reads
 * against the *previous* scratch's stubs and paint one frame of the wrong
 * state. The ref guard is what keeps it idempotent, which is also what makes
 * it safe under StrictMode's double render.
 */
function useScratchSetup(active: Scratch | null): void {
  const applied = React.useRef<string | null>(null);
  if (active !== null && applied.current !== active.slug) {
    applied.current = active.slug;
    // Installed wholesale, never merged: the previous scratch's stubs must not
    // survive into this one.
    installFakeApi(active.api ?? {});
    active.seed?.();
  }
}

/**
 * A `viewport: "window"` scratch, given the whole viewport with the lab's own
 * chrome reduced to one floating control.
 *
 * The control is `fixed` with a high z-index because the surface underneath is
 * a full app shell that owns its own stacking contexts — anything merely
 * "after" it in the DOM would end up beneath it.
 */
function WindowStage({ scratch, theme }: { scratch: Scratch; theme: LabThemeController }) {
  return (
    <>
      {/* Keyed on the slug for the same reason the stage below is: switching
          scratches must remount rather than reconcile. */}
      <div key={scratch.slug} className="h-svh w-full">
        <scratch.default />
      </div>
      <LabThemeToolbar controller={theme} floating />
      {/* Bottom-RIGHT: the app's own bottom-left is the sidebar's pinned
          Settings row, and a lab control sitting on top of a real affordance
          is a control you will eventually mistake for one. */}
      <a
        href="#"
        className="fixed right-3 bottom-3 z-[9999] flex items-center gap-2 rounded-full border border-border bg-background/90 px-3 py-1.5 text-label text-muted-foreground shadow-overlay backdrop-blur transition-colors hover:text-foreground"
      >
        <span aria-hidden>←</span>
        <span>Lab</span>
        <span className="text-foreground">{scratch.title}</span>
      </a>
    </>
  );
}

export function LabShell() {
  const slug = useHashSlug();
  const [stageWidth, setStageWidth] = React.useState<StageWidth>("app");
  const active = scratches.find((scratch) => scratch.slug === slug) ?? null;
  const stage = STAGE_WIDTHS[stageWidth];

  useScratchSetup(active);
  const theme = useLabThemeController(active?.slug ?? null);

  if (active !== null && active.viewport === "window") {
    return <WindowStage scratch={active} theme={theme} />;
  }

  return (
    <div className="flex h-svh w-full bg-background text-foreground">
      <nav className="flex w-56 shrink-0 flex-col gap-px overflow-y-auto border-r border-border p-2">
        <p className="px-2 pb-2 pt-1 font-mono text-label uppercase text-muted-foreground">Lab</p>
        {scratches.map((scratch) => (
          <a
            key={scratch.slug}
            href={`#${scratch.slug}`}
            aria-current={scratch.slug === active?.slug ? "page" : undefined}
            className="rounded-md px-2 py-1.5 text-ui text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:text-foreground"
          >
            {scratch.title}
          </a>
        ))}
        {scratches.length === 0 ? (
          <p className="px-2 text-ui text-muted-foreground">
            No scratches yet — add a file to <code>lab/scratches/</code>.
          </p>
        ) : null}
      </nav>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-2">
          <div className="min-w-0">
            <h1 className="truncate text-ui font-medium text-foreground">
              {active?.title ?? "Pick a scratch"}
            </h1>
            {active?.note ? (
              <p className="truncate text-label text-muted-foreground">{active.note}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <LabThemeToolbar controller={theme} />
            <div className="flex items-center gap-1 border-l border-border pl-2">
              {(Object.keys(STAGE_WIDTHS) as StageWidth[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setStageWidth(key)}
                  aria-pressed={key === stageWidth}
                  className="rounded-full px-2.5 py-0.5 text-label text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
                >
                  {STAGE_WIDTHS[key].label}
                </button>
              ))}
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-auto p-6">
          {active ? (
            // Keyed on the slug so switching scratches remounts rather than
            // reconciles — a scratch's local state must never bleed into the
            // next one's first paint.
            <div
              key={active.slug}
              className="mx-auto"
              style={stage.width === null ? undefined : { maxWidth: stage.width }}
            >
              <active.default />
            </div>
          ) : (
            <p className="text-ui text-muted-foreground">
              {scratches.length > 0
                ? "Choose a scratch on the left."
                : "Add a file to lab/scratches/ to get started."}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
