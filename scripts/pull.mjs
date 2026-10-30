#!/usr/bin/env node
/**
 * Pull the clone's branch and say which of the project's rules the pull changed, so a running
 * loop reads what was merged while it ran. Run in the clone's root, on its default branch.
 *
 * Usage:
 *   node scripts/pull.mjs [--start <command> [--milestone <title>]]
 *
 * Runs `git pull --ff-only`. When it changed `AGENTS.md`, or a file the `## Agent loop` block lists
 * as rules (`rules: <path>[, <path>…]`, read after the pull; a path ending in "/" covers the
 * directory), prints:
 *   RULES_CHANGED: <file> <file> …
 *     git diff <before>..<after> -- <file> <file> …
 * The second line is the command that shows what changed: read it, never the whole files (a path
 * with a space or a shell character is single-quoted there). No such file changed (or nothing was
 * pulled) → nothing. The change is also recorded as pending for this clone (lib/rules.mjs), added
 * to any still pending: pick-next.mjs refuses to pick until rules-ack.mjs has printed it. A record
 * that can't be written adds a third line,
 *   RULES_NOT_RECORDED: run the git diff command above yourself; pick-next.mjs will not wait for it
 * and `pull: rules change not recorded: <message>` on stderr, and still exits 0 (the pull worked).
 *
 * --start <command> (a between-issues point): then prints the operator's restart line, with the
 * loop's own start arguments:
 *   RESTART: exit this session, start a new one in this clone, then run: <command> [--milestone "<title>"]
 *
 * A failed pull (no upstream, a diverged branch, network) prints `pull: <message>` on stderr and
 * exits 2; stdout then has the RESTART line alone (with --start), or nothing.
 */

import { execFileSync } from 'child_process'
import { recordFile, addPending, shellWord } from './lib/rules.mjs'
import { blockLine } from './lib/block.mjs'

const USAGE = 'pull.mjs [--start <command> [--milestone <title>]]'

function usageError(message) {
  process.stderr.write(`${message ? `${message}\n` : ''}Usage: ${USAGE}\n`)
  process.exit(1)
}

function arg(name) {
  const i = process.argv.indexOf(name)
  if (i === -1) return null
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) usageError(`${name}: expected a value`)
  return v
}

const start = arg('--start')
const milestone = arg('--milestone')
if (milestone !== null && start === null) usageError('--milestone needs --start')

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// The rules files the block lists: `rules: a.md, docs/b.md` (brackets and quotes allowed).
function rulesPaths(agents) {
  const line = blockLine(agents, 'rules') ?? ''
  return line
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^['"]+|['"]+$/g, '').replace(/^\.\//, ''))
    .filter(Boolean)
}

// The restart line does not depend on the pull: a failed pull still reaches the operator with it.
const restart =
  start === null
    ? null
    : `RESTART: exit this session, start a new one in this clone, then run: ${start}${milestone !== null ? ` --milestone "${milestone.replace(/(["\\])/g, '\\$1')}"` : ''}`

const lines = []
let range = null
try {
  const before = git('rev-parse', 'HEAD').trim()
  git('pull', '--quiet', '--ff-only')
  const after = git('rev-parse', 'HEAD').trim()
  if (after !== before) {
    const changed = git('diff', '--name-only', `${before}..${after}`).split('\n').filter(Boolean)
    let agents = ''
    try {
      agents = git('show', 'HEAD:AGENTS.md')
    } catch {
      // no AGENTS.md at HEAD
    }
    const watched = ['AGENTS.md', ...rulesPaths(agents)]
    const hits = []
    for (const w of watched) {
      for (const f of changed) {
        const match = w.endsWith('/') ? f.startsWith(w) : f === w
        if (match && !hits.includes(f)) hits.push(f)
      }
    }
    if (hits.length > 0) {
      lines.push(`RULES_CHANGED: ${hits.join(' ')}`)
      lines.push(`  git diff ${before.slice(0, 12)}..${after.slice(0, 12)} -- ${hits.map(shellWord).join(' ')}`)
      range = { from: before, to: after, files: hits }
    }
  }
} catch (e) {
  const detail = String(e?.stderr ?? '').trim() || e?.message || String(e)
  // git leads with hint: lines; the fatal: or error: line is the one that says what stopped it.
  const all = detail.split('\n')
  process.stderr.write(`pull: ${all.find((l) => /^(fatal|error):/.test(l)) ?? all[0]}\n`)
  if (restart) process.stdout.write(`${restart}\n`)
  process.exit(2)
}

if (range) {
  try {
    addPending(recordFile(), range)
  } catch (e) {
    lines.push('RULES_NOT_RECORDED: run the git diff command above yourself; pick-next.mjs will not wait for it')
    process.stderr.write(`pull: rules change not recorded: ${e?.message ?? e}\n`)
  }
}

if (restart) lines.push(restart)
if (lines.length > 0) process.stdout.write(lines.join('\n') + '\n')
