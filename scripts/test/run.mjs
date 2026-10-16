#!/usr/bin/env node
// Contract tests for the signal scripts, run against a fake `gh` (fake-gh.mjs).
//   node scripts/test/run.mjs
// No dependencies. Each case gets a fresh HOME (so state files start empty) and a fixture.
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, readFileSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { execFileSync, spawn } from 'child_process'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scripts = path.resolve(here, '..')
const REPO = 'acme/widgets'

const T = (iso) => iso
const user = (login) => ({ login })
let nextId = 100
const comment = (body, created_at, login = 'acme') => ({ id: nextId++, body, created_at, user: user(login) })
const commit = (date) => ({ commit: { committer: { date } } })

const BASE = {
  pr: { merged: false, head: { sha: 'abc123' } },
  comments: [],
  reviews: [],
  inline: [],
  commits: [commit(T('2026-01-01T10:00:00Z'))],
  checks: [{ name: 'check', state: 'SUCCESS', bucket: 'pass', link: 'https://ci/1' }],
}

let failures = 0
let passes = 0

function makeEnv() {
  const home = mkdtempSync(path.join(tmpdir(), 'agent-loop-test-'))
  const bin = path.join(home, 'bin')
  mkdirSync(bin)
  const gh = path.join(bin, 'gh')
  writeFileSync(gh, `#!/bin/sh\nexec node "${path.join(here, 'fake-gh.mjs')}" "$@"\n`)
  chmodSync(gh, 0o755)
  const fixture = path.join(home, 'fixture.json')
  const log = path.join(home, 'gh.log')
  return {
    home,
    fixture,
    log,
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_FIXTURE: fixture, FAKE_GH_LOG: log },
  }
}

function run(ctx, script, args, fixture) {
  writeFileSync(ctx.fixture, JSON.stringify(fixture))
  try {
    return execFileSync('node', [path.join(scripts, script), ...args], { env: ctx.env, encoding: 'utf8' })
  } catch (e) {
    return `EXIT ${e.status}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`
  }
}

function check(name, cond, detail) {
  if (cond) {
    passes++
    console.log(`ok   ${name}`)
  } else {
    failures++
    console.log(`FAIL ${name}\n     ${String(detail).split('\n').join('\n     ')}`)
  }
}

const poll = (ctx, fixture, extra = []) => run(ctx, 'pr-poll.mjs', ['--repo', REPO, '--pr', '7', ...extra], fixture)
const signals = (out) => out.split('\n').filter((l) => /^[A-Z_]+( |$)/.test(l)).map((l) => l.split(' ')[0])

