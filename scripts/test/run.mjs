#!/usr/bin/env node
// Contract tests for the signal scripts, run against a fake `gh` (fake-gh.mjs).
//   node scripts/test/run.mjs
// No dependencies. Each case gets a fresh HOME (so state files start empty) and a fixture.
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, readFileSync, renameSync, readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { execFileSync, spawn, spawnSync } from 'child_process'
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
  // --require-gate: with no CI the reviewer's LGTM must quote the gate on the head; with CI, CI is the gate.
  const ctx = makeEnv()
  const head = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
  const lgtm = (extra) => comment(`[reviewer] LGTM — a1b2c3d against #3, no CI.${extra}`, T('2026-01-01T12:00:00Z'))
  const noCi = (body, more = {}) => ({ ...BASE, pr: { merged: false, head: { sha: head } }, checks: null, comments: [lgtm(body)], ...more })
  const gate = ['--require-gate']
  const quoted = '\n\nGate on a1b2c3d: `just gate` → ci: check, e2e, mac and fragment passed on a1b2c3d; the tree was clean'
  const ready = (out) => signals(out).includes('MERGE_READY')
  check('poll --require-gate: no CI, LGTM without a gate line → no MERGE_READY', !ready(poll(ctx, noCi(''), gate)))
  check('poll --require-gate: no CI, LGTM quoting the gate on the head → MERGE_READY', ready(poll(ctx, noCi(quoted), gate)))
  check('poll --require-gate: … the full sha, in bold, also counts',
    ready(poll(ctx, noCi(`\n\n**Gate on ${head}:** passed`), gate)))
  check('poll --require-gate: … a line wrapped in backticks, or a list item, also counts',
    ready(poll(ctx, noCi('\n\n`Gate on a1b2c3d: ok`'), gate)) && ready(poll(ctx, noCi('\n\n- Gate on a1b2c3d: ok'), gate)))
  check('poll --require-gate: "Gate on" inside a sentence → no MERGE_READY',
    !ready(poll(ctx, noCi('\n\nI ran it. Gate on a1b2c3d: ok'), gate)))
  check('poll --require-gate: no CI, the gate quoted on another commit → no MERGE_READY',
    !ready(poll(ctx, noCi('\n\nGate on 9f8e7d6: passed'), gate)))
  check('poll --require-gate: a gate line in an older comment, not the LGTM → no MERGE_READY',
    !ready(poll(ctx, noCi('', { comments: [comment(`[reviewer] Review of a1b2c3d.${quoted}\n\n1. fix x`, T('2026-01-01T11:00:00Z')), lgtm('')] }), gate)))
  check('poll --require-gate: every check skipped counts as no CI → quote needed',
    !ready(poll(ctx, noCi('', { checks: [{ name: 'check', state: 'SKIPPED', bucket: 'skipping' }] }), gate)) &&
    ready(poll(ctx, noCi(quoted, { checks: [{ name: 'check', state: 'SKIPPED', bucket: 'skipping' }] }), gate)))
  check('poll --require-gate: CI checks present and green → MERGE_READY without a quote',
    ready(poll(ctx, noCi('', { checks: BASE.checks }), gate)))
  check('poll --require-gate: no CI, gate quoted, but in conflict → no MERGE_READY',
    !ready(poll(ctx, noCi(quoted, { pr: { merged: false, head: { sha: head }, mergeable: false, mergeable_state: 'dirty' } }), gate)))
  check('poll without --require-gate: no CI, LGTM → MERGE_READY as before', ready(poll(ctx, noCi(''))))
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
  // A commit status (local-ci.mjs) comes from gh pr checks with the zero time as completedAt; its REST
  // status id tells one run from the next.
  const ctx = makeEnv()
  const zero = '0001-01-01T00:00:00Z'
  const fx = (bucket, id) => ({
    ...BASE,
    checks: [{ name: 'local-ci', state: bucket === 'fail' ? 'FAILURE' : 'PENDING', bucket, link: '', completedAt: zero }],
    statuses: { abc123: [{ id, context: 'local-ci', state: bucket === 'fail' ? 'failure' : 'pending' }] },
  })
  const first = poll(ctx, fx('fail', 1))
  const same = poll(ctx, fx('fail', 1))
  const rerunning = poll(ctx, fx('pending', 2))
  const again = poll(ctx, fx('fail', 3))
  check('poll: a commit status that fails, is re-run (pending) and fails again on the same head → CI_FAILING twice',
    signals(first).includes('CI_FAILING') && !signals(same).includes('CI_FAILING') && !signals(rerunning).includes('CI_FAILING') && signals(again).includes('CI_FAILING'),
    `${first}---\n${same}---\n${rerunning}---\n${again}`)
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
  check('pick: "_Depends on_ #7" (italic) is read',
    pick({ issues: [issue(7, { milestone: M4 }), issue(10, { body: '_Depends on_ #7' })], milestones, prs: [] }, ms) === 'WAIT:7 PR:none')
  check('pick: "_Depends on:_ #5, #7" and "__Depends on__ #7" are read',
    pick({ issues: [issue(5, { state: 'CLOSED' }), issue(7, { milestone: M4 }), issue(10, { body: '_Depends on:_ #5, #7' })], milestones, prs: [] }, ms) === 'WAIT:7 PR:none' &&
    pick({ issues: [issue(7, { milestone: M4 }), issue(10, { body: '__Depends on__ #7' })], milestones, prs: [] }, ms) === 'WAIT:7 PR:none')
  check('pick: "independs on #7" is not a dependency',
    pick({ issues: [issue(7, { milestone: M4 }), issue(10, { body: 'independs on #7' })] }, ms) === 'ISSUE:10')
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

  // A parked issue's open PR comes back to the executor that held it (#78).
  const claim = (clone, id) => ({ id, body: `[executor] Claimed by ${clone}`, created_at: '2026-01-01T10:00:00Z', user: user('acme') })
  const parked = (over = {}) => ({
    issues: [issue(11), issue(20, { milestone: M4 }), ...(over.issues ?? [])],
    prs: [{ number: 49, body: 'Closes #200', author: user('acme') }, { number: 50, body: 'Fix.\n\nCloses #20', isCrossRepository: false, author: user('acme') }],
    issueComments: { 20: [claim('exec-b', 1), claim('exec-a', 2), { id: 3, body: '[executor] BLOCKED: needs a call', created_at: '2026-01-01T11:00:00Z', user: user('acme') }] },
    milestones,
    ...over,
  })
  const asA = ['--clone', 'exec-a']
  check('pick --clone: an unblocked issue with an open PR, last claimed by this clone → RESUME:<n> PR:<p>, before a lower startable issue',
    pick(parked(), asA) === 'RESUME:20 PR:50')
  check('pick --clone: … whatever the milestone', pick(parked(), [...asA, ...ms]) === 'RESUME:20 PR:50')
  check('pick --clone: the newest claim names another clone → no RESUME (ISSUE as before)', pick(parked(), ['--clone', 'exec-b']) === 'ISSUE:11')
  check('pick --clone: a clone name that only starts the same ("exec-a2") → no RESUME',
    pick(parked({ issueComments: { 20: [claim('exec-a2', 5)] } }), asA) === 'ISSUE:11')
  check('pick --clone: still blocked → no RESUME',
    pick(parked({ issues: [issue(11), issue(20, { labels: label('is-blocked') })] }), asA) === 'ISSUE:11')
  check('pick --clone: claimed again (in-progress) → no RESUME',
    pick(parked({ issues: [issue(11), issue(20, { labels: label('in-progress') })] }), asA) === 'ISSUE:11')
  check('pick --clone: the issue closed → no RESUME',
    pick(parked({ issues: [issue(11), issue(20, { state: 'CLOSED' })] }), asA) === 'ISSUE:11')
  check('pick --clone: skipped → no RESUME', pick(parked(), [...asA, '--skip', '20']) === 'ISSUE:11')
  check('pick --clone: a fork\'s PR that says "Closes #20" → no RESUME',
    pick(parked({ prs: [{ number: 50, body: 'Closes #20', isCrossRepository: true, author: user('acme') }] }), asA) === 'ISSUE:11')
  check('pick --clone: a newer claim naming this clone, posted by someone other than the PR\'s author, does not count → no RESUME',
    pick(parked({ issueComments: { 20: [claim('exec-b', 1), { ...claim('exec-a', 2), user: user('stranger') }] } }), asA) === 'ISSUE:11')
  check('pick --clone: no claim comment at all → no RESUME', pick(parked({ issueComments: { 20: [] } }), asA) === 'ISSUE:11')
  check('pick: without --clone nothing changes → ISSUE:11', pick(parked()) === 'ISSUE:11')
  check('pick --clone: … the open PR saying "Closes #200" (no such issue) is passed over, not a failure, and #200 is not #20',
    pick(parked({ issueComments: { 20: [claim('exec-b', 1)] } }), asA) === 'ISSUE:11')
  const badClone = run(ctx, 'pick-next.mjs', ['--repo', REPO, '--clone', '../x'], { issues: [] })
  check('pick: a --clone that is not a clone name → usage error, exit 1', /^EXIT 1/.test(badClone), badClone)
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

