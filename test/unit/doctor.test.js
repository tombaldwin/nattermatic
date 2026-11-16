// `natter doctor`'s verdicts, from facts made up for each case: what it calls broken, what it only
// warns about, and that every problem comes with something to do about it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diagnose, formatFindings } from '../../src/doctor.js'
import { VERSION } from '../../src/config.js'
import { PROTO } from '../../src/tls.js'

/** A machine where everything is right. @returns {import('../../src/doctor.js').Facts} */
const healthy = () => ({
  host: 'desk.local', port: 7777, onPath: true, oldHome: false, oldCli: '', platform: 'darwin',
  health: { version: VERSION, proto: PROTO, ok: true },
  status: { version: VERSION, member: true, removed: false, pending: [], members: [{ host: 'desk.local', self: true, version: VERSION }, { host: 'laptop.local', version: VERSION }] },
  peers: { remote: [{ host: 'laptop.local', online: true, sessions: [] }] },
  claude: { found: true, version: '9.9.9', accounts: [{ alias: 'claude', registered: true }] },
  codex: { present: false, configured: false, wakes: false },
})
const levels = (/** @type {import('../../src/doctor.js').Finding[]} */ f) => f.map(x => x.level)

test('a healthy machine is all ticks', () => {
  const f = diagnose(healthy())
  assert.deepEqual([...new Set(levels(f))], ['ok'])
  assert.match(formatFindings(f), /Everything looks right\.$/)
})

test('every problem says what to do about it', () => {
  const f = healthy()
  Object.assign(f, { onPath: false, oldHome: true, oldCli: '/usr/local/bin/agentlink' })
  f.status.pending = [{ to_addr: 'x@laptop.local', last_error: 'timeout' }]
  f.peers.remote[0] = { host: 'laptop.local', online: false, error: 'connect EHOSTUNREACH' }
  f.claude = { found: true, version: '1.0.0', accounts: [{ alias: 'claude2', registered: false }] }
  f.codex = { present: true, configured: true, wakes: false }
  const out = diagnose(f)
  for (const x of out.filter(x => x.level !== 'ok')) assert.ok(x.fix, `no fix for "${x.text}"`)
  const text = formatFindings(out)
  assert.match(text, /Local Network/, 'an unreachable LAN machine on macOS: the Local Network permission')
  assert.match(text, /claude2/)
  assert.match(text, /too old to be woken/)
  assert.match(text, /codex queue/)
  assert.match(text, /npm uninstall -g @tombaldwin\/agentlink/)
})

test('what\'s broken and what\'s only worth a look', () => {
  /** @param {(f: import('../../src/doctor.js').Facts) => void} change */
  const worst = change => { const f = healthy(); change(f); const l = levels(diagnose(f)); return l.includes('fail') ? 'fail' : l.includes('warn') ? 'warn' : 'ok' }
  assert.equal(worst(f => { f.health = null; delete f.status; delete f.peers }), 'fail', 'no node')
  assert.equal(worst(f => { f.health = { foreign: true }; delete f.status }), 'fail', 'something else on the port')
  assert.equal(worst(f => { f.status.removed = true }), 'fail', 'removed from its network')
  assert.equal(worst(f => { f.disabled = true }), 'fail', 'uninstalled')
  assert.equal(worst(f => { f.health = { ...f.health, version: '0.0.1' } }), 'warn', 'an older node is replaced on its own')
  assert.equal(worst(f => { f.status.members[1].version = '0.0.1' }), 'warn', 'another machine behind')
  assert.equal(worst(f => { f.peers.remote[0].online = false }), 'warn', 'another machine off')
  // not set up: one finding, and nothing else is looked at
  const f = diagnose({ ...healthy(), setupError: 'nattermatic is not set up on this machine' })
  assert.deepEqual(levels(f), ['fail'])
  assert.match(f[0].fix || '', /install\.sh/)
})

test('a newer node with a newer protocol: an old natter is first on PATH', () => {
  const f = healthy()
  f.health = { version: '99.0.0', proto: PROTO + 1, ok: true }
  assert.match(formatFindings(diagnose(f)), /older than the running node[^]*which -a natter/)
})

test('Codex\'s settings with no codex command on PATH: it says so, not "update Codex"', () => {
  const f = healthy()
  f.codex = { present: true, onPath: false, configured: true, wakes: false }
  const text = formatFindings(diagnose(f))
  assert.match(text, /isn't on this shell's PATH/)
  assert.doesNotMatch(text, /update Codex/)
})

test('nattermatic installed more than once: each with its version, and which is on PATH', () => {
  const f = healthy()
  f.self = '/Applications/nattermatic.app/natter'; f.pathFile = '/usr/local/lib/node_modules/nattermatic/bin/natter.js'
  f.installs = [{ file: f.pathFile, version: '0.3.1' }]
  const text = formatFindings(diagnose(f))
  assert.match(text, /installed more than once[^]*nattermatic\.app\/natter \(\d[^)]*\)[^]*natter\.js \(0\.3\.1\), the natter on PATH/)
  assert.match(text, /npm uninstall -g nattermatic/)
  f.installs = []
  assert.doesNotMatch(formatFindings(diagnose(f)), /more than once/)
})
