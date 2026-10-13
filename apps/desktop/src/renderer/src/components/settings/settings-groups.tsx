/**
 * The Settings rail: grouped categories, app-wide always.
 *
 * THE GROUPS CARRY THE RELATIONSHIP. Preferences is what you like, Services is
 * what Volli talks to on your behalf, System is the install itself. A flat list
 * is a list you read top to bottom every time; grouped categories are a
 * structure you learn once.
 *
 * `keywords` is hand-maintained and guarded — `settings-search-smoke.mjs` walks
 * every row label on both surfaces and fails if one cannot be reached from rail
 * search. Keep it green when you add rows.
 */
import { BellIcon } from "@phosphor-icons/react/dist/csr/Bell";
import { ChartLineIcon } from "@phosphor-icons/react/dist/csr/ChartLine";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { FlaskIcon } from "@phosphor-icons/react/dist/csr/Flask";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { ListMagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/ListMagnifyingGlass";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { PlugsIcon } from "@phosphor-icons/react/dist/csr/Plugs";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { EXPERIMENTS, MODEL_TIER_ROWS, type ExperimentSnapshot } from "@volli/shared";

import { LogViewer } from "@renderer/components/logs/log-viewer";
import { AgentObservabilitySettings } from "@renderer/components/pages/agent-observability-settings";
import { AppearanceSettings } from "@renderer/components/pages/appearance-settings";
import { ExperimentalSettings } from "@renderer/components/pages/experimental-settings";
import { ModelAccessSettings } from "@renderer/components/pages/model-access-settings";
import { WebAccessSettings } from "@renderer/components/pages/web-access-settings";
import type { PrefGroup } from "@renderer/components/settings/kit";
import { hasVisibleExperiments } from "@renderer/stores/experiments";
import { hostsCategory } from "./hosts-category";
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

export interface SettingsGroupsOptions {
  /** The host's effective experiment availability. Hidden until the first answer. */
  readonly experiments?: ExperimentSnapshot | null;
  /**
   * Shows System → Logs, the end-to-end log viewer (VC-699): dev builds, and
   * product builds with the `cloud` experiment on (`useLogViewerEnabled`).
   */
  readonly logs?: boolean;
  /**
   * Shows Services → Hosts, the hosts this Mac added over SSH (VC-700): only
   * with the `cloud` experiment on.
   */
  readonly hosts?: boolean;
}

export function settingsGroups(
  signInProviderId?: string,
  options: SettingsGroupsOptions = {},
): readonly PrefGroup[] {
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
            // The canvas editor's own row labels.
            "colours",
            "colors",
            "primary",
            "swatch",
            "swatches",
            // DisplaySection's cost row. VC-87 mounted the row in this
            // category and did not extend these keywords, so the setting was
            // unreachable from rail search until settings-search-smoke finally
            // ran in CI and said so.
            "show cost and token usage",
            "cost",
            "token",
            "tokens",
            "usage",
            "spend",
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
            "a pull request merges",
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
        ...(options.hosts === true ? [hostsCategory()] : []),
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
            "reasoning",
            "sign in",
            "account",
            "accounts",
            // Every tier row's label, read off the shared list rather than
            // retyped (VC-259): the pane draws its rows from `MODEL_TIER_ROWS`,
            // and a label that reached the pane without reaching this index is
            // a setting a person can see and cannot search for.
            ...MODEL_TIER_ROWS.map((row) => row.label.toLowerCase()),
            "default models",
            "automatic compaction",
            // Code Mode (VC-471): its section and switch, the "Pin a model"
            // row behind Advanced, and the words someone looking for it uses.
            "code mode",
            "codemode",
            "sandbox",
            "javascript",
            "program",
            "pin a model",
            "catalog",
            "signed in",
            "available to connect",
            // The Decision model section (VC-478), every label it can draw.
            "decision model",
            "classifier",
            "classify",
            "jev",
            "llama.cpp",
            "local",
            "cloud",
            "server",
            "model id",
            "connection",
            "cloud model",
            "status",
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
            "external apps",
            "open in",
            "open files in",
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
            "pi sessions",
            "pi session logs",
            "orphaned logs",
            "orphaned pi logs",
            // Long MCP results saved beside the Session (VC-469).
            "saved tool output",
            "tool output",
            // The orphan PROCESS sweep (VC-341). "memory" and "reap" are here
            // because they are what a person actually types when a fan is loud
            // and they are looking for what to stop.
            "running processes",
            "no session owns",
            "reap",
            "reap under memory pressure",
            "memory",
            "process",
            "orphan process",
            "scan",
            "clean up",
            // The build-artifact trim (VC-340). Both the words on screen and the
            // words a person would actually type for it: nobody searches
            // Settings for "git-ignored content", they search for node_modules.
            "build artifacts",
            "trim",
            "trim when a ticket is done",
            "carrying artifacts",
            "artifacts",
            "ignored",
            "node_modules",
            "target",
            "venv",
            "cache",
            "disk space",
            "database",
            "size",
            "database export",
            "export database",
            "export data",
            "export data as json",
            "data export",
            "backup",
            "json",
            "reveal in finder",
          ],
          content: <StoragePane />,
        },
        {
          // Its own category rather than a row under General (VC-119): the
          // collector address is a developer's configuration and the switch
          // governs what leaves the machine, which is a thing somebody should
          // be able to find by looking rather than by scrolling.
          key: "telemetry",
          label: "Telemetry",
          icon: ChartLineIcon,
          keywords: [
            "telemetry",
            "observability",
            "opentelemetry",
            "otel",
            "otlp",
            "collector",
            "jaeger",
            "trace",
            "tracing",
            "span",
            "metrics",
            "export agent telemetry",
            "agent telemetry",
            "tokens",
            "cost",
            "cache hit",
          ],
          content: <AgentObservabilitySettings />,
        },
        ...(options.logs === true
          ? [
              {
                key: "logs",
                label: "Logs",
                icon: ListMagnifyingGlassIcon,
                // One stream wants the whole width.
                fill: true,
                keywords: [
                  "log",
                  "logs",
                  "trace",
                  "trace id",
                  "debug",
                  "host",
                  "hosts",
                  "jsonl",
                  "export",
                ],
                content: <LogViewer />,
              },
            ]
          : []),
        ...(hasVisibleExperiments(options.experiments ?? null)
          ? [
              {
                key: "experimental",
                label: "Experimental",
                icon: FlaskIcon,
                keywords: [
                  "experiment",
                  "experiments",
                  "flags",
                  "feature flags",
                  ...EXPERIMENTS.filter(
                    ({ id }) => options.experiments?.[id].visible !== false,
                  ).flatMap((experiment) => [experiment.id, experiment.label.toLowerCase()]),
                ],
                content: <ExperimentalSettings />,
              },
            ]
          : []),
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
          // No harness keywords: the inventory left the visible pane (it was
          // multi-harness-era diagnosis, and it lives in the copy report now).
          keywords: [
            "version",
            "diagnostics",
            "doctor",
            "cli",
            "health",
            "path",
            "fix",
            "re-check",
            "copy",
            "copy report",
            "report",
            "support",
          ],
          content: <AboutPane />,
        },
      ],
    },
  ];
}