// ---------------------------------------------------------------- idle count, --idle-after (#75)
const idleOf = (out) => /^IDLE (\d+)$/m.exec(out)?.[1] ?? null
{
  const ctx = makeEnv()
  const watch = (fx) => run(ctx, 'pr-watch.mjs', watchArgs('--idle-after', '3'), fx)
  const seen = [watch(watchReviewed), watch(watchReviewed), watch(watchReviewed)]
  check('idle (watch): the first run (REVIEW:7) and the next two empty ones print no IDLE', seen[0] === 'REVIEW:7\n' && seen.every((o) => idleOf(o) === null), seen.join(''))
  const third = watch(watchReviewed)
  check('idle (watch): the third empty run in a row → NONE, then IDLE 3 on its own last line', /^NONE \S+\nIDLE 3\n$/.test(third), third)
  const later = { ...watchReviewed, comments: [...watchReviewed.comments, comment('one more thing', T('2026-01-01T12:30:00Z'))] }
  const news = watch(later)
  check('idle (watch): the next signal resets the count → REVIEW_COMMENTS:7, no IDLE', news === 'REVIEW_COMMENTS:7\n', news)
  const after = watch(later)
  check('idle (watch): … and the empty run after it does not idle (count 1)', idleOf(after) === null && signals(after).join() === 'NONE', after)
  check('idle (watch): the sidecar holds the count', JSON.parse(stateText(ctx, 'acme-widgets-pr-state-wait.json')).idle === 1, stateText(ctx, 'acme-widgets-pr-state-wait.json'))
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const watch = (fx) => run(ctx, 'pr-watch.mjs', watchArgs('--idle-after', '3'), fx)
  const outs = [watch(watchFx), watch(watchFx), watch(watchFx), watch(watchFx)]
  check('idle (watch): a standing REVIEW:7 (waiting for [qa] PASS) counts as nothing new → REVIEW:7 then IDLE 3 on the fourth run',
    outs.every((o) => o.startsWith('REVIEW:7\n')) && outs.slice(0, 3).every((o) => idleOf(o) === null) && idleOf(outs[3]) === '3', outs.join('|'))
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const lgtm = { ...BASE, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))], prView: { reviewDecision: '' }, prs: [{ number: 7, headRefOid: 'abc123', mergeable: 'MERGEABLE', labels: [{ name: 'needs-operator' }] }] }
  const conflicting = { ...lgtm, prs: [{ ...lgtm.prs[0], mergeable: 'CONFLICTING' }] }
  const watch = (fx) => run(ctx, 'pr-watch.mjs', watchArgs('--idle-after', '3'), fx)
  watch(lgtm)
  watch(lgtm)
  const outs = [watch(conflicting), watch(conflicting), watch(conflicting), watch(conflicting)]
  check('idle (watch): a standing MERGE_CONFLICT the reviewer already handled counts as nothing new → IDLE 3 on its third repeat',
    outs.every((o) => o.startsWith('MERGE_CONFLICT:7\n')) && outs.slice(0, 3).every((o) => idleOf(o) === null) && idleOf(outs[3]) === '3', outs.join('|'))
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const outs = [1, 2, 3, 4, 5].map(() => run(ctx, 'pr-watch.mjs', watchArgs(), watchReviewed))
  check('idle (watch): without --idle-after the output never carries IDLE', outs.every((o) => idleOf(o) === null) && outs.slice(1).every((o) => signals(o).join() === 'NONE'), outs.join(''))
  const withFlag = run(ctx, 'pr-watch.mjs', watchArgs('--idle-after', '3'), watchReviewed)
  check('idle (watch): … the count still ran, so adding the flag later idles at once', idleOf(withFlag) === '5', withFlag)
  for (const bad of ['0', 'x', '1.5', '-2']) {
    const r = run(ctx, 'pr-watch.mjs', watchArgs('--idle-after', bad), watchReviewed)
    check(`idle: --idle-after ${bad} → usage error, exit 1`, r.startsWith('EXIT 1') && r.includes('--idle-after'), r)
  }
  const missing = run(ctx, 'pr-watch.mjs', watchArgs('--idle-after'), watchReviewed)
  check('idle: --idle-after with no value → usage error, exit 1', missing.startsWith('EXIT 1'), missing)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  // The IDLE line is printed only: the baseline it records must still match the waiter's dry pass.
  const ctx = makeEnv()
  for (let i = 0; i < 4; i++) run(ctx, 'pr-watch.mjs', watchArgs('--idle-after', '3'), watchReviewed)
  const sidecar = stateText(ctx, 'acme-widgets-pr-state-wait.json')
  setFixture(ctx, watchReviewed)
  const r = await start(ctx, 'pr-watch.mjs', watchArgs('--idle-after', '3', '--wait', '1', '--max', '2')).done
  check('idle (wait): after an IDLE run the waiter is not woken by it → NONE at --max (and takes --idle-after silently)', r.out.startsWith('NONE ') && idleOf(r.out) === null && r.ms >= 2000 && r.code === 0, `${r.ms}ms code ${r.code}\n${r.out}${r.err}`)
  check('idle (wait): the waiter leaves the count alone', stateText(ctx, 'acme-widgets-pr-state-wait.json') === sidecar, `${sidecar}\n${stateText(ctx, 'acme-widgets-pr-state-wait.json')}`)
  const next = run(ctx, 'pr-watch.mjs', watchArgs('--idle-after', '3'), watchReviewed)
  check('idle (wait): … so the one-shot run after it counts on from 3 → IDLE 4', idleOf(next) === '4', next)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  // A standing signal is compared by the waiter (NONE never is): an IDLE line in the baseline would wake it at once.
  const ctx = makeEnv()
  for (let i = 0; i < 4; i++) run(ctx, 'pr-watch.mjs', watchArgs('--idle-after', '3'), watchFx)
  setFixture(ctx, watchFx)
  const r = await start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '2')).done
  check('idle (wait): after REVIEW:7 + IDLE 3, a waiter on the standing REVIEW:7 is not woken → NONE at --max', r.out.startsWith('NONE ') && r.ms >= 2000, `${r.ms}ms\n${r.out}${r.err}`)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const fx = { ...BASE, prs: [{ number: 7, headRefOid: 'abc123', mergeable: 'MERGEABLE' }] }
  const qa = (f) => run(ctx, 'pr-qa.mjs', ['--repo', REPO, '--idle-after', '3'], f)
  const outs = [qa(fx), qa(fx), qa(fx), qa(fx)]
  check('idle (qa): QA_READY, then three empty runs → IDLE 3 on the third', outs[0] === 'QA_READY:7\n' && idleOf(outs[2]) === null && /^NONE \S+\nIDLE 3\n$/.test(outs[3]), outs.join('|'))
  const op = qa({ ...fx, comments: [comment('verified by hand', T('2026-01-01T12:00:00Z'))] })
  check('idle (qa): an operator comment resets it → QA_READY:7, no IDLE', op === 'QA_READY:7\n', op)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const pollIdle = (fx) => poll(ctx, fx, ['--idle-after', '3'])
  const pending = { ...BASE, checks: [{ name: 'check', state: 'IN_PROGRESS', bucket: 'pending' }] }
  const outs = [pollIdle(pending), pollIdle(pending), pollIdle(pending), pollIdle(pending)]
  check('idle (poll): three empty polls → IDLE 3 on the third', idleOf(outs[2]) === null && /^NONE \S+\nIDLE 3\n$/.test(outs[3]), outs.join('|'))
  const green = pollIdle(BASE)
  check('idle (poll): CI changing (pending → pass, no LGTM, output still NONE) resets the count', signals(green).join() === 'NONE' && idleOf(green) === null, green)
  pollIdle(BASE)
  pollIdle(BASE)
  const third = pollIdle(BASE)
  check('idle (poll): … and three empty polls on the new CI state idle again', idleOf(third) === '3', third)
  const own = { ...BASE, comments: [comment('[executor] Pushed fix: x', T('2026-01-01T11:00:00Z'))] }
  const ownOut = pollIdle(own)
  check('idle (poll): a new comment that changes the state but not the output (own [executor] post → NONE) resets the count', signals(ownOut).join() === 'NONE' && idleOf(ownOut) === null, ownOut)
  const pushed = { ...BASE, pr: { merged: false, head: { sha: 'def456' } } }
  const push = pollIdle(pushed)
  check('idle (poll): a new head commit (output still NONE) resets the count', signals(push).join() === 'NONE' && idleOf(push) === null, push)
  const lgtm = { ...pushed, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))] }
  const ready = [pollIdle(lgtm), pollIdle(lgtm), pollIdle(lgtm), pollIdle(lgtm)]
  check('idle (poll): a standing MERGE_READY counts as nothing new → MERGE_READY then IDLE 3 on its third repeat',
    ready.every((o) => signals(o).includes('MERGE_READY')) && ready.slice(0, 3).every((o) => idleOf(o) === null) && idleOf(ready[3]) === '3', ready.join('|'))
  const unreadable = pollIdle({ ...lgtm, checks: 'error' })
  check('idle (poll): CI that cannot be read is a CI change, not quiet', idleOf(unreadable) === null, unreadable)
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

