#!/usr/bin/env node
/**
 * A PR's thread as a loop may read it (#151): every comment, review and inline review comment by a
 * trusted author, and nothing by anyone else. `gh pr view --comments` shows no author association,
 * so a session reading the thread there can't tell the operator from an outsider; this is the one
 * read of the thread the loop texts use.
 *
 * Usage:
 *   node scripts/pr-thread.mjs --repo owner/repo --pr <n>
 *
 * Trusted: `trusted-authors` in the `## Agent loop` block of AGENTS.md on the default branch (the
 * contents API, never the clone's copy), or, when it lists nobody, `allow-author-associations`
 * (default OWNER, MEMBER, COLLABORATOR), as for claims (#134) and verdicts (#148).
 *
 * Output, exit 0: one block per item, oldest first (by time, then id), each starting with its kind:
 *   COMMENT                  a timeline comment
 *   REVIEW                   a review submission (its state line is its content when it has no body)
 *   INLINE                   an inline review comment (path, line, and the id it replies to, if any)
 * then `id:`, `author:`, `at:` (and `state:`, `path:`/`line:`, `reply-to:` as they apply), then the
 * body, each line indented by two spaces, so a line inside it can't pass for a block start. Then, when
 * anything was left out, one last line:
 *   UNTRUSTED <count>        items by authors the block doesn't trust; neither their authors nor their
 *                            text are printed, and they are no one's direction
 * Nothing at all → `EMPTY`. A pending (unsubmitted) review is never printed.
 * The block unreadable, or a failed gh call: `pr-thread: <message>` on stderr, nothing on stdout,
 * exit 2 (never a thread read without the trust list). A usage error: exit 1.
 */

import { execFileSync, execSync } from 'child_process'
import { fetchAgents, trustTest, REPO_NAME } from './lib/block.mjs'

const USAGE = 'pr-thread.mjs --repo owner/repo --pr <n>'
const OPTIONS = ['--repo', '--pr']

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

for (let i = 2; i < process.argv.length; i++) {
  if (OPTIONS.includes(process.argv[i])) i++
  else usageError(`unexpected argument "${process.argv[i]}"`)
}

const repo = arg('--repo')
if (!repo || !REPO_NAME.test(repo)) usageError(repo ? `--repo: expected owner/repo, got "${repo}"` : '--repo is required')
const prArg = arg('--pr')
if (!prArg || !/^#?\d+$/.test(prArg)) usageError(prArg ? `--pr: expected a PR number, got "${prArg}"` : '--pr is required')
const pr = prArg.replace(/^#/, '')

const ghAll = (apiPath) =>
  JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', apiPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '[]').flat()

const indent = (body) => (body ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => `  ${l}`).join('\n')
// A login is GitHub's own characters; anything else in the field is printed as (unknown).
const login = (c) => (/^[A-Za-z0-9-]+(\[bot\])?$/.test(c?.user?.login ?? '') ? c.user.login : '(unknown)')

function read() {
  // Trust first: no thread is read, let alone printed, without the list (an unreadable block exits 2).
  const trusted = trustTest(fetchAgents((cmd, opts) => execSync(cmd, { ...opts, encoding: 'utf8' }), repo))
  const comments = ghAll(`repos/${repo}/issues/${pr}/comments`).map((c) => ({ kind: 'COMMENT', at: c.created_at, c }))
  const reviews = ghAll(`repos/${repo}/pulls/${pr}/reviews`)
    .filter((r) => r.state !== 'PENDING')
    .map((r) => ({ kind: 'REVIEW', at: r.submitted_at, c: r }))
  const inline = ghAll(`repos/${repo}/pulls/${pr}/comments`).map((c) => ({ kind: 'INLINE', at: c.created_at, c }))
  const all = [...comments, ...reviews, ...inline]
  const shown = all.filter((i) => trusted(i.c))
  shown.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')) || a.c.id - b.c.id)
  const blocks = shown.map(({ kind, at, c }) => {
    const head = [kind, `id: ${c.id}`, `author: ${login(c)}`, `at: ${at ?? '?'}`]
    if (kind === 'REVIEW') head.push(`state: ${c.state}`)
    if (kind === 'INLINE') {
      head.push(`path: ${c.path}  line: ${c.line ?? c.original_line ?? '?'}`)
      if (c.in_reply_to_id) head.push(`reply-to: ${c.in_reply_to_id}`)
    }
    return c.body ? `${head.join('\n')}\n${indent(c.body)}` : head.join('\n')
  })
  const left = all.length - shown.length
  if (left > 0) blocks.push(`UNTRUSTED ${left}`)
  return blocks.length ? blocks.join('\n') : 'EMPTY'
}

let out
try {
  out = read()
} catch (e) {
  process.stderr.write(`pr-thread: ${(String(e?.stderr ?? '').trim() || e?.message || String(e)).split('\n')[0]}\n`)
  process.exit(2)
}
process.stdout.write(`${out}\n`)