// ---------------------------------------------------------------- pr-poll.mjs
{
  const ctx = makeEnv()
  const out = poll(ctx, BASE)
  check('poll: first run seeds cursors and emits NONE', signals(out).join() === 'NONE', out)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  poll(ctx, BASE)
  const fx = { ...BASE, comments: [comment('please also handle the empty case', T('2026-01-01T11:00:00Z'))] }
  const out = poll(ctx, fx)
  check('poll: new operator comment → NEW_COMMENT with body', signals(out).includes('NEW_COMMENT') && out.includes('  please also handle'), out)
  const again = poll(ctx, fx)
  check('poll: operator comment not re-emitted after cursor advances', signals(again).join() === 'NONE', again)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  poll(ctx, BASE)
  const fx = { ...BASE, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))] }
  const out = poll(ctx, fx)
  check('poll: LGTM after last commit + CI pass → MERGE_READY (QA optional by default)', signals(out).includes('MERGE_READY'), out)
  check('poll: own-prefix [reviewer] LGTM is also surfaced as NEW_COMMENT (executor reads it)', signals(out).includes('NEW_COMMENT'), out)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  poll(ctx, BASE, ['--require-qa'])
  const lgtmOnly = { ...BASE, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))] }
  const out = poll(ctx, lgtmOnly, ['--require-qa'])
  check('poll --require-qa: LGTM without [qa] PASS → no MERGE_READY', !signals(out).includes('MERGE_READY'), out)
  const both = { ...BASE, comments: [...lgtmOnly.comments, comment('[qa] PASS\n\n| a | b |', T('2026-01-01T12:05:00Z'))] }
  const out2 = poll(ctx, both, ['--require-qa'])
  check('poll --require-qa: LGTM + [qa] PASS after last commit → MERGE_READY', signals(out2).includes('MERGE_READY'), out2)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  poll(ctx, BASE)
  const stale = { ...BASE, comments: [comment('[reviewer] LGTM', T('2026-01-01T09:00:00Z'))] }
  const out = poll(ctx, stale)
  check('poll: LGTM older than last commit is stale → no MERGE_READY', !signals(out).includes('MERGE_READY'), out)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const failing = { ...BASE, checks: [{ name: 'check', state: 'FAILURE', bucket: 'fail', link: 'https://ci/9' }, { name: 'e2e', state: 'SUCCESS', bucket: 'pass' }] }
  const first = poll(ctx, failing)
  check('poll: failing check on first run → CI_FAILING (CI is state, not history)', signals(first).includes('CI_FAILING') && first.includes('check: check  state: FAILURE') && first.includes('https://ci/9'), first)
  check('poll: CI_FAILING lists only failing checks', !first.includes('check: e2e'), first)
  const second = poll(ctx, failing)
  check('poll: same failing head not re-reported', !signals(second).includes('CI_FAILING'), second)
  const newHead = { ...failing, pr: { merged: false, head: { sha: 'def456' } } }
  const third = poll(ctx, newHead)
  check('poll: new head commit still failing → CI_FAILING again', signals(third).includes('CI_FAILING'), third)
  const withLgtm = { ...failing, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))] }
  const fourth = poll(ctx, withLgtm)
  check('poll: LGTM but CI failing → no MERGE_READY', !signals(fourth).includes('MERGE_READY'), fourth)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const pending = { ...BASE, checks: [{ name: 'check', state: 'IN_PROGRESS', bucket: 'pending' }], comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))] }
  poll(ctx, pending)
  const out = poll(ctx, pending)
  check('poll: LGTM but CI pending → no MERGE_READY, no CI_FAILING', !signals(out).includes('MERGE_READY') && !signals(out).includes('CI_FAILING'), out)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const noChecks = { ...BASE, checks: null, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))] }
  const first = poll(ctx, noChecks)
  check('poll: repo with no CI checks does not crash', !first.startsWith('EXIT'), first)
  const out = poll(ctx, noChecks)
  check('poll: no CI configured counts as passing → MERGE_READY', signals(out).includes('MERGE_READY'), out)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const blocked = { ...BASE, comments: [comment('[qa] BLOCKED\n\n| x | none | ❌ |', T('2026-01-01T12:00:00Z'))] }
  const out = poll(ctx, blocked)
  check('poll: live [qa] BLOCKED present at first poll is surfaced (not swallowed by seeding)', signals(out).includes('NEW_COMMENT') && out.includes('[qa] BLOCKED'), out)
  const addressed = { ...blocked, comments: [...blocked.comments, comment('[executor] Pushed fix: added the test', T('2026-01-01T12:10:00Z'))] }
  const out2 = poll(ctx, addressed)
  check('poll: [qa] BLOCKED stops re-surfacing once an [executor] comment follows it', !out2.includes('[qa] BLOCKED'), out2)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  poll(ctx, BASE)
  const inline = { ...BASE, inline: [{ id: 900, body: 'nit: rename this', path: 'src/a.ts', line: 12, user: user('acme') }] }
  const out = poll(ctx, inline)
  check('poll: new inline comment → NEW_INLINE_COMMENT with id/path/line', signals(out).includes('NEW_INLINE_COMMENT') && out.includes('id: 900') && out.includes('path: src/a.ts  line: 12'), out)
  const out2 = poll(ctx, inline)
  check('poll: unanswered inline comment keeps surfacing until replied to', signals(out2).includes('NEW_INLINE_COMMENT'), out2)
  const replied = { ...inline, inline: [...inline.inline, { id: 901, in_reply_to_id: 900, body: '[executor] done', path: 'src/a.ts', line: 12, user: user('acme') }] }
  const out3 = poll(ctx, replied)
  check('poll: replied inline comment stops surfacing; own [executor] reply is not a signal', !signals(out3).includes('NEW_INLINE_COMMENT'), out3)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  poll(ctx, BASE)
  const own = { ...BASE, comments: [comment('[executor] Pushed fix: handled the empty case', T('2026-01-01T11:00:00Z'))] }
  const out = poll(ctx, own)
  check('poll: own [executor] comment is filtered → NONE', signals(out).join() === 'NONE', out)
  const next = { ...own, comments: [...own.comments, comment('thanks, one more thing', T('2026-01-01T11:30:00Z'))] }
  const out2 = poll(ctx, next)
  check('poll: cursor advanced past own comment; the following operator comment still surfaces once', signals(out2).includes('NEW_COMMENT') && out2.includes('one more thing') && !out2.includes('Pushed fix'), out2)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const out = poll(ctx, { ...BASE, pr: { merged: true, head: { sha: 'abc123' } } })
  check('poll: merged PR → MERGED only', out.trim() === 'MERGED', out)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const out = run(ctx, 'pr-poll.mjs', ['--repo', REPO], BASE)
  check('poll: missing --pr → usage error, exit 1', out.startsWith('EXIT 1') && out.includes('Usage'), out)
  rmSync(ctx.home, { recursive: true, force: true })
}

