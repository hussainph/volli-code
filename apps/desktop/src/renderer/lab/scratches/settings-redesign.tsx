/**
 * VC-111 — Settings & Configure, reorganized.
 *
 * Run: `pnpm lab` → "Settings & Configure, reorganized".
 *
 * ── WHAT TO LOOK AT, IN ORDER ─────────────────────────────────────────────
 *
 *  1. **Settings → Appearance.** Flip "Applies to" at the top of the pane.
 *     That one control is the answer to the ticket's headline complaint. At
 *     *All projects* the bar tells you what this project has overridden; at
 *     *volli-code* every scopeable row grows the SAME Inherit/Custom switch in
 *     the SAME place, and Inherit names the value it inherits instead of going
 *     blank. Today that question is asked three different ways within one page
 *     (per-row, per-section-header, and not at all), across two surfaces.
 *
 *  2. **Configure → Skills / Commands / MCP / Plugins.** The brief's ask.
 *     Skills and Commands are not speculative — `main/skills.ts` and
 *     `main/prompt-templates.ts` already read those directories on every
 *     composer open and merge them project-over-personal. They have simply
 *     never been visible. MCP and Plugins are the new plumbing.
 *
 *  3. **Settings → Updates.** One `Segmented` row replaces the `sqlite3`
 *     command that `main/auto-update.ts` currently tells you to run by hand.
 *
 *  4. **Settings → About.** All of diagnostics: one sentence, one button,
 *     internals behind a disclosure. Compare against today's CLI pane, which
 *     shows a socket path, a bin dir, a shell-chain boolean and a PATH table.
 *     The second card is the failure state, so the concise version can be
 *     judged against the case it actually has to survive.
 *
 *  5. **The rail.** Grouped, searchable, and the group labels are where the
 *     Settings-vs-Configure relationship is finally written down.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The switcher below is LAB CHROME, not a proposal. In the app these stay two
 * entry points — the sidebar-footer gear and the project nav tab. It is here so
 * the two can be compared without leaving the page, which is the whole reason
 * to prototype them together.
 *
 * No stores and no bridge: every value is local state, so nothing here can
 * repaint the real app or be mistaken for wired-up behaviour.
 */
import * as React from "react";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";

import { SectionHeading } from "@renderer/components/ui/section-heading";
import { Segmented } from "@renderer/components/ui/segmented";
import { TooltipProvider } from "@renderer/components/ui/tooltip";

import { PrefShell } from "../settings/kit";
import { CONFIGURE_GROUPS } from "../settings/panes-configure";
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

  const isSettings = surface === "settings";

  return (
    // The app mounts this once at its root; a scratch borrowing any component
    // that carries a hover helper has to mount its own, or the pane throws and
    // renders an empty box. `PrefRow`'s `help` is exactly such a component, and
    // Models and Updates both use it.
    <TooltipProvider delayDuration={200}>
      <div className="flex h-svh w-full flex-col bg-background text-foreground">
        {/* Lab chrome. Not part of the proposal — see the module header. */}
        <div className="flex shrink-0 items-center justify-center border-b border-dashed border-border/70 px-4 py-2">
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
        </div>

        <div className="flex min-h-0 flex-1">
          <PrefShell
            key={surface}
            header={<Masthead surface={surface} />}
            groups={isSettings ? SETTINGS_GROUPS : CONFIGURE_GROUPS}
            activeKey={isSettings ? settingsKey : configureKey}
            onSelect={isSettings ? setSettingsKey : setConfigureKey}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

export const title = "Settings & Configure, reorganized";
export const note = "VC-111 — scope as one control, agent config in Configure, concise diagnostics";
export const viewport = "window" as const;
