// End-to-end tests: each group in test/e2e/ runs in a process of its own, with its own folder and
// ports, side by side, so one group's failure doesn't hide another's.
//   node test/e2e.js                  every group
//   node test/e2e.js leases setup     only these
//   node test/e2e.js --serial         one at a time (a slow or busy machine)
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e')
// port bases 40 apart: a group uses its base and the 22 ports after it (messaging also 17787-17792)
const GROUPS = { messaging: 17771, setup: 17811, legacy: 17851, leases: 17891 }

const args = process.argv.slice(2)
const serial = args.includes('--serial')
const asked = args.filter(a => a !== '--serial')
const unknown = asked.filter(g => !(g in GROUPS))
if (unknown.length) { console.error(`no such group: ${unknown.join(', ')} (groups: ${Object.keys(GROUPS).join(', ')})`); process.exit(2) }
const names = asked.length ? asked : Object.keys(GROUPS)

/** Run one group; its output is shown in one piece when it ends. @param {string} name */
function runGroup(name) {
  const t = Date.now()
  return new Promise(resolve => {
    const p = spawn(process.execPath, ['--no-warnings', path.join(DIR, `${name}.js`)], { env: { ...process.env, E2E_PORT_BASE: String(GROUPS[name]) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', c => { out += c })
    p.stderr.on('data', c => { out += c })
    p.on('close', code => {
      const steps = (out.match(/ \.\.\. ok$/gm) || []).length
      console.log(`\n=== ${name}: ${code === 0 ? 'passed' : 'FAILED'} (${steps} steps, ${Math.round((Date.now() - t) / 1000)} s) ===\n${out.trimEnd()}`)
      resolve({ name, ok: code === 0, steps })
    })
  })
}

const results = []
if (serial) for (const n of names) results.push(await runGroup(n))
else results.push(...await Promise.all(names.map(runGroup)))
const failed = results.filter(r => !r.ok)
const steps = results.reduce((s, r) => s + r.steps, 0)
console.log(failed.length ? `\nFAILED: ${failed.map(r => r.name).join(', ')} (${steps} steps passed)` : `\nall ${steps} steps passed in ${results.length} groups`)
process.exitCode = failed.length ? 1 : 0
