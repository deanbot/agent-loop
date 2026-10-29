#!/usr/bin/env node
/**
 * The auditor's numbers: for each control the loop ran over a period, what it cost and what it caught.
 * Read-only: it calls `gh` for data and prints a report; it posts nothing (spec: "Auditor").
 *
 * Usage:
 *   node scripts/audit.mjs --repo owner/repo --since <YYYY-MM-DD|ISO|Nd> [--until <YYYY-MM-DD|ISO>]
 *                          [--floor id,id] [--operators login,login] [--labels l,l] [--format md|json]
 *
 * The period: PRs closed in [since, until]. Their runs are counted whenever they started, so a PR's
 * whole cost is in the period it closed in; label time is clipped to the period, on the PRs and
 * issues updated in it. --until defaults to now (a bare date: the end of that day); `Nd` means N days
 * before --until. Lists (--floor, --operators, --labels) may be written as a block writes them:
 * `[a, b]`, quoted, `@login`.
 *
 * Controls (ids; --floor takes these, exactly):
 *   ci-prose:<workflow>    runs of a workflow on PRs that changed only prose, when their median is at
 *                          least half that of its runs on code PRs (else it already skips the work)
 *   reruns:<workflow>      earlier attempts of a run that was re-run
 *   cancelled:<workflow>   runs cancelled before they finished (a cancelled attempt is counted here only)
 *   label:<name>           time a PR or issue carried the label (--labels; default needs-operator,is-blocked)
 *   review-rounds          [reviewer] posts on PRs, and the time from a commit to the next one
 * <workflow> is the workflow file's base name without its extension (ci for .github/workflows/ci.yml).
 *
 * Comments are read for their time, their prefix and their author's login only, never for their text.
 * A PR is named by number only: a title is text anyone can write.
 *
 * Output (md, the default): a report whose header names the period, the exact arguments and the
 * cost unit; then the findings in cost order, then what was measured without a finding. --format json
 * prints { period, args, findings, unmatchedFloor, idle } for tests and tools.
 *
 * A failed gh call prints `audit: <message>` on stderr and exits 2.
 */

