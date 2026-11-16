// `natter doctor`: checks this machine's setup end to end and says what to do about anything wrong.
// It never starts a node or changes anything: it reports the machine as it is.
//
// gather() collects the facts (files, the running node, Claude Code, Codex); diagnose() judges
// them. diagnose() is pure, so every verdict can be tested without a machine to break.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { homeDir, loadConfig, VERSION, cmpVersion, errMsg } from './config.js'
import { Local, nodeAction } from './local.js'
import { claudeAccounts, claudeBin, isRegistered, wakeSupport, which, selfCmd, WAKE_MIN_CLAUDE } from './claude.js'
import { canQueue, codexConfigFile, codexPresent, withoutBlock } from './codex.js'
import { oldHome } from './legacy.js'
import { listPrograms, askProgram } from './programs.js'

/**
 * @typedef {{
 *   setupError?: string, disabled?: boolean, host?: string, port?: number,
 *   health?: import('./types.js').Health | { foreign: true } | null,
 *   status?: any, peers?: any, nodeError?: string,
 *   claude?: { found: boolean, version: string, accounts: { alias: string, registered: boolean }[] },
 *   codex?: { present: boolean, onPath?: boolean, configured: boolean, wakes: boolean },
 *   onPath: boolean, oldHome: boolean, oldCli: string, platform: string,
 *   self?: string, pathFile?: string, installs?: { file: string, version: string }[],
 * }} Facts
 * @typedef {{ level: 'ok' | 'warn' | 'fail', text: string, fix?: string }} Finding
 */

/** @returns {Promise<Facts>} */
export async function gather() {
  // (~/.agentlink as a link to ~/.nattermatic is setup's own, for anything still using the old path)
  const old = fs.lstatSync(oldHome(), { throwIfNoEntry: false })
  /** @type {Facts} */
  const f = { onPath: !!which('natter'), oldHome: !!old && !old.isSymbolicLink(), oldCli: oldCliPath(), platform: process.platform }
  f.disabled = fs.existsSync(path.join(homeDir(), 'disabled'))
  // other installs of nattermatic here, each asked its version (#4)
  const real = (/** @type {string | null} */ p) => { try { return p ? fs.realpathSync(p) : '' } catch { return '' } }
  f.self = real(selfCmd().at(-1) ?? '')
  f.pathFile = real(which('natter'))
  const others = listPrograms(homeDir()).filter(c => real(c.at(-1) ?? '') && real(c.at(-1) ?? '') !== f.self)
  // the natter on PATH too: an install older than this check never notes itself
  if (f.pathFile && f.pathFile !== f.self && !others.some(c => real(c.at(-1) ?? '') === f.pathFile)) others.push([f.pathFile])
  f.installs = await Promise.all(others.map(async c => ({ file: real(c.at(-1) ?? ''), version: await versionOf(c) })))
  let cfg
  try { cfg = loadConfig() } catch (e) { f.setupError = errMsg(e) }
  if (cfg) {
    f.host = cfg.host; f.port = cfg.port
    const local = new Local(cfg)
    f.health = await local.health()
    if (f.health && !('foreign' in f.health)) {
      try {
        ;[f.status, f.peers] = await Promise.all([local.req('GET', '/local/status'), local.req('GET', '/local/peers', undefined, '', 20_000)])
      } catch (e) { f.nodeError = errMsg(e) }
    }
  }
  if (claudeBin()) {
    const support = wakeSupport()          // once: it runs `claude --version`
    f.claude = { found: true, version: support.version, accounts: claudeAccounts().map(a => ({ alias: a.alias, registered: isRegistered(a.dir, support) })) }
  } else f.claude = { found: false, version: '', accounts: [] }
  if (codexPresent()) {
    let text = ''
    try { text = fs.readFileSync(codexConfigFile(), 'utf8') } catch {}
    const codex = which('codex')
    f.codex = { present: true, onPath: !!codex, configured: withoutBlock(text) !== text, wakes: canQueue(codex) }
  } else f.codex = { present: false, onPath: false, configured: false, wakes: false }
  return f
}

