// Errors the node tells apart by kind, not by matching their text.

/** An error for the local or machine-to-machine API, answered with this HTTP status. @param {number} status @param {string} message */
export function httpErr(status, message) { return Object.assign(new Error(message), { status }) }

/**
 * Another machine answered a request with an error status. Only the status is kept: what another
 * machine writes would reach sessions and terminals as our own words.
 */
export class PeerAnswered extends Error {
  /** @param {string} host @param {number} status */
  constructor(host, status) {
    super(`${host} answered HTTP ${status}`)
    this.host = host
    this.peerStatus = status
  }
}

/** A request to another machine ran out of time: no answer, or not all of it, within its limit. */
export class TimeoutError extends Error {
  /** @param {string} [message] @param {ErrorOptions} [options] */
  constructor(message = 'timed out', options) { super(message, options) }
}
