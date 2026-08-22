/**
 * VC-111 — Settings & Configure, reorganized.
 *
 * Run: `pnpm lab` → "Settings & Configure, reorganized".
 *
 * ── WHAT TO LOOK AT, IN ORDER ─────────────────────────────────────────────
 *
 *  1. **Configure → Skills / Commands / MCP / Plugins.** The brief's ask, and
 *     the reason the redesign exists. Skills and Commands are not speculative:
 *     `main/skills.ts` and `main/prompt-templates.ts` already read those
 *     directories and merge them project-over-personal. They have simply never
 *     been visible. Each is a bounded table with provenance as a COLUMN and one
 *     filter, rather than a "This project" pill repeated down every row.
 *
 *  2. **Configure → Sessions.** Divergence from the app-wide value is said once,
 *     by a control: an inheriting row shows its value, an overridden one grows a
 *     revert button that names what it would go back to. There is no scope mode
 *     to enter first — choosing a value IS overriding. Precedence lives in the
 *     header's (i).
 *
 *  3. **Settings → Models.** A hundred-model catalogue as a capped table, so
 *     Accounts below it is still reachable. Provider is a column, which is what
 *     tells the two `gpt-5.6-luna` rows apart.
 *
 *  4. **Settings → Updates.** One row replaces the `sqlite3` command that
 *     `main/auto-update.ts` currently tells you to run by hand.
 *
 *  5. **Settings → About.** All of diagnostics: a headline, and a row per fault
 *     ACTUALLY PRESENT, each with its own remedy. Healthy machines get one
 *     sentence; this fixture is deliberately broken so the concise version can
 *     be judged against the case it has to survive.
 *
 *  6. **The rail.** Grouped and searchable, and the group labels are where the
 *     Settings-vs-Configure relationship is finally written down.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * TWO CONTROLS BELOW ARE LAB CHROME, not proposals:
 *
 *  - The **surface switch**. In the app these stay two entry points — the
 *    sidebar-footer gear and the project nav tab. It is here so the two can be
 *    compared without leaving the page.
 *  - The **data state**. Every collection is asynchronous, failable and empty
 *    before it is full, and `AsyncSection` exists to say so — but with every
 *    pane passing `ready(...)` those branches never rendered once. This drives
 *    all four through every table on both surfaces, which is the only way to
 *    judge whether the empty copy reads well and the error is actionable.
 *
 * No stores and no bridge: every value is local state, so nothing here can
 * write to the real app.
 */
import * as React from "react";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";

import { SectionHeading } from "@renderer/components/ui/section-heading";
import { Segmented } from "@renderer/components/ui/segmented";
import { TooltipProvider } from "@renderer/components/ui/tooltip";

import { PrefShell } from "../settings/kit";
import { CONFIGURE_GROUPS } from "../settings/panes-configure";
import { FixtureProvider, type FixtureMode } from "../settings/fixtures";
import { SETTINGS_GROUPS } from "../settings/panes-settings";

type Surface = "settings" | "configure";

/**
 * The rail's masthead — the surface's identity, above the search.
 *
 * It sits here rather than inside the pane because the thing being configured
 * does not change as you move down the rail. Today's Configure demonstrates the
 * alternative: it has no masthead, so it titles its first SECTION with the
 * project's name and the scope is announced by whichever card happens to be
 * first.
 */
function Masthead({ surface }: { surface: Surface }) {
  const Icon = surface === "settings" ? GearSixIcon : FolderIcon;
  return (
    <div className="flex items-center gap-2">
      <div className="flex size-7 items-center justify-center rounded-md bg-accent">
        <Icon className="size-4 text-foreground" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">
          {surface === "settings" ? "Settings" : "volli-code"}
        </p>
        {/*
         * Settings gets NO subtitle, and that is a correction the prototype
         * earned. It first read "Settings / ALL PROJECTS", which contradicts
         * itself the moment you flip a pane's `ScopeBar` to one project — the
         * masthead would be claiming a scope the pane had already left. Scope
         * belongs to the pane (rule 2); the masthead only says which surface
         * you are on. Configure keeps its eyebrow because "volli-code" alone
         * does not say what kind of thing it is naming.
         */}
        {surface === "configure" ? <SectionHeading as="p">Project</SectionHeading> : null}
      </div>
    </div>
  );
}

export default function SettingsRedesign() {
  const [surface, setSurface] = React.useState<Surface>("settings");
  const [settingsKey, setSettingsKey] = React.useState("appearance");
  const [configureKey, setConfigureKey] = React.useState("skills");
  const [dataMode, setDataMode] = React.useState<FixtureMode>("ready");

  const isSettings = surface === "settings";

  return (
    // The app mounts this once at its root; a scratch borrowing any component
    // that carries a hover helper has to mount its own, or the pane throws and
    // renders an empty box. `PrefRow`'s `help` is exactly such a component, and
    // Models and Updates both use it.
    <TooltipProvider delayDuration={200}>
      <div className="flex h-svh w-full flex-col bg-background text-foreground">
        {/* Lab chrome. Not part of the proposal — see the module header. */}
        <div className="flex shrink-0 items-center justify-start gap-4 border-b border-dashed border-border/70 px-4 py-2">
          <Segmented
            ariaLabel="Prototype surface"
            size="default"
            value={surface}
            options={[
              { key: "settings", label: "Settings", icon: GearSixIcon },
              { key: "configure", label: "Configure", icon: FolderIcon },
            ]}
            onChange={(key) => setSurface(key as Surface)}
          />
          <Segmented
            ariaLabel="Fixture data state"
            value={dataMode}
            options={[
              { key: "ready", label: "Ready" },
              { key: "loading", label: "Loading" },
              { key: "error", label: "Error" },
              { key: "empty", label: "Empty" },
            ]}
            onChange={(key) => setDataMode(key as FixtureMode)}
          />
        </div>

        <div className="flex min-h-0 flex-1">
          <FixtureProvider mode={dataMode}>
            <PrefShell
              key={surface}
              header={<Masthead surface={surface} />}
              surfaceLabel={isSettings ? "Settings" : "Configure"}
              groups={isSettings ? SETTINGS_GROUPS : CONFIGURE_GROUPS}
              activeKey={isSettings ? settingsKey : configureKey}
              onSelect={isSettings ? setSettingsKey : setConfigureKey}
            />
          </FixtureProvider>
        </div>
      </div>
    </TooltipProvider>
  );
}

export const title = "Settings & Configure, reorganized";
export const note = "VC-111 — scope as one control, agent config in Configure, concise diagnostics";
export const viewport = "window" as const;