/** A program's version: asked as a node start asks it, or from `version` for one older than that. @param {string[]} cmd */
async function versionOf(cmd) {
  const p = await askProgram(cmd)
  if (p) return p.version
  try { return execFileSync(cmd[0], [...cmd.slice(1), 'version'], { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().match(/^\d+\.\d+\.\d+\S*$/)?.[0] ?? '' } catch { return '' }
}

/**
 * An `agentlink` command on PATH from the old package (an npm or Homebrew install of
 * @tombaldwin/agentlink, whose command was agentlink.js), or ''. This install's own `agentlink` (a
 * link or a wrapper in ~/.nattermatic/bin, or a development checkout's bin/natter.js) isn't one.
 */
function oldCliPath() {
  const p = which('agentlink')
  if (!p) return ''
  try { return /@tombaldwin[\\/]agentlink[\\/]|[\\/]agentlink\.js$/.test(fs.realpathSync(p)) ? p : '' } catch { return '' }
}

/** @param {Facts} f @returns {Finding[]} */
export function diagnose(f) {
  /** @type {Finding[]} */
  const out = []
  const ok = (/** @type {string} */ text) => out.push({ level: 'ok', text })
  const warn = (/** @type {string} */ text, /** @type {string} */ fix) => out.push({ level: 'warn', text, fix })
  const fail = (/** @type {string} */ text, /** @type {string} */ fix) => out.push({ level: 'fail', text, fix })

  if (f.disabled) fail('nattermatic is uninstalled on this machine', 'run `natter setup` to turn it back on')
  if (f.setupError) {
    fail(`not set up: ${f.setupError}`, 'run the installer: curl -fsSL https://nattermatic.com/install.sh | sh')
    return out
  }
  if (!f.onPath) warn('the natter command isn\'t on this shell\'s PATH', 'open a new terminal window (setup adds it to your shell\'s startup file)')

  // the node
  const h = f.health
  if (!h) fail(`no node is running on port ${f.port}`, 'run `natter setup` to start its background service (or any natter command, which starts one)')
  else if ('foreign' in h) fail(`port ${f.port} is used by something that isn't this machine's nattermatic node`, `stop whatever is on port ${f.port}, or give nattermatic another port in ~/.nattermatic/config.json`)
  else {
    const action = nodeAction(h)
    if (action === 'stale') warn(`this natter (${VERSION}) is older than the running node (${h.version})`, 'an older copy is first on PATH: run `which -a natter` and remove the old one')
    else if (action === 'replace') warn(`the running node is ${h.version}, older than this natter (${VERSION})`, 'run `natter setup` to restart it on this version')
    else ok(`node ${h.version} is running as ${f.host}:${f.port}`)
  }
  if (f.nodeError) fail(`the node didn't answer: ${f.nodeError}`, 'see ~/.nattermatic/node.log, then run `natter setup`')

  // the network
  const st = f.status
  if (st) {
    if (st.removed) fail('this machine has been removed from its network', 'to rejoin, run an invite line from a member (`natter invite` there)')
    else if (!st.member) fail('this machine isn\'t a member of its network yet', 'run the invite line a member printed, or `natter setup --new-network` to start one')
    const remote = new Map((f.peers?.remote || []).map((/** @type {any} */ r) => [r.host, r]))
    const members = (st.members || []).filter((/** @type {any} */ m) => !m.self)
    const newest = (st.members || []).map((/** @type {any} */ m) => m.version).filter(Boolean)
      .reduce((/** @type {string} */ a, /** @type {string} */ v) => cmpVersion(v, a) > 0 ? v : a, String(st.version || VERSION))
    if (st.member && !members.length) ok('this machine is the only one on its network (`natter invite` adds another)')
    for (const m of members) {
      const r = remote.get(m.host)
      const ver = m.version ? (cmpVersion(m.version, newest) < 0 ? `, on ${m.version}, behind ${newest}` : `, on ${m.version}`) : ', version not known'
      if (r?.online) {
        if (m.version && cmpVersion(m.version, newest) < 0) warn(`${m.host} is reachable${ver}`, `upgrade it on that machine: curl -fsSL https://nattermatic.com/install.sh | sh`)
        else ok(`${m.host} is reachable${ver}`)
      } else {
        const why = r?.error ? `: ${r.error}` : ''
        const lan = f.platform === 'darwin' && /EHOSTUNREACH|ENETUNREACH/.test(r?.error || '')
        warn(`${m.host} can't be reached${why}`, lan
          ? 'if it\'s on, macOS may be blocking nattermatic from the local network: System Settings → Privacy & Security → Local Network, turn on nattermatic'
          : 'if it should be on, check it\'s awake and on the same network (or Tailscale), with port 7777 open; messages for it are kept until it\'s back')
      }
    }
    const pending = Array.isArray(st.pending) ? st.pending : []
    if (pending.length) warn(`${pending.length >= 20 ? '20 or more' : pending.length} message(s) waiting to be delivered${pending[0]?.last_error ? ` (last error: ${pending[0].last_error})` : ''}`, 'they\'re retried until the machine is back, for up to 7 days')
  }

  // Claude Code
  const c = f.claude
  if (c && !c.found) {
    if (!f.codex?.present) warn('neither Claude Code nor Codex was found', 'install one of them, then run `natter setup`')
  } else if (c) {
    if (c.version && cmpVersion(c.version, WAKE_MIN_CLAUDE) < 0) warn(`Claude Code ${c.version} is too old to be woken by messages (needs ${WAKE_MIN_CLAUDE})`, 'update Claude Code, then run `natter setup`')
    for (const a of c.accounts) {
      if (a.registered) ok(`Claude Code account "${a.alias}" is set up`)
      else warn(`Claude Code account "${a.alias}" isn't set up for nattermatic, or is set up for an older version`, 'run `natter setup`, then /reload-plugins in its open sessions')
    }
  }

  // Codex
  const x = f.codex
  if (x?.present) {
    if (!x.configured) warn('Codex is installed but nattermatic isn\'t added to it', 'run `natter setup`')
    else if (x.onPath === false) warn('Codex\'s settings are here, but the codex command isn\'t on this shell\'s PATH, so it couldn\'t be checked', 'run `natter doctor` from a shell where `codex` works')
    else if (!x.wakes) warn('Codex is set up, but this Codex can\'t be woken by messages (it needs `codex queue`)', 'update Codex, then run `natter setup`')
    else ok('Codex is set up and can be woken')
  }

  // more than one install (#4)
  if (f.installs?.length) {
    const list = [{ file: f.self ?? '', version: VERSION }, ...f.installs]
      .map(i => `${i.file} (${i.version || 'version not known'})${i.file === f.pathFile ? ', the natter on PATH' : ''}`)
    warn(`nattermatic is installed more than once here: ${list.join('; ')}`, 'keep one and remove the others (an npm install with `npm uninstall -g nattermatic`): an install from before 0.4.2 can still start its own, older node')
  }

  // leftovers from before the rename
  if (f.oldHome) warn('~/.agentlink, from before the rename, is still here', 'run `natter setup`, which moves what\'s in it')
  if (f.oldCli) warn(`an old agentlink command is on PATH (${f.oldCli})`, 'remove it: `npm uninstall -g @tombaldwin/agentlink`, or delete that file')
  return out
}

/** @param {Finding[]} findings */
export function formatFindings(findings) {
  const mark = { ok: '✓', warn: '!', fail: '✗' }
  const lines = findings.map(x => `${mark[x.level]} ${x.text}${x.fix ? `\n    → ${x.fix}` : ''}`)
  const bad = findings.filter(x => x.level !== 'ok').length
  lines.push('', bad ? `${bad} thing(s) to look at.` : 'Everything looks right.')
  return lines.join('\n')
}

/** @returns {Promise<number>} 0 if nothing failed, 1 if something did (warnings alone are 0) */
export async function runDoctor() {
  const findings = diagnose(await gather())
  console.log(formatFindings(findings))
  return findings.some(x => x.level === 'fail') ? 1 : 0
}
