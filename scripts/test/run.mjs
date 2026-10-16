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

// ---------------------------------------------------------------- negative verdicts survive non-fix commits (#41)
// deanbot/loom#91: the reviewer posts a finding on a draft before the executor's first poll; a
// baselines-only commit follows; the first poll must still deliver the finding.
{
  const ctx = makeEnv()
  const finding = comment('[reviewer] 1. the empty-state screenshot is missing', T('2026-01-01T12:05:00Z'))
  const fx = { ...BASE, commits: [commit(T('2026-01-01T10:00:00Z')), commit(T('2026-01-01T12:10:00Z'))], comments: [finding] }
  const first = poll(ctx, fx)
  check('poll #41: a finding, then a non-fix commit, then the first poll → NEW_COMMENT with the finding', signals(first).includes('NEW_COMMENT') && first.includes('empty-state screenshot'), first)
  const again = poll(ctx, fx)
  check('poll #41: … and it stays live while unanswered', again.includes('empty-state screenshot'), again)
  const answered = { ...fx, comments: [finding, comment('[executor] Pushed fix: added the screenshot', T('2026-01-01T12:20:00Z'))] }
  poll(ctx, answered)
  const quiet = poll(ctx, answered)
  check('poll #41: after an [executor] comment the finding goes quiet', !quiet.includes('empty-state screenshot'), quiet)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const finding = comment('[reviewer] 1. the empty-state screenshot is missing', T('2026-01-01T12:05:00Z'))
  const lgtm = comment('[reviewer] LGTM — recheck of def456', T('2026-01-01T12:30:00Z'))
  const fx = { ...BASE, commits: [commit(T('2026-01-01T10:00:00Z')), commit(T('2026-01-01T12:10:00Z'))], comments: [finding, lgtm] }
  poll(ctx, fx)
  const out = poll(ctx, fx)
  check('poll #41: a finding superseded by a newer LGTM is quiet, and MERGE_READY follows', !out.includes('empty-state screenshot') && out.trim() === 'MERGE_READY', out)
  const staleLgtm = { ...fx, commits: [...fx.commits, commit(T('2026-01-01T12:40:00Z'))] }
  const out2 = poll(ctx, staleLgtm)
  check('poll #41: … an LGTM older than the last commit still gives no MERGE_READY (commit rule kept for LGTM)', !signals(out2).includes('MERGE_READY') && !out2.includes('empty-state screenshot'), out2)
  const second = comment('[reviewer] 2. the dark-mode baseline is wrong', T('2026-01-01T12:50:00Z'))
  const out3 = poll(ctx, { ...staleLgtm, comments: [finding, lgtm, second] })
  check('poll #41: a newer finding is live; the older, superseded one is not re-surfaced', out3.includes('dark-mode baseline') && !out3.includes('empty-state screenshot'), out3)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const blocked = comment('[qa] BLOCKED\n\n| criterion | missing |', T('2026-01-01T12:05:00Z'))
  const fx = { ...BASE, commits: [commit(T('2026-01-01T10:00:00Z')), commit(T('2026-01-01T12:10:00Z'))], comments: [blocked] }
  const first = poll(ctx, fx, ['--require-qa'])
  check('poll #41: [qa] BLOCKED before a non-fix commit survives the first poll', first.includes('[qa] BLOCKED'), first)
  const passed = { ...fx, comments: [blocked, comment('[qa] PASS\n\n| a | b |', T('2026-01-01T12:30:00Z'))] }
  const out = poll(ctx, passed, ['--require-qa'])
  check('poll #41: … and a newer [qa] post supersedes it', !out.includes('[qa] BLOCKED'), out)
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

// Standing MERGE_CONFLICT (#48): a PR in the operator's inbox (needs-operator) that falls into
// conflict with no new commit, e.g. a monitor's PR with no executor after main moved.
{
  const ctx = makeEnv()
  const lgtm = { ...BASE, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))], prView: { reviewDecision: '' } }
  const pr = (extra) => ({ ...lgtm, prs: [{ number: 7, headRefOid: 'abc123', mergeable: 'MERGEABLE', labels: [], ...extra }] })
  const watch = (fx, extra = []) => run(ctx, 'pr-watch.mjs', ['--repo', REPO, ...extra], fx)
  watch(pr({}))
  watch(pr({}))
  const ready = watch(pr({ labels: [{ name: 'needs-operator' }] }))
  check('watch: labelled, mergeable, reviewed PR → NONE', signals(ready).join() === 'NONE', ready)
  const conflicting = pr({ labels: [{ name: 'needs-operator' }], mergeable: 'CONFLICTING' })
  const out = watch(conflicting)
  check('watch: labelled PR falls into conflict with no new commit → MERGE_CONFLICT:7', out.trim() === 'MERGE_CONFLICT:7', out)
  const again = watch(conflicting)
  check('watch: … repeated while the label is on (a standing signal)', again.trim() === 'MERGE_CONFLICT:7', again)
  const unlabelled = watch(pr({ mergeable: 'CONFLICTING' }))
  check('watch: … quiet once the label is off', signals(unlabelled).join() === 'NONE', unlabelled)
  const unknown = watch(pr({ labels: [{ name: 'needs-operator' }], mergeable: 'UNKNOWN' }))
  check('watch: labelled PR with mergeable UNKNOWN → NONE', signals(unknown).join() === 'NONE', unknown)
  const custom = watch(pr({ labels: [{ name: 'waiting-on-dean' }], mergeable: 'CONFLICTING' }), ['--needs-operator-label', 'waiting-on-dean'])
  check('watch: --needs-operator-label names the label → MERGE_CONFLICT:7', custom.trim() === 'MERGE_CONFLICT:7', custom)
  const otherLabel = watch(pr({ labels: [{ name: 'needs-operator' }], mergeable: 'CONFLICTING' }), ['--needs-operator-label', 'waiting-on-dean'])
  check('watch: … and the default label no longer counts', signals(otherLabel).join() === 'NONE', otherLabel)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const fx = { ...BASE, prView: { reviewDecision: '' }, prs: [{ number: 7, headRefOid: 'abc123', mergeable: 'MERGEABLE', labels: [{ name: 'needs-operator' }] }] }
  run(ctx, 'pr-watch.mjs', ['--repo', REPO], fx)
  const out = run(ctx, 'pr-watch.mjs', ['--repo', REPO], { ...fx, prs: [{ ...fx.prs[0], mergeable: 'CONFLICTING' }] })
  check('watch: labelled conflicting PR the reviewer never posted on → one MERGE_CONFLICT:7, not two', out.trim() === 'MERGE_CONFLICT:7', out)
  rmSync(ctx.home, { recursive: true, force: true })
}
// MERGE_CONFLICT (#46): a PR that falls into conflict after its LGTM, e.g. when another PR merges.
{
  const ctx = makeEnv()
  const lgtm = { ...BASE, pr: { ...BASE.pr, mergeable: true, mergeable_state: 'clean' }, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))] }
  poll(ctx, BASE)
  const ready = poll(ctx, lgtm)
  check('poll: mergeable PR with LGTM + green CI → MERGE_READY, no MERGE_CONFLICT', signals(ready).includes('MERGE_READY') && !signals(ready).includes('MERGE_CONFLICT'), ready)
  const conflicting = { ...lgtm, pr: { ...lgtm.pr, mergeable: false, mergeable_state: 'dirty' } }
  const out = poll(ctx, conflicting)
  check('poll: conflicting PR with a current LGTM + green CI → MERGE_CONFLICT, not MERGE_READY', out.trim() === 'MERGE_CONFLICT', out)
  const again = poll(ctx, conflicting)
  check('poll: MERGE_CONFLICT repeats on every run while the conflict holds', again.trim() === 'MERGE_CONFLICT', again)
  const unknown = { ...lgtm, pr: { ...lgtm.pr, mergeable: null, mergeable_state: 'unknown' } }
  const out2 = poll(ctx, unknown)
  check('poll: mergeable UNKNOWN (null) changes nothing → MERGE_READY, no MERGE_CONFLICT', out2.trim() === 'MERGE_READY', out2)
  const resolved = poll(ctx, lgtm)
  check('poll: … and once mergeable again, MERGE_READY', resolved.trim() === 'MERGE_READY', resolved)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const fx = { ...BASE, pr: { ...BASE.pr, mergeable: false, mergeable_state: 'dirty' } }
  poll(ctx, BASE)
  const out = poll(ctx, fx)
  check('poll: conflict without an LGTM → MERGE_CONFLICT alone', out.trim() === 'MERGE_CONFLICT', out)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const fx = { ...BASE, pr: { ...BASE.pr, mergeable: null, mergeable_state: 'unknown' } }
  poll(ctx, BASE)
  const out = poll(ctx, fx)
  check('poll: mergeable UNKNOWN without an LGTM → NONE', signals(out).join() === 'NONE', out)
  rmSync(ctx.home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- pick-next.mjs
{
  const ctx = makeEnv()
  const pick = (fx, extra = []) => run(ctx, 'pick-next.mjs', ['--repo', REPO, ...extra], fx).trim()
  const M3 = { title: 'M3' }
  const M4 = { title: 'M4' }
  const issue = (number, extra = {}) => ({ number, title: `#${number}`, body: '', labels: [], milestone: M3, ...extra })
  const label = (name) => [{ name }]
  const milestones = [
    { number: 2, title: 'M2', state: 'closed' },
    { number: 3, title: 'M3', state: 'open' },
    { number: 4, title: 'M4', state: 'open' },
  ]
  const ms = ['--milestone', 'M3']

  check('pick: lowest-numbered startable issue → ISSUE:<n>', pick({ issues: [issue(12), issue(11)] }) === 'ISSUE:11')
  check('pick: in-progress and blocked issues are passed over',
    pick({ issues: [issue(10, { labels: label('in-progress') }), issue(11, { labels: label('is-blocked') }), issue(12)] }) === 'ISSUE:12')
  check('pick: custom label names are honoured',
    pick({ issues: [issue(10, { labels: label('wip') }), issue(11)] }, ['--in-progress-label', 'wip']) === 'ISSUE:11')
  const deps = { issues: [issue(5, { state: 'CLOSED' }), issue(6), issue(10, { body: 'Depends on #6' }), issue(11, { body: 'Notes\nDepends on #5, #9' }), issue(9, { state: 'CLOSED' })] }
  check('pick: an issue whose dependency is open waits; one whose dependencies are closed is picked',
    pick({ ...deps, issues: deps.issues.map((i) => (i.number === 6 ? { ...i, labels: label('in-progress') } : i)) }) === 'ISSUE:11')
  check('pick: --skip passes over issues this session turned down', pick({ issues: [issue(11), issue(12)] }, ['--skip', '11']) === 'ISSUE:12')
  check('pick: no milestone and nothing startable → NONE', pick({ issues: [issue(11, { labels: label('in-progress') })] }) === 'NONE')
  check('pick: milestone filters the listing', pick({ issues: [issue(3, { milestone: M4 }), issue(11)] }, ms) === 'ISSUE:11')

  // Waiting: the blocker and its PR.
  const claimedFirst = { issues: [issue(28, { labels: label('in-progress') }), issue(29, { body: 'Depends on #28' })], milestones }
  check('pick: milestone, first open issue claimed, no PR → WAIT:28 PR:none', pick({ ...claimedFirst, prs: [] }, ms) === 'WAIT:28 PR:none')
  check('pick: … with an open PR that closes it → WAIT:28 PR:<n>',
    pick({ ...claimedFirst, prs: [{ number: 40, body: 'Closes #280' }, { number: 41, body: 'Fix.\n\nCloses #28' }] }, ms) === 'WAIT:28 PR:41')
  const depFirst = { issues: [issue(7, { milestone: M4 }), issue(30, { body: 'Depends on #7' })], milestones, prs: [] }
  check('pick: first open issue waits on a dependency (another milestone) → WAIT on that dependency',
    pick(depFirst, ms) === 'WAIT:7 PR:none')

  // The loom #118 case: an issue filed while the executor waited is picked at the next call.
  const before = { ...claimedFirst, prs: [] }
  check('pick: before the new issue → WAIT', pick(before, ms) === 'WAIT:28 PR:none')
  const filed = { ...before, issues: [...before.issues, issue(118, { body: 'Depends on #20' }), issue(20, { state: 'CLOSED' })] }
  check('pick: an unblocked issue filed after the last wait → ISSUE:118', pick(filed, ms) === 'ISSUE:118')

  // Moving on.
  check('pick: milestone with no open issues → MOVE_ON <next open milestone>',
    pick({ issues: [issue(1, { state: 'CLOSED' })], milestones: [...milestones, { number: 5, title: 'M5 Service and CLI', state: 'open' }] }, ms) === 'MOVE_ON M4')
  check('pick: … a title with spaces is printed whole',
    pick({ issues: [], milestones: [milestones[1], { number: 4, title: 'M4', state: 'closed' }, { number: 5, title: 'M5 Service and CLI', state: 'open' }] }, ms) === 'MOVE_ON M5 Service and CLI')
  check('pick: no open milestone after it → NONE', pick({ issues: [], milestones: milestones.slice(0, 2) }, ms) === 'NONE')
  check('pick: every open issue skipped (a claim another executor still holds) → WAIT on the lowest, not NONE',
    pick({ issues: [issue(11, { labels: label('in-progress') }), issue(12)], milestones, prs: [{ number: 60, body: 'Closes #11' }] }, [...ms, '--skip', '12,11']) === 'WAIT:11 PR:60')
  check('pick: no milestone and every open issue skipped → NONE', pick({ issues: [issue(11)] }, ['--skip', '11']) === 'NONE')
  check('pick: --skip none is an empty list', pick({ issues: [issue(11)] }, ['--skip', 'none']) === 'ISSUE:11')
  check('pick: "Depends on #5, #6, and #7" waits on all three',
    pick({ issues: [issue(5, { state: 'CLOSED' }), issue(6, { state: 'CLOSED' }), issue(7, { milestone: M4 }), issue(10, { body: 'Depends on #5, #6, and #7' })], milestones, prs: [] }, ms) === 'WAIT:7 PR:none')
  check('pick: "**Depends on:** #7" is read',
    pick({ issues: [issue(7, { milestone: M4 }), issue(10, { body: '**Depends on:** #7' })], milestones, prs: [] }, ms) === 'WAIT:7 PR:none')
  check('pick: "Depends on: #7 & #8" is read',
    pick({ issues: [issue(7, { state: 'CLOSED' }), issue(8, { milestone: M4 }), issue(10, { body: 'Depends on: #7 & #8' })], milestones, prs: [] }, ms) === 'WAIT:8 PR:none')
  check('pick: a list ends at the line break ("Depends on #5\\n#9 is related")',
    pick({ issues: [issue(5, { state: 'CLOSED' }), issue(9, { milestone: M4 }), issue(10, { body: 'Depends on #5\n#9 is related' })] }, ms) === 'ISSUE:10')

  check('pick: a dependency that is a merged PR counts as closed',
    pick({ issues: [issue(49, { state: 'MERGED' }), issue(50, { body: 'Depends on #49' })] }) === 'ISSUE:50')
  check('pick: only the list right after "Depends on" counts ("Depends on #5. See #9.")',
    pick({ issues: [issue(5, { state: 'CLOSED' }), issue(9), issue(10, { body: 'Depends on #5. See #9 for context.', milestone: M4 })] }, ['--milestone', 'M4']) === 'ISSUE:10')
  check('pick: "Depends on #5 and #9" waits on both',
    pick({ issues: [issue(5, { state: 'CLOSED' }), issue(9, { milestone: M4 }), issue(10, { body: 'Depends on #5 and #9' })], milestones, prs: [] }, ms) === 'WAIT:9 PR:none')
  const failed = run(ctx, 'pick-next.mjs', ['--repo', REPO], { fail: true })
  check('pick: a failed gh call → exit 2, one stderr line, nothing on stdout',
    /^EXIT 2\n\npick-next: HTTP 502/.test(failed), failed)
  const usage = run(ctx, 'pick-next.mjs', ['--milestone', 'M3'], { issues: [] })
  check('pick: missing --repo → usage error, exit 1', /^EXIT 1/.test(usage) && /Usage: pick-next\.mjs/.test(usage), usage)
  const badSkip = run(ctx, 'pick-next.mjs', ['--repo', REPO, '--skip', '11,x'], { issues: [] })
  check('pick: malformed --skip → usage error', /^EXIT 1/.test(badSkip), badSkip)
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
const POLL_STATE = 'acme-widgets-pr-poll-7.json'
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
  const lgtm = { ...BASE, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))], prView: { reviewDecision: '' }, prs: [{ number: 7, headRefOid: 'abc123', mergeable: 'MERGEABLE', labels: [{ name: 'needs-operator' }] }] }
  run(ctx, 'pr-watch.mjs', ['--repo', REPO], lgtm)
  run(ctx, 'pr-watch.mjs', ['--repo', REPO], lgtm)
  setFixture(ctx, lgtm)
  const w = start(ctx, 'pr-watch.mjs', ['--repo', REPO, '--wait', '1', '--max', '15'])
  await pause(1500)
  const conflicting = { ...lgtm, prs: [{ ...lgtm.prs[0], mergeable: 'CONFLICTING' }] }
  setFixture(ctx, conflicting)
  const r = await w.done
  const out = run(ctx, 'pr-watch.mjs', ['--repo', REPO], conflicting)
  check('wait (watch): a ready PR falling into conflict is news → PENDING, then MERGE_CONFLICT:7', r.out === 'PENDING\n' && r.ms < 10000 && out.trim() === 'MERGE_CONFLICT:7', `${r.ms}ms\n${r.out}${r.err}${out}`)
  const standing = await start(ctx, 'pr-watch.mjs', ['--repo', REPO, '--wait', '1', '--max', '2']).done
  check('wait (watch): … a standing one is not news again → NONE at --max', signals(standing.out).join() === 'NONE' && standing.ms >= 2000, `${standing.ms}ms\n${standing.out}`)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const lgtm = { ...BASE, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))] }
  poll(ctx, BASE)
  poll(ctx, lgtm)
  setFixture(ctx, lgtm)
  const w = start(ctx, 'pr-poll.mjs', ['--repo', REPO, '--pr', '7', '--wait', '1', '--max', '15'])
  await pause(1500)
  const conflicting = { ...lgtm, pr: { ...lgtm.pr, mergeable: false, mergeable_state: 'dirty' } }
  setFixture(ctx, conflicting)
  const r = await w.done
  const out = poll(ctx, conflicting)
  check('wait (poll): a standing MERGE_READY falling into conflict is news → PENDING, then MERGE_CONFLICT', r.out === 'PENDING\n' && r.ms < 10000 && out.trim() === 'MERGE_CONFLICT', `${r.ms}ms\n${r.out}${r.err}${out}`)
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

