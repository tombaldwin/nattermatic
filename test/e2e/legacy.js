// End-to-end: machines set up as agentlink move to nattermatic.
import {
  fs, os, path, assert, net, tls, crypto, spawn, execFileSync, execFile, spawnSync, fileURLToPath, Client, StdioClientTransport, newIdentity, Roster, signEnvelope, sealBeacon, authedRequest, peerCertificate, Local, readIdentity, VERSION, openStore, BIN, EXE, PRE, ROOT, sleep, BASE, NODES, EXTRA_PORTS, routes, IDS, TESTER, NET, OTHER_NET, home, envFor, localOf, procs, startNode, stopNode, cliAsync, cliFails, cli, adapter, waitFor, acked, running, ensureNode, memberPost, envelope, outsiderGet, curlBin, killPorts, step, setupEnv, setup, scli, sLocal, parseInvite, joinArgs, run,
} from './harness.js'

await run(async () => {
  await step('a machine set up as agentlink moves to nattermatic, keeping its key, network, messages and settings', async () => {
    // a home of its own, as a user's would be: no NATTERMATIC_HOME
    const H = path.join(ROOT, 'old-user')
    fs.mkdirSync(H)
    const port = String(EXTRA_PORTS[3])
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NATTERMATIC|AGENTLINK)_/.test(k)))
    const run = (env, ...args) => spawnSync(EXE, [...PRE, ...args], { env: { ...clean, HOME: H, ...env }, encoding: 'utf8', timeout: 60_000 })
    const opts = ['--no-service', '--no-claude', '--no-codex', '--no-alias']
    const now = { NATTERMATIC_PORT: port, NATTERMATIC_HOST: 'old.test', NATTERMATIC_DISCOVERY: '0', NATTERMATIC_AUTO_ALIASES: '0' }
    let r = run(now, 'setup', ...opts)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(run(now, 'to', 'someone', 'SAVED BEFORE THE MOVE').stdout, /queued/)
    const home = path.join(H, '.nattermatic'), old = path.join(H, '.agentlink')
    const fp = readIdentity(home).fp
    const before = JSON.parse(run(now, 'status').stdout).counts
    const local = new Local({ identity: readIdentity(home), port: Number(port), dir: home })
    await local.req('POST', '/local/shutdown').catch(() => {})
    await waitFor(async () => !await local.health(), 5000, 'the node to stop')
    // as agentlink left it
    fs.renameSync(home, old)
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(path.join(old, `nattermatic.db${ext}`))) fs.renameSync(path.join(old, `nattermatic.db${ext}`), path.join(old, `agentlink.db${ext}`))
    // its settings, under their old names
    const then = Object.fromEntries(Object.entries(now).map(([k, v]) => [k.replace('NATTERMATIC_', 'AGENTLINK_'), v]))
    r = run(then, 'setup', ...opts)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /moved .*\.agentlink to .*\.nattermatic/)
    assert.ok(fs.lstatSync(old).isSymbolicLink() && fs.realpathSync(old) === fs.realpathSync(home), 'the old path leads to the new home')
    assert.equal(readIdentity(home).fp, fp, 'the same key')
    assert.ok(fs.existsSync(path.join(home, 'nattermatic.db')) && !fs.existsSync(path.join(home, 'agentlink.db')), 'the database under its new name')
    const st = JSON.parse(run(then, 'status').stdout)
    assert.equal(st.host, 'old.test')
    assert.deepEqual(st.counts, before, 'the same messages')
    // the old command names still work
    assert.match(run(then, 'peers').stdout, /old\.test \(this machine\)/)
    // and a second setup has nothing more to move
    r = run(now, 'setup', ...opts)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /moved/)
    await local.req('POST', '/local/shutdown').catch(() => {})
  })

  // A user's machine as agentlink left it, in a home of its own: an unused invite and a queued message
  // in agentlink.db, its node stopped. `where` is the folder ~/.agentlink is (a link leads to it if not there).
  const oldMachine = async (name, where) => {
    const H = path.join(ROOT, name)
    fs.mkdirSync(H)
    const port = String(EXTRA_PORTS[3])
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NATTERMATIC|AGENTLINK)_/.test(k)))
    const env = { NATTERMATIC_PORT: port, NATTERMATIC_HOST: `${name}.test`, NATTERMATIC_DISCOVERY: '0', NATTERMATIC_AUTO_ALIASES: '0' }
    const run = (...args) => spawnSync(EXE, [...PRE, ...args], { env: { ...clean, HOME: H, ...env }, encoding: 'utf8', timeout: 60_000 })
    const opts = ['--no-service', '--no-claude', '--no-codex', '--no-alias']
    let r = run('setup', ...opts)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(run('to', 'someone', 'FOR THE OLD NETWORK').stdout, /queued/)
    const home = path.join(H, '.nattermatic'), old = path.join(H, '.agentlink')
    const local = new Local({ identity: readIdentity(home), port: Number(port), dir: home })
    await local.req('POST', '/local/shutdown').catch(() => {})
    await waitFor(async () => !await local.health(), 5000, 'the node to stop')
    const dir = where ? path.join(H, where) : old
    fs.renameSync(home, dir)
    if (where) fs.symlinkSync(dir, old)
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(path.join(dir, `nattermatic.db${ext}`))) fs.renameSync(path.join(dir, `nattermatic.db${ext}`), path.join(dir, `agentlink.db${ext}`))
    const fp = readIdentity(dir).fp
    return { H, home, old, dir, fp, run, opts, local }
  }
  const stopAt = async (m) => {
    const l = new Local({ identity: readIdentity(m.home), port: Number(EXTRA_PORTS[3]), dir: m.home })
    await l.req('POST', '/local/shutdown').catch(() => {})
    await waitFor(async () => !await l.health(), 5000, 'the node to stop')
  }

  await step('a machine set up as agentlink that starts a new network keeps none of the old one\'s invites or messages', async () => {
    const m = await oldMachine('old-new')
    const r = m.run('setup', ...m.opts, '--new-network')
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /moved .*\.agentlink/)
    assert.match(r.stdout, /dropped 1 undelivered message/)
    assert.notEqual(readIdentity(m.home).fp, m.fp, 'a new key')
    const st = JSON.parse(m.run('status').stdout)
    assert.equal(st.counts.find(c => c.state === 'queued'), undefined, 'the old network\'s message is gone')
    // only the new network's own invite: agentlink's unused one went with its network
    assert.equal(m.run('invite', '--list').stdout.trim().split('\n').filter(l => /made/.test(l)).length, 1)
    // a client started before the new key (a running session's adapter) reaches the node under it
    const h = await m.local.health()
    assert.ok(h && !('foreign' in h), 'the node is found under the new key')
    assert.equal(m.local.cfg.identity.fp, readIdentity(m.home).fp)
    await stopAt(m)
  })

  await step('a machine whose ~/.agentlink is a link moves too, with its data left where the link leads', async () => {
    const m = await oldMachine('old-link', 'elsewhere')
    const r = m.run('setup', ...m.opts)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /linked .*\.nattermatic to .*elsewhere/)
    assert.doesNotMatch(r.stdout, /New network/)
    assert.equal(fs.realpathSync(m.home), fs.realpathSync(m.dir), 'the new home leads to the same folder')
    assert.equal(fs.realpathSync(m.old), fs.realpathSync(m.dir), 'and so does the old one')
    assert.equal(readIdentity(m.home).fp, m.fp, 'the same key')
    assert.ok(fs.existsSync(path.join(m.dir, 'nattermatic.db')), 'the database under its new name')
    assert.ok(JSON.parse(m.run('status').stdout).counts.find(c => c.state === 'queued'), 'the same messages')
    // a second setup has nothing more to move
    const r2 = m.run('setup', ...m.opts)
    assert.equal(r2.status, 0, r2.stdout + r2.stderr)
    assert.doesNotMatch(r2.stdout, /moved|linked/)
    await stopAt(m)
  })

  await step('a join that can\'t go ahead leaves a machine set up as agentlink as it was', async () => {
    const m = await oldMachine('old-join')
    // nothing answers on this port: the invite can't be checked
    const r = m.run('setup', ...m.opts, '--join', `127.0.0.1:${EXTRA_PORTS[2]}`, '--pin', 'x'.repeat(10), '--token', 'y'.repeat(24))
    assert.notEqual(r.status, 0)
    assert.match(r.stdout + r.stderr, /cannot reach/)
    assert.ok(fs.lstatSync(m.old).isDirectory(), 'agentlink\'s home is still where it was')
    assert.ok(!fs.existsSync(m.home) || !fs.readdirSync(m.home).includes('node.key'), 'nothing was moved')
  })
})
