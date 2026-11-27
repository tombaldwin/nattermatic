// End-to-end: setup, invites, joining and removal, with real `natter setup` (nodes on ports i/k/l).
import {
  fs, os, path, assert, net, tls, crypto, spawn, execFileSync, execFile, spawnSync, fileURLToPath, Client, StdioClientTransport, newIdentity, Roster, signEnvelope, sealBeacon, authedRequest, peerCertificate, Local, readIdentity, VERSION, openStore, BIN, EXE, PRE, ROOT, sleep, BASE, NODES, EXTRA_PORTS, routes, IDS, TESTER, NET, OTHER_NET, home, envFor, localOf, procs, startNode, stopNode, cliAsync, cliFails, cli, adapter, waitFor, acked, running, ensureNode, memberPost, envelope, outsiderGet, curlBin, killPorts, step, setupEnv, setup, scli, sLocal, parseInvite, joinArgs, run,
} from './harness.js'

await run(async () => {
  let inv

  await step('setup creates a network and keeps it; --new-network starts over', async () => {
    let r = setup('i')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /New network created/)
    inv = parseInvite(r.stdout)
    const fp1 = readIdentity(path.join(ROOT, 's-i')).fp
    assert.notEqual(inv.pin, fp1, 'the invite pins an invite key, not the machine key')
    assert.equal((await peerCertificate(`127.0.0.1:${NODES.i}`)).fp, inv.pin, 'presented while the invite is open')
    const first = inv
    r = setup('i')
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stdout, /New network created/)
    assert.doesNotMatch(r.stdout, /Join my nattermatic network/, 're-running setup makes no new invite')
    assert.equal(readIdentity(path.join(ROOT, 's-i')).fp, fp1, 'key kept')
    r = setup('i', ['--new-network'])
    assert.match(r.stdout, /New network created/)
    assert.notEqual(readIdentity(path.join(ROOT, 's-i')).fp, fp1, 'new key')
    const h = await sLocal('i').health()
    assert.equal(h.fp, readIdentity(path.join(ROOT, 's-i')).fp, 'the old node was stopped and the new one runs')
    inv = parseInvite(r.stdout)
    assert.notEqual(inv.pin, first.pin, 'a new network gets a new invite key')
    assert.equal(spawnSync(curlBin, ['-fsSL', '-k', `https://127.0.0.1:${NODES.i}/join/install?t=${first.token}`]).status, 22, 'the old network\'s invites are gone')
  })

  await step('the invite line works with real curl, and only with the right key', async () => {
    const url = `https://127.0.0.1:${NODES.i}/join/install?t=${inv.token}`
    const good = spawnSync(curlBin, ['-fsSL', '-k', '--pinnedpubkey', `sha256//${inv.pin}`, url], { encoding: 'utf8' })
    assert.equal(good.status, 0, good.stderr)
    assert.match(good.stdout, /NATTERMATIC_PIN=/)
    assert.match(good.stdout, /NATTERMATIC_TOKEN=/)
    assert.doesNotMatch(good.stdout, /--token/, 'the token is never put on a command line')
    assert.match(good.stdout, /^set -- --join .* "\$@"$/m, 'what the user adds to the line (--host) is kept')
    const bad = spawnSync(curlBin, ['-fsSL', '-k', '--pinnedpubkey', `sha256//${newIdentity().fp}`, url], { encoding: 'utf8' })
    assert.notEqual(bad.status, 0, 'a different key (an impostor serving the installer) is refused')
    assert.equal(spawnSync(curlBin, ['-fsSL', '-k', `https://127.0.0.1:${NODES.i}/join/install?t=wrong-token`]).status, 22, 'a wrong token gets nothing')
  })

  await step('a machine joins with an invite; the invite is then spent', async () => {
    const r = setup('k', joinArgs(inv))
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /Joined the network via i\.test/)
    assert.doesNotMatch(r.stdout, /Join my nattermatic network/, 'a machine that just joined opens no invite of its own')
    assert.equal(scli('k', 'invite', '--list').stdout.trim(), 'No unused invites.')
    const typo = scli('k', 'invite', '--lsit')
    assert.equal(typo.status, 2)
    assert.match(typo.stderr, /unknown option --lsit/)
    assert.equal(scli('k', 'invite', '--list').stdout.trim(), 'No unused invites.', 'a mistyped option makes no invite')
    const iStatus = JSON.parse(scli('i', 'status').stdout)
    assert.deepEqual(iStatus.members.map(m => m.host).sort(), ['i.test', 'k.test'])
    assert.equal(iStatus.members.find(m => m.host === 'k.test').added_by, 'i.test')
    // the token is single-use
    const again = setup('l', joinArgs(inv))
    assert.notEqual(again.status, 0)
    assert.match(again.stderr, /not presenting this invite's key\. Either the invite was already used/)
    // the invite key went with the last open invite: back to throwaway keys
    const after = await peerCertificate(`127.0.0.1:${NODES.i}`)
    assert.ok(![inv.pin, readIdentity(path.join(ROOT, 's-i')).fp].includes(after.fp), 'neither the spent invite key nor the machine key')
    // k can message i (k learns i's address from the join address)
    await waitFor(() => JSON.parse(scli('k', 'status').stdout).peers.some(p => p.host === 'i.test' && p.addr), 8000, 'k knows where i is')
    assert.match(scli('k', 'send', 'x@i.test', 'hello from k').stdout, /stored on i\.test/)
  })

  await step('joining is refused for a wrong key, a taken name, and expired or revoked invites', async () => {
    // an invite whose pin doesn't match the machine at the address (someone in the middle)
    let fresh = parseInvite(scli('i', 'invite').stdout)
    let r = setup('l', joinArgs({ ...fresh, pin: newIdentity().fp }))
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /not presenting this invite's key/)
    // a name that's already a member
    r = setup('l', joinArgs(fresh), { NATTERMATIC_HOST: 'k.test' })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /k\.test is already a member/)
    // revoked
    assert.match(scli('i', 'invite', '--revoke').stdout, /revoked [1-9]/)
    r = setup('l', joinArgs(fresh))
    assert.match(r.stderr, /not presenting this invite's key/, 'no invite open: its key is gone')
    // expired, while another invite is open (both pin the same invite key, so the token decides)
    fresh = parseInvite(scli('i', 'invite').stdout)
    const other = parseInvite(scli('i', 'invite').stdout)
    assert.equal(other.pin, fresh.pin, 'open invites share the invite key')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path.join(ROOT, 's-i', 'nattermatic.db'))
    db.prepare(`UPDATE invites SET expires_at=1 WHERE hash=?`).run(crypto.createHash('sha256').update(fresh.token).digest('base64url'))
    db.close()
    r = setup('l', joinArgs(fresh))
    assert.match(r.stderr, /not valid \(already used, expired or revoked\)/)
    scli('i', 'invite', '--revoke')
  })

  await step('only an earlier machine can remove one; a removed machine can neither send nor receive', async () => {
    const no = scli('k', 'remove', 'i.test')
    assert.notEqual(no.status, 0)
    assert.match(no.stderr, /i\.test joined the network before this machine, so only an earlier machine can remove it/)
    const r = scli('i', 'remove', 'k.test')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /removed k\.test/)
    const iStatus = JSON.parse(scli('i', 'status').stdout)
    assert.deepEqual(iStatus.members.map(m => m.host), ['i.test'])
    const out = scli('k', 'send', 'x@i.test', 'after removal').stdout
    assert.doesNotMatch(out, /pushed to|stored on/)
    assert.match(scli('i', 'send', 'x@k.test', 'to the removed').stderr, /k\.test was removed from the network/)
    assert.match(scli('i', 'remove', 'i.test').stderr, /natter uninstall/)
  })

  const netOf = n => JSON.parse(fs.readFileSync(path.join(ROOT, `s-${n}`, 'roster.json'), 'utf8')).net
  await step('a removed machine re-joins with an invite (as the invite line runs it), with a new key', async () => {
    const dir = path.join(ROOT, 's-k'), old = readIdentity(dir).fp
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'roster.json'), 'utf8')).records.some(r => r.fp === old), 'nothing told k it was removed')
    const fresh = parseInvite(scli('i', 'invite').stdout)
    const r = setup('k', [...joinArgs(fresh), '--net', netOf('i')])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /Joined the network via i\.test/)
    assert.notEqual(readIdentity(dir).fp, old, 'a removed key is gone for good')
    assert.ok(JSON.parse(scli('i', 'status').stdout).members.some(m => m.host === 'k.test'))
    assert.equal(scli('i', 'invite', '--list').stdout.trim(), 'No unused invites.', 'and the invite was used once')
    await waitFor(() => /stored on i\.test/.test(scli('k', 'send', 'x@i.test', 'back again').stdout), 8000, 'k reaches i again')
  })

  await step('a machine is renamed by removing it and joining under the new name', async () => {
    let fresh = parseInvite(scli('i', 'invite').stdout)
    const asIs = setup('k', [...joinArgs(fresh), '--net', netOf('i')], { NATTERMATIC_HOST: 'k2.test' })
    assert.notEqual(asIs.status, 0)
    assert.match(asIs.stderr, /already a member as k\.test\. To rename it, run `natter remove k\.test`/)
    assert.equal(scli('i', 'remove', 'k.test').status, 0)
    const r = setup('k', [...joinArgs(fresh), '--net', netOf('i')], { NATTERMATIC_HOST: 'k2.test' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(JSON.parse(scli('i', 'status').stdout).members.some(m => m.host === 'k2.test'))
    const stay = setup('k', [], { NATTERMATIC_HOST: 'other.test' })
    assert.notEqual(stay.status, 0, 'and without an invite the name can\'t be changed, by flag or by environment')
    assert.match(stay.stderr, /on its network as k2\.test/)
  })

  await step('messages waiting for the old network stay behind when a machine leaves it', async () => {
    await sLocal('k').req('POST', '/local/shutdown').catch(() => {})
    await waitFor(async () => !await sLocal('k').health(), 5000, 'k to stop')
    assert.match(scli('i', 'send', 'x@k2.test', 'NET1-SECRET').stdout, /queued/)
    const r = setup('i', ['--new-network'])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /dropped \d+ undelivered message/)
    assert.deepEqual(JSON.parse(scli('i', 'status').stdout).pending, [])
    scli('i', 'invite', '--revoke')
  })

  await step('a standing-by node does not start after uninstall', async () => {
    const env = setupEnv('i')
    const standby = spawn(EXE, [...PRE, 'node'], { env, stdio: 'ignore' })
    await sleep(1000)
    fs.writeFileSync(path.join(ROOT, 's-i', 'disabled'), '')        // what `natter uninstall` writes first
    await sLocal('i').req('POST', '/local/shutdown')
    const exited = await Promise.race([new Promise(r => standby.once('exit', () => r(true))), sleep(8000).then(() => false)])
    if (!exited) standby.kill('SIGKILL')
    assert.ok(exited, 'standby node exited instead of taking over')
    assert.equal(await sLocal('i').health(), null)
  })

  await step('setup: bad config, bad --host and old-style secrets never change the network', async () => {
    const dir = path.join(ROOT, 's-i')
    const cfgFile = path.join(dir, 'config.json')
    assert.equal(setup('i').status, 0)
    const fp = readIdentity(dir).fp
    // an old-style secret argument is refused with a pointer to invites
    let r = setup('i', ['some-old-shared-secret-0123456789'])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /no longer uses a shared network secret/)
    // an invalid --host is refused before anything is written
    const before = fs.readFileSync(cfgFile, 'utf8')
    r = setup('i', ['--host', 'my_host'])
    assert.notEqual(r.status, 0)
    assert.equal(fs.readFileSync(cfgFile, 'utf8'), before)
    // a config with a syntax error stops setup instead of minting a new network
    fs.writeFileSync(cfgFile, before.replace(/\}\s*$/, ',}'))
    r = setup('i')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /bad config/)
    assert.doesNotMatch(r.stdout, /New network created/)
    assert.equal(readIdentity(dir).fp, fp)
    fs.writeFileSync(cfgFile, before)
    // the home directory and key are private even if something created the directory world-readable first
    fs.chmodSync(dir, 0o755)
    assert.equal(setup('i').status, 0)
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(dir, 'node.key')).mode & 0o077, 0)
    // a lost certificate comes back from the member list, and nothing is replaced
    const roster = fs.readFileSync(path.join(dir, 'roster.json'), 'utf8')
    const id = readIdentity(dir)
    fs.rmSync(path.join(dir, 'node.crt'))
    r = setup('i')
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /restored .*node\.crt/)
    assert.doesNotMatch(r.stdout, /New network created/)
    assert.equal(readIdentity(dir).fp, id.fp)
    assert.equal(fs.readFileSync(path.join(dir, 'roster.json'), 'utf8'), roster)
    // a lost key can't be: setup says so instead of starting a new network over the old one
    fs.rmSync(path.join(dir, 'node.key'))
    r = setup('i')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /key files are incomplete/)
    assert.equal(fs.readFileSync(path.join(dir, 'roster.json'), 'utf8'), roster)
    fs.writeFileSync(path.join(dir, 'node.key'), id.key, { mode: 0o600 })
    // a certificate that isn't this key's, or a damaged one: the member list holds the right one
    for (const bad of [newIdentity().cert, '-----BEGIN CERT']) {
      fs.writeFileSync(path.join(dir, 'node.crt'), bad)
      r = setup('i')
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /restored .*node\.crt/)
      assert.equal(readIdentity(dir).fp, id.fp)
    }
    // and --new-network still works with one
    fs.writeFileSync(path.join(dir, 'node.crt'), newIdentity().cert)
    assert.equal(setup('i', ['--new-network']).status, 0)
    scli('i', 'invite', '--revoke')
  })

  await step('a node started on demand exits when one is already running', async () => {
    assert.ok(await sLocal('i').health(), 'a node is running')
    const r = spawnSync(EXE, [...PRE, 'node', '--on-demand'], { env: setupEnv('i'), encoding: 'utf8', timeout: 10_000 })
    assert.equal(r.status, 0, 'exited on its own')
    assert.match(r.stderr, /already running/)
  })

  await step('re-joining the same network keeps a removal the inviter has not heard of', async () => {
    assert.equal(setup('i', ['--new-network']).status, 0)
    scli('i', 'invite', '--revoke')
    assert.equal(setup('k', joinArgs(parseInvite(scli('i', 'invite').stdout)), { NATTERMATIC_HOST: 'k.test' }).status, 0, 'k joins')
    fs.rmSync(path.join(ROOT, 's-l'), { recursive: true, force: true })
    assert.equal(setup('l', joinArgs(parseInvite(scli('i', 'invite').stdout))).status, 0, 'l joins')
    await sLocal('l').req('POST', '/local/shutdown').catch(() => {})
    await sLocal('k').req('POST', '/local/shutdown').catch(() => {})     // a node starting up says hello
    await waitFor(async () => !await sLocal('k').health(), 5000, 'k to stop')
    await waitFor(async () => JSON.parse(scli('k', 'status').stdout).members.some(m => m.host === 'l.test'), 8000, 'k hears of l')
    const again = parseInvite(scli('i', 'invite').stdout)
    await sLocal('i').req('POST', '/local/shutdown').catch(() => {})
    await waitFor(async () => !await sLocal('i').health(), 5000, 'i to stop')
    assert.match(scli('k', 'remove', 'l.test').stdout, /removed l\.test/)
    await sLocal('k').req('POST', '/local/shutdown').catch(() => {})
    await waitFor(async () => !await sLocal('k').health(), 5000, 'k to stop')
    scli('i', 'status')                                        // i comes back, knowing nothing of it
    assert.ok(JSON.parse(scli('i', 'status').stdout).members.some(m => m.host === 'l.test'))
    const net = JSON.parse(fs.readFileSync(path.join(ROOT, 's-i', 'roster.json'), 'utf8')).net
    const r = setup('k', [...joinArgs(again), '--net', net])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /Already a member/)
    assert.ok(!JSON.parse(scli('k', 'status').stdout).members.some(m => m.host === 'l.test'), 'still gone here')
    await waitFor(() => !JSON.parse(scli('i', 'status').stdout).members.some(m => m.host === 'l.test'), 8000, 'and i learns of it')
  })

  await step('the install preset keeps the name that worked, and setup finds a node on its old port', async () => {
    const inv2 = parseInvite(scli('i', 'invite').stdout)
    const script = host => spawnSync(curlBin, ['-fsSL', '-k', '-H', `Host: ${host}`, `https://127.0.0.1:${NODES.i}/join/install?t=${inv2.token}`], { encoding: 'utf8' }).stdout
    assert.match(script(`127.0.0.1:${NODES.i}`), /--peer 'i\.test/)
    assert.match(script(`[::1]:${NODES.i}`), new RegExp(`--join '\\[::1\\]:${NODES.i}'`))
    assert.match(script('box:99999'), new RegExp(`--join 'i\\.test:${NODES.i}'`), 'no such port: our own address')
    scli('i', 'invite', '--revoke')
    const k = sLocal('k')
    assert.ok(await k.health(), 'k runs on its port')
    assert.equal(setup('k', [], { NATTERMATIC_PORT: String(NODES.m) }).status, 0)
    await waitFor(async () => !await k.health(), 3000, 'the old node gone')
    await new Local({ identity: readIdentity(path.join(ROOT, 's-k')), port: NODES.m, dir: path.join(ROOT, 's-k') }).req('POST', '/local/shutdown').catch(() => {})
  })

  await step('a name the roster would refuse stops setup, however it was given', async () => {
    for (const name of ['10.0.0.5', 'localhost']) {
      fs.rmSync(path.join(ROOT, 's-n'), { recursive: true, force: true })
      const r = setup('n', [], { NATTERMATIC_HOST: name })
      assert.notEqual(r.status, 0)
      assert.match(r.stderr, /can't identify a machine/)
      assert.ok(!fs.existsSync(path.join(ROOT, 's-n', 'roster.json')))
    }
  })

  await step('leaving a network leaves nothing of it behind, even with its database locked', async () => {
    const dir = path.join(ROOT, 's-i')
    assert.match(scli('i', 'send', 'nobody', 'OLD-NETWORK').stdout, /queued/)
    parseInvite(scli('i', 'invite').stdout)
    const db = openStore(path.join(dir, 'nattermatic.db'))
    await sLocal('i').req('POST', '/local/shutdown').catch(() => {})
    await waitFor(async () => !await sLocal('i').health(), 5000, 'i to stop')
    db.exec('BEGIN IMMEDIATE')
    const r = setup('i', ['--new-network'])
    db.exec('ROLLBACK')
    db.close()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /removing it/)
    assert.equal(scli('i', 'invite', '--list').stdout.includes('made'), true, 'a new network\'s own invite, and no other')
    assert.equal((JSON.parse(scli('i', 'status').stdout).counts.find(c => c.state === 'queued')), undefined)
    scli('i', 'invite', '--revoke')
    // and without the lock, queued messages go too
    assert.match(scli('i', 'send', 'nobody', 'OLD-NETWORK').stdout, /queued/)
    const r2 = setup('i', ['--new-network'])
    assert.match(r2.stdout, /dropped 1 undelivered message/)
    assert.equal(JSON.parse(scli('i', 'status').stdout).counts.find(c => c.state === 'queued'), undefined)
    scli('i', 'invite', '--revoke')
  })
})
