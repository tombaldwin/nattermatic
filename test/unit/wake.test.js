// The wait behind both wake hooks (Claude Code's and Codex's), driven by a scripted node: when it wakes
// the session, when it carries on, and every way it stops.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { waitForWakes } from '../../src/wake.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-wake-'))
let n = 0
/**
 * @param {Array<import('../../src/wake.js').WakeEvent | null | 'unreachable'>} script what the node answers, in turn
 * @param {Partial<Parameters<typeof waitForWakes>[0]>} [o]
 */
async function run(script, o = {}) {
  const mark = path.join(dir, `mark-${n++}`)
  /** @type {import('../../src/wake.js').WakeEvent[]} */
  const woken = []
  let i = 0
  const code = await waitForWakes({
    mark, retryMs: 5, giveUpMs: 500,
    wait: async () => { const r = script[Math.min(i++, script.length - 1)]; if (r === 'unreachable') throw new Error('no node'); return r },
    alive: () => true,
    onWake: r => { woken.push(r); return 2 },
    ...o,
  })
  return { code, woken, asked: i, markLeft: fs.existsSync(mark) }
}

test('a wake ends the wait with its exit code, and takes its mark with it', async () => {
  const r = await run([null, 'unreachable', { event: 'wake', name: 'api', count: 3 }])
  assert.equal(r.code, 2)
  assert.deepEqual(r.woken, [{ event: 'wake', name: 'api', count: 3 }])
  assert.equal(r.markLeft, false)
})

test('a waiter that carries on after a wake (Codex) is woken once per wake', async () => {
  /** @type {number[]} */
  const counts = []
  const r = await run([{ event: 'wake', count: 1 }, { event: 'wake', count: 2 }, { event: 'done' }], { onWake: w => { counts.push(w.count || 0); return undefined } })
  assert.deepEqual(counts, [1, 2])
  assert.equal(r.code, 0)
})

test('it stops when its agent has gone, when a newer waiter takes over, and when the session has gone', async () => {
  assert.equal((await run([null], { alive: () => false })).asked, 1, 'its agent has gone')
  assert.equal((await run([{ event: 'done' }])).code, 0, 'told to stop by the node')
  // the session was there, closed, and stayed away past lostMs
  const lost = await run([{ event: 'closed' }, null], { lostMs: 30 })
  assert.equal(lost.code, 0); assert.ok(lost.asked < 50, `stopped after ${lost.asked} asks`)
  // with no lostMs (Claude Code), it waits for the session to come back, until it gives up
  const t = Date.now()
  await run([{ event: 'closed' }, null])
  assert.ok(Date.now() - t >= 450, 'waited until the give-up time')
})

test('a session not seen yet isn\'t given up for lost, and a newer waiter\'s mark sends this one away', async () => {
  // never seen: lostMs doesn't apply (an adapter may not have started yet); only the give-up time does
  const t = Date.now()
  await run([null], { lostMs: 10 })
  assert.ok(Date.now() - t >= 450)
  // another waiter writes the mark: this one stops at once, leaving the mark to it
  const mark = path.join(dir, 'taken')
  let asked = 0
  const code = await waitForWakes({ mark, retryMs: 5, giveUpMs: 500, alive: () => true, onWake: () => 2, wait: async () => { if (++asked === 2) fs.writeFileSync(mark, 'someone else'); return null } })
  assert.equal(code, 0)
  assert.equal(fs.readFileSync(mark, 'utf8'), 'someone else')
})
