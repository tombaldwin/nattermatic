// Errors the node tells apart by kind, not by matching their text.

/** An error for the local or machine-to-machine API, answered with this HTTP status. @param {number} status @param {string} message */
export function httpErr(status, message) { return Object.assign(new Error(message), { status }) }

/** A code in an error answer: a short fixed word, never a sentence. */
const CODE = /^[a-z][a-z-]{0,31}$/
/**
 * Another machine answered a request with an error status. Only the status is kept, and a code if it
 * gave one (a fixed word, see CODE: what the status means, for this node to put in its own words):
 * what another machine writes would reach sessions and terminals as our own words.
 */
export class PeerAnswered extends Error {
  /** @param {string} host @param {number} status @param {unknown} [code] */
  constructor(host, status, code) {
    super(`${host} answered HTTP ${status}`)
    this.host = host
    this.peerStatus = status
    /** @type {string | null} */
    this.peerCode = typeof code === 'string' && CODE.test(code) ? code : null
  }
}

/** A request to another machine ran out of time: no answer, or not all of it, within its limit. */
export class TimeoutError extends Error {
  /** @param {string} [message] @param {ErrorOptions} [options] */
  constructor(message = 'timed out', options) { super(message, options) }
}
