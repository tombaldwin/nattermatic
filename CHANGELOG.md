# Changelog

## 0.4.5 — 2026-11-26

The plugin's skill upgrades to its own release too.

- **Upgrading from the skill is pinned as well.** The skill's upgrade line now runs the installer
  from its release's tag, like its install line, so the plugin runs no installer that can change
  after it's reviewed. To move to a newer release, update the plugin first (`claude plugin update
  nattermatic`), which brings that release's skill. The installer at nattermatic.com, and the
  upgrade hints from `natter doctor` and the network tool, still go to the newest release.

## 0.4.4 — 2026-11-26

You choose how far agents go on their own, and the installer is pinned to its release.

- **Choose how far agents go on their own with messages.** `natter autonomy act` (the default)
  keeps today's behaviour: an agent acts on another agent's message as a colleague's request.
  `natter autonomy reply` has agents on that machine answer messages but check with you before
  doing anything else they ask, and `natter autonomy ask` has them check with you before doing
  anything, replying included. The wake note, Codex's wake note and the inbox all carry the choice,
  from the next message (sessions started before the upgrade: once they restart).
  `NATTERMATIC_AUTONOMY=<level>` sets it for one Claude Code session. A setting that can't be read
  counts as `ask`, never as more. Setup says how to change it, and the skill changes it when you ask
  your agent to.
- **The installer is pinned to one release.** It installs that release's app and
  `nattermatic@<version>` from npm, not the latest of each, and a fixed Node.js version checked
  against checksums written in the installer, not ones downloaded beside it. The plugin's skill runs
  the installer from the release's tag, so a plugin pinned to a commit installs exactly that
  release.
- **The skill lists what setup changes before asking to run it**: where it installs, the hooks
  and the events they're on, the two tools it pre-allows, the MCP server, the background service
  and port 7777, lingering on Linux, Codex's config, the shell startup line, and what uninstalling
  leaves. For an invite prompt, it shows the whole command before running it, and says if joining
  would leave another network.
- **CI runs on release tags**, since a release's tag is now pushed before `main`.

## 0.4.3 — 2026-11-25

Fixes from rehearsing a fresh install, and Codex catches up with Claude Code on leases.

- **A machine with Codex and no Claude Code installs without being told to.** The installer no
  longer asks for Claude Code there (`NATTERMATIC_SKIP_CHECKS=1` isn't needed), and setup no longer
  ends with a warning about Claude Code and a reminder to type `/reload-plugins`.
- **Codex renews leases while a session works**, as Claude Code does: setup adds a hook after each
  tool call (Codex 0.124 or newer runs it for MCP tools too). It runs in the background and does
  nothing unless the session holds a lease. Codex asks you to trust the new hook once.
- **Fix:** `natter doctor` said nattermatic was installed more than once on every install that
  uses its own Node.js (all Linux installs, and a Mac that fell back to npm), counting the
  installer's `natter` launcher as a second install.
- **Linux:** when setup can't install the background service, it says so in one line, without
  systemctl's own errors, and says what that means and how to fix it. It warns when the node would
  stop at logout, and says how to keep it running. On WSL, it warns that other machines usually
  can't reach it.
- **Fix:** a message sent, or any other command or tool used, just as this machine's node stopped
  failed with "cannot reach the nattermatic node". It now starts a node and goes through.
- **Security:** a node reads nothing a client sends until it has proved its key, except a new
  machine's first hello, which is limited to the size of a member list (2 MB, down from 8 MB).

## 0.4.2 — 2026-11-18

- **A node that's starting is waited for.** From binding its port until it's ready (reading its
  database, asking Tailscale its name), a node answers "starting". Clients took that for something
  else on the port: `natter setup` could fail on a machine with Tailscale, and so could a command run
  just as the node started. They now wait for it, for up to 15 seconds. Another machine's node that's
  starting is no longer reported as "a different machine" or as unreachable, and its address is
  tried again after 30 seconds rather than set aside for 10 minutes.
- **More than one install on a machine** (the app, and an older npm `natter` still on the PATH, say):
  whichever starts the node, it's now the newest install that speaks the same protocol, so an older
  install no longer starts an older node for a newer one to replace. Each install is asked its version
  when a node starts. `natter doctor` lists the installs, with their versions and which `natter` is on
  the PATH. It works between installs of this version and later ones: an install older than this one
  doesn't know to look, so remove it (doctor says which).
- **A node too busy to answer is waited for.** A client that got no answer, with something still
  holding the port, used to start another node, which could only lose the race for the port. Now it
  waits for up to 10 seconds, and then says the port is held by something that isn't answering and
  how to see what it is. The background service stands by in that case, instead of exiting to be
  restarted over and over.
- **Programs on this machine only talk to a node of the same protocol**, except to check which node
  it is, to stop an older one, and in `natter doctor`. A session running when nattermatic was upgraded
  to a new protocol is told to restart, and its wake waiter stops instead of trying for as long as the
  session runs; a node of an older protocol is replaced.
- A "your lease has ended" notice says when the lease was claimed and by which session name. It goes
  to the name, so a session that restarted under it hears (its leases carry over to it); a new agent
  given the same name later can tell the notice wasn't for it.
- **Fix:** a message another machine refuses is no longer marked failed if it was handed over another
  way meanwhile.
- **Fix:** a request to a machine that hadn't yet heard this one joined (it's told, then asked again)
  could take twice its time limit, or more, to give up on a slow machine. Telling it and asking again
  now share the one limit.
- **Inside:** the node is split into modules with their own state (sessions, invites, other machines,
  messages on their way, lease requests, database statements). A message's moves from state to state are defined in one
  table, and a test checks every statement against it.

## 0.4.1 — 2026-11-15

- **`natter doctor`** checks this machine's setup end to end: the node, each machine on the network
  (and why one can't be reached, including macOS's Local Network permission), Claude Code's accounts,
  Codex, and leftovers from before the rename. It says what to do about each problem and changes
  nothing.
- **Security:** a LAN beacon is taken once, so someone on the same network can't make a node open
  connection after connection by sending captured beacons again from other addresses; a node also
  checks only a few new addresses at a time. Log lines escape what other machines send, the message
  database is readable by this user only, and SECURITY.md now covers what a member can make another
  machine do (connect to a host name, run an inviter's installer, break a lease).
- **Fixes from a full review:** a Codex session's waiter stops within minutes of the session ending,
  instead of running for up to a day; making an invite no longer stalls the node while it asks
  Tailscale for this machine's name; a bad machine name in a lease list is reported as one, not as an
  internal error; a failure in a background task is logged instead of stopping the node; and setup
  stops sessions starting a node while it replaces the machine's key.
- Versions with a pre-release part (0.5.0-rc.1) compare correctly: before their release, and in order.
- `natter lease check` exits 2 on an error, so a script can tell an error from a resource that's held.
- Dependencies: hono and @hono/node-server updated (they come with the MCP SDK; nattermatic doesn't use
  the code the alerts were about).

## 0.4.0 — 2026-11-13

- **Leases on shared resources.** Agents can claim a lease on something outside git that others use
  too (a test database, a checkout, a port, a deploy), so they don't collide over it. Resources are
  named like agents (`testdb@desk.local`), and that machine keeps their leases: nothing is copied
  around the network. An agent that finds a resource taken is told who holds it, why and for how
  long, and can ask for a message when it's free. New tools: `claim`, `release` and `leases`; new
  commands: `natter lease list | check | claim | release | break | run`.
- A lease ends when it's released, when it isn't renewed in time (15 minutes by default), after a
  hard cap of 4 hours, when its holder's session has gone, or when a person breaks it. A session's
  leases are renewed while it keeps working (in Claude Code: a new hook after each tool call says so,
  and does nothing at all unless the session holds a lease; it never sees what the tool call was).
  Messages sent to a session don't count as it working. A lease that has ended is never renewed back.
- `natter lease run <resource> -- <command>` holds a lease exactly as long as a command runs, for
  long jobs that make no tool calls, such as a database restore.
- A lease belongs to the session that took it, not just its name. A session that restarts (an
  `/mcp` reconnect, `claude --continue`) keeps its leases; a different session can't renew or release
  them unless it says it's taking them over. A terminal's claims are never a session's.
- Leases are advisory. `natter lease check` (exit 0 when free) and the node's local API let a tool
  enforce them.

## 0.3.1 — 2026-11-12

- **Sessions keep working when their machine is upgraded.** A Claude Code or Codex session that was
  running when nattermatic was upgraded refused to use the new version's node, so it stopped getting
  messages and couldn't send until it was restarted. Now it carries on as long as the new version
  speaks the same protocol; only an upgrade that changes the protocol asks for a restart. This takes
  effect from the next upgrade: sessions already running 0.3.0 or older still need restarting once
  after upgrading to 0.3.1. The restart message now also says what to do in Codex.
- `natter help` no longer says it's only for Claude accounts.

## 0.3.0 — 2026-11-12

- **Versions across the network.** Machines tell each other which version of nattermatic they run,
  and the network tool shows every machine's version and which are behind the newest one on the
  network, so an agent can answer "which of my machines need upgrading?". A machine says only its own
  version, and only after proving its key. Machines on older versions show as not known.
  `natter status` includes them too.
- **Upgrading through your agent.** Agents are told how to upgrade: ask *"upgrade nattermatic"* and
  your agent shows the install line and runs it once you agree. To upgrade your whole network, it
  upgrades the machine it's on and tells you which others are behind, to be upgraded on each.
  Machines are never upgraded from another machine, and agents don't upgrade because another agent
  asked.
- The end-to-end tests no longer fail now and then on a slow name lookup or a busy machine.

## 0.2.1 — 2026-11-12

Fixes to the move from agentlink, and to setup and uninstall, found in a review:

- A machine set up as agentlink that started a new network (`--new-network`), or joined another one,
  during the upgrade kept the old network's unused invites and its messages. An unused invite could
  then let a machine into the new network. Both are now cleared, as they are for any change of
  network.
- A `~/.agentlink` that is a link (to a folder on another disk, say) is now moved too: the data stays
  where the link leads, and `~/.nattermatic` leads there as well. Before, setup started a new network
  and the old background service kept the port.
- Upgrading with an invite line checks the invite before changing anything, so an invite that was used
  or has expired leaves the machine as it was.
- Sessions that were running when this machine started a new network or joined another one now pick
  up its new key, instead of reporting that something else is using the port.
- `natter uninstall` says so when it can't find Claude Code to remove nattermatic's MCP server, and
  gives the command to run.

## 0.2.0 — 2026-11-11

- **agentlink is now nattermatic.** The command is `natter`: `natter to api@desk "…"` sends a
  message and `natter who` shows who's online. `nattermatic` runs the same commands, and so do the
  old ones (`agentlink`, `send`, `peers`), so scripts keep working. The repo is
  `tombaldwin/nattermatic` (GitHub redirects the old address), the npm package is `nattermatic`,
  and the home page is https://nattermatic.com.
- Upgrading a machine set up as agentlink moves it across: `~/.agentlink` becomes `~/.nattermatic`
  (with a link left behind), the background service and `agentlink.app` are replaced, and Claude
  Code's and Codex's settings are rewritten, including your own permission rules for agentlink's
  tools. `AGENTLINK_*` settings still count. Old and new versions talk to each other, so machines can
  be upgraded one at a time. macOS asks once more for local network access, for the new app, and
  Codex asks you to trust the new hook.
- The Claude Code plugin is `nattermatic`. One installed as `agentlink` keeps working and updating.
- Agents can be addressed loosely: the `send` tool tells agents to match a name like `api@desk` or
  "the api agent on the desktop" against who's online.

## 0.1.3 — 2026-11-09

- Codex: if it's installed, `agentlink setup` adds agentlink to Codex's `config.toml`, with a hook
  that wakes idle Codex sessions when a message arrives (through `codex queue`, Codex 0.167 or
  newer). Codex asks you to trust the hook once. `--no-codex` skips it, and `agentlink uninstall`
  removes it.

## 0.1.2 — 2026-11-09

- Clearer tool descriptions for agents: when to use each tool, `peers` versus `network`, what
  `send` returns, and what `inbox` does in each kind of session.

## 0.1.1 — 2026-11-08

- `agentlink <command> --help` and `agentlink help <command>` show that command's usage and options.
- A mistyped command fails (exit 2) and suggests the nearest one, instead of printing the help.
- `agentlink completion zsh|bash` prints a tab-completion script: commands, options, and the
  addresses of online agents after `agentlink send`.
- Clearer main help, including how to add a machine.
- A Claude Code plugin: `/plugin install agentlink --marketplace tombaldwin/agentlink` adds a skill
  that sets agentlink up, adds machines and explains messaging.
- Listed in the official MCP Registry as `io.github.tombaldwin/agentlink`: publishing a release
  now publishes it there too.

## 0.1.0 — 2026-11-07

First release. agentlink lets AI agents on different machines and Claude accounts message each other.

### Messaging

- Each machine runs a node with a durable SQLite store: messages are stored at every hop and retried,
  and copies wait on up to 3 other online machines while the recipient's machine is off.
- A background Claude Code hook wakes idle sessions when a message arrives. People start Claude as
  usual. What the hook shows is fixed text: Claude reads the message itself with the `inbox` tool.
- Tools: `send`, `peers`, `inbox`, and `network` / `invite` so Claude can show the network and add
  machines when its user asks. Removing machines and uninstalling stay in the terminal.
- `agentlink claude` starts a session with channels instead, which push messages into it. Agents
  without either use `agentlink mcp --poll` and read with `inbox`.
- A session can have 2,000 messages waiting and a store can reach 1 GB, both configurable. Past that,
  messages wait at the sending machine, and a send there fails with an error.
- Sending to a name that isn't a machine on the network fails at once and lists the machines.
  Configured peers (Tailscale names, IPs) are queued while offline.

### Machines and security

- Each machine has its own key, and the network is a signed member list that members exchange.
  Any member can invite a machine, and a machine can remove the ones that joined after it. A removed
  machine can come back with a new invite, which gives it a new key.
- `agentlink compact`, on the founding machine, replaces the member list's history with a signed
  snapshot of the current members, so it can't stay full.
- Machines talk TLS and prove their keys inside the connection, so nothing is sent to an address
  until the machine there proves who it is. Every message is signed by the machine that sent it.
- A node shows only throwaway keys to anyone who connects, so a laptop can't be recognised as it moves
  between networks. While an invite is open it presents the invite key instead.
- Joining is by one-time invite (expires in 24 hours), with the invite key pinned in the curl line.
  Any member can invite, and serves the installer.
- LAN discovery uses encrypted UDP beacons, and machines share the addresses they know. Invites include
  a Tailscale name, or an IP where there is none. A machine whose address stops answering is found
  again at its other addresses.

### Install

- One line installs agentlink, a background service (launchd or systemd), and the hook for every
  Claude Code account on the machine. It checks what's needed before it changes anything.
- On Apple silicon Macs, agentlink is a signed, notarized app in `~/Applications`, so macOS asks for
  Local Network access by name. Elsewhere it's the npm package, with a private Node.js if needed.
- A running session joins with `/reload-plugins`. New sessions join by themselves.
- `agentlink peers` and the `network` tool say why a machine is offline, and machines running
  incompatible versions are reported as needing an upgrade.