// ---------------------------------------------------------------- local-ci.mjs
{
  // A real git origin (a bare repo with refs/pull/<n>/head) and the runner's own clone; gh is faked,
  // and the fake writes posted statuses back into the fixture. The gate is the repository's gate.sh,
  // so each pull request's head carries its own: it records start and end lines and the checked-out
  // sha in $TRACE.
  const ctx = makeEnv()
  const trace = path.join(ctx.home, 'trace')
  const env = {
    ...ctx.env,
    TRACE: trace,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  }
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const origin = path.join(ctx.home, 'acme', 'widgets.git')
  const seed = path.join(ctx.home, 'seed')
  const runner = path.join(ctx.home, 'runner')
  g(ctx.home, 'init', '-q', '--bare', origin)
  g(ctx.home, 'init', '-q', seed)
  const GATE_SH = [
    'echo "start $(cat pr.txt) $(git rev-parse HEAD)" >> "$TRACE"',
    'sleep 0.3',
    'echo "end $(cat pr.txt)" >> "$TRACE"',
    'if [ "$(cat pr.txt)" = fail ]; then echo "lint ok"; echo "2 tests failed"; exit 1; fi',
    "printf '\\033[32mall 3 passed\\033[0m\\n\\n'",
  ].join('\n')
  const commitFiles = (files) => {
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(seed, name), text)
    g(seed, 'add', '-A')
    g(seed, 'commit', '-q', '-m', 'c')
    return g(seed, 'rev-parse', 'HEAD')
  }
  const agentsMd = (authors) => `# Project\n\n## Agent loop\nrepo: ${REPO}\ntrusted-authors: ${authors}\n\n## Other\ntrusted-authors: [nobody]\n`
  const mainSha = commitFiles({ 'AGENTS.md': agentsMd('[alice, "@bob"]'), 'pr.txt': 'main\n', 'gate.sh': GATE_SH })
  g(seed, 'push', '-q', origin, 'HEAD:refs/heads/main')
  g(ctx.home, '--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  const makePr = (n, files) => {
    g(seed, 'checkout', '-q', '--detach', mainSha)
    const sha = commitFiles(typeof files === 'string' ? { 'pr.txt': `${files}\n` } : files)
    g(seed, 'push', '-q', '--force', origin, `HEAD:refs/pull/${n}/head`)
    return sha
  }
  g(ctx.home, 'clone', '-q', origin, runner)
  const pr = (number, headRefOid, login = 'alice', isCrossRepository = false) => ({ number, headRefOid, author: { login }, isCrossRepository })
  const lci = (fixture, extra = [], cwd = runner) => {
    if (fixture) setFixture(ctx, fixture)
    try {
      return execFileSync('node', [path.join(scripts, 'local-ci.mjs'), '--repo', REPO, '--gate', 'sh gate.sh', ...extra], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return `EXIT ${e.status}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`
    }
  }
  const statuses = () => JSON.parse(readFileSync(ctx.fixture, 'utf8')).statuses ?? {}
  const traceText = () => {
    try {
      return readFileSync(trace, 'utf8')
    } catch {
      return ''
    }
  }
  const states = (sha) => (statuses()[sha] ?? []).map((s) => s.state).join()
  const logDir = path.join(ctx.home, '.agent-loop', 'local-ci', 'acme-widgets')

  const s1 = makePr(1, '1')
  const s3 = makePr(3, '3')
  const s4 = makePr(4, '4')
  const fx1 = { prs: [pr(1, s1), pr(3, s3, 'alice', true), pr(4, s4, 'mallory')], statuses: {} }
  const out1 = lci(fx1)
  const st1 = statuses()[s1] ?? []
  check('local-ci: a new head → pending, then success with the gate\'s last line (colour codes removed)',
    states(s1) === 'pending,success' && st1[1].description === 'all 3 passed' && st1.every((s) => s.context === 'local-ci') &&
    out1.trim() === `#1 ${s1.slice(0, 7)} success: all 3 passed`, `${out1}${JSON.stringify(st1)}`)
  check('local-ci: … the gate ran on the head, checked out detached in the runner\'s clone',
    traceText().includes(`start 1 ${s1}`) && g(runner, 'rev-parse', 'HEAD') === s1 && g(runner, 'status', '--porcelain', '--branch').startsWith('## HEAD (no branch)'), traceText())
  const logs = readdirSync(logDir)
  check('local-ci: … its output went to a log file per run, and the status names none (no --log-url)',
    logs.length === 1 && logs[0].startsWith(`1-${s1.slice(0, 12)}-`) && readFileSync(path.join(logDir, logs[0]), 'utf8').includes('all 3 passed') &&
    st1.every((s) => !('target_url' in s)), `${logs} ${JSON.stringify(st1)}`)
  check('local-ci: a fork\'s head and an untrusted author\'s head get no status and no run',
    !(s3 in statuses()) && !(s4 in statuses()) && !/start [34] /.test(traceText()), JSON.stringify(statuses()))
  const before = traceText()
  const out2 = lci(null)
  check('local-ci: a head already done is skipped → NONE, no post, no run',
    /^NONE /.test(out2) && states(s1) === 'pending,success' && traceText() === before, out2)

  const s2 = makePr(2, 'fail')
  const out3 = lci({ prs: [pr(2, s2)], statuses: {} })
  check('local-ci: a failing gate → pending, then failure with its last line',
    states(s2) === 'pending,failure' && statuses()[s2][1].description === '2 tests failed' && out3.includes(`#2 ${s2.slice(0, 7)} failure: 2 tests failed`), `${out3}${JSON.stringify(statuses()[s2])}`)

  const s5 = makePr(5, '5')
  const stale = { [s5]: [{ state: 'success', context: 'other-ci' }, { state: 'pending', context: 'local-ci', description: 'queued: sh gate.sh' }] }
  const out4 = lci({ prs: [pr(5, s5)], statuses: stale })
  check('local-ci: a stale pending under its context is run again on start, with no second pending',
    statuses()[s5].map((s) => `${s.context}:${s.state}`).join() === 'other-ci:success,local-ci:pending,local-ci:success' && traceText().includes(`start 5 ${s5}`), `${out4}${JSON.stringify(statuses()[s5])}`)

  const s6 = makePr(6, '6')
  const s7 = makePr(7, '7')
  writeFileSync(ctx.log, '')
  writeFileSync(trace, '')
  lci({ prs: [pr(7, s7), pr(6, s6)], statuses: {} })
  const order = traceText().split('\n').filter(Boolean).map((l) => l.split(' ').slice(0, 2).join(' '))
  const posts = readFileSync(ctx.log, 'utf8').split('\n').filter((l) => l.includes('/statuses/')).map((l) => `${/statuses\/(\w{7})/.exec(l)[1] === s6.slice(0, 7) ? 6 : 7}:${/state=(\w+)/.exec(l)[1]}`)
  check('local-ci: two pull requests run one after the other, oldest first',
    order.join() === 'start 6,end 6,start 7,end 7', order.join())
  check('local-ci: … both heads show pending before the first gate starts (a queued head has CI too)',
    posts.join() === '6:pending,7:pending,6:success,7:success', posts.join())

  // Trusted authors come from AGENTS.md on the default branch, never from the checked-out head.
  const s8 = makePr(8, { 'pr.txt': '8\n', 'AGENTS.md': agentsMd('[alice, mallory]') })
  const s9 = makePr(9, '9')
  lci({ prs: [pr(8, s8)], statuses: {} })
  const out5 = lci({ prs: [pr(9, s9, 'mallory')], statuses: {} })
  check('local-ci: a pull request that adds its author to trusted-authors does not make them trusted',
    readFileSync(path.join(runner, 'AGENTS.md'), 'utf8').includes('mallory') && /^NONE /.test(out5) && !(s9 in statuses()), `${out5}${JSON.stringify(statuses())}`)
  const s10 = makePr(10, '10')
  lci({ prs: [pr(10, s10, 'bob')], statuses: {} })
  check('local-ci: … a quoted "@login" in the list counts', states(s10) === 'pending,success', JSON.stringify(statuses()))
  const out6 = lci({ prs: [pr(9, s9, 'mallory')], statuses: {} }, ['--trusted-authors', 'mallory'])
  check('local-ci: --trusted-authors replaces the block\'s list', states(s9) === 'pending,success', `${out6}${JSON.stringify(statuses())}`)

  const s11 = makePr(11, { 'pr.txt': '11\n', 'gate.sh': `node -e "console.log('é'.repeat(200))"\n` })
  lci({ prs: [pr(11, s11)], statuses: {} }, ['--log-url', 'https://ci.example/logs/'])
  const st11 = statuses()[s11] ?? []
  check('local-ci: the description is cut to 140 characters, and --log-url names the run\'s log',
    [...(st11[1]?.description ?? '')].length === 140 && st11[1].description.startsWith('é') &&
    new RegExp(`^https://ci\\.example/logs/11-${s11.slice(0, 12)}-[^/]+\\.log$`).test(st11[1].target_url) && !('target_url' in st11[0]),
    JSON.stringify(st11))

  // A head that cannot be fetched (no refs/pull/12/head on the origin) gets error, not a stuck pending.
  const out7 = lci({ prs: [pr(12, s1)], statuses: {} })
  check('local-ci: a head that cannot be checked out → error (never left pending)', states(s1) === 'pending,error' && out7.includes('error: could not check out'), `${out7}${JSON.stringify(statuses()[s1])}`)

  // A listed head that origin's pull/<n>/head does not match (the head moved, or it persists): skipped
  // this pass, said on stderr.
  const s15a = makePr(15, '15a')
  makePr(15, '15b')
  setFixture(ctx, { prs: [pr(15, s15a)], statuses: {} })
  const mis = spawnSync('node', [path.join(scripts, 'local-ci.mjs'), '--repo', REPO, '--gate', 'sh gate.sh'], { cwd: runner, env, encoding: 'utf8' })
  check('local-ci: a listed head origin does not have → skipped, with a stderr line naming both heads',
    mis.status === 0 && states(s15a) === 'pending' && new RegExp(`#15 is listed at ${s15a.slice(0, 7)} but origin's pull/15/head is [0-9a-f]{7}`).test(mis.stderr),
    `${mis.stdout}${mis.stderr}`)
  const otherClone = path.join(ctx.home, 'other-clone')
  g(ctx.home, 'clone', '-q', origin, otherClone)
  g(otherClone, 'remote', 'set-url', 'origin', 'https://github.com/acme/widgets-fork.git')
  const wrongOrigin = lci({ prs: [], statuses: {} }, [], otherClone)
  g(otherClone, 'remote', 'set-url', 'origin', 'git@github.com:Acme/Widgets.git')
  const sshOrigin = lci({ prs: [], statuses: {} }, ['--trusted-authors', 'alice'], otherClone)
  check('local-ci: a clone whose origin is not --repo → exit 1; an ssh origin naming it (any case) is fine',
    wrongOrigin.startsWith('EXIT 1') && /not acme\/widgets/.test(wrongOrigin) && /^NONE /.test(sshOrigin), `${wrongOrigin}${sshOrigin}`)

  const lockFile = path.join(ctx.home, '.agent-loop', 'state', 'acme-widgets-local-ci-local-ci.lock')
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started: 0 }))
  const held = lci({ prs: [], statuses: {} })
  rmSync(lockFile)
  check('local-ci: a second runner while one is alive → RUNNER_RUNNING <pid>, exit 3 (no expiry)', held.startsWith(`EXIT 3\nRUNNER_RUNNING ${process.pid}`), held)
  const agentClone = path.join(ctx.home, 'agent-clone')
  g(ctx.home, 'clone', '-q', origin, agentClone)
  mkdirSync(path.join(agentClone, '.agent-loop'))
  writeFileSync(path.join(agentClone, '.agent-loop', 'role'), 'executor\n')
  const inAgent = lci({ prs: [], statuses: {} }, [], agentClone)
  const inSub = lci(null, [], path.join(runner, '..'))
  const noTrust = lci(null, ['--trusted-authors', ''])
  const noGate = run(ctx, 'local-ci.mjs', ['--repo', REPO], { prs: [] })
  check('local-ci: refuses an agent\'s clone, a directory that is not a clone\'s root, no trusted authors, no --gate (exit 1)',
    inAgent.startsWith('EXIT 1') && /agent's/.test(inAgent) && inSub.startsWith('EXIT 1') && noTrust.startsWith('EXIT 1') && noGate.startsWith('EXIT 1'),
    `${inAgent}${inSub}${noTrust}${noGate}`)

  // --wait keeps going after a run; a stop also stops a running gate, whose head stays pending.
  const s13 = makePr(13, '13')
  const s14 = makePr(14, { 'pr.txt': '14\n', 'gate.sh': 'echo $$ > "$TRACE.pid"\nsleep 30\n' })
  setFixture(ctx, { prs: [pr(13, s13)], statuses: {} })
  const w = spawn('node', [path.join(scripts, 'local-ci.mjs'), '--repo', REPO, '--gate', 'sh gate.sh', '--wait', '1'], { cwd: runner, env })
  let wOut = ''
  w.stdout.on('data', (d) => (wOut += d))
  const waitFor = async (cond, ms = 15000) => {
    const t0 = Date.now()
    while (!cond() && Date.now() - t0 < ms) await pause(100)
    return cond()
  }
  const ran = await waitFor(() => states(s13) === 'pending,success')
  await pause(1500)
  check('local-ci --wait: runs a new head and keeps polling', ran && w.exitCode === null && wOut.includes(`#13 ${s13.slice(0, 7)} success`), wOut)
  const fx14 = { ...JSON.parse(readFileSync(ctx.fixture, 'utf8')), prs: [pr(13, s13), pr(14, s14)] }
  setFixture(ctx, fx14)
  const started = await waitFor(() => existsSync(`${trace}.pid`))
  const gatePid = started ? Number(readFileSync(`${trace}.pid`, 'utf8')) : 0
  w.kill('SIGTERM')
  await new Promise((r) => (w.exitCode !== null ? r() : w.on('close', r)))
  await pause(300)
  let gateAlive = false
  try {
    process.kill(gatePid, 0)
    gateAlive = true
  } catch {
    // gone
  }
  check('local-ci --wait: a stop stops the running gate and releases the lock; the head stays pending',
    started && !gateAlive && states(s14) === 'pending' && !existsSync(lockFile), `${started} ${gateAlive} ${states(s14)}`)
  rmSync(ctx.home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- pull.mjs
{
  // A real origin, a clone that plays the loop's (on main), and a seed clone that lands merges.
  const home = mkdtempSync(path.join(tmpdir(), 'agent-loop-pull-'))
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  }
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const origin = path.join(home, 'origin.git')
  const seed = path.join(home, 'seed')
  const loop = path.join(home, 'loop')
  g(home, 'init', '-q', '--bare', origin)
  g(home, 'clone', '-q', origin, seed)
  g(seed, 'checkout', '-q', '-b', 'main')
  const land = (files) => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(seed, name)), { recursive: true })
      writeFileSync(path.join(seed, name), text)
    }
    g(seed, 'add', '-A')
    g(seed, 'commit', '-q', '-m', 'merge')
    g(seed, 'push', '-q', 'origin', 'HEAD:main')
    return g(seed, 'rev-parse', 'HEAD')
  }
  const block = (rules) => `# P\n\n## Agent loop\nrepo: ${REPO}\n${rules ? `rules: ${rules}\n` : ''}\n## Conventions\nrules: not-this.md\n`
  land({ 'AGENTS.md': block(''), 'src/a.js': '1\n' })
  g(home, 'clone', '-q', '--branch', 'main', origin, loop)
  const pull = (...args) => spawnSync('node', [path.join(scripts, 'pull.mjs'), ...args], { cwd: loop, env, encoding: 'utf8' })

  const head0 = g(loop, 'rev-parse', 'HEAD')
  land({ 'src/a.js': '2\n' })
  const code = pull()
  check('pull: a pull that changes no rules file → nothing printed, exit 0, the clone is at the new head',
    code.status === 0 && code.stdout === '' && g(loop, 'rev-parse', 'HEAD') !== head0, `${code.status} ${code.stdout}${code.stderr}`)
  const idle = pull()
  check('pull: nothing new to pull → nothing printed', idle.status === 0 && idle.stdout === '', `${idle.stdout}${idle.stderr}`)

  const before = g(loop, 'rev-parse', 'HEAD')
  const after = land({ 'AGENTS.md': block('docs/a.md, ./docs/b.md'), 'src/a.js': '3\n' })
  const agents = pull()
  check('pull: AGENTS.md changed → RULES_CHANGED: AGENTS.md, and the diff command for exactly that range',
    agents.stdout === `RULES_CHANGED: AGENTS.md\n  git diff ${before.slice(0, 12)}..${after.slice(0, 12)} -- AGENTS.md\n`, agents.stdout)

  land({ 'docs/b.md': 'b\n', 'not-this.md': 'x\n', 'src/a.js': '4\n' })
  const one = pull()
  land({ 'docs/a.md': 'a\n', 'docs/b.md': 'b2\n' })
  const two = pull()
  check('pull: a rules key with two paths → each listed file that changed, and nothing outside the block\'s list',
    /^RULES_CHANGED: docs\/b\.md\n/.test(one.stdout) && /^RULES_CHANGED: docs\/a\.md docs\/b\.md\n {2}git diff \w+\.\.\w+ -- docs\/a\.md docs\/b\.md\n$/.test(two.stdout),
    `${one.stdout}---\n${two.stdout}`)
  land({ 'AGENTS.md': block('docs/'), 'docs/c.md': 'c\n' })
  const dir = pull()
  check('pull: a rules path ending in "/" covers the directory', /^RULES_CHANGED: AGENTS\.md docs\/c\.md\n/.test(dir.stdout), dir.stdout)

  land({ 'AGENTS.md': block("docs/my rules.md, docs/it's.md"), 'docs/my rules.md': 'a\n', "docs/it's.md": 'a\n' })
  pull()
  land({ 'docs/my rules.md': 'b\n', "docs/it's.md": 'b\n' })
  const spaced = pull()
  const cmd = spaced.stdout.split('\n')[1]?.trim() ?? ''
  const shown = cmd ? spawnSync('sh', ['-c', cmd], { cwd: loop, env, encoding: 'utf8' }).stdout : ''
  check('pull: a rules path with a space or a quote is one shell word in the diff command, which shows its change',
    spaced.stdout.startsWith("RULES_CHANGED: docs/my rules.md docs/it's.md\n") && cmd.endsWith(`-- 'docs/my rules.md' 'docs/it'\\''s.md'`) &&
    shown.includes('+++ b/docs/my rules.md') && shown.includes("+++ b/docs/it's.md"), `${spaced.stdout}---\n${shown}`)

  land({ 'src/a.js': '5\n' })
  const restart = pull('--start', '/agent-loop:start-executor', '--milestone', 'M3 "core" loop')
  const bare = pull('--start', '/agent-loop:start-executor')
  check('pull --start: the restart line reproduces the start, --milestone included, exactly',
    restart.stdout === 'RESTART: exit this session, start a new one in this clone, then run: /agent-loop:start-executor --milestone "M3 \\"core\\" loop"\n' &&
    bare.stdout === 'RESTART: exit this session, start a new one in this clone, then run: /agent-loop:start-executor\n',
    `${restart.stdout}${bare.stdout}`)

  writeFileSync(path.join(loop, 'local.txt'), 'x\n')
  g(loop, 'add', 'local.txt')
  g(loop, 'commit', '-q', '-m', 'local')
  land({ 'src/a.js': '6\n' })
  const diverged = pull()
  const lone = pull('--milestone', 'M3')
  const failedRestart = pull('--start', '/agent-loop:start-executor', '--milestone', 'M3')
  check('pull --start: a failed pull still prints the restart line (exit 2, the pull: line on stderr)',
    failedRestart.status === 2 && /^pull: (fatal|error): /.test(failedRestart.stderr) &&
    failedRestart.stdout === 'RESTART: exit this session, start a new one in this clone, then run: /agent-loop:start-executor --milestone "M3"\n',
    `${failedRestart.status} ${failedRestart.stdout}${failedRestart.stderr}`)
  check('pull: a diverged branch → exit 2, one pull: line, nothing on stdout; --milestone without --start → usage error',
    diverged.status === 2 && diverged.stdout === '' && /^pull: (fatal|error): /.test(diverged.stderr) && diverged.stderr.split('\n').filter(Boolean).length === 1 && lone.status === 1, `${diverged.status} ${diverged.stdout}${diverged.stderr}${lone.stderr}`)
  rmSync(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- session.mjs and the Claude Code guard
{
  // One loop session per clone; the newest start wins. Each case runs in a scratch clone directory.
  const clone = mkdtempSync(path.join(tmpdir(), 'agent-loop-clone-'))
  const sess = (...args) => {
    try {
      return execFileSync('node', [path.join(scripts, 'session.mjs'), ...args], { cwd: clone, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    } catch (e) {
      return `EXIT ${e.status} ${String(e.stderr).trim()}`
    }
  }
  const file = path.join(clone, '.agent-loop', 'session')
  const read = () => JSON.parse(readFileSync(file, 'utf8'))

  check('session: a start in a clone nobody holds → NEW', sess('--start', 'sess-a') === 'NEW')
  check('session: the same session again → MINE; its beat → MINE', sess('--start', 'sess-a') === 'MINE' && sess('--beat', 'sess-a') === 'MINE')
  const b = sess('--start', 'sess-b')
  check('session: another session starts → TOOK_OVER <old id> <secs>', /^TOOK_OVER sess-a \d+$/.test(b), b)
  check('session: … the old one is recorded as superseded', read().owner.id === 'sess-b' && read().superseded.join() === 'sess-a', JSON.stringify(read()))
  check('session: the old session\'s beat → SUPERSEDED <new id>, the new one\'s → MINE',
    sess('--beat', 'sess-a') === 'SUPERSEDED sess-b' && sess('--beat', 'sess-b') === 'MINE')
  check('session: release by a session that does not hold it → NOT_OWNER, nothing changes',
    sess('--release', 'sess-a') === 'NOT_OWNER' && read().owner.id === 'sess-b')
  check('session: release by the holder → RELEASED', sess('--release', 'sess-b') === 'RELEASED' && read().owner === null)
  check('session: after the release, a superseded session stays superseded → SUPERSEDED none', sess('--beat', 'sess-a') === 'SUPERSEDED none')
  check('session: … a session never superseded takes the free clone on its beat → MINE', sess('--beat', 'sess-c') === 'MINE' && read().owner.id === 'sess-c')
  const back = sess('--start', 'sess-a')
  check('session: the old session started again (the operator chose it) → TOOK_OVER, and is no longer superseded',
    /^TOOK_OVER sess-c \d+$/.test(back) && !read().superseded.includes('sess-a') && sess('--beat', 'sess-c') === 'SUPERSEDED sess-a', `${back} ${JSON.stringify(read())}`)

  writeFileSync(file, JSON.stringify({ owner: { id: 'sess-old', at: new Date(Date.now() - 600_000).toISOString() }, superseded: [] }))
  const aged = sess('--start', 'sess-new')
  check('session: TOOK_OVER reports how long ago the old session was last seen', /^TOOK_OVER sess-old (59\d|60\d)$/.test(aged), aged)
  writeFileSync(file, '{ not json')
  check('session: an unreadable file is an empty one → NEW', sess('--start', 'sess-x') === 'NEW')
  writeFileSync(file, JSON.stringify({ owner: { id: 'sess-0', at: new Date().toISOString() }, superseded: Array.from({ length: 20 }, (_, i) => `old-${i}`) }))
  sess('--start', 'sess-y')
  check('session: the superseded list keeps the newest 20', read().superseded.length === 20 && read().superseded.at(-1) === 'sess-0' && !read().superseded.includes('old-0'), JSON.stringify(read().superseded))
  const literal = sess('--start', '${CLAUDE_SESSION_ID}')
  const none = sess('--beat')
  const two = sess('--start', 'a', '--beat', 'a')
  check('session: an id that was never filled in, a missing id, or two modes → usage error, exit 1',
    literal.startsWith('EXIT 1') && none.startsWith('EXIT 1') && two.startsWith('EXIT 1'), `${literal}\n${none}\n${two}`)

  // The guard hook (adapters/claude-code/hooks/guard.mjs) reads the same file.
  const guardPath = path.resolve(scripts, '..', 'adapters', 'claude-code', 'hooks', 'guard.mjs')
  const guard = (session_id, tool_name, tool_input = {}, cwd = clone) => {
    const out = execFileSync('node', [guardPath], { input: JSON.stringify({ cwd, session_id, tool_name, tool_input }), encoding: 'utf8' })
    return out ? JSON.parse(out).hookSpecificOutput.permissionDecisionReason : 'ALLOW'
  }
  writeFileSync(path.join(clone, '.agent-loop', 'role'), 'executor\n')
  writeFileSync(file, JSON.stringify({ owner: { id: 'sess-new', at: new Date().toISOString() }, superseded: ['sess-old'] }))
  const sup = guard('sess-old', 'Bash', { command: 'git status --porcelain' })
  check('guard: a superseded session\'s Bash call is refused, naming the session that took over',
    /superseded/.test(sup) && /session sess-new took over this executor clone/.test(sup), sup)
  check('guard: … its Edit, Write and NotebookEdit calls too',
    ['Edit', 'Write', 'NotebookEdit'].every((t) => /superseded/.test(guard('sess-old', t, { file_path: path.join(clone, 'x.txt') }))))
  check('guard: … but a plain session.mjs call passes (a restart in the old session)',
    guard('sess-old', 'Bash', { command: 'node /plugins/agent-loop/scripts/session.mjs --start sess-old' }) === 'ALLOW')
  check('guard: … and nothing chained onto session.mjs slips past',
    /superseded/.test(guard('sess-old', 'Bash', { command: 'node /p/scripts/session.mjs --beat sess-old && git checkout main' })))
  check('guard: the session holding the clone, and one the file never named, are not affected',
    guard('sess-new', 'Bash', { command: 'git status' }) === 'ALLOW' && guard('sess-new', 'Edit', { file_path: 'x' }) === 'ALLOW' &&
    guard('sess-operator', 'Bash', { command: 'git status' }) === 'ALLOW')
  check('guard: merging is still refused for the holder', /operator's action/.test(guard('sess-new', 'Bash', { command: 'gh pr merge 7' })))
  const status = (fields) => guard('sess-new', 'Bash', { command: `gh api -X POST repos/o/r/statuses/abc123 ${fields}` })
  check('guard: a commit status other than pending is refused (success, failure, error, quoted, no gap, no state, --input)',
    ['-f state=success -f context=local-ci', '-f state=failure', '-f state=error', "-f 'state=success'", '-fstate=success', '-F state=success',
      '-f context=local-ci', '--input body.json', '-f state=pending -f state=success',
      '--input body.json -f state=pending', '--input - -f state=pending', '-f state=pending --input=body.json'].every((f) => /only the local runner posts/.test(status(f))),
    status('-f state=success'))
  check('guard: … state=pending (a re-run request) passes, and so does reading statuses',
    status('-f state=pending -f context=local-ci -f description=re-run') === 'ALLOW' &&
    guard('sess-new', 'Bash', { command: 'gh api repos/o/r/commits/abc123/status' }) === 'ALLOW' &&
    guard('sess-new', 'Bash', { command: 'gh api repos/o/r/statuses/abc123' }) === 'ALLOW')
  const bare = mkdtempSync(path.join(tmpdir(), 'agent-loop-bare-'))
  check('guard: no role marker (the operator\'s clone) → nothing refused', guard('sess-old', 'Bash', { command: 'gh pr merge 7' }, bare) === 'ALLOW')
  rmSync(bare, { recursive: true, force: true })
  rmSync(clone, { recursive: true, force: true })
}

// ---------------------------------------------------------------- the Claude Code RESTART-line hook
{
  // After a merge, pull.mjs --start prints the RESTART line; the hook shows it to the operator.
  const hookPath = path.resolve(scripts, '..', 'adapters', 'claude-code', 'hooks', 'restart-line.mjs')
  const run = (input) => spawnSync('node', [hookPath], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' })
  const shown = (input) => {
    const r = run(input)
    if (r.status !== 0) return `EXIT ${r.status}`
    return r.stdout ? JSON.parse(r.stdout).systemMessage : 'SILENT'
  }
  const clone = (role) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-loop-hook-'))
    if (role) {
      mkdirSync(path.join(dir, '.agent-loop'))
      writeFileSync(path.join(dir, '.agent-loop', 'role'), `${role}\n`)
    }
    return dir
  }
  const exec = clone('executor')
  const pull = 'node /plugins/agent-loop/scripts/pull.mjs --start "/agent-loop:start-executor" --milestone "M7"'
  const restart = 'RESTART: exit this session, start a new one in this clone, then run: /agent-loop:start-executor --milestone "M7"'
  const ok = (command, stdout, cwd = exec) => ({ cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '', interrupted: false, isImage: false } })

  check('restart hook: executor clone, pull.mjs --start, a RESTART line → that line as the systemMessage, exactly',
    shown(ok(pull, `${restart}\n`)) === restart, shown(ok(pull, `${restart}\n`)))
  const rules = `RULES_CHANGED: AGENTS.md\n  git diff abc..def -- AGENTS.md\n${restart}\n`
  check('restart hook: RULES_CHANGED lines before it → only the RESTART line', shown(ok(pull, rules)) === restart, shown(ok(pull, rules)))
  const failed = { cwd: exec, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: pull }, error: `Exit code 2\npull: Not possible to fast-forward, aborting.\n${restart}` }
  check('restart hook: a failed pull (exit 2, PostToolUseFailure shape) → the line', shown(failed) === restart, shown(failed))
  const quoted = ['node "/Users/x/My Plugins/agent-loop/scripts/pull.mjs" --start "/agent-loop:start-executor"', "node '/p/scripts/pull.mjs' --start '/agent-loop:start-executor'"]
  check('restart hook: a double- or single-quoted pull.mjs path (a plugin root with a space) → the line',
    quoted.every((c) => shown(ok(c, `${restart}\n`)) === restart), quoted.map((c) => shown(ok(c, restart))).join(' | '))
  check('restart hook: pull.mjs without --start → silent', shown(ok('node /p/scripts/pull.mjs', restart)) === 'SILENT')
  check('restart hook: other commands (pick-next, git diff, session.mjs --start, a grep naming pull.mjs) → silent, even with a RESTART-looking line',
    ['node /p/scripts/pick-next.mjs --repo o/r --skip none', 'git diff abc..def -- AGENTS.md', 'node /p/scripts/session.mjs --start sess-a',
      'node /p/scripts/repull.mjs --start x', 'grep -n RESTART scripts/pull.mjs'].every((c) => shown(ok(c, restart)) === 'SILENT'))
  const reviewer = clone('reviewer')
  const bare = clone(null)
  check('restart hook: a reviewer clone, or a clone with no role marker → silent',
    shown(ok(pull, restart, reviewer)) === 'SILENT' && shown(ok(pull, restart, bare)) === 'SILENT')
  check('restart hook: output without a RESTART line → silent', shown(ok(pull, 'RULES_CHANGED: AGENTS.md\n')) === 'SILENT')
  check('restart hook: another tool, malformed, empty or null stdin → silent, exit 0',
    shown({ ...ok(pull, restart), tool_name: 'Edit' }) === 'SILENT' && ['{ not json', '', 'null', '[]', '7'].every((s) => shown(s) === 'SILENT'),
    ['{ not json', '', 'null', '[]', '7'].map(shown).join(' | '))
  const hooks = JSON.parse(readFileSync(path.resolve(scripts, '..', 'adapters', 'claude-code', 'hooks', 'hooks.json'), 'utf8')).hooks
  const runs = (event, file) => (hooks[event] ?? []).some((e) => e.matcher === 'Bash' && e.hooks.some((h) => h.command.includes(`hooks/${file}`)))
  check('restart hook: hooks.json runs it after Bash on PostToolUse and PostToolUseFailure; the guard entry is unchanged',
    runs('PostToolUse', 'restart-line.mjs') && runs('PostToolUseFailure', 'restart-line.mjs') &&
    hooks.PreToolUse.length === 1 && hooks.PreToolUse[0].matcher === 'Bash|Edit|Write|NotebookEdit' && hooks.PreToolUse[0].hooks[0].command.includes('hooks/guard.mjs'))
  for (const dir of [exec, reviewer, bare]) rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- .github/workflows/ci.yml
{
  const ci = readFileSync(path.resolve(scripts, '..', '.github', 'workflows', 'ci.yml'), 'utf8')
  const uses = [...ci.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1])
  check('ci: every action is pinned to a full commit sha', uses.length > 0 && uses.every((u) => /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(u)), uses.join('\n'))
  const perms = /^permissions:\n((?:[ \t]+.*\n)+)/m.exec(ci)?.[1].trim()
  check('ci: the token is read-only (permissions: contents: read, nothing else, no job overrides)',
    perms === 'contents: read' && ci.match(/^\s*permissions:/gm).length === 1 && !/pull_request_target/.test(ci), perms)
  const types = /^  pull_request:\n    types: \[(.*)\]$/m.exec(ci)?.[1].split(',').map((s) => s.trim()) ?? []
  check('ci: a pull request reruns on edited (a change of base branch), and on the default types',
    ['opened', 'synchronize', 'reopened', 'edited'].every((t) => types.includes(t)), types.join())
  const checkouts = [...ci.matchAll(/uses: actions\/checkout@\S+.*\n((?: {8}.*\n)*)/g)].map((m) => m[1])
  check('ci: every checkout is the pull request\'s head commit (or the pushed one), never the merge commit',
    checkouts.length === 2 && checkouts.every((w) => /^\s+ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/m.test(w)), checkouts.join('---\n'))
  check('ci: the change detection diffs the event\'s base and head shas',
    ci.includes("BASE: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before }}") &&
    ci.includes("HEAD: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}") &&
    ci.includes('git diff --name-only --no-renames "$BASE...$HEAD"'))
  const jobs = ci.slice(ci.indexOf('\njobs:'))
  const jobIfs = [...jobs.matchAll(/^  [\w-]+:\n(?:    .*\n)*?    if: (.*)$/gm)].map((m) => m[1])
  check('ci: every job is off while AGENT_LOOP_CI is off', jobIfs.length === 3 && jobIfs.every((c) => c.includes("vars.AGENT_LOOP_CI != 'off'")), jobIfs.join('\n'))
  const agg = /^  required:\n((?:    .*\n|\s*\n)*)/m.exec(jobs)?.[1] ?? ''
  check('ci: the required check runs after a failed or cancelled test job (always()), and is named contract-tests only while on',
    /^    if: always\(\) /m.test(agg) && agg.includes("name: ${{ vars.AGENT_LOOP_CI == 'off' && 'contract-tests (off)' || 'contract-tests' }}"), agg)
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
