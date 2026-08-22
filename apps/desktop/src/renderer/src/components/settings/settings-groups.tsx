/**
 * The Settings rail: three groups, nine categories, app-wide always.
 *
 * THE GROUPS CARRY THE RELATIONSHIP. Preferences is what you like, Services is
 * what Volli talks to on your behalf, System is the install itself. A flat list
 * of nine is a list you read top to bottom every time; three groups of three is
 * a structure you learn once.
 *
 * `keywords` is hand-maintained and guarded — `vc111-settings-search.mjs` walks
 * every row label on both surfaces and fails if one cannot be reached from rail
 * search. Keep it green when you add rows.
 */
import { BellIcon } from "@phosphor-icons/react/dist/csr/Bell";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { PlugsIcon } from "@phosphor-icons/react/dist/csr/Plugs";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";

import { AppearanceSettings } from "@renderer/components/pages/appearance-settings";
import { ModelAccessSettings } from "@renderer/components/pages/model-access-settings";
import { WebAccessSettings } from "@renderer/components/pages/web-access-settings";
import type { PrefGroup } from "@renderer/components/settings/kit";
import { AboutPane } from "./panes/about-pane";
import { DisplaySection } from "./panes/display-section";
import { GeneralPane } from "./panes/general-pane";
import { IntegrationsPane } from "./panes/integrations-pane";
import { NotificationsPane } from "./panes/notifications-pane";
import { StoragePane } from "./panes/storage-pane";
import { UpdatesPane } from "./panes/updates-pane";

/**
 * The Models category key.
 *
 * It was `"model-access"`, and `chat-plane.tsx` deep-links here to open a
 * provider sign-in. Renaming it without an alias would have sent that link to
 * General — see `resolveSettingsCategory`, which keeps the old key working.
 */
export const MODELS_CATEGORY_KEY = "models";

/** The old key the chat blocker's deep link still uses. */
export const LEGACY_MODELS_CATEGORY_KEY = "model-access";

/**
 * Resolves a stored or deep-linked category key against the current rail.
 *
 * Kept as a named function rather than inlined because the alias is a
 * compatibility fact with a caller outside this folder, and a `??` buried in a
 * component is not somewhere anyone looks for one.
 */
export function resolveSettingsCategory(key: string | undefined): string | undefined {
  if (key === LEGACY_MODELS_CATEGORY_KEY) return MODELS_CATEGORY_KEY;
  return key;
}

export function settingsGroups(signInProviderId?: string): readonly PrefGroup[] {
  return [
    {
      key: "preferences",
      label: "Preferences",
      categories: [
        {
          key: "general",
          label: "General",
          icon: GearSixIcon,
          keywords: [
            "window",
            "show the project switcher",
            "project switcher",
            "keep the sidebar open",
            "sidebar",
            "rail",
          ],
          content: <GeneralPane />,
        },
        {
          key: "appearance",
          label: "Appearance",
          icon: PaletteIcon,
          keywords: [
            "theme",
            "dark",
            "light",
            "mode",
            "canvas",
            "vibrancy",
            "grain",
            "zoom",
            "font",
            "terminal",
            "diff",
            "ghostty",
            "overlay",
            "display",
            "config files",
            "layout",
            "side by side",
            "inline",
            // The full row labels. Rail search matches a keyword that CONTAINS
            // what was typed, so a reader typing a label they can see needs the
            // whole phrase here — "diff" alone does not match "Diff layout".
            "app theme",
            "diff layout",
            "font family",
            "font size",
            "config file",
          ],
          content: (
            <>
              <AppearanceSettings />
              <DisplaySection />
            </>
          ),
        },
        {
          key: "notifications",
          label: "Notifications",
          icon: BellIcon,
          keywords: [
            "notify me",
            "alert",
            "banner",
            "an agent needs my input",
            "a session finishes",
            "volli reclaims a worktree",
            "an update is ready",
          ],
          content: <NotificationsPane />,
        },
      ],
    },
    {
      key: "services",
      label: "Services",
      categories: [
        {
          key: MODELS_CATEGORY_KEY,
          label: "Models",
          icon: CpuIcon,
          keywords: [
            "model",
            "provider",
            "anthropic",
            "openai",
            "codex",
            "compaction",
            "reserve",
            "reasoning",
            "sign in",
            "account",
            "accounts",
            "project chats",
            "ticket sessions",
            "utility",
            "default models",
            "automatic compaction",
            "catalog",
            "project chats",
            "ticket sessions",
            "utility",
          ],
          content: <ModelAccessSettings autoSignInProviderId={signInProviderId} />,
        },
        {
          key: "web",
          label: "Web Search",
          icon: GlobeIcon,
          keywords: ["search", "brave", "exa", "searxng", "api key", "provider", "instance"],
          content: <WebAccessSettings />,
        },
        {
          key: "integrations",
          label: "Integrations",
          icon: PlugsIcon,
          keywords: [
            "editor",
            "vscode",
            "cursor",
            "zed",
            "open in…",
            "open in",
            "terminal",
            "external",
          ],
          content: <IntegrationsPane />,
        },
      ],
    },
    {
      key: "system",
      label: "System",
      categories: [
        {
          key: "storage",
          label: "Storage",
          icon: TreeStructureIcon,
          keywords: [
            "retention",
            "worktree",
            "orphan",
            "cleanup",
            "keep",
            "days",
            "delete",
            "done",
            "reclaim",
            "keep done worktrees for",
            "orphaned worktrees",
          ],
          content: <StoragePane />,
        },
        {
          key: "updates",
          label: "Updates",
          icon: DownloadSimpleIcon,
          keywords: [
            "update",
            "version",
            "canary",
            "prerelease",
            "channel",
            "stable",
            "check now",
            "current version",
          ],
          content: <UpdatesPane />,
        },
        {
          key: "about",
          label: "About",
          icon: InfoIcon,
          keywords: [
            "version",
            "diagnostics",
            "doctor",
            "cli",
            "harness",
            "harnesses",
            "health",
            "path",
            "re-check",
            "claude code",
            "harnesses",
          ],
          content: <AboutPane />,
        },
      ],
    },
  ];
}
