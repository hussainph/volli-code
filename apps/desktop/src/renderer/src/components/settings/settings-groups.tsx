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
import { RobotIcon } from "@phosphor-icons/react/dist/csr/Robot";
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
import { cloudMovesCategory } from "./cloud-moves-category";
import { PrivacyDataPane } from "./panes/privacy-data-pane";
import { AppearanceSettings } from "./panes/appearance-pane";
import { ExperimentalSettings } from "./panes/experimental-pane";
import { ModelAccessSettings } from "./panes/models-pane";
import { WebSearchPane } from "./panes/web-search-pane";
import type { PrefGroup } from "@renderer/components/settings/kit";
import { hasVisibleExperiments } from "@renderer/stores/experiments";
import { accountCategory } from "./account-category";
import { hostsCategory } from "./hosts-category";
import { runnersCategory } from "./runners-category";
import { workspaceCategory } from "./workspace-category";
import { AboutPane } from "./panes/about-pane";

import { GeneralPane } from "./panes/general-pane";
import { IntegrationsPane } from "./panes/integrations-pane";
import { NotificationsPane } from "./panes/notifications-pane";
import { StorageOverviewPane } from "./panes/storage-pane";
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
  /** Quiet local-project move entry, in either launch, only with cloud on. */
  readonly moves?: boolean;
  /**
   * Shows Services → Account: with cloud on, or as stable preview enrollment.
   */
  readonly account?: boolean;
  /**
   * Shows Services → Runners and Workspace: the cloud launch's runner and team settings.
   * Neither category exists in a local launch.
   */
  readonly runners?: boolean;
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
            "zoom",
            "diff layout",
            "display",
            "inline",
            "side by side",
            "cost",
            "token",
            "show cost and token usage",
            "usage",
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
          content: <AppearanceSettings />,
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
        ...(options.account === true ? [accountCategory()] : []),
        ...(options.runners === true ? [runnersCategory(), workspaceCategory()] : []),
        ...(options.moves === true ? [cloudMovesCategory()] : []),
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
            "catalog",
            "signed in",
            "available to connect",
          ],
          content: <ModelAccessSettings autoSignInProviderId={signInProviderId} />,
        },
        {
          key: "agents",
          label: "Agents",
          icon: RobotIcon,
          keywords: [
            "code mode",
            "codemode",
            "compaction",
            "decision model",
            "automatic compaction",
            "exceptions",
            "add model exception",
            "pick models automatically",
            "sandbox",
            "javascript",
            "program",
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
          content: <ModelAccessSettings agents />,
        },
        {
          key: "web",
          label: "Web Search",
          icon: GlobeIcon,
          keywords: ["search", "brave", "exa", "searxng", "api key", "provider", "instance"],
          content: <WebSearchPane />,
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
            "backup",
            "backups",
            "local profile backups",
            "last backup",
            "backup notice",
            "back up now",
            "restore",
            "backup bundle",
            "restart and restore",
            "previous profile",
            "show in finder",
          ],
          content: <StorageOverviewPane />,
        },
        {
          // Its own category rather than a row under General (VC-119): the
          // collector address is a developer's configuration and the switch
          // governs what leaves the machine, which is a thing somebody should
          // be able to find by looking rather than by scrolling.
          key: "telemetry",
          label: "Privacy & data",
          icon: ChartLineIcon,
          keywords: [
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
          content: <PrivacyDataPane />,
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
            "status",
            "retry",
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
            "retry",
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
