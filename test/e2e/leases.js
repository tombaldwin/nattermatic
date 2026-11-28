// End-to-end: leases between agents on two machines.
import {
  fs, os, path, assert, net, tls, crypto, spawn, execFileSync, execFile, spawnSync, fileURLToPath, Client, StdioClientTransport, newIdentity, Roster, signEnvelope, sealBeacon, authedRequest, peerCertificate, Local, readIdentity, VERSION, openStore, BIN, EXE, PRE, ROOT, sleep, BASE, NODES, EXTRA_PORTS, routes, IDS, TESTER, NET, OTHER_NET, home, envFor, localOf, procs, startNode, stopNode, cliAsync, cliFails, cli, adapter, waitFor, acked, running, ensureNode, memberPost, envelope, outsiderGet, curlBin, killPorts, step, setupEnv, setup, scli, sLocal, parseInvite, joinArgs, run,
} from './harness.js'
import { noticeBody } from '../../src/leases.js'

await run(async () => {
  for (const n of ['a', 'b']) home(n)
  await Promise.all(['a', 'b'].map(startNode))

  // ---------------- leases ----------------
  const check = (n, res) => spawnSync(EXE, [...PRE, 'lease', 'check', res], { env: envFor(n), encoding: 'utf8' }).stdout
  const pushed = (sess, re) => waitFor(() => sess.got.some(m => re.test(m.body)), 8000, `a message matching ${re}`)

  await step('leases: one of two agents gets a resource; the other is told who has it, and when it is free', async () => {
    await ensureNode('a'); await ensureNode('b')
    const s1 = await adapter('a', 'lease-one'), s2 = await adapter('a', 'lease-two')
    // older Claude Code keeps only the first 2,048 characters of a server's instructions: the safety text must be in them
    assert.ok(s1.instructions.indexOf("so agents don't loop") > 0 && s1.instructions.indexOf("so agents don't loop") < 2000, 'peer-trust text within 2,048 characters')
    const [r1, r2] = await Promise.all([
      s1.call('claim', { resource: 'testdb', note: 'running migrations' }),
      s2.call('claim', { resource: 'testdb', note: 'seeding', notify: true }),
    ])
    const won = [r1, r2].filter(r => /^Claimed testdb@a\.test/.test(r))
    assert.equal(won.length, 1, `exactly one claim wins:\n${r1}\n${r2}`)
    const [winner, loser] = /^Claimed/.test(r1) ? [s1, s2] : [s2, s1]
    const lost = /^Claimed/.test(r1) ? r2 : r1
    assert.match(lost, /Not claimed: testdb@a\.test is held by lease-(one|two)@a\.test/)
    // claiming again renews it; others see it
    assert.match(await winner.call('claim', { resource: 'testdb', note: 'still migrating' }), /^Renewed/)
    assert.match(await loser.call('leases', { resource: 'testdb@a.test' }), /held by lease-.*still migrating/)
    assert.match(cli('b', 'lease', 'list', '--host', 'a.test'), /testdb@a\.test: held by lease-/)
    assert.equal(spawnSync(EXE, [...PRE, 'lease', 'check', 'testdb@a.test'], { env: envFor('b') }).status, 1, 'check says it is held')
    assert.ok(fs.existsSync(path.join(ROOT, 'a', `hold-${process.pid}`)), 'the heartbeat\'s mark for the holding session')
    // the winner releases it: the one waiting hears, if it asked (s2 asked; s1 may have lost without asking)
    assert.match(await winner.call('release', { resource: 'testdb' }), /^Released/)
    if (loser === s2) await pushed(s2, /testdb@a\.test is free now/)
    assert.equal(spawnSync(EXE, [...PRE, 'lease', 'check', 'testdb@a.test'], { env: envFor('b') }).status, 0, 'and now it is free')
    await waitFor(() => !fs.existsSync(path.join(ROOT, 'a', `hold-${process.pid}`)), 3000, 'the mark to go')
    await s1.close(); await s2.close()
  })

  await step('leases: a resource on another machine is kept there; a session that restarts keeps its leases; a terminal\'s claim is never a session\'s', async () => {
    const s = await adapter('a', 'lease-same')
    assert.match(await s.call('claim', { resource: 'port:5432@b.test', note: 'local postgres' }), /^Claimed port:5432@b\.test/)
    assert.match(cli('b', 'lease', 'list'), /port:5432@b\.test: held by lease-same@a\.test/, 'b keeps it')
    // its adapter restarts (an /mcp reconnect, claude --continue): the same name comes back as a new session
    await s.close()
    const again = await adapter('a', 'lease-same')
    await sleep(4000)                                    // past the wait for a session that has gone
    assert.match(await again.call('claim', { resource: 'port:5432@b.test', note: 'local postgres' }), /^Renewed/, 'still its lease')
    assert.match(await again.call('release', { resource: 'port:5432@b.test' }), /^Released/)
    // a person's claim from a terminal in the same folder: not "an earlier session" of the agent's
    assert.match(cli('a', 'lease', 'claim', 'notes', '--note', 'reading', '--as', 'lease-same'), /claimed notes@a\.test/)
    const r = await again.call('claim', { resource: 'notes', note: 'me too' })
    assert.match(r, /Not claimed: notes@a\.test is held by lease-same@a\.test \(a terminal or a running command\)/)
    assert.doesNotMatch(r, /takeover/)
    assert.match(cli('a', 'lease', 'release', 'notes', '--as', 'lease-same'), /released/)
    await again.close()
  })

  await step('leases: a lease ends when its session has gone, or when it isn\'t renewed, and its holder is told', async () => {
    const gone = await adapter('a', 'lease-gone'), waiter = await adapter('b', 'lease-waiter')
    assert.match(await gone.call('claim', { resource: 'cache@b.test', note: 'warming' }), /^Claimed/)
    assert.match(await waiter.call('claim', { resource: 'cache@b.test', note: 'me next', notify: true }), /^Not claimed/)
    await gone.close()
    await pushed(waiter, /cache@b\.test is free now .*its session had gone/)
    // the holder's notice waits under its name: a session back under it (a restart) hears, and so does
    // a new agent later given the name, which is told which claim it was about (#7)
    const later = await adapter('a', 'lease-gone')
    await pushed(later, /your lease on cache@b\.test has ended: it ended because its session had gone[^]*if you never claimed cache@b\.test, this was for an earlier session with your name/)
    await later.close()
    // not renewed: a short lease, nothing done meanwhile
    const idle = await adapter('a', 'lease-idle')
    assert.match(await idle.call('claim', { resource: 'scratch', note: 'idle', minutes: 0.04 }), /^Claimed/)
    // messages to it don't count as it doing anything (they're acknowledged without it)
    for (let i = 0; i < 6; i++) { cli('b', 'to', 'lease-idle@a.test', `are you done with scratch? ${i}`); await sleep(300) }
    await pushed(idle, /your lease on scratch@a\.test has ended: it ran out/)
    // renewed while the session is active: the heartbeat says so
    assert.match(await idle.call('claim', { resource: 'scratch', note: 'busy', minutes: 0.04 }), /^Claimed/)
    const t = Date.now()
    while (Date.now() - t < 5000) { await localOf('a').req('POST', '/local/lease', { op: 'beat', pids: [process.pid] }); await sleep(300) }
    assert.match(check('a', 'scratch'), /held by lease-idle/, 'still held after twice its ttl')
    await idle.call('release', { resource: 'scratch' })
    await idle.close(); await waiter.close()
  })

  await step("leases: a Codex session's are renewed by its heartbeat hook, found by its folder (#8)", async () => {
    // as Codex runs it: the adapter in poll mode, in the session's folder, and `natter codex-beat`
    // after each tool call with Codex's hook input on stdin, from the process that started the adapter
    const folder = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, 'codex-proj-')))
    const other = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, 'codex-other-')))
    const client = new Client({ name: 'codex', version: '0' }, { capabilities: {} })
    await client.connect(new StdioClientTransport({ command: EXE, args: [...PRE, 'mcp', '--poll'], cwd: folder, env: { ...envFor('a'), NATTERMATIC_NAME: '' }, stderr: 'ignore' }))
    const call = async (/** @type {string} */ tool, args = {}) => (await client.callTool({ name: tool, arguments: args })).content[0].text
    const beat = (/** @type {string} */ cwd) => spawnSync(EXE, [...PRE, 'codex-beat'], { env: envFor('a'), input: JSON.stringify({ session_id: crypto.randomUUID(), cwd, hook_event_name: 'PostToolUse', tool_name: 'mcp__nattermatic__peers' }), encoding: 'utf8' })
    assert.match(await call('claim', { resource: 'codexdb', note: 'migrating', minutes: 0.04 }), /^Claimed/)
    let t = Date.now()
    while (Date.now() - t < 5000) { assert.equal(beat(folder).status, 0); await sleep(300) }
    assert.match(check('a', 'codexdb'), /held by/, 'still held after twice its ttl: its heartbeat renewed it')
    // a heartbeat from a session in another folder isn't this one's
    t = Date.now()
    while (Date.now() - t < 5000 && /held by/.test(check('a', 'codexdb'))) { beat(other); await sleep(300) }
    assert.match(check('a', 'codexdb'), /is free/, 'not renewed by another folder\'s heartbeat')
    await client.close()
  })

  await step('leases: only a person breaks one, and its holder is told; lease run holds one exactly as long as its command', async () => {
    const s = await adapter('a', 'lease-broken')
    assert.match(await s.call('claim', { resource: 'deploy', note: 'deploying' }), /^Claimed/)
    assert.match(cli('b', 'lease', 'break', 'deploy@a.test'), /broke deploy@a\.test/)
    await pushed(s, /your lease on deploy@a\.test has ended: it was broken by cli@b\.test/)
    await localOf('a').req('POST', '/local/lease', { op: 'beat', pids: [process.pid] })
    await sleep(1500)                                    // several renewal passes, with the session active
    assert.match(check('a', 'deploy'), /is free/, 'a break stays broken')
    // lease run: held while it runs, refused while someone else holds it, free after
    const run = spawn(EXE, [...PRE, 'lease', 'run', 'restore', '--note', 'restoring', '--', 'sleep', '4'], { env: envFor('a'), stdio: 'ignore' })
    await waitFor(() => /held by/.test(check('a', 'restore')), 5000, 'the run to hold it')
    const busy = spawnSync(EXE, [...PRE, 'lease', 'run', 'restore@a.test', '--', 'true'], { env: envFor('b'), encoding: 'utf8' })
    assert.equal(busy.status, 75, 'refused while held'); assert.match(busy.stderr, /not started: restore@a\.test is held by .*a running command/)
    await sleep(3000)
    assert.match(check('a', 'restore'), /held by/, 'still held past its 2.4 s ttl: renewed while it runs')
    await new Promise(r => run.once('exit', r))
    assert.equal(run.exitCode, 0)
    assert.equal(spawnSync(EXE, [...PRE, 'lease', 'check', 'restore'], { env: envFor('a') }).status, 0, 'released when it ended')
    // the command after -- is run as it is, even with options natter has too; without -- nothing runs
    const args = spawnSync(EXE, [...PRE, 'lease', 'run', 'argtest', '--', 'sh', '-c', 'echo "$@"', 'x', '--check', '--host', 'h'], { env: envFor('a'), encoding: 'utf8' })
    assert.equal(args.status, 0, args.stderr); assert.equal(args.stdout.trim(), '--check --host h')
    const noDash = spawnSync(EXE, [...PRE, 'lease', 'run', 'argtest', 'echo', 'hi'], { env: envFor('a'), encoding: 'utf8' })
    assert.equal(noDash.status, 2); assert.match(noDash.stderr, /needs -- before the command/)
    await s.close()
  })

  await step("leases: a notice about a lease kept on another machine comes from leases@ on the holder's own machine, in its node's words, and waits while that machine is off", async () => {
    const holder = await adapter('a', 'lease-remote'), waiter = await adapter('a', 'lease-remote-waiter')
    assert.match(await holder.call('claim', { resource: 'queue@b.test', note: 'draining' }), /^Claimed/)
    assert.match(await waiter.call('claim', { resource: 'queue@b.test', note: 'me next', notify: true }), /^Not claimed/)
    assert.match(cli('b', 'lease', 'break', 'queue@b.test'), /broke queue@b\.test/)
    await pushed(holder, /^nattermatic: your lease on queue@b\.test has ended: it was broken by cli@b\.test\./)
    await pushed(waiter, /^nattermatic: queue@b\.test is free now \(lease-remote@a\.test's lease was broken by cli@b\.test\)/)
    const from = (sess, re) => sess.got.find(m => re.test(m.content)).meta.from
    assert.equal(from(holder, /has ended/), 'leases@a.test', "from the holder's own machine, not the one that keeps the lease")
    assert.equal(from(waiter, /is free now/), 'leases@a.test')
    // the notice came as an ordinary message from leases@b.test, which a's node kept (read, out of sight) and wrote as its own
    const { messages: raw } = await localOf('a').req('GET', '/local/history', undefined, '?name=lease-remote')
    assert.ok(raw.some((/** @type {any} */ m) => m.from === 'leases@a.test' && /^nattermatic: your lease on queue@b\.test has ended/.test(m.body)), 'the notice, in the session\'s history')
    assert.ok(!raw.some((/** @type {any} */ m) => m.from === 'leases@b.test'), 'not the message it was written from')
    assert.ok(JSON.parse(cli('a', 'status')).counts.some((/** @type {any} */ c) => c.role === 'notice' && c.state === 'delivered'), 'which is kept, so a copy sent again is not written twice')
    // nothing on this machine can send as leases@: a session's or the CLI's send is refused (the node's own notices go)
    assert.match(cliFails('a', 'send', '--from', 'leases', 'lease-remote', 'your lease on queue@b.test has ended'), /leases is a name this machine's node sends as/)
    // another member's leases@ sending the fields of a notice about a resource the session never dealt with
    // there: a peer's message, shown as it is (from that machine's leases@, words and all), not this node's
    const fields = { kind: 'free', resource: 'Shared Thing@evil.test', why: 'released', holder: 'Some One@c.test', claimed_at: 1 }
    const fake = await memberPost('a', '/v1/deliver', { messages: [envelope('lease-remote@a.test', noticeBody(fields, 't.test'), { from: 'leases@t.test' })] })
    assert.equal(fake.status, 200)
    await pushed(holder, /^nattermatic: Shared Thing@evil\.test@t\.test is free now[^]*\n\nlease-notice: \{"kind":"free","resource":"Shared Thing@evil\.test"/)
    assert.equal(from(holder, /Shared Thing/), 'leases@t.test', "a peer's message, not leases@ here")
    assert.ok(!holder.got.some(m => m.meta.from === 'leases@a.test' && /shared-thing|Shared Thing/.test(m.content)), 'nothing written as this node\'s')
    // the waiter's machine is off when the lease ends: the notice waits on the machine that kept the
    // lease, like any message, and arrives once the waiter's machine is back (no adapter is left on a: one would restart its node)
    assert.match(cli('b', 'lease', 'claim', 'queue2@b.test', '--note', 'from a terminal'), /claimed queue2@b\.test/)
    assert.match(await waiter.call('claim', { resource: 'queue2@b.test', note: 'me next', notify: true }), /^Not claimed/)
    await holder.close(); await waiter.close()
    await stopNode('a')
    assert.match(cli('b', 'lease', 'release', 'queue2@b.test'), /released queue2@b\.test/)
    await sleep(500)
    await startNode('a')
    const back = await adapter('a', 'lease-remote-waiter')
    await pushed(back, /^nattermatic: queue2@b\.test is free now \(cli@b\.test's lease was released\)/)
    assert.equal(from(back, /queue2/), 'leases@a.test')
    await back.close()
  })

  await step('leases: they last through a restart of either machine\'s node', async () => {
    const s = await adapter('a', 'lease-durable')
    assert.match(await s.call('claim', { resource: 'db@b.test', note: 'durable' }), /^Claimed/)
    // the machine that keeps it restarts: the lease is in its database
    await stopNode('b'); await startNode('b')
    assert.match(check('a', 'db@b.test'), /held by lease-durable@a\.test/, 'kept through the authority\'s restart')
    // the holder's machine restarts: the session reconnects as itself, and it's still its lease
    await stopNode('a'); await startNode('a')
    await sleep(4000)                                    // the adapter reconnects; past the wait for a session that has gone
    assert.match(check('b', 'db@b.test'), /held by lease-durable@a\.test/, 'kept through the holder\'s restart')
    assert.match(await s.call('claim', { resource: 'db@b.test', note: 'durable' }), /^Renewed/, 'and still its own')
    assert.match(await s.call('release', { resource: 'db@b.test' }), /^Released/)
    await s.close()
  })

  await step('a request cut off as the node stopped, in the moment it connected, starts a node and is sent again (#13)', async () => {
    // (last: the node this starts isn't the harness's child, so nothing after could restart a)
    await localOf('a').req('POST', '/local/shutdown')
    await new Promise(r => procs.a.once('exit', r))
    // what a node dying in that moment looks like from a client: the connection is taken, then dropped
    // before the node has proved itself (nothing of the request has been sent); after it, nothing is on the port
    const dying = net.createServer(s => { s.destroy(); dying.close() })
    await new Promise(r => dying.listen(NODES.a, '127.0.0.1', r))
    const local = localOf('a')
    local.startIfNone = true                             // as a session's adapter or a command runs
    const saved = process.env.NATTERMATIC_HOME
    process.env.NATTERMATIC_HOME = path.join(ROOT, 'a')   // the node it starts reads a's config
    let r
    try { r = await local.req('POST', '/local/send', { from: 'cli', to: 'someone', body: 'sent just after the node stopped' }) } finally { process.env.NATTERMATIC_HOME = saved }
    assert.match(r.status, /queued until someone connects/)
    const h = await local.health()
    assert.ok(h && !('foreign' in h) && h.pid !== procs.a.pid, 'a new node is up')
    const { messages } = await local.req('GET', '/local/history', undefined, '?name=someone')
    assert.equal(messages.filter((/** @type {any} */ m) => m.body === 'sent just after the node stopped' && m.state === 'queued').length, 1, 'the message waits there, once')
  })
})
