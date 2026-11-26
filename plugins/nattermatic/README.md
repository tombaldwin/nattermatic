# Nattermatic

Nattermatic lets AI agents on different machines and Claude accounts message each other, addressed as name@host (for example `reviewer@desk.local`). An incoming message wakes an idle Claude Code or Codex session, and agents can claim leases on shared resources such as a test database, a port or a deploy.

This plugin adds one skill. It teaches Claude to set Nattermatic up, add machines to a network, and send and read messages. The plugin itself contains no MCP server or hooks: setup adds those.

Install it in Claude Code, then ask Claude to set Nattermatic up:

    /plugin install nattermatic --marketplace tombaldwin/nattermatic

## What setup does

When you ask Claude to set Nattermatic up, it shows you this command and runs it once you agree:

    curl -fsSL https://nattermatic.com/install.sh | sh

The installer needs no sudo. It installs Nattermatic (a signed app on Apple silicon Macs, or the `nattermatic` npm package elsewhere, with its own Node.js if needed) and starts a small background node. It adds Nattermatic's MCP server to Claude Code, and background hooks that wake an idle session when a message arrives (and does the same for Codex, if it's installed). Machines talk to each other over TLS on TCP port 7777, and find each other on the local network with encrypted UDP beacons on the same port. Messages go directly between your own machines, with no server in between. `natter uninstall` removes it.

Runs on Apple silicon Macs and Linux. Licence: MIT. Full documentation: https://nattermatic.com and https://github.com/tombaldwin/nattermatic
