#!/usr/bin/env node
// Contract tests for the signal scripts, run against a fake `gh` (fake-gh.mjs).
//   node scripts/test/run.mjs
// No dependencies. Each case gets a fresh HOME (so state files start empty) and a fixture.
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
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
  const verified = { ...BASE, comments: [comment('[reviewer] Verified abc123 against #4: criteria covered. Awaiting operator confirmation of: the real-model check.', T('2026-01-01T12:00:00Z'))] }
  const first = poll(ctx, verified)
  check('poll: [reviewer] Verified (awaiting operator) is not a live blocker', !first.includes('Awaiting operator'), first)
  const out = poll(ctx, verified)
  check('poll: [reviewer] Verified does not count as LGTM → no MERGE_READY', !signals(out).includes('MERGE_READY'), out)
  const confirmed = { ...verified, comments: [...verified.comments, comment('ran it, both models load', T('2026-01-01T13:00:00Z')), comment('[reviewer] LGTM — operator confirmed the real-model check.', T('2026-01-01T13:05:00Z'))] }
  const out2 = poll(ctx, confirmed)
  check('poll: Verified → operator confirms → LGTM → MERGE_READY', signals(out2).includes('MERGE_READY'), out2)
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

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
