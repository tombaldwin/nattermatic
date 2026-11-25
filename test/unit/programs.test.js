// Several installs on one machine (#4): the node that runs is the newest that speaks this protocol,
// whichever install starts it, and each install's version is read when it's needed, not remembered.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listPrograms, noteProgram, askProgram, pick, chooseProgram, runChosen } from '../../src/programs.js'

const me = { version: '0.5.0', proto: 2 }
const P = (/** @type {string} */ version, proto = 2, cmd = [`/x/${version}`]) => ({ cmd, version, proto })

test('pick: only a newer program with the same protocol, and the newest of those', () => {
  assert.equal(pick([], me), null)
  assert.equal(pick([null, P('0.4.9'), P('0.5.0')], me), null, 'older or the same: this one runs')
  assert.equal(pick([P('0.6.0', 3)], me), null, 'a newer protocol never: older clients could not use its node')
  assert.equal(pick([P('0.6.0', 1)], me), null)
  assert.deepEqual(pick([P('0.5.1'), P('0.5.3'), P('0.5.2')], me), P('0.5.3'))
  assert.deepEqual(pick([P('0.5.1-rc.1')], me), P('0.5.1-rc.1'))
})

/** A fake install: a script that answers `version --json` with `out`, and logs how it was run. @param {string} dir @param {string} name @param {string} out @param {string} [node] what `node` does */
function fake(dir, name, out, node = 'exit 0') {
  const f = path.join(dir, name)
  fs.writeFileSync(f, `#!/bin/sh\necho "$@" >> "${f}.log"\nif [ "$1" = version ]; then printf '%s' '${out}'; exit 0; fi\n${node}\n`, { mode: 0o755 })
  return [f]
}

test('programs are noted by file, and ones that have gone are dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natter-programs-'))
  try {
    const a = fake(dir, 'a', ''), b = fake(dir, 'b', '')
    noteProgram(dir, a)
    noteProgram(dir, b)
    noteProgram(dir, ['/another/node', '--no-warnings', a[0]])     // same program, run by another node binary
    assert.deepEqual(listPrograms(dir), [['/another/node', '--no-warnings', a[0]], b])
    assert.equal(fs.statSync(path.join(dir, 'programs.json')).mode & 0o777, 0o600)
    fs.rmSync(b[0])
    noteProgram(dir, a)
    assert.deepEqual(listPrograms(dir), [a])
    noteProgram(path.join(dir, 'missing'), a)                        // no home yet: nothing, and no throw
    fs.writeFileSync(path.join(dir, 'programs.json'), '{not json')
    assert.deepEqual(listPrograms(dir), [])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test("each program is asked its version when a node starts: an install downgraded in place isn't chosen", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natter-programs-'))
  try {
    const self = fake(dir, 'self', '')
    const newer = fake(dir, 'newer', '{"version":"0.5.2","proto":2}')
    const old = fake(dir, 'old', '0.4.1\n')                           // from before --json: a bare version
    const broken = fake(dir, 'broken', 'oops')
    assert.deepEqual(await askProgram(newer), { cmd: newer, version: '0.5.2', proto: 2 })
    assert.equal(await askProgram(old), null)
    assert.equal(await askProgram(broken), null)
    assert.equal(await askProgram(['/no/such/natter']), null)
    // one that says which file it runs (from 0.4.3): doctor tells a launcher of this install from another install
    const wrapper = fake(dir, 'wrapper', '{"version":"0.4.3","proto":1,"file":"/x/bin/natter.js"}')
    assert.deepEqual(await askProgram(wrapper), { cmd: wrapper, version: '0.4.3', proto: 1, file: '/x/bin/natter.js' })
    for (const c of [self, newer, old, broken]) noteProgram(dir, c)

    assert.deepEqual((await chooseProgram(dir, self, me))?.cmd, newer)
    assert.ok(!fs.existsSync(`${self[0]}.log`), 'this program is not asked')
    fake(dir, 'newer', '{"version":"0.4.0","proto":2}')               // downgraded since it was noted
    assert.equal(await chooseProgram(dir, self, me), null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the chosen node is run with --chosen; one that dies before any node answers is reported', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natter-programs-'))
  try {
    const dies = fake(dir, 'dies', '', 'exit 3')
    const r = await runChosen({ cmd: dies, version: '0.5.2', proto: 2 }, { onDemand: false, up: async () => false, log: () => {} })
    assert.deepEqual(r, { code: 3, up: false, stopped: false })
    assert.equal(fs.readFileSync(`${dies[0]}.log`, 'utf8').trim(), 'node --chosen')

    const runs = fake(dir, 'runs', '', 'sleep 1')
    let calls = 0
    const t0 = Date.now()
    const r2 = await runChosen({ cmd: runs, version: '0.5.2', proto: 2 }, { onDemand: true, up: async () => ++calls > 2, log: () => {} })
    assert.deepEqual(r2, { code: 0, up: true, stopped: false }, 'on demand: done once a node answers, leaving it running')
    assert.ok(Date.now() - t0 < 5000)
    assert.equal(fs.readFileSync(`${runs[0]}.log`, 'utf8').trim(), 'node --chosen --on-demand')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('under the service, a stop while the chosen node starts is passed on, and this one stops too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natter-programs-'))
  const before = process.listenerCount('SIGTERM')
  try {
    const slow = fake(dir, 'slow', '', 'exec sleep 30')
    const run = runChosen({ cmd: slow, version: '0.5.2', proto: 2 }, { onDemand: false, up: async () => false, log: () => {} })
    assert.equal(process.listenerCount('SIGTERM'), before + 1)
    await new Promise(r => setTimeout(r, 300))
    process.emit('SIGTERM')
    const r = await run
    assert.equal(r.stopped, true, "told to stop: the caller mustn't run its own node")
    assert.equal(r.up, false)
    assert.equal(process.listenerCount('SIGTERM'), before, 'its handlers are gone, so a later stop stops this process')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test("setup reports systemctl's error, not the link it made first", async () => {
  const { systemctlError } = await import('../../src/setup.js')
  assert.equal(systemctlError('Created symlink /a → /b.\nJob for nattermatic.service failed because the control process exited.\n'), 'Job for nattermatic.service failed because the control process exited.')
  assert.equal(systemctlError('Failed to connect to bus: No medium found\n'), 'Failed to connect to bus: No medium found')
  assert.equal(systemctlError('Created symlink /a → /b.\n'), '')
})
