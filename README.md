<p align="center">
  <img src="apps/desktop/build/icon-source.svg" width="96" alt="Volli Code icon" />
</p>

<h1 align="center">Volli Code</h1>

<p align="center">
  A local-first macOS workspace for code projects: a ticket board, chats that carry your project or ticket context, isolated Git worktrees, and changes you review.
</p>

<p align="center">
  <a href="https://volli.app/download/">Download</a>
  ·
  <a href="https://volli.app">Website</a>
  ·
  <a href="https://docs.volli.app">Documentation</a>
  ·
  <a href="https://github.com/hussainph/volli-code/issues">Feedback</a>
</p>

## Install

> [!IMPORTANT]
> Volli Code is in **early alpha**, for **Apple silicon** Macs (M1 and later). Builds ship as prereleases, features move between them, and behavior you rely on can change. There is no Intel or universal build yet.

Download the current build from [volli.app/download](https://volli.app/download/), or from [GitHub Releases](https://github.com/hussainph/volli-code/releases) if you want a specific one. Builds are signed with a Developer ID and notarized, and the app updates itself from the same feed when you quit.

The [installation guide](https://docs.volli.app/start/install/) covers first run, where your data lives, and how to uninstall cleanly.

## From ticket to review

`ticket → chat → worktree → change set → review`

- Plan scope, constraints, and what a good result looks like in a local ticket board.
- Start a chat that already has the context: a project chat works from your main checkout, a ticket chat from that ticket's isolated Git worktree.
- Read the live change set beside the chat history that produced it — you review it, Volli does not certify it.
- Open Claude Code, Codex, OpenCode, or a custom TUI in an embedded terminal when you want a manual companion. It is never a silent fallback for a chat.

Projects, tickets, and chat history stay on your machine. Model requests go to the provider you select through Model Access.

## Build from source

Requirements: macOS, Node.js `^24.13.0` (a `.nvmrc` is provided — `nvm use`), and pnpm `11.10.0`. The Node range is enforced: `pnpm install` and the dev scripts refuse to run under an unsupported Node, because native modules built against the wrong ABI leave the app unable to open its database (and sign-in disabled).

```bash
git clone https://github.com/hussainph/volli-code.git
cd volli-code
pnpm install
pnpm dev
```

To build and run the production bundle locally:

```bash
pnpm run build
pnpm start
```

See the [installation guide](https://docs.volli.app/start/install/) for native dependency setup and troubleshooting.

## Project

- [Documentation](https://docs.volli.app) · [Quickstart](https://docs.volli.app/start/quickstart/)
- [Releases](https://github.com/hussainph/volli-code/releases)
- [Report a bug or give feedback](https://github.com/hussainph/volli-code/issues)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Apache-2.0 license](LICENSE)
