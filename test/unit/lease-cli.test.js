// `natter lease check` as a script sees it: exit 0 when the resource is free, 1 when it's held, and
// 2 for anything that went wrong, so a loop waiting on a resource can tell "held" from "error".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runLease } from '../../src/lease-cli.js'

/**
 * runLease against a fake node that answers `answer`, or throws it (an Error: from the request, or
 * from getting a client at all), capturing what it prints.
 * @param {string[]} args @param {unknown} answer @param {{ noClient?: boolean }} [o]
 */
async function lease(args, answer, { noClient = false } = {}) {
  /** @type {string[]} */
  const out = [], err = []
  const log = console.log, error = console.error
  console.log = (...a) => out.push(a.join(' ')); console.error = (...a) => err.push(a.join(' '))
  try {
    const req = async () => { if (answer instanceof Error) throw answer; return answer }
    const client = async () => { if (noClient) throw /** @type {Error} */ (answer); return /** @type {any} */ ({ req }) }
    return { code: await runLease(args, {}, client), out: out.join('\n'), err: err.join('\n') }
  } finally { console.log = log; console.error = error }
}

test('lease check: 0 when free, 1 when held, 2 on an error or a bad command line', async () => {
  const held = { resource: 'db@a.test', holder: 'web@a.test', kind: 'session', note: 'migrating', left_s: 60, cap_s: 600, held_s: 5, ttl_s: 60 }
  let r = await lease(['check', 'db'], { resource: 'db@a.test', lease: null })
  assert.equal(r.code, 0); assert.match(r.out, /^db@a\.test is free$/)
  r = await lease(['check', 'db'], { resource: 'db@a.test', lease: held })
  assert.equal(r.code, 1); assert.match(r.out, /^db@a\.test: held by web@a\.test for 5s, 60s left unless renewed; the holder's note: "migrating"$/)
  // errors: the node can't be reached or started, or it refuses the request
  r = await lease(['check', 'db'], new Error('could not start the nattermatic node'), { noClient: true })
  assert.equal(r.code, 2); assert.match(r.err, /^natter: could not start the nattermatic node$/); assert.equal(r.out, '')
  r = await lease(['check', 'db@nowhere.test'], new Error('nowhere.test is not a machine on this network'))
  assert.equal(r.code, 2); assert.match(r.err, /nowhere\.test is not a machine/); assert.equal(r.out, '')
  // a bad command line is an error too, never "held"
  r = await lease(['check'], null)
  assert.equal(r.code, 2); assert.match(r.err, /usage: natter lease check <resource>/)
  r = await lease(['check', 'db', 'extra'], null)
  assert.equal(r.code, 2)
})
