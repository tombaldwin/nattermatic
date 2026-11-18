#!/usr/bin/env node
// Line coverage of src/ and bin/ from the raw V8 coverage that Node writes for every process when
// NODE_V8_COVERAGE is set (the unit tests, and the nodes, sessions and commands the end-to-end tests
// start). `npm run coverage` runs both suites that way and prints a table; in GitHub Actions the table
// also goes in the job summary. No dependencies: c8 does the same, with more detail.
//
// A line counts if it has code (not just a comment or punctuation) and some of that code ran in any
// process. A process stopped with SIGKILL writes nothing, so what only it ran isn't counted.
//
// usage: node scripts/coverage.mjs <dir of V8 coverage JSON>
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = process.argv[2]
if (!dir || !fs.existsSync(dir)) { console.error('usage: node scripts/coverage.mjs <NODE_V8_COVERAGE dir>'); process.exit(2) }
const ours = (/** @type {string} */ f) => (f.startsWith(path.join(ROOT, 'src') + path.sep) || f.startsWith(path.join(ROOT, 'bin') + path.sep)) && f.endsWith('.js')

/** @type {Map<string, { src: string, ran: Uint8Array }>} file -> which characters ran in any process */
const files = new Map()
for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
  let dump
  try { dump = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) } catch { continue }   // one cut short as its process died
  for (const script of dump.result ?? []) {
    if (!String(script.url).startsWith('file://')) continue
    const file = fileURLToPath(script.url)
    if (!ours(file)) continue
    let f = files.get(file)
    if (!f) { const src = fs.readFileSync(file, 'utf8'); f = { src, ran: new Uint8Array(src.length) }; files.set(file, f) }
    // the innermost range at each character decides: outer ranges first, inner ones over them
    const ranges = script.functions.flatMap((/** @type {any} */ fn) => fn.ranges)
      .sort((/** @type {any} */ a, /** @type {any} */ b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset)
    const count = new Uint32Array(f.src.length)
    for (const r of ranges) count.fill(r.count, r.startOffset, Math.min(r.endOffset, f.src.length))
    for (let i = 0; i < count.length; i++) if (count[i]) f.ran[i] = 1
  }
}
// files no process loaded count too, as not run at all
for (const sub of ['src', 'bin']) for (const n of fs.readdirSync(path.join(ROOT, sub))) {
  const file = path.join(ROOT, sub, n)
  if (ours(file) && !files.has(file)) { const src = fs.readFileSync(file, 'utf8'); files.set(file, { src, ran: new Uint8Array(src.length) }) }
}

/** @param {{ src: string, ran: Uint8Array }} f */
function lines(f) {
  let code = 0, hit = 0, at = 0, inComment = false
  for (const line of f.src.split('\n')) {
    const t = line.trim()
    const start = at
    at += line.length + 1
    if (inComment) { if (t.includes('*/')) inComment = false; continue }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inComment = true; continue }
    if (!/[\w$'"`]/.test(t) || t.startsWith('//') || t.startsWith('#!')) continue
    code++
    for (let i = start; i < start + line.length; i++) if (f.ran[i] && /\S/.test(f.src[i])) { hit++; break }
  }
  return { code, hit }
}

const rows = [...files].map(([file, f]) => ({ file: path.relative(ROOT, file), ...lines(f) })).sort((a, b) => a.file.localeCompare(b.file))
const total = rows.reduce((t, r) => ({ code: t.code + r.code, hit: t.hit + r.hit }), { code: 0, hit: 0 })
const pct = (/** @type {{ code: number, hit: number }} */ r) => r.code ? (100 * r.hit / r.code).toFixed(1) : '100.0'
const table = ['| File | Lines | Covered |', '| --- | ---: | ---: |', ...rows.map(r => `| ${r.file} | ${r.code} | ${pct(r)}% |`), `| **Total** | **${total.code}** | **${pct(total)}%** |`].join('\n')
console.log(table)
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Line coverage (unit and end-to-end tests)\n\n${table}\n`)
