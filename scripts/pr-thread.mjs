#!/usr/bin/env node
/**
 * A PR's thread as a loop may read it (#151): every comment, review and inline review comment by a
 * trusted author, and nothing by anyone else. `gh pr view --comments` shows no author association,
 * so a session reading the thread there can't tell the operator from an outsider; this is the one
 * read of the thread the loop texts use. With --issue, the same for an issue (#153): its header,
 * its title and body only when its author is trusted, and its trusted comments.
 *
 * Usage:
 *   node scripts/pr-thread.mjs --repo owner/repo --pr <n>
 *   node scripts/pr-thread.mjs --repo owner/repo --issue <n>
 *
 * --issue output, exit 0: first one ISSUE block,
 *   ISSUE
 *   id: <n>
 *   author: <login>          (unknown) for a deleted account
 *   trusted: yes | no        whether the block trusts the author: `no` → no title and no body are
 *                            printed, and the issue is nobody's direction
 *   state: open | closed
 *   labels: <a>, <b>         (none) when it has none
 *   at: <created>
 *   title: <title>           trusted only
 *     <body, indented>       trusted only
 * then each trusted COMMENT block as below, oldest first, then `UNTRUSTED <count>` when comments were
 * left out. A PR's number is refused (exit 2: read it with --pr).
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

const USAGE = 'pr-thread.mjs --repo owner/repo (--pr <n> | --issue <n>)'
const OPTIONS = ['--repo', '--pr', '--issue']

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
const issueArg = arg('--issue')
if (prArg !== null && issueArg !== null) usageError('give --pr or --issue, not both')
const kind = issueArg !== null ? 'issue' : 'pr'
const numArg = prArg ?? issueArg
if (!numArg || !/^#?\d+$/.test(numArg)) usageError(numArg ? `--${kind}: expected ${kind === 'pr' ? 'a PR' : 'an issue'} number, got "${numArg}"` : '--pr or --issue is required')
const pr = numArg.replace(/^#/, '')

const ghAll = (apiPath) =>
  JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', apiPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '[]').flat()
const ghOne = (apiPath) => JSON.parse(execFileSync('gh', ['api', apiPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || 'null')

const indent = (body) => (body ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => `  ${l}`).join('\n')
// One line: a title or a label name can't open a line of its own.
const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ')
// A login is GitHub's own characters; anything else in the field is printed as (unknown).
const login = (c) => (/^[A-Za-z0-9-]+(\[bot\])?$/.test(c?.user?.login ?? '') ? c.user.login : '(unknown)')
const commentBlock = (c) => {
  const head = ['COMMENT', `id: ${c.id}`, `author: ${login(c)}`, `at: ${c.created_at ?? '?'}`].join('\n')
  return c.body ? `${head}\n${indent(c.body)}` : head
}

// The issue, then its trusted comments (#153). The title and body are the author's text: printed
// only when the author is trusted, so an outsider's issue gives its header and nothing to act on.
function readIssue(trusted) {
  const issue = ghOne(`repos/${repo}/issues/${pr}`)
  if (issue?.pull_request) throw new Error(`#${pr} is a pull request: read it with --pr`)
  const ok = login(issue) !== '(unknown)' && trusted(issue)
  const labels = (issue?.labels ?? []).map((l) => oneLine(typeof l === 'string' ? l : l?.name)).filter(Boolean)
  const head = ['ISSUE', `id: ${pr}`, `author: ${login(issue)}`, `trusted: ${ok ? 'yes' : 'no'}`, `state: ${issue?.state === 'closed' ? 'closed' : 'open'}`,
    `labels: ${labels.length ? labels.join(', ') : '(none)'}`, `at: ${issue?.created_at ?? '?'}`]
  if (ok) head.push(`title: ${oneLine(issue.title)}`)
  const blocks = [ok && issue.body ? `${head.join('\n')}\n${indent(issue.body)}` : head.join('\n')]
  const comments = ghAll(`repos/${repo}/issues/${pr}/comments`)
  const shown = comments.filter((c) => trusted(c)).sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || a.id - b.id)
  blocks.push(...shown.map(commentBlock))
  if (comments.length > shown.length) blocks.push(`UNTRUSTED ${comments.length - shown.length}`)
  return blocks.join('\n')
}

function read() {
  // Trust first: no thread is read, let alone printed, without the list (an unreadable block exits 2).
  const trusted = trustTest(fetchAgents((cmd, opts) => execSync(cmd, { ...opts, encoding: 'utf8' }), repo))
  if (kind === 'issue') return readIssue(trusted)
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