// ---------------------------------------------------------------- pr-poll: one state file per PR (#29)
// Two executors on one repo: a run for PR 7 reads its state, a run for PR 8 reads and saves, then
// the PR 7 run saves. Neither may put back the other's older entry.
{
  const ctx = makeEnv()
  const pollPr = (c, pr, fixture) => run(c, 'pr-poll.mjs', ['--repo', REPO, '--pr', pr], fixture)
  pollPr(ctx, '7', BASE)
  pollPr(ctx, '8', BASE)
  const fx = { ...BASE, comments: [comment('please also handle the empty case', T('2026-01-01T11:00:00Z'))] }
  const slow = { ...fx, delayMs: 400 }
  setFixture(ctx, slow)
  const a = start(ctx, 'pr-poll.mjs', ['--repo', REPO, '--pr', '7'])
  await pause(600)
  const fastFixture = path.join(ctx.home, 'fixture-fast.json')
  const fast = { ...ctx, fixture: fastFixture, env: { ...ctx.env, FAKE_GH_FIXTURE: fastFixture } }
  const b = pollPr(fast, '8', fx)
  const ra = await a.done
  check('poll per PR: setup — both overlapping runs deliver NEW_COMMENT, the PR 7 run finishing last', signals(ra.out).includes('NEW_COMMENT') && signals(b).includes('NEW_COMMENT') && ra.ms > 1500, `${ra.ms}ms\n${ra.out}${b}`)
  const again7 = pollPr(ctx, '7', fx)
  const again8 = pollPr(ctx, '8', fx)
  check('poll per PR: after interleaved runs neither PR re-emits the handled comment', signals(again7).join() === 'NONE' && signals(again8).join() === 'NONE', `${again7}${again8}`)
  check('poll per PR: each PR has its own state file', stateText(ctx, 'acme-widgets-pr-poll-7.json') !== null && stateText(ctx, 'acme-widgets-pr-poll-8.json') !== null, '')
  rmSync(ctx.home, { recursive: true, force: true })
}
// Migration: a PR with no per-PR file takes its entry from the shared file earlier versions kept.
{
  const fresh = makeEnv()
  const migrated = makeEnv()
  poll(fresh, BASE)
  const entry = JSON.parse(stateText(fresh, POLL_STATE))
  const shared = path.join(migrated.home, '.agent-loop', 'state', 'acme-widgets-pr-poll-state.json')
  mkdirSync(path.dirname(shared), { recursive: true })
  const sharedText = JSON.stringify({ 7: entry, 8: { comments: 1, reviews: null, reviewComments: null } })
  writeFileSync(shared, sharedText)
  const fx = { ...BASE, comments: [comment('please also handle the empty case', T('2026-01-01T11:00:00Z'))] }
  const want = poll(fresh, fx)
  const got = poll(migrated, fx)
  check('poll migration: the shared file\'s entry gives the same output as before', got === want && signals(got).includes('NEW_COMMENT'), `${want}---\n${got}`)
  check('poll migration: the per-PR file is written and the shared file is left alone', stateText(migrated, POLL_STATE) === stateText(fresh, POLL_STATE) && readFileSync(shared, 'utf8') === sharedText, `${stateText(migrated, POLL_STATE)}\n${stateText(fresh, POLL_STATE)}`)
  const quiet = poll(migrated, fx)
  check('poll migration: the next run reads the per-PR file → NONE', signals(quiet).join() === 'NONE', quiet)
  const bad = run(migrated, 'pr-poll.mjs', ['--repo', REPO, '--pr', '../x'], fx)
  check('poll: a --pr that is not a number → usage error, exit 1', bad.startsWith('EXIT 1') && bad.includes('Usage'), bad)
  rmSync(fresh.home, { recursive: true, force: true })
  rmSync(migrated.home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- already read before the role's own post (#28)
// loom#72: the executor pushes, the reviewer's one-shot run prints REVIEW, the executor's comment
// lands after that run, and the reviewer re-reads the thread and posts LGTM. The executor comment
// is older than the LGTM: already read, so neither a waiter nor the next run reports it.
{
  const ctx = makeEnv()
  const findings = { ...watchFx, comments: [comment('[reviewer] 1. empty input crashes', T('2026-01-01T12:00:00Z'))] }
  run(ctx, 'pr-watch.mjs', watchArgs(), findings)
  run(ctx, 'pr-watch.mjs', watchArgs(), findings)
  const pushed = { ...findings, prs: [{ number: 7, headRefOid: 'def456', mergeable: 'MERGEABLE' }] }
  const review = run(ctx, 'pr-watch.mjs', watchArgs(), pushed)
  check('seen: setup — the fix push gives REVIEW:7', review.trim() === 'REVIEW:7', review)
  const answered = {
    ...pushed,
    comments: [...pushed.comments, comment('[executor] Pushed fix: guard empty input', T('2026-01-01T12:10:05Z')), comment('[reviewer] LGTM — recheck of def456', T('2026-01-01T12:10:33Z'))],
  }
  setFixture(ctx, answered)
  const w1 = await start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '2')).done
  check('seen: an executor comment older than the [reviewer] post → the waiter does not return PENDING', signals(w1.out).join() === 'NONE', `${w1.ms}ms\n${w1.out}${w1.err}`)
  const quiet = run(ctx, 'pr-watch.mjs', watchArgs(), answered)
  check('seen: … and the next one-shot run prints NONE', signals(quiet).join() === 'NONE', quiet)
  const w2 = await start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '2')).done
  check('seen: … and a waiter after that run still returns NONE', signals(w2.out).join() === 'NONE', `${w2.out}${w2.err}`)
  // Inline comments have their own id sequence: a higher id but an earlier time is still older.
  const inlineOld = { ...answered, inline: [{ id: 9000, body: '[executor] done, see 983ffbc', created_at: T('2026-01-01T12:10:20Z'), user: user('acme') }] }
  setFixture(ctx, inlineOld)
  const w4 = await start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '2')).done
  const inlineRun = run(ctx, 'pr-watch.mjs', watchArgs(), inlineOld)
  check('seen: an inline comment older than the [reviewer] post (higher id) → waiter NONE, one-shot NONE', signals(w4.out).join() === 'NONE' && signals(inlineRun).join() === 'NONE', `${w4.out}${inlineRun}`)
  const later = { ...inlineOld, comments: [...inlineOld.comments, comment('[executor] Also renamed the helper', T('2026-01-01T12:11:00Z'))] }
  setFixture(ctx, later)
  const w5 = await start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '5')).done
  const newer = run(ctx, 'pr-watch.mjs', watchArgs(), later)
  check('seen: an executor comment newer than the [reviewer] post → PENDING, then REVIEW_COMMENTS:7', w5.out === 'PENDING\n' && newer.trim() === 'REVIEW_COMMENTS:7', `${w5.out}${newer}`)
  const op = { ...later, comments: [...later.comments, comment('[reviewer] LGTM', T('2026-01-01T12:12:00Z')), comment('one more thing before I merge', T('2026-01-01T12:20:00Z'))] }
  const opRun = run(ctx, 'pr-watch.mjs', watchArgs(), op)
  check('seen: an operator comment after the [reviewer] post → REVIEW_COMMENTS:7', opRun.trim() === 'REVIEW_COMMENTS:7', opRun)
  const inlineNew = { ...op, inline: [...op.inline, { id: 9001, body: '[executor] renamed it', created_at: T('2026-01-01T12:12:00Z'), in_reply_to_id: 9000, user: user('acme') }] }
  const tieRun = run(ctx, 'pr-watch.mjs', watchArgs(), inlineNew)
  check('seen: an inline [executor] comment at the same second as the [reviewer] post counts as news', tieRun.trim() === 'REVIEW_COMMENTS:7', tieRun)
  rmSync(ctx.home, { recursive: true, force: true })
}
// Only [executor] comments are covered: an operator (or [qa]) comment that lands between the
// reviewer's re-read and its post is older than the post but was never read, so it stays news.
{
  const ctx = makeEnv()
  run(ctx, 'pr-watch.mjs', watchArgs(), watchReviewed)
  run(ctx, 'pr-watch.mjs', watchArgs(), watchReviewed)
  const raced = {
    ...watchReviewed,
    comments: [...watchReviewed.comments, comment('hold off, I want to rename this first', T('2026-01-01T12:30:00Z')), comment('[reviewer] LGTM — recheck', T('2026-01-01T12:30:04Z'))],
  }
  setFixture(ctx, raced)
  const w = await start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '5')).done
  const out = run(ctx, 'pr-watch.mjs', watchArgs(), raced)
  check('seen: an unseen operator comment older than the [reviewer] post → PENDING, then REVIEW_COMMENTS:7', w.out === 'PENDING\n' && out.trim() === 'REVIEW_COMMENTS:7', `${w.out}${out}`)
  const inlineRaced = { ...raced, inline: [{ id: 9099, body: '[executor] kept the constant', created_at: T('2026-01-01T12:00:20Z'), user: user('acme') }, { id: 9100, body: 'why this constant?', created_at: T('2026-01-01T12:00:30Z'), in_reply_to_id: 9099, user: user('acme') }] }
  const inlineOut = run(ctx, 'pr-watch.mjs', watchArgs(), inlineRaced)
  check('seen: an unseen inline operator comment older than the [reviewer] post → REVIEW_COMMENTS:7', inlineOut.trim() === 'REVIEW_COMMENTS:7', inlineOut)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const fx = { ...BASE, prs: [{ number: 7, headRefOid: 'abc123', mergeable: 'MERGEABLE' }] }
  run(ctx, 'pr-qa.mjs', ['--repo', REPO], fx)
  const answered = { ...fx, comments: [comment('verified by hand on my Mac', T('2026-01-01T12:00:05Z')), comment('[qa] PASS\n\n| a | b |', T('2026-01-01T12:00:40Z'))] }
  setFixture(ctx, answered)
  const w = await start(ctx, 'pr-qa.mjs', ['--repo', REPO, '--wait', '1', '--max', '5']).done
  const out = run(ctx, 'pr-qa.mjs', ['--repo', REPO], answered)
  check('qa: an unseen operator comment older than the [qa] post still counts → PENDING, then QA_READY:7', w.out === 'PENDING\n' && out.trim() === 'QA_READY:7', `${w.out}${out}`)
  rmSync(ctx.home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- several reviewers (#35)
// Reviewers share HOME (one machine), each with --reviewer <clone>. Times are relative to now: a claim
// goes stale after --stale-after (default 1800s) without a reviewer post.
const ago = (min) => new Date(Date.now() - min * 60000).toISOString()
const claimBy = (clone, at) => comment(`[reviewer] Reviewing (${clone})`, at)
const rw = (ctx, clone, fixture, extra = []) => run(ctx, 'pr-watch.mjs', ['--repo', REPO, '--reviewer', clone, ...extra], fixture)
const checkClaim = (ctx, clone, fixture, extra = []) => rw(ctx, clone, fixture, ['--check-claim', '7', ...extra]).trim()
const multiFx = (comments, commits = [commit(ago(20))], sha = 'abc123') => ({
  ...BASE,
  prs: [{ number: 7, headRefOid: sha, mergeable: 'MERGEABLE' }],
  prView: { reviewDecision: '' },
  commits,
  comments,
})
{
  const ctx = makeEnv()
  const fresh = multiFx([])
  const a0 = rw(ctx, 'rev-a', fresh)
  const b0 = rw(ctx, 'rev-b', fresh)
  check('reviewers: a new unclaimed PR is visible to both → REVIEW:7 each', a0.trim() === 'REVIEW:7' && b0.trim() === 'REVIEW:7', `${a0}${b0}`)
  check('reviewers: --check-claim on an unclaimed PR → OPEN', checkClaim(ctx, 'rev-a', fresh) === 'OPEN', checkClaim(ctx, 'rev-a', fresh))
  const claimA = claimBy('rev-a', ago(0.2))
  const claimB = claimBy('rev-b', ago(0.1))
  const raced = multiFx([claimA, claimB])
  const beforeA = stateText(ctx, 'acme-widgets-pr-state-rev-a.json')
  const beforeWait = stateText(ctx, 'acme-widgets-pr-state-rev-a-wait.json')
  const ca = checkClaim(ctx, 'rev-a', raced)
  const cb = checkClaim(ctx, 'rev-b', raced)
  check('reviewers: both claim at once → the earlier claim wins (MINE / THEIRS rev-a)', ca === 'MINE' && cb === 'THEIRS rev-a', `${ca} | ${cb}`)
  check('reviewers: --check-claim writes no state and no baseline', stateText(ctx, 'acme-widgets-pr-state-rev-a.json') === beforeA && stateText(ctx, 'acme-widgets-pr-state-rev-a-wait.json') === beforeWait, '')
  const bLost = rw(ctx, 'rev-b', raced)
  const held = multiFx([claimA])
  const a1 = rw(ctx, 'rev-a', held)
  const b1 = rw(ctx, 'rev-b', held)
  check('reviewers: exactly one reviews it — the holder keeps REVIEW:7 (a claim is not a post), the other gets NONE', a1.trim() === 'REVIEW:7' && signals(bLost).join() === 'NONE' && signals(b1).join() === 'NONE', `${a1}${bLost}${b1}`)
  check('reviewers: state is per reviewer, and the other reviewer drops the PR', stateText(ctx, WATCH_STATE) === null && !('7' in JSON.parse(stateText(ctx, 'acme-widgets-pr-state-rev-b.json'))), stateText(ctx, 'acme-widgets-pr-state-rev-b.json'))
  setFixture(ctx, held)
  const bw = await start(ctx, 'pr-watch.mjs', ['--repo', REPO, '--reviewer', 'rev-b', '--wait', '1', '--max', '2']).done
  check('reviewers: the other reviewer\'s waiter stays quiet while the PR is held', signals(bw.out).join() === 'NONE', `${bw.out}${bw.err}`)
  // A recheck stays with the claimant.
  const reviewed = multiFx([claimA, comment('[reviewer] 1. empty input crashes', ago(0.05))])
  const a2 = rw(ctx, 'rev-a', reviewed)
  const pushed = multiFx([...reviewed.comments, comment('[executor] Pushed fix: guard empty input', ago(0.01))], [commit(ago(20)), commit(ago(0.02))], 'def456')
  const a3 = rw(ctx, 'rev-a', pushed)
  const b3 = rw(ctx, 'rev-b', pushed)
  check('reviewers: after a fix push the recheck goes to the claimant (REVIEW:7) and not the other (NONE)', signals(a2).join() === 'NONE' && a3.trim() === 'REVIEW:7' && signals(b3).join() === 'NONE', `${a2}${a3}${b3}`)
  check('reviewers: … and the other reviewer never reports CLOSED for it', signals(rw(ctx, 'rev-b', { ...pushed, prs: [] })).join() === 'NONE', '')
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  // A stale claim is taken over: rev-a claimed and reviewed, the executor pushed 90 minutes ago, and
  // no reviewer has posted since.
  const ctx = makeEnv()
  const claimA = claimBy('rev-a', ago(180))
  const history = [claimA, comment('[reviewer] 1. empty input crashes', ago(170)), comment('[executor] Pushed fix', ago(89))]
  const commits = [commit(ago(200)), commit(ago(90))]
  const stale = multiFx(history, commits, 'def456')
  const ca = checkClaim(ctx, 'rev-a', stale)
  const b0 = rw(ctx, 'rev-b', stale)
  check('takeover: a holder silent for 30 minutes after a push holds nothing → OPEN, and the other reviewer gets REVIEW:7', ca === 'OPEN' && b0.trim() === 'REVIEW:7', `${ca}\n${b0}`)
  const taken = multiFx([...history, claimBy('rev-b', ago(0.1))], commits, 'def456')
  const cb = checkClaim(ctx, 'rev-b', taken)
  const ca2 = checkClaim(ctx, 'rev-a', taken)
  const a1 = rw(ctx, 'rev-a', taken)
  check('takeover: the new claim holds (MINE for rev-b, THEIRS rev-b for rev-a) and rev-a gets NONE', cb === 'MINE' && ca2 === 'THEIRS rev-b' && signals(a1).join() === 'NONE', `${cb} | ${ca2} | ${a1}`)
  const after = multiFx([...taken.comments, comment('[reviewer] LGTM — recheck of def456', ago(0.05))], commits, 'def456')
  check('takeover: after rev-b reviews, rev-a\'s old claim stays dead', checkClaim(ctx, 'rev-a', after) === 'THEIRS rev-b' && checkClaim(ctx, 'rev-b', after) === 'MINE', checkClaim(ctx, 'rev-a', after))
  const again = multiFx([...after.comments, claimBy('rev-b', ago(0.01))], commits, 'def456')
  check('takeover: a re-claim by the holder keeps it', checkClaim(ctx, 'rev-b', again) === 'MINE', checkClaim(ctx, 'rev-b', again))
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  // A waiter wakes when the holder's claim goes stale, with no state change (--stale-after 3).
  const ctx = makeEnv()
  const fx = multiFx([claimBy('rev-a', new Date().toISOString())], [commit(ago(20))])
  const b0 = rw(ctx, 'rev-b', fx, ['--stale-after', '3'])
  setFixture(ctx, fx)
  const w = await start(ctx, 'pr-watch.mjs', ['--repo', REPO, '--reviewer', 'rev-b', '--stale-after', '3', '--wait', '1', '--max', '15']).done
  check('takeover: the other reviewer\'s waiter returns PENDING once the claim goes stale', signals(b0).join() === 'NONE' && w.out === 'PENDING\n' && w.ms < 10000, `${b0}${w.ms}ms ${w.out}${w.err}`)
  const bad = run(ctx, 'pr-watch.mjs', ['--repo', REPO, '--check-claim', '7'], fx)
  const badName = run(ctx, 'pr-watch.mjs', ['--repo', REPO, '--reviewer', '../x'], fx)
  check('reviewers: --check-claim without --reviewer, or a bad clone name → usage error, exit 1', bad.startsWith('EXIT 1') && badName.startsWith('EXIT 1'), `${bad}${badName}`)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  // The executor's poll ignores claim comments: a claim after an LGTM is not a finding.
  const ctx = makeEnv()
  poll(ctx, BASE)
  const fx = { ...BASE, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z')), comment('[reviewer] Reviewing (rev-b)', T('2026-01-01T12:05:00Z'))] }
  const first = poll(ctx, fx)
  const second = poll(ctx, fx)
  check('poll: a [reviewer] Reviewing claim after an LGTM leaves MERGE_READY and is never surfaced', signals(first).includes('MERGE_READY') && !first.includes('Reviewing') && second.trim() === 'MERGE_READY', `${first}---\n${second}`)
  rmSync(ctx.home, { recursive: true, force: true })
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
