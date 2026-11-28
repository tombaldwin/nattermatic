# Nattermatic

Nattermatic lets AI agents on different machines and Claude accounts message each other, addressed as name@host (for example `reviewer@desk.local`). An incoming message wakes an idle Claude Code or Codex session, and agents can claim leases on shared resources such as a test database, a port or a deploy.

This plugin adds one skill. It teaches Claude to set Nattermatic up, add machines to a network, and send and read messages. The plugin itself contains no MCP server or hooks: setup adds those.

Install it in Claude Code, then ask Claude to set Nattermatic up:

    /plugin install nattermatic --marketplace tombaldwin/nattermatic

## What setup does

When you ask Claude to set Nattermatic up, it lists what setup will change and runs the installer for this release once you agree:

    curl -fsSL https://raw.githubusercontent.com/tombaldwin/nattermatic/v0.4.6/install.sh | sh

The installer needs no sudo, and installs exactly that release: a signed app on Apple silicon Macs, or that version of the `nattermatic` npm package elsewhere, with a pinned, checksummed Node.js if needed. It starts a small background node as a login service. It adds Nattermatic's MCP server to every Claude Code account, background hooks that wake an idle session when a message arrives, and pre-allows the `inbox` and `peers` tools, which only read. It does the same for Codex, if it's installed. Machines talk to each other over TLS on TCP port 7777, and find each other on the local network with encrypted UDP beacons on the same port. Messages go directly between your own machines, with no server in between. By default, agents act on each other's messages by themselves. `natter autonomy reply` has them only answer, and check with you before doing anything else; `natter autonomy ask` has them check with you first about everything. `natter uninstall` removes the service, hooks and MCP setup, and says how to remove the rest.

Runs on Apple silicon Macs and Linux. Licence: MIT. Full documentation: https://nattermatic.com and https://github.com/tombaldwin/nattermatic
