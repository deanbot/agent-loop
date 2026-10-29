#!/usr/bin/env node
/**
 * Print the rules change this clone has pulled and its session has not read, then clear the
 * record, so pick-next.mjs picks again. Run in the clone's root (any folder of the clone works).
 *
 * Usage:
 *   node scripts/rules-ack.mjs
 *
 * For each pending range (pull.mjs records one per pull that changed a rules file), oldest first:
 *   RULES_DIFF: git diff <before>..<after> -- <file> <file> …
 *   <that diff>
 * At most 200 lines in all. Past that the output is cut, and ends with
 *   RULES_CUT: <n> more lines; run each command below for the rest
 *     git diff <before>..<after> -- <file> …      (the cut range, and every one after it)
 * Nothing pending → nothing printed. A record that can't be read prints
 *   RULES_UNREADABLE: the pending rules record could not be read; read AGENTS.md and the files its rules key lists, in full
 * and is cleared. A failed diff, or a record that can't be cleared, prints `rules-ack: <message>`
 * on stderr and exits 2 with nothing on stdout and the record kept: pick-next.mjs goes on refusing.
 */

import { execFileSync } from 'child_process'
import { recordFile, readPending, clearPending, diffCommand } from './lib/rules.mjs'

const CAP = 200

if (process.argv.length > 2) {
  process.stderr.write('Usage: rules-ack.mjs\n')
  process.exit(1)
}

const fail = (e) => {
  const detail = String(e?.stderr ?? '').trim() || e?.message || String(e)
  const all = detail.split('\n')
  process.stderr.write(`rules-ack: ${all.find((l) => /^(fatal|error):/.test(l)) ?? all[0]}\n`)
  process.exit(2)
}

const file = recordFile()
const pending = readPending(file)
if (pending !== null && pending.length === 0) process.exit(0)

const lines = []
if (pending === null) {
  lines.push('RULES_UNREADABLE: the pending rules record could not be read; read AGENTS.md and the files its rules key lists, in full')
} else {
  const blocks = []
  try {
    for (const r of pending) {
      const diff = execFileSync('git', ['diff', `${r.from}..${r.to}`, '--', ...r.files], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      })
      blocks.push({ r, lines: [`RULES_DIFF: ${diffCommand(r)}`, ...diff.split('\n').filter((l, i, all) => l !== '' || i < all.length - 1)] })
    }
  } catch (e) {
    fail(e)
  }
  const total = blocks.reduce((n, b) => n + b.lines.length, 0)
  let cutAt = -1
  for (const [i, b] of blocks.entries()) {
    const room = CAP - lines.length
    if (b.lines.length <= room) {
      lines.push(...b.lines)
      continue
    }
    lines.push(...b.lines.slice(0, room))
    cutAt = i
    break
  }
  if (cutAt !== -1) {
    lines.push(`RULES_CUT: ${total - lines.length} more lines; run each command below for the rest`)
    for (const b of blocks.slice(cutAt)) lines.push(`  ${diffCommand(b.r)}`)
  }
}

try {
  clearPending(file)
} catch (e) {
  fail(e)
}
process.stdout.write(lines.join('\n') + '\n')
