# VC-615: setting up a remote host — lab prototypes and the decisions they put to the owner

**Status:** prototypes ready for the owner's review (2026-10). Nothing here is built. The scratches are UI state and scripted flows only; no backend.

Run `pnpm lab`, then open the scratches below. In each, the **lab bar** (mono caps, "LAB") sets the scripted conditions a backend would produce: an outcome, a host state, a speed. Where a scratch has a **picker** (a dark pill, bottom centre), it compares design directions: `1`–`3` or `←`/`→` switch between them, `R` replays.

| Scratch | Flow | Picker |
|---|---|---|
| `#host-add` — Add a host over SSH | 1, and the landing of 5 | Checklist · Quiet · Console |
| `#host-pair` — Pair a running host, pair a phone | 2, 3 | — |
| `#host-sign-ins` — Sign-ins on the host | 4 (set-up and expiry) | From this Mac · On the host · Per sign-in |
| `#host-health` — Connection, health and updates | 5, 6 | Island · Banner · Chip |
| `#host-manage` — Settings → Hosts | 7 | — |

The shared kit is `apps/desktop/src/renderer/lab/remote-host/`. It holds the host tile, step marks, the scripted-flow runner, the install script with every failure, the pairing-code field and the sign-in rows.

## What each flow covers

**1. Add a host over SSH.** Type `you@box`, or pick a host from `~/.ssh/config`; a host you already paired is marked "Paired". The sheet then runs five steps: connect, check the system, install, start, pair. Each step has three faces:

- a noun while it waits ("Install");
- a verb while it runs ("Installing Volli host 0.3.0", with a byte count);
- a fact when it lands ("Ubuntu 24.04 · x86-64 · 8 GB", "Keeps running when you log out").

So a finished install reads as a description of the box, not a list of chores. The tile shows the OS as soon as the box says what it is.

The sheet ends on sign-ins (flow 4) and a transport chip ("Over SSH ▾", which offers Tailscale when the box is on a tailnet). Done drops the host into the title-bar host chip.

Every failure state is reachable from the lab bar's Outcome menu, or naturally by picking the matching `~/.ssh/config` host. Each one shows a single line and a single recovery:

| Failure | What the person sees | Recovery |
|---|---|---|
| Can't reach the host | The connect step fails | Try again |
| Server wants a password | An inline password field, with "Add this Mac's key so it won't ask again" (on by default) | Connect |
| SSH key locked (not in the agent) | A passphrase field, with "Remember in Keychain" | Unlock |
| arm64 Linux (`pi`) | "Volli hosts run on x86-64 Linux or an Apple silicon Mac." | Choose another host |
| No linger (`staging`) | The command it will run (`sudo loginctl enable-linger deploy`) and a sudo password field | Run it |
| Disk full | "96 MB free · needs 420 MB" | Check again |
| Older hostd already running (`build`) | "Its 2 workspaces stay either way." | **Update and pair**, or Use 0.2.4 |
| Already paired (`studio`) | The pair step is already ticked | Open studio |
| Restored host, new identity | "It was restored or reinstalled. Devices paired before must pair again." | Pair again |

**2 and 3. Pairing.** See `#host-pair`:

- The box's terminal (`volli-hostd pair`) and the desktop sheet sit side by side, and each answers the other.
- The code is 12 characters and forgives what people mistype: paste, lowercase, `O` for zero.
- After the code, you pick a route: Tailscale (detected), a URL, or an SSH tunnel.
- The short host-key fingerprint is shown on both sides, so a careful person can compare them.
- Pair a phone reverses the roles: the QR is on the desktop, and the desktop approves the phone.
- A host reached only over SSH can't pair a phone. That is a blocked state with one action.

**4. Sign-ins.** See `#host-sign-ins`. Its "Expired later" moment shows a Session on the host stopping. It uses the real `SessionBlocker`: "Claude sign-in expired on hetzner-1 · The turn is paused, not lost". The host's row in the switcher shows the same attention, and both offer the same recovery. Once you recover, the Session continues.

**5 and 6. First use, health and updates.** See `#host-health`. It is staged over the real app window:

- **Host chip and switcher.** The current workspace's host sits in the title bar. Its switcher lists This Mac and every paired host, and ends in Add a host…, Pair with a code… and Manage hosts….
- **Read-only is real.** While the host can't serve, the board's create controls stand down; reading and opening tickets still work.
- **Reconnecting** waits out a 1.5 s grace period before it says anything, so a blip never flashes a banner.
- **Offline** counts down to an automatic retry, and offers Retry now.
- **Host older than the app** shows a quiet attention badge, and the update lives in the switcher. If Sessions are running, it asks whether to update now or when they finish. It then shows progress and comes back with a toast: "Sessions picked up where they paused".
- **Host too old to connect** and **database from a newer Volli** are both read-only, with a single action: Update host.
- **Host newer than this app** offers Update Volli.