{
  const ctx = makeEnv()
  const errored = { ...BASE, checks: 'error', comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))] }
  const first = poll(ctx, errored)
  check('poll: unreadable CI (auth/network) does not crash', !first.startsWith('EXIT'), first)
  const out = poll(ctx, errored)
  check('poll: unreadable CI fails closed → no MERGE_READY, no CI_FAILING', !signals(out).includes('MERGE_READY') && !signals(out).includes('CI_FAILING'), out)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const cancelled = { ...BASE, checks: [{ name: 'check', state: 'CANCELLED', bucket: 'cancel', link: 'https://ci/5' }], comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))] }
  const out = poll(ctx, cancelled)
  check('poll: cancelled check → CI_FAILING and no MERGE_READY (not a silent stall)', signals(out).includes('CI_FAILING') && !signals(out).includes('MERGE_READY'), out)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const failing = (completedAt) => ({ ...BASE, checks: [{ name: 'lint', state: 'FAILURE', bucket: 'fail', link: 'https://ci/9', completedAt }] })
  poll(ctx, failing('2026-01-01T10:05:00Z'))
  const same = poll(ctx, failing('2026-01-01T10:05:00Z'))
  check('poll: unchanged failing run not re-reported', !signals(same).includes('CI_FAILING'), same)
  const rerun = poll(ctx, failing('2026-01-01T10:20:00Z'))
  check('poll: a re-run that fails again on the same head → CI_FAILING again', signals(rerun).includes('CI_FAILING'), rerun)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  poll(ctx, BASE)
  const lgtmThenFinding = { ...BASE, comments: [
    comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z')),
    comment('also handle the empty case please', T('2026-01-01T12:10:00Z')),
    comment('[reviewer] Recheck: 1. **Empty input still crashes.** …', T('2026-01-01T12:20:00Z')),
  ] }
  const out = poll(ctx, lgtmThenFinding)
  check('poll: a later [reviewer] finding revokes an earlier LGTM without a push → no MERGE_READY', !signals(out).includes('MERGE_READY') && signals(out).includes('NEW_COMMENT'), out)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  poll(ctx, BASE, ['--require-qa'])
  const passThenBlocked = { ...BASE, comments: [
    comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z')),
    comment('[qa] PASS', T('2026-01-01T12:01:00Z')),
    comment('[qa] BLOCKED\n\n| x | none | ❌ |', T('2026-01-01T12:30:00Z')),
  ] }
  const out = poll(ctx, passThenBlocked, ['--require-qa'])
  check('poll --require-qa: a later [qa] BLOCKED revokes an earlier PASS → no MERGE_READY', !signals(out).includes('MERGE_READY'), out)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  poll(ctx, BASE) // seed the cursors first, so the question arrives as new activity
  const asked = { ...BASE, comments: [comment('[reviewer] Question: keep the launcher on --no-sync, or follow the plan literally?\n\nThe plan says bare `uv run loom`; the PR uses --no-sync so starting never reaches the network.\n\nReply with: "keep", or "follow the plan".', T('2026-01-01T12:00:00Z'))] }
  const first = poll(ctx, asked)
  check('poll: a new [reviewer] Question surfaces once as new activity, not as MERGE_READY', signals(first).includes('NEW_COMMENT') && first.includes('launcher') && !signals(first).includes('MERGE_READY'), first)
  const out = poll(ctx, asked)
  check('poll: [reviewer] Question is not a live blocker: it does not re-surface and is not an LGTM', !out.includes('launcher') && !signals(out).includes('MERGE_READY'), out)
  const legacy = { ...asked, comments: [...asked.comments, comment('[reviewer] Verified abc123 against #4: criteria covered.', T('2026-01-01T12:10:00Z'))] }
  poll(ctx, legacy) // seen once as an ordinary new comment, like any thread activity
  const outL = poll(ctx, legacy)
  check('poll: retired [reviewer] Verified kind is tolerated (not re-surfaced, not an LGTM)', !outL.includes('Verified abc123') && !signals(outL).includes('MERGE_READY'), outL)
  const answered = { ...legacy, comments: [...legacy.comments, comment('keep', T('2026-01-01T13:00:00Z')), comment('[reviewer] LGTM — abc123 against #4. Before you merge: run ./loom check on the Mac.', T('2026-01-01T13:05:00Z'))] }
  const out2 = poll(ctx, answered)
  check('poll: Question → operator answers → LGTM with a before-merge note → MERGE_READY', signals(out2).includes('MERGE_READY'), out2)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  poll(ctx, BASE)
  const lgtmThenQuestion = { ...BASE, comments: [
    comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z')),
    comment('[reviewer] Question: ship the old default?\n\nThe issue is silent on it.\n\nReply with: "yes", or "no, use X".', T('2026-01-01T12:30:00Z')),
  ] }
  const out = poll(ctx, lgtmThenQuestion)
  check('poll: a later [reviewer] Question withholds MERGE_READY until the next verdict', !signals(out).includes('MERGE_READY'), out)
  const relgtm = { ...lgtmThenQuestion, comments: [...lgtmThenQuestion.comments, comment('yes', T('2026-01-01T13:00:00Z')), comment('[reviewer] LGTM — recheck', T('2026-01-01T13:05:00Z'))] }
  const out2 = poll(ctx, relgtm)
  check('poll: the operator answers and the reviewer re-approves → MERGE_READY', signals(out2).includes('MERGE_READY'), out2)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  poll(ctx, BASE)
  const page1 = Array.from({ length: 30 }, (_, i) => comment(`older comment ${i}`, T('2026-01-01T09:00:00Z')))
  const page2 = [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))]
  const paged = { ...BASE, comments_pages: [page1, page2] }
  const out = poll(ctx, paged)
  check('poll: comments beyond the first API page are read (paginate + slurp)', signals(out).includes('MERGE_READY') && out.includes('[reviewer] LGTM'), out)
  rmSync(ctx.home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- pr-watch.mjs / pr-qa.mjs smoke
{
  const ctx = makeEnv()
  const fx = {
    ...BASE,
    prs: [{ number: 7, headRefOid: 'abc123', mergeable: 'MERGEABLE' }],
    prView: { reviewDecision: '' },
  }
  const out = run(ctx, 'pr-watch.mjs', ['--repo', REPO], fx)
  check('watch: new PR with no [reviewer] post → REVIEW:7', out.trim() === 'REVIEW:7', out)
  const out2 = run(ctx, 'pr-watch.mjs', ['--repo', REPO], fx)
  check('watch: still no [reviewer] post → REVIEW:7 again (initial review outstanding)', out2.trim() === 'REVIEW:7', out2)
  const reviewed = { ...fx, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))] }
  const out3 = run(ctx, 'pr-watch.mjs', ['--repo', REPO], reviewed)
  check('watch: reviewer has posted and nothing new → NONE', signals(out3).join() === 'NONE', out3)
  const opComment = { ...reviewed, comments: [...reviewed.comments, comment('looks good, one more thing', T('2026-01-01T12:30:00Z'))] }
  const out4 = run(ctx, 'pr-watch.mjs', ['--repo', REPO], opComment)
  check('watch: new operator comment → REVIEW_COMMENTS:7', out4.trim() === 'REVIEW_COMMENTS:7', out4)
  const page1 = Array.from({ length: 30 }, (_, i) => comment(`old ${i}`, T('2026-01-01T09:00:00Z')))
  const paged = { ...opComment, comments_pages: [page1, [...opComment.comments, comment('and one on page two', T('2026-01-01T12:40:00Z'))]] }
  const out4b = run(ctx, 'pr-watch.mjs', ['--repo', REPO], paged)
  check('watch: a new comment on the second API page is seen → REVIEW_COMMENTS:7', out4b.trim() === 'REVIEW_COMMENTS:7', out4b)
  const conflict = { ...opComment, prs: [{ number: 7, headRefOid: 'zzz999', mergeable: 'CONFLICTING' }] }
  const out5 = run(ctx, 'pr-watch.mjs', ['--repo', REPO], conflict)
  check('watch: new commit on conflicting branch → MERGE_CONFLICT:7', out5.trim() === 'MERGE_CONFLICT:7', out5)
  const gone = { ...conflict, prs: [] }
  const out6 = run(ctx, 'pr-watch.mjs', ['--repo', REPO], gone)
  check('watch: tracked PR merged or closed → CLOSED:7 once', out6.trim() === 'CLOSED:7', out6)
  const out7 = run(ctx, 'pr-watch.mjs', ['--repo', REPO], gone)
  check('watch: closed PR not reported again → NONE', signals(out7).join() === 'NONE', out7)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const fx = { ...BASE, prs: [{ number: 7, headRefOid: 'abc123', mergeable: 'MERGEABLE' }] }
  const out = run(ctx, 'pr-qa.mjs', ['--repo', REPO], fx)
  check('qa: new PR → QA_READY:7', out.trim() === 'QA_READY:7', out)
  const out2 = run(ctx, 'pr-qa.mjs', ['--repo', REPO], fx)
  check('qa: unchanged → NONE', signals(out2).join() === 'NONE', out2)
  const op = { ...fx, comments: [comment('verified by hand on my Mac', T('2026-01-01T12:00:00Z'))] }
  const out3 = run(ctx, 'pr-qa.mjs', ['--repo', REPO], op)
  check('qa: operator comment without a push → QA_READY:7', out3.trim() === 'QA_READY:7', out3)
  const out4 = run(ctx, 'pr-qa.mjs', ['--repo', REPO], { ...op, prs: [] })
  check('qa: tracked PR merged or closed → CLOSED:7 once', out4.trim() === 'CLOSED:7', out4)
  rmSync(ctx.home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- --wait (lib/wait.mjs)
// The waiter runs in the background so a test can change the fixture mid-wait. Intervals are 1s.
function start(ctx, script, args) {
  const t0 = Date.now()
  const child = spawn('node', [path.join(scripts, script), ...args], { env: ctx.env })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (err += d))
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ out, err, code, ms: Date.now() - t0 })))
  return { child, done }
}
const setFixture = (ctx, fixture) => {
  writeFileSync(`${ctx.fixture}.tmp`, JSON.stringify(fixture))
  renameSync(`${ctx.fixture}.tmp`, ctx.fixture)
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const stateText = (ctx, name) => {
  try {
    return readFileSync(path.join(ctx.home, '.agent-loop', 'state', name), 'utf8')
  } catch {
    return null
  }
}
const WATCH_STATE = 'acme-widgets-pr-state.json'
const POLL_STATE = 'acme-widgets-pr-poll-state.json'
const watchFx = {
  ...BASE,
  prs: [{ number: 7, headRefOid: 'abc123', mergeable: 'MERGEABLE' }],
  prView: { reviewDecision: '' },
}
const watchReviewed = { ...watchFx, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))] }
const watchArgs = (...extra) => ['--repo', REPO, ...extra]
{
  const ctx = makeEnv()
  setFixture(ctx, watchFx)
  const r = await start(ctx, 'pr-watch.mjs', watchArgs('--wait', '5', '--max', '20')).done
  check('wait: a signal already pending → PENDING at once, exit 0', r.out === 'PENDING\n' && r.code === 0 && r.ms < 4000, `${r.ms}ms code ${r.code}\n${r.out}${r.err}`)
  check('wait: the waiter writes no state', stateText(ctx, WATCH_STATE) === null, stateText(ctx, WATCH_STATE))
  const after = run(ctx, 'pr-watch.mjs', watchArgs(), watchFx)
  check('wait: … and the one-shot run that follows delivers the signal', after.trim() === 'REVIEW:7', after)
  const standing = await start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '2')).done
  check('wait: a standing REVIEW:<n> (no reviewer post yet) is not news → NONE at --max', signals(standing.out).join() === 'NONE' && standing.ms >= 2000, `${standing.ms}ms\n${standing.out}`)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  run(ctx, 'pr-watch.mjs', watchArgs(), watchReviewed)
  run(ctx, 'pr-watch.mjs', watchArgs(), watchReviewed)
  const before = stateText(ctx, WATCH_STATE)
  const r = await start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '2')).done
  check('wait: --max expiry prints NONE and exits 0', signals(r.out).join() === 'NONE' && r.code === 0 && r.ms >= 2000, `${r.ms}ms code ${r.code}\n${r.out}${r.err}`)
  check('wait: --max expiry leaves the state file byte-for-byte unchanged', stateText(ctx, WATCH_STATE) === before, `${before}\n${stateText(ctx, WATCH_STATE)}`)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  run(ctx, 'pr-watch.mjs', watchArgs(), watchReviewed)
  run(ctx, 'pr-watch.mjs', watchArgs(), watchReviewed)
  const before = stateText(ctx, WATCH_STATE)
  const w = start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '15'))
  await pause(1500)
  const later = { ...watchReviewed, comments: [...watchReviewed.comments, comment('one more thing', T('2026-01-01T12:30:00Z'))] }
  setFixture(ctx, later)
  const r = await w.done
  check('wait: a signal that arrives mid-wait → PENDING, state untouched', r.out === 'PENDING\n' && r.ms < 10000 && stateText(ctx, WATCH_STATE) === before, `${r.ms}ms\n${r.out}${r.err}`)
  const first = run(ctx, 'pr-watch.mjs', watchArgs(), later)
  const second = run(ctx, 'pr-watch.mjs', watchArgs(), later)
  check('wait: … the next one-shot run prints it once, and the run after sees nothing new', first.trim() === 'REVIEW_COMMENTS:7' && signals(second).join() === 'NONE', `${first}${second}`)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const lgtm = { ...BASE, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))] }
  poll(ctx, BASE)
  const first = poll(ctx, lgtm)
  check('wait (poll): setup — MERGE_READY delivered by a one-shot run', signals(first).includes('MERGE_READY'), first)
  const before = stateText(ctx, POLL_STATE)
  setFixture(ctx, lgtm)
  const r = await start(ctx, 'pr-poll.mjs', ['--repo', REPO, '--pr', '7', '--wait', '1', '--max', '3']).done
  check('wait (poll): a standing MERGE_READY does not return before --max', signals(r.out).join() === 'NONE' && r.ms >= 3000, `${r.ms}ms\n${r.out}${r.err}`)
  check('wait (poll): the waiter leaves the state file byte-for-byte unchanged', stateText(ctx, POLL_STATE) === before, stateText(ctx, POLL_STATE))
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const pending = { ...BASE, checks: [{ name: 'check', state: 'IN_PROGRESS', bucket: 'pending' }], comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))] }
  poll(ctx, pending)
  poll(ctx, pending)
  setFixture(ctx, pending)
  const w = start(ctx, 'pr-poll.mjs', ['--repo', REPO, '--pr', '7', '--wait', '1', '--max', '15'])
  await pause(1500)
  const green = { ...pending, checks: BASE.checks }
  setFixture(ctx, green)
  const r = await w.done
  const out = poll(ctx, green)
  check('wait (poll): CI turning green under an LGTM is news → PENDING, then MERGE_READY', r.out === 'PENDING\n' && r.ms < 10000 && out.trim() === 'MERGE_READY', `${r.ms}ms\n${r.out}${r.err}${out}`)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  run(ctx, 'pr-watch.mjs', watchArgs(), watchReviewed)
  run(ctx, 'pr-watch.mjs', watchArgs(), watchReviewed)
  setFixture(ctx, watchReviewed)
  const first = start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '4'))
  await pause(1000)
  const second = await start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '4')).done
  check('wait: a second waiter on the same state → WATCHER_RUNNING <pid>, exit 3', /^WATCHER_RUNNING \d+\n$/.test(second.out) && second.code === 3, `code ${second.code}\n${second.out}${second.err}`)
  await first.done
  const third = await start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '1')).done
  check('wait: the lock is released when a waiter exits', signals(third.out).join() === 'NONE', `${third.out}${third.err}`)
  const killed = start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '30'))
  await pause(1000)
  killed.child.kill('SIGTERM')
  const k = await killed.done
  const fourth = await start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '1')).done
  check('wait: a stopped waiter (SIGTERM) prints nothing and releases the lock', k.out === '' && signals(fourth.out).join() === 'NONE', `${k.out}|${fourth.out}${fourth.err}`)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  setFixture(ctx, { fail: true })
  const w = start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '15'))
  await pause(1500)
  setFixture(ctx, watchFx)
  const r = await w.done
  check('wait: a transient API error is retried, not fatal', r.out === 'PENDING\n' && r.code === 0 && /retrying/.test(r.err), `code ${r.code}\n${r.out}${r.err}`)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const bad = run(ctx, 'pr-watch.mjs', watchArgs('--wait', 'abc'), watchFx)
  check('wait: a non-numeric --wait → usage error, exit 1', bad.startsWith('EXIT 1') && bad.includes('Usage'), bad)
  const noWait = run(ctx, 'pr-watch.mjs', watchArgs('--max', '5'), watchFx)
  check('wait: --max without --wait → usage error, exit 1', noWait.startsWith('EXIT 1'), noWait)
  run(ctx, 'pr-watch.mjs', watchArgs(), watchReviewed)
  run(ctx, 'pr-watch.mjs', watchArgs(), watchReviewed)
  setFixture(ctx, watchReviewed)
  const r = await start(ctx, 'pr-watch.mjs', watchArgs('--wait', '--max', '1')).done
  check('wait: bare --wait takes the default interval and does not swallow --max', signals(r.out).join() === 'NONE' && r.ms < 5000, `${r.ms}ms\n${r.out}${r.err}`)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const fx = { ...BASE, prs: [{ number: 7, headRefOid: 'abc123', mergeable: 'MERGEABLE' }] }
  setFixture(ctx, fx)
  const r = await start(ctx, 'pr-qa.mjs', ['--repo', REPO, '--wait', '5', '--max', '20']).done
  check('wait (qa): a pending QA_READY → PENDING at once', r.out === 'PENDING\n' && r.ms < 4000, `${r.ms}ms\n${r.out}${r.err}`)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  run(ctx, 'pr-watch.mjs', watchArgs(), watchFx)
  const calls = readFileSync(ctx.log, 'utf8').trim().split('\n')
  check('one-shot: the baseline pass reuses the gh responses (no command runs twice)', new Set(calls).size === calls.length, calls.join('\n'))
  rmSync(ctx.home, { recursive: true, force: true })
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