import { execFileSync } from 'child_process'
import { readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import path from 'path'

const USAGE =
  'audit.mjs --repo owner/repo --since <YYYY-MM-DD|ISO|Nd> [--until <YYYY-MM-DD|ISO>] [--floor id,id] [--operators login,login] [--labels l,l] [--format md|json]'

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

// A list as a block writes it: `a, b`, `[a, b]`, quoted items, `@login` (brackets, quotes and @ dropped).
const list = (v) => (v ?? '').replace(/^\s*\[|\]\s*$/g, '').split(',').map((s) => s.trim().replace(/^['"]+|['"]+$/g, '').replace(/^@/, '')).filter(Boolean)

const repo = arg('--repo')
if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) usageError(repo ? `--repo: expected owner/repo, got "${repo}"` : undefined)
const [owner] = repo.split('/')

// A bare date is the start of that day for --since and its last second for --until (both UTC).
const parseDate = (v, name, end = false) => {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${end ? '23:59:59' : '00:00:00'}Z` : v)
  if (Number.isNaN(t)) usageError(`${name}: expected a date, got "${v}"`)
  return t
}
const untilArg = arg('--until')
const until = untilArg === null ? Date.now() : parseDate(untilArg, '--until', true)
const sinceArg = arg('--since')
if (sinceArg === null) usageError('--since is required')
const days = /^(\d+)d$/.exec(sinceArg)
const since = days ? until - Number(days[1]) * 86400000 : parseDate(sinceArg, '--since')
if (since > until) usageError('--since is after --until')
const floor = list(arg('--floor'))
const operators = new Set([owner, ...list(arg('--operators'))].map((s) => s.toLowerCase()))
const labels = list(arg('--labels') ?? 'needs-operator,is-blocked')
const format = arg('--format') ?? 'md'
if (!['md', 'json'].includes(format)) usageError(`--format: expected md or json, got "${format}"`)

const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')
const day = (t) => iso(t).slice(0, 10)
const gh = (...a) => JSON.parse(execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) || 'null')
const pages = (p) => (gh('api', '--paginate', '--slurp', p) ?? []).flatMap((page) => (Array.isArray(page) ? page : (page.workflow_runs ?? [])))
const minutes = (a, b) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 60000)
const round1 = (n) => Math.round(n * 10) / 10

// Prose: Markdown and other text a test can't notice (in docs/ or anywhere else; docs/app.js is code).
// A PR whose file list hit the API's cap is never prose.
const FILE_CAP = 100
const PROSE = /(\.(md|mdx|markdown|txt|rst|adoc)$|(^|\/)(LICENSE|NOTICE|AUTHORS|CHANGELOG)(\.(md|txt))?$)/i
const DEPS = /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|requirements[^/]*\.txt|poetry\.lock|Pipfile(\.lock)?|composer\.(json|lock))$/
const CONFIG = /(^\.github\/|(^|\/)\.[^/]+$|\.(ya?ml|toml|ini|cfg|json)$)/
export function classify(file) {
  if (DEPS.test(file)) return 'dependencies'
  if (PROSE.test(file)) return 'prose'
  if (CONFIG.test(file)) return 'config'
  return 'code'
}

// A workflow's id part: its file's base name, plain characters only.
const workflowId = (run) => (path.basename(run.path ?? '').replace(/\.(ya?ml)$/i, '') || 'workflow').replace(/[^A-Za-z0-9._-]/g, '-')

// What the auditor keeps of a comment: its time, its author's login and its prefix (the role word in
// a leading `[…]`). Never the text after the prefix: comments are data, and on a public repository
// anyone writes them.
// Any leading `[…]` is agent traffic (the operator never uses one), whatever the word in it.
const commentFacts = (c) => ({
  at: c.created_at,
  login: (c.user?.login ?? '').toLowerCase(),
  prefix: /^\[(executor|reviewer|qa|auditor)\]/.exec(c.body ?? '')?.[1] ?? null,
  bracketed: /^\s*\[[^\]\n]*\]/.test(c.body ?? ''),
})

function gather() {
  const range = `${day(since)}..${day(until)}`
  const prs = (gh('pr', 'list', '--repo', repo, '--state', 'closed', '--search', `closed:${range}`, '--limit', '1000', '--json', 'number,createdAt,closedAt,mergedAt,files') ?? [])
    .filter((p) => Date.parse(p.closedAt) >= since && Date.parse(p.closedAt) <= until)
    .sort((a, b) => a.number - b.number)
  const byNumber = new Map()
  const shaToPr = new Map()
  for (const p of prs) {
    const files = (p.files ?? []).map((f) => f.path)
    const classes = new Set(files.map(classify))
    const prose = files.length > 0 && files.length < FILE_CAP && [...classes].every((c) => c === 'prose')
    const commits = pages(`repos/${repo}/pulls/${p.number}/commits?per_page=100`)
    for (const c of commits) shaToPr.set(c.sha, p.number)
    const comments = pages(`repos/${repo}/issues/${p.number}/comments?per_page=100`).map(commentFacts)
    byNumber.set(p.number, { ...p, prose, classes: [...classes], commits, comments })
  }

  // Runs of those PRs' commits, from the earliest PR's start.
  const from = prs.length ? Math.min(...prs.map((p) => Date.parse(p.createdAt))) : since
  const runs = prs.length
    ? pages(`repos/${repo}/actions/runs?event=pull_request&created=${encodeURIComponent(`${iso(from)}..${iso(until)}`)}&per_page=100`).filter((r) => shaToPr.has(r.head_sha))
    : []
  const attempts = []
  for (const r of runs) {
    const pr = shaToPr.get(r.head_sha)
    attempts.push({ ...r, pr, latest: true })
    for (let n = 1; n < (r.run_attempt ?? 1); n++) attempts.push({ ...gh('api', `repos/${repo}/actions/runs/${r.id}/attempts/${n}`), pr, latest: false })
  }

  // Label spans on PRs closed in the period and on any PR or issue updated in it.
  const items = new Map([...byNumber.keys()].map((n) => [n, { number: n, closedAt: byNumber.get(n).closedAt, comments: byNumber.get(n).comments }]))
  for (const i of pages(`repos/${repo}/issues?state=all&since=${iso(since)}&per_page=100`)) {
    if (!items.has(i.number)) items.set(i.number, { number: i.number, closedAt: i.closed_at ?? null, comments: null })
  }
  const spans = []
  for (const it of items.values()) {
    const events = pages(`repos/${repo}/issues/${it.number}/events?per_page=100`)
    if (!events.some((e) => labels.includes(e.label?.name))) continue
    it.comments ??= pages(`repos/${repo}/issues/${it.number}/comments?per_page=100`).map(commentFacts)
    const open = new Map()
    for (const e of events.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
      const name = e.label?.name
      if (!labels.includes(name)) continue
      if (e.event === 'labeled' && !open.has(name)) open.set(name, e.created_at)
      if (e.event === 'unlabeled' && open.has(name)) {
        spans.push({ item: it, label: name, from: open.get(name), to: e.created_at })
        open.delete(name)
      }
    }
    for (const [name, at] of open) spans.push({ item: it, label: name, from: at, to: it.closedAt ?? iso(until) })
  }
  // Each span clipped to the period; one wholly outside it is dropped. The end keeps its own time
  // for the merge-or-close test, `ended`, and the clipped one is the cost.
  const clipped = spans
    .map((s) => ({ ...s, ended: s.to, from: iso(Math.max(Date.parse(s.from), since)), to: iso(Math.min(Date.parse(s.to), until)) }))
    .filter((s) => Date.parse(s.to) > Date.parse(s.from))
  return { prs: [...byNumber.values()], attempts, spans: clipped }
}

function findings({ prs, attempts, spans }) {
  const out = []
  const add = (f) => out.push(f)
  const done = attempts.filter((a) => a.status === 'completed' && a.run_started_at && a.updated_at)
  const byWorkflow = new Map()
  for (const a of done) (byWorkflow.get(workflowId(a)) ?? byWorkflow.set(workflowId(a), []).get(workflowId(a))).push(a)
  const prose = new Set(prs.filter((p) => p.prose).map((p) => p.number))

  for (const [wf, list] of byWorkflow) {
    // A cancelled attempt counts under cancelled only, never as a re-run's earlier attempt too.
    const cancelled = list.filter((a) => a.conclusion === 'cancelled')
    const earlier = list.filter((a) => !a.latest && a.conclusion !== 'cancelled')
    // Latest attempts only (an earlier one is a re-run's cost), and only when a prose run costs at
    // least half what a code run of the same workflow does: a workflow that already skips its
    // tests on prose has nothing left to narrow.
    const onProse = list.filter((a) => prose.has(a.pr) && a.latest && a.conclusion !== 'cancelled')
    const onCode = list.filter((a) => !prose.has(a.pr) && a.latest && a.conclusion !== 'cancelled')
    if (onProse.length && !onCode.length) notes.push(`\`ci-prose:${wf}\`: no run on a code PR in the period to compare with, so no finding.`)
    if (onProse.length && onCode.length && median(onProse) >= median(onCode) / 2) {
      const failed = onProse.filter((a) => a.conclusion === 'failure').length
      add({ id: `ci-prose:${wf}`, control: `\`${wf}\` runs on PRs that changed only prose`, cost: sum(onProse), runs: onProse.length,
        prs: [...new Set(onProse.map((a) => a.pr))], caught: failed,
        rule: `skip \`${wf}\`'s tests when every changed file is prose (Markdown, docs/), and still report the required check` })
    }
    if (earlier.length) {
      const failedAgain = list.filter((a) => a.latest && a.run_attempt > 1 && a.conclusion === 'failure').length
      add({ id: `reruns:${wf}`, control: `re-runs of \`${wf}\``, cost: sum(earlier), runs: earlier.length,
        prs: [...new Set(earlier.map((a) => a.pr))], caught: failedAgain, drop: true,
        rule: `re-run \`${wf}\` only after a failure that is a known flake, once` })
    }
    if (cancelled.length) {
      add({ id: `cancelled:${wf}`, control: `\`${wf}\` runs cancelled before they finished`, cost: sum(cancelled), runs: cancelled.length,
        prs: [...new Set(cancelled.map((a) => a.pr))], caught: 0,
        rule: `don't start a \`${wf}\` run that a newer one on the same head will cancel (a title or body edit, say)` })
    }
  }

  for (const name of labels) {
    const own = spans.filter((s) => s.label === name)
    if (!own.length) continue
    // A span caught something when it ended in a merge or close, or the operator (the owner or a
    // --operators login, unprefixed) commented during it.
    const caught = own.filter((s) => {
      const end = Date.parse(s.to)
      if (s.item.closedAt && Math.abs(Date.parse(s.item.closedAt) - Date.parse(s.ended)) < 60000) return true
      return s.item.comments.some((c) => !c.bracketed && operators.has(c.login) && Date.parse(c.at) >= Date.parse(s.from) && Date.parse(c.at) <= end)
    })
    add({ id: `label:${name}`, control: `the \`${name}\` label`, cost: own.reduce((n, s) => n + minutes(s.from, s.to), 0), spans: own.length,
      prs: [...new Set(own.map((s) => s.item.number))], caught: caught.length,
      rule: `take \`${name}\` off, and tell the operator once, when nothing has answered it within a day` })
  }

  // Review rounds: a [reviewer] post; it caught something when a commit followed it before the next post.
  let rounds = 0
  let caught = 0
  let wait = 0
  const reviewed = []
  for (const p of prs) {
    const posts = p.comments.filter((c) => c.prefix === 'reviewer').map((c) => Date.parse(c.at)).sort((a, b) => a - b)
    if (!posts.length) continue
    reviewed.push(p.number)
    const pushes = p.commits.map((c) => Date.parse(c.commit?.committer?.date ?? c.commit?.author?.date)).filter((t) => !Number.isNaN(t))
    posts.forEach((t, i) => {
      rounds++
      const next = posts[i + 1] ?? Infinity
      if (pushes.some((x) => x > t && x < next)) caught++
    })
    for (const x of pushes) {
      const after = posts.find((t) => t >= x)
      if (after !== undefined) wait += (after - x) / 60000
    }
  }
  if (rounds) add({ id: 'review-rounds', control: 'review rounds', cost: wait, rounds, prs: reviewed, caught,
    rule: 'skip a new review round when the push after an LGTM changes only prose' })

  // Both numbers or nothing: a finding with no cost or an unknown catch is not posted.
  return out
    .filter((f) => f.cost > 0 && f.caught !== null && f.caught !== undefined)
    .map((f) => {
      const floored = floor.includes(f.id)
      const recommendation = floored ? null : f.caught > 0 ? 'keep' : f.drop ? 'drop' : 'narrow'
      return { ...f, cost: round1(f.cost), floor: floored, recommendation, rule: recommendation === 'narrow' || recommendation === 'drop' ? f.rule : null }
    })
    .sort((a, b) => b.cost - a.cost || (a.id < b.id ? -1 : 1))
}
function sum(list) {
  return list.reduce((n, a) => n + minutes(a.run_started_at, a.updated_at), 0)
}
function median(list) {
  const m = list.map((a) => minutes(a.run_started_at, a.updated_at)).sort((a, b) => a - b)
  return m.length % 2 ? m[(m.length - 1) / 2] : (m[m.length / 2 - 1] + m[m.length / 2]) / 2
}
const notes = []

// Wake-ups that found nothing: each waiter's current idle streak, from this machine's state folder.
function idleStreaks() {
  const dir = path.join(homedir(), '.agent-loop', 'state')
  const slug = repo.replace('/', '-')
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(`${slug}-`) && f.endsWith('-wait.json'))
      .map((f) => {
        try {
          const idle = JSON.parse(readFileSync(path.join(dir, f), 'utf8')).idle
          return Number.isInteger(idle) ? { file: f, idle } : null
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

let data
try {
  data = gather()
} catch (e) {
  const detail = String(e?.stderr ?? '').trim() || e?.message || String(e)
  process.stderr.write(`audit: ${detail.split('\n')[0]}\n`)
  process.exit(2)
}
const result = findings(data)
const ids = new Set(result.map((f) => f.id))
const unmatchedFloor = floor.filter((id) => !ids.has(id))
const idle = idleStreaks()
const command = ['node scripts/audit.mjs', '--repo', repo, '--since', iso(since), '--until', iso(until), ...(floor.length ? ['--floor', floor.join(',')] : []),
  ...(arg('--operators') ? ['--operators', list(arg('--operators')).join(',')] : []), ...(arg('--labels') ? ['--labels', labels.join(',')] : [])].join(' ')

if (format === 'json') {
  process.stdout.write(JSON.stringify({ period: { since: iso(since), until: iso(until) }, args: command, prs: data.prs.length, findings: result, unmatchedFloor, notes, idle }, null, 2) + '\n')
  process.exit(0)
}

const lines = [
  `# [auditor] Audit ${day(since)}..${day(until)}`,
  '',
  `Period: PRs closed from ${iso(since)} to ${iso(until)} (${data.prs.length}), with every run of their commits; label time on PRs and issues updated in it, clipped to it.`,
  `Reproduce: \`${command}\``,
  'Cost is in minutes: a run\'s wall-clock time from start to its last update, a label\'s time on, a review round\'s time from a commit to the next review. Findings are in cost order.',
  'Caught: failures a run found, re-runs that failed again, label spans that ended in a merge or close or got an operator\'s comment, review rounds followed by a new commit.',
  '',
  '## Findings',
  '',
]
if (!result.length) lines.push('None: no control had both a cost and a count of what it caught in this period.')
for (const f of result) {
  const what = f.runs !== undefined ? `${f.runs} run${f.runs === 1 ? '' : 's'}` : f.spans !== undefined ? `${f.spans} span${f.spans === 1 ? '' : 's'}` : `${f.rounds} round${f.rounds === 1 ? '' : 's'}`
  lines.push(`### \`${f.id}\`: ${f.control}`)
  lines.push(`- Cost: ${f.cost} min over ${what}, on PRs and issues ${f.prs.map((n) => `#${n}`).join(', ')}.`)
  if (f.floor) {
    lines.push('- In `audit-floor`: cost only. Whether to change it is the operator\'s call.')
  } else {
    lines.push(`- Caught: ${f.caught}.`)
    lines.push(`- Recommendation: **${f.recommendation}**${f.rule ? `: ${f.rule}.` : '.'}`)
  }
  lines.push('')
}
lines.push('## Measured, no finding', '')
for (const n of notes) lines.push(`- ${n}`)
if (unmatchedFloor.length) lines.push(`- \`audit-floor\` ids that matched no control in this period: ${unmatchedFloor.map((id) => `\`${id}\``).join(', ')}.`)
lines.push(idle.length
  ? `- Wake-ups that found nothing, as each waiter's current idle streak on this machine: ${idle.map((i) => `${i.file} ${i.idle}`).join(', ')}. What a wake-up catches isn't recorded, so there is no finding.`
  : '- Wake-ups that found nothing: no waiter state for this repository on this machine.')
process.stdout.write(lines.join('\n') + '\n')