The "Running on hetzner-1" venue label appears on the Session in `#host-sign-ins`, as the `VenueChip` part.

**7. Manage hosts.** See `#host-manage`. It is Settings → Hosts in the real `PrefShell`:

- the host list;
- a host page with rename, system, version, connection, host key, workspaces and paired devices;
- Revoke and Forget, each behind an irreversible confirm.

## The decisions — options, and a recommendation for each

The choice is the owner's. These recommendations come from building and using the prototypes.

### 1. Is Add-a-host-over-SSH the main self-hosted path?

**Recommend yes.**

- It needs nothing the person doesn't already have: SSH access and a box.
- The install proves the route to the box.
- Pairing can ride the SSH channel, since the box's SSH host key already authenticates it. So the main path never shows a code.

Code pairing (flow 2) stays for hosts installed some other way (a script, Docker, or a Mac set up in person) and for phones. If the owner says yes, file the "Add a host over SSH" implementation ticket under M2.

### 2. Send this Mac's sign-ins (with a confirm), or always sign in on the host?

The three directions are in `#host-sign-ins`. **Recommend "Per sign-in"**, with defaults by kind:

- **API keys and git push: send from this Mac.** The one-line trust boundary is "hetzner-1 keeps a copy of what this Mac sends." A copy costs nothing.
- **Subscription logins (Claude, ChatGPT): sign in on the host with a device code.** You approve in this Mac's browser, and the row on the box turns signed-in by itself. Copying an OAuth login shares one refresh token between two machines. A provider that rotates refresh tokens on use will then sign one of the two out, at random, later.
  - **To verify before ruling:** does each provider rotate its refresh tokens? Pi's auth code can answer this.
  - If none rotates, "From this Mac" is simpler and is also fine.

### 3. Transport: Tailscale required, or an SSH tunnel by default?

**Recommend: the SSH tunnel by default for a desktop that added the host over SSH; Tailscale or HTTPS optional, and required for phones and web.**

- **The tunnel costs nothing.** The install already proved the SSH route, so there is no new configuration.
- **Closing the lid doesn't break it.** Agents run on the host, so the client's link only carries the view. After sleep, it reconnects within the "Reconnecting" grace period.
- **Tailscale is offered where it's useful.** The ready step offers it when the box is on a tailnet. Pair a phone shows a blocked state with one action when the host has no Tailscale or HTTPS route.

### 4. When to publish hostd downloads, an install script and a Docker image?

**Recommend:** publish the hostd tarballs as GitHub release assets from M2, because the SSH install needs them. The install script and the Docker image can wait for M3.

- **How the tarball reaches the box.** The SSH install uploads it from this Mac (Zed's approach; the Console direction shows the `scp` line). The box then needs no internet access to our releases, and the app fetches and caches the tarball once.
- **Who the script and the image are for.** People who never open the desktop app: headless-only installs, and phone-first users.

### 5. Where does "Add a host" live, and how much install detail does the progress view show?

- **Placement. Recommend:**
  - The title-bar host chip's switcher, ending in "Add a host…". This is the primary place, and it is where a host lands when it's added.
  - "Add a host…" as the section action in Settings → Hosts.
  - The ⌘K command "Add a host…" (not prototyped; a command palette entry is cheap).
- **Detail. Recommend Checklist.** The facts are reassuring, failures point to the step that broke, and the log is one click away under Details. The alternatives:
  - **Quiet** is the most beautiful when everything works. It reads worst when something fails, because the ring cannot say which step broke.
  - **Console** suits the people who want it, but makes a one-minute task look like work. It could live behind Details rather than ship as the main view.
- **Connection state (VC-576). Recommend Island for blocking states.** It is one line and one action, and it floats over the board without moving it. Non-blocking states (an update available, a sign-in expired) stay as a badge on the chip. The alternatives:
  - **Banner** is clearer, but it shifts the page and is heavier.
  - **Chip** alone is too easy to miss for a read-only workspace.

## Open questions surfaced while building

- **Revoke while the host is offline.** Can a device be revoked while its host is offline? The host must drop the key itself, so the prototype disables Revoke until the host is back.
- **What rename changes.** Does renaming a host change the host's own name, or only this Mac's label for it? The prototype treats it as a label.
- **Where Hosts sits in Settings.** The prototype puts it under Services; System is the alternative.
- **One connection per workspace.** The prototypes never show it, as ruled. A host's workspaces list is the only place several workspaces on one host appear together.
