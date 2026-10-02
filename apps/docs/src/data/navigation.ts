export interface DocLink {
  label: string;
  slug: string;
}

export interface DocSection {
  label: string;
  items: DocLink[];
}

/** Shared by the sidebar and the Markdown index. Every public page belongs here. */
export const DOC_SECTIONS: DocSection[] = [
  {
    label: "Get started",
    items: [
      { label: "Install", slug: "start/install" },
      { label: "Quickstart", slug: "start/quickstart" },
      { label: "Concepts", slug: "start/concepts" },
    ],
  },
  {
    label: "Tickets and code",
    items: [
      { label: "The board", slug: "guides/board" },
      { label: "Manage tickets", slug: "guides/manage-tickets" },
      { label: "Ticket workspace", slug: "guides/ticket-workspace" },
      { label: "Chats and worktrees", slug: "guides/agents-and-worktrees" },
      { label: "Review and publish changes", slug: "guides/review-changes" },
      { label: "Clean up worktrees", slug: "guides/clean-up-worktrees" },
    ],
  },
  {
    label: "Run agents",
    items: [
      { label: "Use a chat", slug: "guides/sessions" },
      { label: "Browser Tabs", slug: "guides/browser-tabs" },
      { label: "Terminal companions", slug: "guides/terminal-companions" },
      { label: "Split view", slug: "guides/split-view" },
      { label: "Recover a Session", slug: "guides/recover-session" },
    ],
  },
  {
    label: "Automations",
    items: [
      { label: "Overview", slug: "guides/automations" },
      { label: "Create an Automation", slug: "guides/automations/create" },
      { label: "Run an Automation", slug: "guides/automations/run" },
      { label: "Run when a ticket moves", slug: "guides/automations/columns" },
      { label: "Schedule an Automation", slug: "guides/automations/schedules" },
    ],
  },
  {
    label: "Configure Volli",
    items: [
      { label: "Models and usage", slug: "guides/models" },
      { label: "Code Mode", slug: "guides/code-mode" },
      { label: "Skills and commands", slug: "guides/skills-and-commands" },
      { label: "MCP servers", slug: "guides/mcp-servers" },
      { label: "Agent authority", slug: "guides/authority" },
      { label: "Settings", slug: "guides/settings" },
      { label: "Theming", slug: "guides/theming" },
      { label: "Storage and backups", slug: "guides/storage" },
      { label: "Local data and network access", slug: "reference/data-and-privacy" },
    ],
  },
  {
    label: "Reference",
    items: [
      { label: "CLI setup and context", slug: "reference/cli" },
      { label: "CLI commands", slug: "reference/cli-commands" },
      { label: "Command effects", slug: "reference/command-effects" },
      { label: "CLI errors", slug: "reference/cli-errors" },
      { label: "Agent operating model", slug: "reference/agent-operating-model" },
      { label: "Agent capability changes", slug: "reference/agent-capability-changes" },
      { label: "Keyboard shortcuts", slug: "reference/keyboard-shortcuts" },
      { label: "Troubleshooting", slug: "reference/troubleshooting" },
      { label: "Build from source", slug: "reference/build-from-source" },
    ],
  },
  {
    label: "Releases",
    items: [{ label: "What's new in 0.2", slug: "releases/whats-new-0-2" }],
  },
];
