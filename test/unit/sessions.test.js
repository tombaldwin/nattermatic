// The session hub on its own: what a session is offered, when its wait wakes it, and that a message it
// has been told about doesn't wake it again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createSessions } from '../../src/sessions.js'

/** A stand-in for an HTTP response: records the events written to it. */
function fakeRes() {
  const r = Object.assign(new EventEmitter(), {
    /** @type {{ event: string, data: any }[]} */ events: [], ended: false, writableLength: 0,
    writeHead() {},
    /** @param {string} chunk */
    write(chunk) { const m = /^event: (\w+)\ndata: (.*)\n/.exec(chunk); if (m) r.events.push({ event: m[1], data: JSON.parse(m[2]) }) },
    end() { r.ended = true; r.emit('close') },
  })
  return r
}

function setup() {
  /** @type {Map<string, any>} */
  const rows = new Map()
  const delivered = new Set()
  const q = /** @type {any} */ ({
    inboxQueued: { all: (/** @type {string} */ name) => [...rows.values()].filter(r => r.to === name && !delivered.has(r.id)).map(r => ({ id: r.id })) },
    delivered: { run: (/** @type {number} */ _t, /** @type {string} */ id) => delivered.add(id) },
    pushed: { run: (/** @type {number} */ _t, /** @type {string} */ id) => delivered.add(id) },
  })
  const hub = createSessions({ q, msgRow: id => rows.get(id), tx: fn => fn(), now: Date.now, safe: fn => fn(), host: () => 'desk.local' })
  const add = (/** @type {string} */ id, to = 'api') => rows.set(id, { id, to, from_addr: 'x@laptop.local', to_addr: `${to}@desk.local`, body: id, sent_at: 1 })
  return { hub, add, delivered }
}

test('a polling session is offered its messages, and its wait wakes once for each new one', () => {
  const { hub, add } = setup()
  const stream = fakeRes()
  const { name } = hub.connect(/** @type {any} */ (stream), { want: 'api', token: 't', live: false, owner: 42, cwd: '/w' }, () => {})
  assert.equal(name, 'api')
  assert.equal(hub.status('api'), "waiting in api's inbox (the session is connected but reads with the inbox tool)")
  add('m1'); hub.pump('api')
  assert.deepEqual(stream.events.map(e => e.event), ['hello', 'message'])

  const w = fakeRes()
  assert.ok(hub.wait(/** @type {any} */ (w), [7, 42], null))
  assert.equal(w.events[0]?.event, 'wake', 'woken for m1 at once')
  assert.ok(w.ended)

  // told about m1 already: a new wait isn't woken for it again
  const w2 = fakeRes()
  hub.wait(/** @type {any} */ (w2), [42], null)
  assert.equal(w2.events.length, 0)
  assert.ok(hub.awake('api'))
  add('m2'); hub.pump('api')
  assert.deepEqual(w2.events.map(e => e.event), ['wake'])
  assert.equal(w2.events[0].data.count, 1)
  hub.closeAll()
})

test('acknowledged messages are done with; nacked ones are offered again', () => {
  const { hub, add, delivered } = setup()
  const stream = fakeRes()
  hub.connect(/** @type {any} */ (stream), { want: 'api', token: 't', live: true, owner: 1, cwd: '' }, () => {})
  add('m1'); add('m2'); hub.pump('api')
  hub.ack('api', ['m1'], 'pushed')
  assert.ok(delivered.has('m1'))
  assert.equal(stream.events.filter(e => e.event === 'message').length, 2, 'nothing offered twice')
  assert.equal(hub.map.get('api')?.sent.has('m2'), true)
  hub.nack('api', ['m2'])
  assert.equal(hub.map.get('api')?.sent.has('m2'), false)
  hub.closeAll()
})

test('a name in use: the same session reconnecting keeps it, anyone else gets another', () => {
  const { hub } = setup()
  const a = fakeRes()
  let closed = 0
  hub.connect(/** @type {any} */ (a), { want: 'api', token: 't', live: true, owner: 1, cwd: '' }, () => closed++)
  assert.equal(hub.connect(/** @type {any} */ (fakeRes()), { want: 'api', token: 'other', live: true, owner: 2, cwd: '' }, () => {}).name, 'api-2')
  // leases@ is the node's own: a session asking for the name gets another, as if it were in use
  assert.equal(hub.connect(/** @type {any} */ (fakeRes()), { want: 'leases', token: 'l', live: true, owner: 3, cwd: '' }, () => {}).name, 'leases-2')
  const again = hub.connect(/** @type {any} */ (fakeRes()), { want: 'api', token: 't', live: true, owner: 1, cwd: '' }, () => {})
  assert.deepEqual(again, { name: 'api', reconnected: true })
  assert.ok(a.ended, 'its stale stream is closed')
  assert.equal(closed, 1)
  assert.equal(hub.map.size, 3)
  assert.equal(hub.wait(/** @type {any} */ (fakeRes()), [99], null), false, 'no session for these processes')
  hub.closeAll()
})
