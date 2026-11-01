#!/usr/bin/env node
// Contract tests for the signal scripts, run against a fake `gh` (fake-gh.mjs).
//   node scripts/test/run.mjs
// No dependencies. Each case gets a fresh HOME (so state files start empty) and a fixture.
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, readFileSync, renameSync, readdirSync, existsSync, symlinkSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { execFileSync, spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'

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

  // #107 --local-ci: a head the runner hasn't marked yet is pending CI for the window, then no CI.
  const lctx = makeEnv()
  const local = ['--require-gate', '--local-ci', 'local-ci']
  const stateFile = path.join(lctx.home, '.agent-loop', 'state', 'acme-widgets-pr-poll-7.json')
  const age = (secs) => {
    const s = JSON.parse(readFileSync(stateFile, 'utf8'))
    s.head.seenAt = Date.now() - secs * 1000
    writeFileSync(stateFile, JSON.stringify(s))
  }
  const fresh = poll(lctx, noCi(quoted), local)
  check('poll --local-ci: no checks yet on a head first seen now → CI pending: no MERGE_READY even with the gate quoted, no NO_LOCAL_CI',
    !ready(fresh) && !signals(fresh).includes('NO_LOCAL_CI'), fresh)
  age(200)
  const within = poll(lctx, noCi(quoted), local)
  check('poll --local-ci: … still within the window (200 s of 300) → still pending', !ready(within) && !signals(within).includes('NO_LOCAL_CI'), within)
  age(301)
  const after = poll(lctx, noCi(''), local)
  check('poll --local-ci: after the window with still no check → NO_LOCAL_CI, and no CI as without the flag (the quote is needed)',
    signals(after).includes('NO_LOCAL_CI') && !ready(after), after)
  const again = poll(lctx, noCi(quoted), local)
  check('poll --local-ci: … NO_LOCAL_CI once per head; the gate quoted on the head then gives MERGE_READY',
    !signals(again).includes('NO_LOCAL_CI') && ready(again), again)
  const runner = (bucket) => ({ checks: [{ name: 'local-ci', state: bucket === 'pass' ? 'SUCCESS' : 'PENDING', bucket, link: '', completedAt: '0001-01-01T00:00:00Z' }] })
  const newHead = 'b2c3d4e5f60718293a4b5c6d7e8f901234567890'
  const moved = (body, more = {}) => noCi(body, { pr: { merged: false, head: { sha: newHead } }, ...more })
  // The review of #121: after NO_LOCAL_CI the runner is down for the PR; a later head with no check
  // has no CI at once, without a second window or a second NO_LOCAL_CI.
  const downHead = 'c3d4e5f60718293a4b5c6d7e8f90123456789012'
  const down = (body) => noCi(body, { pr: { merged: false, head: { sha: downHead } } })
  const later = poll(lctx, down('\n\nGate on c3d4e5f: ok'), local)
  check('poll --local-ci: after NO_LOCAL_CI, a later head with no check has no CI at once: MERGE_READY with its quote, no second NO_LOCAL_CI',
    ready(later) && !signals(later).includes('NO_LOCAL_CI'), later)
  const laterUnquoted = poll(lctx, down(''), local)
  check('poll --local-ci: … and without the quote no MERGE_READY (no CI, so the quote is needed)', !ready(laterUnquoted) && !signals(laterUnquoted).includes('NO_LOCAL_CI'), laterUnquoted)
  const pendingRun = poll(lctx, moved('', runner('pending')), local)
  check('poll --local-ci: the runner\'s pending check on a new head → CI pending as for any check, no NO_LOCAL_CI', !ready(pendingRun) && !signals(pendingRun).includes('NO_LOCAL_CI'), pendingRun)
  age(400)
  const passed = poll(lctx, moved('', runner('pass')), local)
  check('poll --local-ci: the runner\'s check passing → MERGE_READY with no quote (it is CI), never NO_LOCAL_CI', ready(passed) && !signals(passed).includes('NO_LOCAL_CI'), passed)
  const backHead = 'd4e5f60718293a4b5c6d7e8f9012345678901234'
  const back = poll(lctx, noCi(`\n\nGate on d4e5f60: ok`, { pr: { merged: false, head: { sha: backHead } } }), local)
  check('poll --local-ci: once the runner\'s check has shown up again, the next unmarked head gets a window again (CI pending)',
    !ready(back) && !signals(back).includes('NO_LOCAL_CI'), back)
  const window = run(lctx, 'pr-poll.mjs', ['--repo', REPO, '--pr', '7', '--local-ci-window', 'soon'], BASE)
  check('poll: --local-ci-window that is not seconds → usage error, exit 1', window.startsWith('EXIT 1'), window)
  rmSync(lctx.home, { recursive: true, force: true })

  // #129: the block on the default branch turns the flags on by itself; a flag given still wins.
  const block = (lines) => `# Project\n\n## Agent loop\n\nrepo: acme/widgets\n${lines}\n\n## Other\n\ngate: not-the-block\n`
  const bctx = makeEnv()
  const withBlock = (lines, fx) => ({ ...fx, agents: block(lines) })
  check('poll, block has gate (no flag): no CI, LGTM without a gate line → no MERGE_READY; quoting it → MERGE_READY',
    !ready(poll(bctx, withBlock('gate: just gate', noCi('')))) && ready(poll(bctx, withBlock('gate: `just gate`', noCi(quoted)))))
  check('poll: a gate key under another heading is not the block\'s → MERGE_READY without a quote',
    ready(poll(bctx, withBlock('', noCi('')))))
  check('poll, block has qa-gate: on (no flag): LGTM without [qa] PASS → no MERGE_READY; with it → MERGE_READY',
    !ready(poll(bctx, withBlock('qa-gate: on', { ...BASE, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))] }))) &&
    ready(poll(bctx, withBlock('qa-gate: on', { ...BASE, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z')), comment('[qa] PASS', T('2026-01-01T12:05:00Z'))] }))))
  check('poll, block has qa-gate: off → no PASS needed',
    ready(poll(bctx, withBlock('qa-gate: off', { ...BASE, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))] }))))
  rmSync(bctx.home, { recursive: true, force: true })

  // local-ci from the block behaves as --local-ci: pending in the window, then NO_LOCAL_CI.
  const kctx = makeEnv()
  const kstate = path.join(kctx.home, '.agent-loop', 'state', 'acme-widgets-pr-poll-7.json')
  const kage = (secs) => {
    const s = JSON.parse(readFileSync(kstate, 'utf8'))
    s.head.seenAt = Date.now() - secs * 1000
    writeFileSync(kstate, JSON.stringify(s))
  }
  const lblock = 'gate: just gate\nlocal-ci: local-ci'
  const kfresh = poll(kctx, withBlock(lblock, noCi(quoted)))
  check('poll, block has local-ci (no flags): a head with no checks first seen now → CI pending, as with --local-ci',
    !ready(kfresh) && !signals(kfresh).includes('NO_LOCAL_CI'), kfresh)
  kage(301)
  const kafter = poll(kctx, withBlock(lblock, noCi('')))
  check('poll, block has local-ci (no flags): after the window → NO_LOCAL_CI, and the gate quote is needed',
    signals(kafter).includes('NO_LOCAL_CI') && !ready(kafter), kafter)
  rmSync(kctx.home, { recursive: true, force: true })
  const wctx = makeEnv()
  const wnow = poll(wctx, withBlock(lblock, noCi('')), ['--local-ci-window', '0'])
  check('poll: --local-ci-window applies to the block\'s context', signals(wnow).includes('NO_LOCAL_CI'), wnow)
  rmSync(wctx.home, { recursive: true, force: true })

  // The flag's context wins: block "local-ci: other", flag --local-ci local-ci. After NO_LOCAL_CI,
  // the runner's check under local-ci clears "down" only when local-ci is the context in use, so the
  // next unmarked head gets a window again (no MERGE_READY even quoted) rather than no CI at once.
  const fctx = makeEnv()
  const fstate = path.join(fctx.home, '.agent-loop', 'state', 'acme-widgets-pr-poll-7.json')
  const flagCi = ['--local-ci', 'local-ci']
  const oblock = 'gate: just gate\nlocal-ci: other'
  poll(fctx, withBlock(oblock, noCi('')), flagCi)
  const fs0 = JSON.parse(readFileSync(fstate, 'utf8'))
  fs0.head.seenAt = Date.now() - 301 * 1000
  writeFileSync(fstate, JSON.stringify(fs0))
  poll(fctx, withBlock(oblock, noCi('')), flagCi)
  poll(fctx, withBlock(oblock, moved('', runner('pass'))), flagCi)
  const fback = poll(fctx, withBlock(oblock, noCi('\n\nGate on d4e5f60: ok', { pr: { merged: false, head: { sha: backHead } } })), flagCi)
  check('poll: --local-ci on the command line wins over the block\'s local-ci', !ready(fback) && !signals(fback).includes('NO_LOCAL_CI'), fback)
  rmSync(fctx.home, { recursive: true, force: true })

  // Fail closed: an unreadable block may hold a gate the flags don't, so MERGE_READY waits.
  const ectx = makeEnv()
  const lgtmFx = { ...BASE, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))], agents: 'error' }
  writeFileSync(ectx.fixture, JSON.stringify({ ...BASE, agents: 'error' }))
  spawnSync('node', [path.join(scripts, 'pr-poll.mjs'), '--repo', REPO, '--pr', '7'], { env: ectx.env })
  writeFileSync(ectx.fixture, JSON.stringify(lgtmFx))
  const unread = spawnSync('node', [path.join(scripts, 'pr-poll.mjs'), '--repo', REPO, '--pr', '7'], { env: ectx.env, encoding: 'utf8' })
  check('poll: the block can\'t be read → no MERGE_READY, a pr-poll: line on stderr, exit 0 and the other signals as usual (NEW_COMMENT)',
    unread.status === 0 && !ready(unread.stdout) && signals(unread.stdout).includes('NEW_COMMENT') && /^pr-poll: could not read the Agent loop block \(MERGE_READY withheld\): HTTP 502/m.test(unread.stderr),
    `${unread.status}\n${unread.stdout}\n${unread.stderr}`)
  writeFileSync(ectx.fixture, JSON.stringify({ ...lgtmFx, agents: block('') }))
  const reread = spawnSync('node', [path.join(scripts, 'pr-poll.mjs'), '--repo', REPO, '--pr', '7'], { env: ectx.env, encoding: 'utf8' })
  check('poll: … the next run reads it again (a failure is not kept) → MERGE_READY', ready(reread.stdout), reread.stdout + reread.stderr)
  // The review of #133: the API is case-sensitive, so an agents.md the clone reads fine is a 404 here.
  writeFileSync(ectx.fixture, JSON.stringify({ ...lgtmFx, agents: null }))
  const gone = spawnSync('node', [path.join(scripts, 'pr-poll.mjs'), '--repo', REPO, '--pr', '7'], { env: ectx.env, encoding: 'utf8' })
  check('poll: no AGENTS.md on the default branch (404) fails closed, never an empty block → no MERGE_READY, a pr-poll: line saying so',
    gone.status === 0 && !ready(gone.stdout) && /^pr-poll: could not read the Agent loop block \(MERGE_READY withheld\): no AGENTS\.md on the default branch$/m.test(gone.stderr),
    `${gone.status}\n${gone.stdout}\n${gone.stderr}`)
  writeFileSync(ectx.fixture, JSON.stringify({ ...lgtmFx, agents: 'too-large' }))
  const large = spawnSync('node', [path.join(scripts, 'pr-poll.mjs'), '--repo', REPO, '--pr', '7'], { env: ectx.env, encoding: 'utf8' })
  check('poll: an AGENTS.md the API sends without content (over 1 MB) is unreadable, not an empty block → no MERGE_READY',
    !ready(large.stdout) && /could not read the Agent loop block/.test(large.stderr), large.stdout + large.stderr)
  rmSync(ectx.home, { recursive: true, force: true })

  // The block comes from the default branch through the API, never from the clone's AGENTS.md (a PR's
  // head could change its own gate): a clone whose AGENTS.md has gate and qa-gate changes nothing.
  const cctx = makeEnv()
  const clone = path.join(cctx.home, 'clone')
  mkdirSync(clone)
  writeFileSync(path.join(clone, 'AGENTS.md'), block('gate: just gate\nqa-gate: on\nlocal-ci: local-ci'))
  writeFileSync(cctx.fixture, JSON.stringify(withBlock('', noCi(''))))
  const inClone = execFileSync('node', [path.join(scripts, 'pr-poll.mjs'), '--repo', REPO, '--pr', '7'], { env: cctx.env, cwd: clone, encoding: 'utf8' })
  const asked = readFileSync(cctx.log, 'utf8').split('\n').filter((l) => l.includes('contents/AGENTS.md'))
  check('poll: the clone\'s own AGENTS.md is never read: no CI, LGTM → MERGE_READY when the default branch\'s block has no gate',
    ready(inClone), inClone)
  check('poll: … the block is read once per run, from the default branch (no ref)', asked.length === 1 && !/ref=/.test(asked[0]), asked.join('\n'))
  rmSync(cctx.home, { recursive: true, force: true })
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
  const asked = { ...BASE, comments: [comment('[reviewer] Question: keep the launcher on --no-sync, or follow the plan literally?\n\nThe plan says bare `uv run example-app`; the PR uses --no-sync so starting never reaches the network.\n\nReply with: "keep", or "follow the plan".', T('2026-01-01T12:00:00Z'))] }
  const first = poll(ctx, asked)
  check('poll: a new [reviewer] Question surfaces once as new activity, not as MERGE_READY', signals(first).includes('NEW_COMMENT') && first.includes('launcher') && !signals(first).includes('MERGE_READY'), first)
  const out = poll(ctx, asked)
  check('poll: [reviewer] Question is not a live blocker: it does not re-surface and is not an LGTM', !out.includes('launcher') && !signals(out).includes('MERGE_READY'), out)
  const legacy = { ...asked, comments: [...asked.comments, comment('[reviewer] Verified abc123 against #4: criteria covered.', T('2026-01-01T12:10:00Z'))] }
  poll(ctx, legacy) // seen once as an ordinary new comment, like any thread activity
  const outL = poll(ctx, legacy)
  check('poll: retired [reviewer] Verified kind is tolerated (not re-surfaced, not an LGTM)', !outL.includes('Verified abc123') && !signals(outL).includes('MERGE_READY'), outL)
  const answered = { ...legacy, comments: [...legacy.comments, comment('keep', T('2026-01-01T13:00:00Z')), comment('[reviewer] LGTM — abc123 against #4. Before you merge: run ./example-app check on a device.', T('2026-01-01T13:05:00Z'))] }
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
// #41: the reviewer posts a finding on a draft before the executor's first poll; a
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

  // A consumer's case: an issue filed while the executor waited is picked at the next call.
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
  const claim = (clone, id, association = 'OWNER') => ({ id, body: `[executor] Claimed by ${clone}`, created_at: '2026-01-01T10:00:00Z', user: user('acme'), author_association: association })
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
  // #134: the PR author's claim counts only when that author is trusted (the default branch's block).
  check('pick --clone (#134): the claim\'s author is not trusted (no list, association NONE) → no RESUME',
    pick(parked({ issueComments: { 20: [claim('exec-a', 2, 'NONE')] } }), asA) === 'ISSUE:11')
  check('pick --clone (#134): trusted-authors names someone else → no RESUME; naming the author → RESUME',
    pick(parked({ agents: '## Agent loop\n\nrepo: acme/widgets\ntrusted-authors: [bob]\n' }), asA) === 'ISSUE:11' &&
      pick(parked({ agents: '## Agent loop\n\nrepo: acme/widgets\ntrusted-authors: [Acme]\n' }), asA) === 'RESUME:20 PR:50')
  const blindPick = run(ctx, 'pick-next.mjs', ['--repo', REPO, ...asA], parked({ agents: 'error' }))
  check('pick --clone (#134): the block unreadable when a claim needs checking → exit 2, never a RESUME on an unread list', /^EXIT 2\n\npick-next: HTTP 502/.test(blindPick), blindPick)
  writeFileSync(ctx.log, '')
  const plainPick = pick(parked({ agents: 'error', issueComments: { 20: [] } }), asA)
  check('pick --clone (#134): no claim to check → the block is not read (a pick gains no call)',
    plainPick === 'ISSUE:11' && !readFileSync(ctx.log, 'utf8').includes('contents/AGENTS.md'), plainPick)
  const badClone = run(ctx, 'pick-next.mjs', ['--repo', REPO, '--clone', '../x'], { issues: [] })
  check('pick: a --clone that is not a clone name → usage error, exit 1', /^EXIT 1/.test(badClone), badClone)
  rmSync(ctx.home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- the executor's check order (#87)
{
  // The checks that take seconds run before the one that takes minutes, so a refusal at push time
  // never costs a second gate. Every executor text, and the fix rounds, name the same order.
  const adapters = path.resolve(scripts, '..', 'adapters')
  const order = [
    '**Before every push, in this order:** `pre-gate` when the block has it, fixed and run again until it passes (commit what a formatter changed); commit;',
    'the push-time checks without pushing: `git push --dry-run origin <branch>`, which runs the project\'s pre-push hooks on the commits it would send,',
    'then `quality-gates` and the gate on the committed, clean tree; then the push.',
  ]
  const texts = ['claude-code/skills/start-executor/reference/implement.md', 'claude-code/skills/start-executor/reference/signals.md',
    'generic/executor.md', 'kiro/skills/start-executor/SKILL.md']
  const missing = texts.filter((f) => {
    const t = readFileSync(path.join(adapters, f), 'utf8').replace(/\n\s*/g, ' ')
    const at = order.map((s) => t.indexOf(s))
    return at.some((i) => i === -1) || !(at[0] < at[1] && at[1] < at[2])
  })
  check('executor order: every executor text, and the fix rounds, run pre-gate, then the push-time dry-run, then the gate, then the push', missing.length === 0, missing.join('\n'))
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
  return { child, done, output: () => ({ out, err }) }
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
// The takeover checks wait on what they need to have happened (a lock naming a pid, a request
// file, a line of output), never on a fixed pause, so a slow machine can't reorder them (#135).
// True once cond() holds; false at the timeout, which the check then reports.
const until = async (cond, ms = 15000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) return false
    await pause(20)
  }
  return true
}
const waitLock = (ctx, state = WATCH_STATE) => path.join(ctx.home, '.agent-loop', 'state', state.replace(/\.json$/, '-wait.lock'))
const lockPid = (ctx, state) => {
  try {
    return JSON.parse(readFileSync(waitLock(ctx, state), 'utf8')).pid
  } catch {
    return null
  }
}
// A waiter holds the lock once the lock names it; it takes the lock before its first pass, and
// its signal handlers are on before anything else can run.
const holdsLock = (ctx, w, state) => until(() => lockPid(ctx, state) === w.child.pid)

// ---------------------------------------------------------------- pr-watch CI_DONE (#131)
{
  // With review-waits-for-ci: on, a check on a watched head reaching a final state since the last
  // run gives CI_DONE:<n>, so a reviewer holding its verdict for CI is woken.
  const ciOn = '## Agent loop\n\nrepo: acme/widgets\nreview-waits-for-ci: on\n'
  const ciOff = '## Agent loop\n\nrepo: acme/widgets\n'
  const status = (context, state) => ({ __typename: 'StatusContext', context, state })
  const checkRun = (name, st, conclusion = '') => ({ __typename: 'CheckRun', workflowName: 'CI', name, status: st, conclusion })
  const ciFx = (rollup, { sha = 'abc123', agents = ciOn, base = watchReviewed } = {}) =>
    ({ ...base, agents, prs: [{ number: 7, headRefOid: sha, mergeable: 'MERGEABLE', statusCheckRollup: rollup }] })
  const watch = (ctx, fx) => run(ctx, 'pr-watch.mjs', watchArgs(), fx)
  const seeded = (fx) => {
    const ctx = makeEnv()
    watch(ctx, fx)
    return ctx
  }
  const line = (out) => out.split('\n')[0]

  let ctx = seeded(ciFx([status('local-ci', 'PENDING')]))
  const done = watch(ctx, ciFx([status('local-ci', 'SUCCESS')]))
  const again = watch(ctx, ciFx([status('local-ci', 'SUCCESS')]))
  check('watch CI_DONE: a status going pending → success on a watched head → CI_DONE:7 once; the next run → NONE',
    line(done) === 'CI_DONE:7' && /^NONE /.test(again), `${done}|${again}`)
  rmSync(ctx.home, { recursive: true, force: true })

  ctx = seeded(ciFx([status('local-ci', 'PENDING')]))
  const failed = watch(ctx, ciFx([status('local-ci', 'FAILURE')]))
  const errored = (() => {
    const c = seeded(ciFx([status('local-ci', 'PENDING')]))
    const out = watch(c, ciFx([status('local-ci', 'ERROR')]))
    rmSync(c.home, { recursive: true, force: true })
    return out
  })()
  check('watch CI_DONE: a status going pending → failure, or → error, also gives CI_DONE:7 (the reviewer reads the checks)',
    line(failed) === 'CI_DONE:7' && line(errored) === 'CI_DONE:7', `${failed}|${errored}`)
  rmSync(ctx.home, { recursive: true, force: true })

  ctx = seeded(ciFx([checkRun('test (node 22)', 'IN_PROGRESS'), checkRun('lint', 'COMPLETED', 'SUCCESS')]))
  const runDone = watch(ctx, ciFx([checkRun('test (node 22)', 'COMPLETED', 'SUCCESS'), checkRun('lint', 'COMPLETED', 'SUCCESS')]))
  const runAgain = watch(ctx, ciFx([checkRun('test (node 22)', 'COMPLETED', 'SUCCESS'), checkRun('lint', 'COMPLETED', 'SUCCESS')]))
  check('watch CI_DONE: a check run is treated like a status (a name with spaces included) → CI_DONE:7 once',
    line(runDone) === 'CI_DONE:7' && /^NONE /.test(runAgain), `${runDone}|${runAgain}`)
  const stillRunning = (() => {
    const c = seeded(ciFx([checkRun('a', 'QUEUED'), checkRun('b', 'IN_PROGRESS')]))
    const out = watch(c, ciFx([checkRun('a', 'IN_PROGRESS'), checkRun('b', 'IN_PROGRESS'), status('x', 'EXPECTED')]))
    rmSync(c.home, { recursive: true, force: true })
    return out
  })()
  check('watch CI_DONE: checks moving between non-final states (queued, in progress, a status expected) → NONE', /^NONE /.test(stillRunning), stillRunning)
  rmSync(ctx.home, { recursive: true, force: true })

  ctx = seeded(ciFx([status('local-ci', 'PENDING')]))
  const pushed = watch(ctx, ciFx([status('local-ci', 'SUCCESS')], { sha: 'def456' }))
  const afterPush = watch(ctx, ciFx([status('local-ci', 'SUCCESS')], { sha: 'def456' }))
  check('watch CI_DONE: a head pushed between runs → REVIEW:7 and no CI_DONE (the new head\'s checks are recorded silently); the next run → NONE',
    line(pushed) === 'REVIEW:7' && /^NONE /.test(afterPush), `${pushed}|${afterPush}`)
  rmSync(ctx.home, { recursive: true, force: true })

  // A first review held for CI: the PR has no reviewer post, so REVIEW stands every run.
  ctx = seeded(ciFx([status('local-ci', 'PENDING')], { base: watchFx }))
  const standing = watch(ctx, ciFx([status('local-ci', 'SUCCESS')], { base: watchFx }))
  check('watch CI_DONE: a standing REVIEW (no reviewer post yet) does not hide it → REVIEW:7 CI_DONE:7', line(standing) === 'REVIEW:7 CI_DONE:7', standing)
  rmSync(ctx.home, { recursive: true, force: true })

  // A rerun on the same head: red, re-run (pending), green. Each finish counts.
  ctx = seeded(ciFx([status('local-ci', 'FAILURE')]))
  const rerunPending = watch(ctx, ciFx([status('local-ci', 'PENDING')]))
  const rerunGreen = watch(ctx, ciFx([status('local-ci', 'SUCCESS')]))
  check('watch CI_DONE: a check re-run on the same head (failure → pending → success) → NONE, then CI_DONE:7',
    /^NONE /.test(rerunPending) && line(rerunGreen) === 'CI_DONE:7', `${rerunPending}|${rerunGreen}`)
  rmSync(ctx.home, { recursive: true, force: true })

  // The key off (absent): today's output, the transition included.
  ctx = seeded(ciFx([status('local-ci', 'PENDING')], { agents: ciOff }))
  const off = watch(ctx, ciFx([status('local-ci', 'SUCCESS')], { agents: ciOff }))
  const offStanding = (() => {
    const c = seeded(ciFx([status('local-ci', 'PENDING')], { agents: ciOff, base: watchFx }))
    const out = watch(c, ciFx([status('local-ci', 'SUCCESS')], { agents: ciOff, base: watchFx }))
    rmSync(c.home, { recursive: true, force: true })
    return out
  })()
  check('watch CI_DONE: without review-waits-for-ci: on, no CI_DONE ever → NONE, and a standing REVIEW:7 alone',
    /^NONE \S+\n$/.test(off) && offStanding === 'REVIEW:7\n', `${off}|${offStanding}`)
  // … and turning it on later reports only what finishes after (seeded silently when it turns on).
  const turnedOn = watch(ctx, ciFx([status('local-ci', 'SUCCESS')]))
  check('watch CI_DONE: … turning the key on later reports nothing that finished before', /^NONE /.test(turnedOn), turnedOn)
  rmSync(ctx.home, { recursive: true, force: true })

  // State written before this signal existed (no ci field): recorded silently, never a CI_DONE.
  ctx = makeEnv()
  mkdirSync(path.join(ctx.home, '.agent-loop', 'state'), { recursive: true })
  writeFileSync(path.join(ctx.home, '.agent-loop', 'state', WATCH_STATE), JSON.stringify({ 7: { sha: 'abc123', lastComment: 999999, lastReviewComment: 0 } }))
  const upgraded = watch(ctx, ciFx([status('local-ci', 'SUCCESS')]))
  check('watch CI_DONE: a state from before CI_DONE (no ci field) → NONE, the checks recorded', /^NONE /.test(upgraded) && JSON.parse(stateText(ctx, WATCH_STATE))[7].ci?.['status:local-ci'] === 'SUCCESS', `${upgraded}\n${stateText(ctx, WATCH_STATE)}`)
  rmSync(ctx.home, { recursive: true, force: true })

  // The block can't be read on the run that sees the finish: withheld, with a line, and reported
  // on the next run that reads it.
  ctx = seeded(ciFx([status('local-ci', 'PENDING')]))
  writeFileSync(ctx.fixture, JSON.stringify(ciFx([status('local-ci', 'SUCCESS')], { agents: 'error' })))
  const blind = spawnSync('node', [path.join(scripts, 'pr-watch.mjs'), ...watchArgs()], { env: ctx.env, encoding: 'utf8' })
  const seen = watch(ctx, ciFx([status('local-ci', 'SUCCESS')]))
  check('watch CI_DONE: an unreadable block withholds it (NONE, a pr-watch: line on stderr); the next run that reads the block → CI_DONE:7',
    /^NONE /.test(blind.stdout) && /^pr-watch: could not read the Agent loop block \(CI_DONE withheld\): HTTP 502/.test(blind.stderr) && line(seen) === 'CI_DONE:7',
    `${blind.stdout}${blind.stderr}|${seen}`)
  rmSync(ctx.home, { recursive: true, force: true })

  // The waiter wakes on it like on the other signals.
  ctx = seeded(ciFx([status('local-ci', 'PENDING')]))
  watch(ctx, ciFx([status('local-ci', 'PENDING')]))
  const w = start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '15'))
  const waiting = await holdsLock(ctx, w)
  setFixture(ctx, ciFx([status('local-ci', 'SUCCESS')]))
  const woke = await w.done
  const delivered = watch(ctx, ciFx([status('local-ci', 'SUCCESS')]))
  check('watch CI_DONE: a waiter wakes on a check finishing → PENDING, and the one-shot run that follows → CI_DONE:7',
    waiting && woke.out === 'PENDING\n' && woke.code === 0 && woke.ms < 10000 && line(delivered) === 'CI_DONE:7', `held: ${waiting}\n${woke.ms}ms ${woke.code} ${woke.out}${woke.err}|${delivered}`)
  rmSync(ctx.home, { recursive: true, force: true })

  // The review of #141: a check change must not touch the state unless it is a finish the key
  // reports. A state change wakes a waiter and resets the idle count, so storing every check change
  // gave a standing REVIEW a wake on each one and pushed the idle wait back, with the key off too.
  const quietWaiter = async (agents, before, after) => {
    const c = seeded(ciFx(before, { agents, base: watchFx }))
    watch(c, ciFx(before, { agents, base: watchFx }))
    const waiter = start(c, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '4'))
    const held = await holdsLock(c, waiter)
    setFixture(c, ciFx(after, { agents, base: watchFx }))
    const res = await waiter.done
    rmSync(c.home, { recursive: true, force: true })
    return { held, ...res }
  }
  const [offWait, onWait] = await Promise.all([
    quietWaiter(ciOff, [status('local-ci', 'PENDING')], [status('local-ci', 'SUCCESS')]),
    quietWaiter(ciOn, [status('local-ci', 'SUCCESS')], [status('local-ci', 'SUCCESS'), status('other-ci', 'PENDING')]),
  ])
  check('watch CI_DONE (review of #141): key off, a standing REVIEW:7 and a check that finishes → the waiter is not woken (NONE at --max)',
    offWait.held && /^NONE \S+\n$/.test(offWait.out) && offWait.ms >= 3500, `held: ${offWait.held} ${offWait.ms}ms ${offWait.out}${offWait.err}`)
  check('watch CI_DONE (review of #141): key on, a held REVIEW:7 and a new check that is only pending → the waiter is not woken (NONE at --max)',
    onWait.held && /^NONE \S+\n$/.test(onWait.out) && onWait.ms >= 3500, `held: ${onWait.held} ${onWait.ms}ms ${onWait.out}${onWait.err}`)
  ctx = makeEnv()
  const idleRun = (state) => run(ctx, 'pr-watch.mjs', watchArgs('--idle-after', '2'), ciFx([status('local-ci', state)], { agents: ciOff }))
  const idleOuts = ['PENDING', 'PENDING', 'PENDING', 'PENDING', 'SUCCESS', 'SUCCESS'].map(idleRun)
  check('watch CI_DONE (review of #141): key off, a check that finishes on a reviewed PR → the IDLE count keeps rising (IDLE 4, IDLE 5)',
    idleOuts[4].trimEnd().endsWith('IDLE 4') && idleOuts[5].trimEnd().endsWith('IDLE 5'), idleOuts.join('|'))
  rmSync(ctx.home, { recursive: true, force: true })

  // Every reviewer adapter takes the key, holds an LGTM on it, and handles CI_DONE without ever
  // posting an LGTM it never reviewed for.
  const adapters = path.resolve(scripts, '..', 'adapters')
  const flatText = (f) => readFileSync(path.join(adapters, f), 'utf8').replace(/\n\s*/g, ' ')
  const reviewers = { 'claude-code/skills/start-reviewer/SKILL.md': 'claude-code/skills/start-reviewer/reference/review.md', 'generic/reviewer.md': null,
    'kiro/skills/start-reviewer/SKILL.md': null }
  const unhandled = Object.entries(reviewers).filter(([f, extra]) => {
    const t = flatText(f) + (extra ? flatText(extra) : '')
    return !t.includes('`review-waits-for-ci` (`on` or `off`') && !t.includes('`review-waits-for-ci` (default `off`') && !t.includes('`review-waits-for-ci` — `on` or `off` (default `off`)') ||
      !/\*\*`CI_DONE:<n>`\*\* \(only with `review-waits-for-ci: on`/.test(t) || !t.includes('never an LGTM from nothing') ||
      !t.includes('A check still `pending` → post nothing') || !/CI (is )?pending( \(everything else holds\))?, with `review-waits-for-ci: on` → no LGTM yet/.test(t) ||
      // A held first review keeps REVIEW standing: the REVIEW handler says so, or every wake re-reviews.
      !/`REVIEW:<n>`\*\*[^]*?a head you already reviewed in this session with no findings and hold for CI → post nothing: `CI_DONE:<n>` brings you back \(you can't tell → review it as below\)[^]*?\*\*`REVIEW_COMMENTS:<n>`\*\*/.test(t)
  }).map(([f]) => f)
  check('reviewer texts (#131): every reviewer takes review-waits-for-ci, holds the LGTM with CI pending, and handles CI_DONE (never an LGTM from nothing)',
    unhandled.length === 0, unhandled.join('\n'))
}
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
  // #116: a second waiter on the same state takes the lock over; the first says TAKEN_OVER, exit 4.
  const first = start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '30'))
  const firstHolds = await holdsLock(ctx, first)
  const second = start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '4'))
  const f = await first.done
  check('wait: a second waiter on the same state takes the lock over: the first prints TAKEN_OVER and exits 4',
    firstHolds && f.out === 'TAKEN_OVER\n' && f.code === 4, `first held the lock: ${firstHolds}\ncode ${f.code}\n${f.out}${f.err}`)
  const s = await second.done
  check('wait: … and the second waits as usual (NONE at --max, exit 0)', signals(s.out).join() === 'NONE' && s.code === 0, `code ${s.code}\n${s.out}${s.err}`)
  const third = await start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '1')).done
  check('wait: the lock is released when a waiter exits', signals(third.out).join() === 'NONE', `${third.out}${third.err}`)
  const killed = start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '30'))
  const killedHolds = await holdsLock(ctx, killed)
  killed.child.kill('SIGTERM')
  const k = await killed.done
  const fourth = await start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '1')).done
  check('wait: a stopped waiter (SIGTERM) prints nothing and releases the lock',
    killedHolds && k.out === '' && signals(fourth.out).join() === 'NONE', `held the lock: ${killedHolds}\n${k.out}|${fourth.out}${fourth.err}`)

  // A second taker while a first one's request is live: the first gets the lock, the second exits 3
  // (one attempt each). The window is held open by stopping the holder (SIGSTOP), so its handler
  // can't claim the request until the second taker has met it; a fixed pause can't promise that.
  // The first taker is stopped too once its request is out, so its grace (counted in its own
  // pauses) can't run out and withdraw the request while the second one starts on a slow machine.
  const holder = start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '30'))
  const holderHolds = await holdsLock(ctx, holder)
  holder.child.kill('SIGSTOP')
  const a = start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '3'))
  const request = `${waitLock(ctx)}.takeover`
  const aAsked = await until(() => {
    try {
      return readFileSync(request, 'utf8') === String(a.child.pid)
    } catch {
      return false
    }
  })
  if (aAsked) a.child.kill('SIGSTOP')
  const rb = await start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '3')).done
  holder.child.kill('SIGCONT')
  a.child.kill('SIGCONT')
  const h = await holder.done
  // Never are both waiters gone: once the holder has left, the lock names the first taker.
  const aHolds = await holdsLock(ctx, a)
  const ra = await a.done
  check('wait: a taker that meets another taker\'s live request → WATCHER_RUNNING <holder>, exit 3; the first taker gets the lock and waits (exit 0); the holder exits 4',
    holderHolds && aAsked && aHolds && rb.code === 3 && rb.out === `WATCHER_RUNNING ${holder.child.pid}\n` && ra.code === 0 && signals(ra.out).join() === 'NONE' &&
      h.code === 4 && h.out === 'TAKEN_OVER\n',
    `holder held the lock: ${holderHolds}, a's request seen: ${aAsked}, a then held it: ${aHolds}\nholder ${h.code} ${h.out}| a ${ra.code} ${ra.out}${ra.err}| b ${rb.code} ${rb.out}${rb.err}`)

  // A taker that arrives after a takeover has finished finds the new holder, and takes the lock over
  // from it in turn: expected, not an error (the other order of "two at once").
  const c1 = start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '30'))
  const c1Holds = await holdsLock(ctx, c1)
  const c2 = start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '30'))
  const c2Holds = await holdsLock(ctx, c2)
  const c3 = start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '2'))
  const [r1, r2, r3] = await Promise.all([c1.done, c2.done, c3.done])
  check('wait: a taker that arrives after a completed takeover takes the lock over from the new holder → both earlier waiters exit 4, the last waits (exit 0)',
    c1Holds && c2Holds && r1.code === 4 && r2.code === 4 && r2.out === 'TAKEN_OVER\n' && r3.code === 0 && signals(r3.out).join() === 'NONE',
    `held: ${c1Holds} ${c2Holds}\n${r1.code} ${r1.out}| ${r2.code} ${r2.out}| ${r3.code} ${r3.out}${r3.err}`)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  // A lock that can't be verified is never taken over: the new waiter exits 3 as before and the
  // holder is left alone. The holders here are stand-ins, never this test's own process.
  const ctx = makeEnv()
  setFixture(ctx, watchReviewed)
  const stateDir = path.join(ctx.home, '.agent-loop', 'state')
  mkdirSync(stateDir, { recursive: true })
  const stateFile = path.join(stateDir, WATCH_STATE)
  const lockFile = stateFile.replace(/\.json$/, '-wait.lock')
  const script = path.join(scripts, 'pr-watch.mjs')
  // A stand-in that exits 9 on SIGUSR2 (so a signal shows), or ignores it. It says "ready" once its
  // handler is on: a signal before that would kill it by default and pass for a takeover.
  const standIn = (args, ignore = false) => {
    const proc = spawn('node', ['-e', `process.on('SIGUSR2',()=>{${ignore ? '' : 'process.exit(9)'}});process.stdout.write('ready');setInterval(()=>{},1000)`, ...args], { env: ctx.env })
    proc.said = ''
    proc.stdout.on('data', (d) => (proc.said += d))
    return proc
  }
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const tryWith = async (proc, lock) => {
    if (!(await until(() => proc.said === 'ready'))) {
      proc.kill('SIGKILL')
      return { code: 'stand-in never ready', out: '', err: '', stillAlive: false }
    }
    writeFileSync(lockFile, JSON.stringify({ pid: proc.pid, started: Date.now(), max: 3300, script, stateFile, ...lock }))
    const r = await start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '2')).done
    const stillAlive = alive(proc.pid)
    proc.kill('SIGKILL')
    rmSync(lockFile, { force: true })
    return { ...r, stillAlive }
  }
  const notWaiter = await tryWith(standIn([]))
  check('wait: a live process at the lock\'s pid that is not a waiter → exit 3, left alone',
    notWaiter.code === 3 && /^WATCHER_RUNNING \d+\n$/.test(notWaiter.out) && notWaiter.stillAlive, `${notWaiter.code} ${notWaiter.out}${notWaiter.err} alive ${notWaiter.stillAlive}`)
  const oldLock = await tryWith(standIn([script, '--wait']), { script: undefined, stateFile: undefined })
  check('wait: a lock without the script and state file (an older version\'s) → exit 3, its holder left alone',
    oldLock.code === 3 && oldLock.stillAlive, `${oldLock.code} ${oldLock.out}${oldLock.err} alive ${oldLock.stillAlive}`)
  const reused = await tryWith(standIn([script, '--wait']), { started: Date.now() - 600000 })
  check('wait: a holder that started long before the lock says (a reused pid) → exit 3, left alone',
    reused.code === 3 && reused.stillAlive, `${reused.code} ${reused.out}${reused.err} alive ${reused.stillAlive}`)
  const otherState = await tryWith(standIn([script, '--wait']), { stateFile: path.join(stateDir, 'other.json') })
  check('wait: a lock naming another state file → exit 3, its holder left alone',
    otherState.code === 3 && otherState.stillAlive, `${otherState.code} ${otherState.out}${otherState.err} alive ${otherState.stillAlive}`)
  const stubborn = await tryWith(standIn([script, '--wait'], true))
  check('wait: a verified holder that ignores the request → exit 3 after the grace period, still alive (no SIGKILL)',
    stubborn.code === 3 && stubborn.stillAlive && stubborn.ms >= 4500, `${stubborn.code} ${stubborn.ms}ms ${stubborn.out}${stubborn.err} alive ${stubborn.stillAlive}`)
  // The review of #118: a waiter from another plugin version runs the same script from another
  // folder; it is still this state file's waiter.
  const elsewhere = '/elsewhere/agent-loop/9.9.9/scripts/pr-watch.mjs'
  const otherVersion = await tryWith(standIn([elsewhere, '--wait']), { script: elsewhere })
  check('wait: a waiter running the script from another plugin folder (same name, same state file) is taken over',
    otherVersion.code === 0 && !otherVersion.stillAlive, `${otherVersion.code} ${otherVersion.out}${otherVersion.err} alive ${otherVersion.stillAlive}`)
  check('wait: … and no takeover request is left behind', !existsSync(`${lockFile}.takeover`), '')
  const verified = await tryWith(standIn([script, '--wait']))
  check('wait: … while the same stand-in that does leave on the request is taken over (the checks above are the only difference)',
    verified.code === 0 && !verified.stillAlive, `${verified.code} ${verified.out}${verified.err} alive ${verified.stillAlive}`)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  // The review of #118: a real waiter whose pass (slow gh calls) outlasts the taker's grace period
  // handles the signal only after the taker gave up and withdrew. It must keep waiting, never exit 4,
  // so one waiter is always left.
  const ctx = makeEnv()
  run(ctx, 'pr-watch.mjs', watchArgs(), watchReviewed)
  run(ctx, 'pr-watch.mjs', watchArgs(), watchReviewed)
  setFixture(ctx, { ...watchReviewed, delayMs: 2500 })
  const holder = start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '12'))
  // It takes the lock, then starts its first pass at once: the taker lands in that pass.
  const slowHolds = await holdsLock(ctx, holder)
  const taker = await start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '2')).done
  const h = await holder.done
  check('wait: a takeover that lands during the holder\'s slow pass → the taker exits 3 after its grace, and the holder keeps waiting (never exit 4)',
    slowHolds && taker.code === 3 && h.code === 0 && signals(h.out).join() === 'NONE', `held the lock: ${slowHolds}\ntaker ${taker.code} ${taker.out} | holder ${h.code} ${h.out}${h.err}`)
  check('wait: … and the withdrawn request is gone',
    !existsSync(path.join(ctx.home, '.agent-loop', 'state', WATCH_STATE.replace(/\.json$/, '-wait.lock.takeover'))), '')

  // A request whose taker is gone (stopped after signalling, before withdrawing) is not honoured.
  setFixture(ctx, watchReviewed)
  const lone = start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '4'))
  const loneHolds = await holdsLock(ctx, lone)
  const dead = spawnSync('node', ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout
  writeFileSync(path.join(ctx.home, '.agent-loop', 'state', WATCH_STATE.replace(/\.json$/, '-wait.lock.takeover')), dead)
  lone.child.kill('SIGUSR2')
  const l = await lone.done
  check('wait: a takeover request whose taker is gone → the holder keeps waiting (NONE at --max), never exit 4',
    loneHolds && l.code === 0 && signals(l.out).join() === 'NONE', `held the lock: ${loneHolds}\n${l.code} ${l.out}${l.err}`)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  setFixture(ctx, { fail: true })
  const w = start(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--max', '15'))
  // The API comes back only after the waiter has met (and logged) a failure.
  const failedOnce = await until(() => /retrying/.test(w.output().err))
  setFixture(ctx, watchFx)
  const r = await w.done
  check('wait: a transient API error is retried, not fatal', failedOnce && r.out === 'PENDING\n' && r.code === 0 && /retrying/.test(r.err), `saw a failure first: ${failedOnce}\ncode ${r.code}\n${r.out}${r.err}`)
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

// ---------------------------------------------------------------- audit.mjs, the auditor's numbers (#85)
{
  // One month: a prose-only PR gated in full (#10), a code PR with a run cancelled, a re-run after a
  // cancelled attempt, a re-run after a failure and two review rounds (#11), and an issue left blocked
  // for a day (#20). An in-progress lint run has no cost yet, so no lint finding may appear.
  const ctx = makeEnv()
  const at = (d) => `2026-03-${d}Z`
  const wfRun = (id, sha, start, end, extra = {}) => ({ id, path: '.github/workflows/ci.yml', head_sha: sha, status: 'completed', conclusion: 'success', run_attempt: 1, run_started_at: at(start), updated_at: at(end), ...extra })
  const fx = {
    prs: [
      { number: 10, createdAt: at('02T09:00:00'), closedAt: at('03T09:00:00'), mergedAt: at('03T09:00:00'), files: [{ path: 'README.md' }, { path: 'docs/guide.md' }] },
      { number: 11, createdAt: at('05T08:00:00'), closedAt: at('07T00:00:00'), mergedAt: at('07T00:00:00'), files: [{ path: 'src/a.js' }, { path: 'README.md' }] },
    ],
    prCommits: {
      10: [{ sha: 'a10', commit: { committer: { date: at('02T10:00:00') } } }],
      11: [{ sha: 'b11', commit: { committer: { date: at('05T09:00:00') } } }, { sha: 'c11', commit: { committer: { date: at('06T09:00:00') } } }],
    },
    runs: [
      wfRun(1001, 'a10', '02T10:01:00', '02T10:12:00'),
      wfRun(1101, 'b11', '05T09:01:00', '05T09:03:00', { conclusion: 'cancelled' }),
      wfRun(1102, 'b11', '05T09:05:00', '05T09:15:00', { run_attempt: 2 }),
      wfRun(1103, 'c11', '06T09:10:00', '06T09:15:00', { run_attempt: 2 }),
      wfRun(1201, 'a10', '02T10:01:00', '02T10:02:00', { path: '.github/workflows/lint.yml', status: 'in_progress', conclusion: null }),
      wfRun(9999, 'zzz', '05T09:00:00', '05T10:00:00'),
      wfRun(1301, 'a10', '02T10:05:00', '02T10:05:00', { path: '.github/workflows/docs.yml' }),
      wfRun(1302, 'b11', '05T09:05:00', '05T09:05:00', { path: '.github/workflows/docs.yml' }),
      wfRun(1401, 'a10', '02T10:01:00', '02T10:02:00', { path: '.github/workflows/build.yml' }),
      wfRun(1402, 'b11', '05T09:01:00', '05T09:11:00', { path: '.github/workflows/build.yml' }),
      wfRun(1403, 'c11', '06T09:01:00', '06T09:11:00', { path: '.github/workflows/build.yml' }),
      wfRun(1501, 'a10', '02T10:01:00', '02T10:03:00', { path: '.github/workflows/pages.yml' }),
    ],
    attempts: {
      '1102/1': wfRun(1102, 'b11', '05T09:03:00', '05T09:04:00', { conclusion: 'cancelled' }),
      '1103/1': wfRun(1103, 'c11', '06T09:01:00', '06T09:06:00', { conclusion: 'failure' }),
    },
    issueComments: {
      10: [],
      11: [comment('[reviewer] Review of b11.', at('05T12:00:00'), 'acme'), comment('[reviewer] LGTM', at('06T12:00:00'), 'acme'), comment('merging', at('06T20:00:00'), 'acme')],
      20: [comment('[executor] BLOCKED: waiting.', at('10T00:05:00'), 'acme'), comment('[dev] noted', at('10T01:00:00'), 'acme'), comment('ping', at('10T06:00:00'), 'stranger')],
      21: [],
      // Two executors claimed #22 three minutes apart: the claim comment settled a race.
      22: [comment('[executor] Claimed by exec-a', at('15T10:00:00'), 'acme'), comment('[executor] Claimed by exec-b', at('15T10:03:00'), 'acme')],
    },
    items: [{ number: 20, state: 'open', closed_at: null, labels: [] }, { number: 11, state: 'closed', closed_at: at('07T00:00:00') }, { number: 21, state: 'open', closed_at: null },
      { number: 22, state: 'open', closed_at: null }],
    events: {
      11: [{ event: 'labeled', label: { name: 'needs-operator' }, created_at: at('06T13:00:00') }],
      // A span wholly before the period, then the day-long one inside it.
      20: [{ event: 'labeled', label: { name: 'needs-operator' }, created_at: '2026-02-01T00:00:00Z' }, { event: 'unlabeled', label: { name: 'needs-operator' }, created_at: '2026-02-02T00:00:00Z' },
        { event: 'labeled', label: { name: 'is-blocked' }, created_at: at('10T00:00:00') }, { event: 'unlabeled', label: { name: 'is-blocked' }, created_at: at('11T00:00:00') }],
      // A span that crosses the period's end: cut at --until (the end of 2026-03-31).
      21: [{ event: 'labeled', label: { name: 'is-blocked' }, created_at: at('31T12:00:00') }, { event: 'unlabeled', label: { name: 'is-blocked' }, created_at: '2026-04-01T12:00:00Z' }],
      22: [{ event: 'labeled', label: { name: 'in-progress' }, created_at: at('15T10:00:00') }, { event: 'unlabeled', label: { name: 'in-progress' }, created_at: at('16T10:00:00') }],
    },
  }
  const audit = (extra = []) => run_(['--repo', REPO, '--since', '2026-03-01', '--until', '2026-03-31', '--format', 'json', ...extra])
  const run_ = (args) => {
    const out = run(ctx, 'audit.mjs', args, fx)
    try {
      return JSON.parse(out)
    } catch {
      return { error: out }
    }
  }
  const r = audit()
  const f = (id) => (r.findings ?? []).find((x) => x.id === id)
  const brief = JSON.stringify((r.findings ?? []).map((x) => [x.id, x.cost, x.caught, x.recommendation]))
  check('audit: a prose-only PR gated in full → ci-prose finding, its run\'s minutes, caught 0, narrow with the narrower rule',
    f('ci-prose:ci')?.cost === 11 && f('ci-prose:ci').caught === 0 && f('ci-prose:ci').recommendation === 'narrow' && /prose/.test(f('ci-prose:ci').rule) &&
      JSON.stringify(f('ci-prose:ci').prs) === '[10]', brief + (r.error ?? ''))
  check('audit: a cancelled run and a cancelled first attempt → cancelled cost 3 min over 2 runs, caught 0; the attempt after the cancel is no re-run cost (re-runs: 5 min, one attempt)',
    f('cancelled:ci')?.cost === 3 && f('cancelled:ci').runs === 2 && f('reruns:ci')?.cost === 5 && f('reruns:ci').runs === 1, brief)
  check('audit: a re-run that passed after a failed attempt (a flake) → caught 1, keep', f('reruns:ci')?.caught === 1 && f('reruns:ci').recommendation === 'keep', brief)
  check('audit: claim and release times are measured with no finding: the time held, the claim comments and a race settled within 10 minutes',
    !(r.findings ?? []).some((x) => x.id === 'claims') && JSON.stringify(r.claims) === JSON.stringify({ items: [22], minutes: 1440, claims: 2, races: 1 }) &&
      (r.notes ?? []).some((n) => n.startsWith('Claims: 1 item (#22) held `in-progress` for 1440 min')), JSON.stringify([r.claims, r.notes]))
  check('audit: an issue left blocked for a day with no operator comment (a stranger\'s, a role-prefixed and a [dev] one by the owner don\'t count) → caught 0, narrow',
    f('label:is-blocked')?.caught === 0 && f('label:is-blocked').recommendation === 'narrow', brief)
  check('audit: label time is clipped to the period: a span before it adds nothing, one crossing its end is cut there (1440 + 720 min)',
    f('label:is-blocked')?.cost === 2160 && f('label:is-blocked').spans === 2 && f('label:needs-operator')?.spans === 1, brief)
  check('audit: a workflow whose prose runs cost under half its code runs gets no ci-prose finding (it already skips the work)',
    !(r.findings ?? []).some((x) => x.id === 'ci-prose:build'), brief)
  check('audit: prose runs with no code run to compare → no finding, and a note says so',
    !(r.findings ?? []).some((x) => x.id === 'ci-prose:pages') && (r.notes ?? []).some((n) => n.startsWith('`ci-prose:pages`: no run on a code PR')), JSON.stringify(r.notes))
  const listed = audit(['--operators', '[@stranger, other]', '--floor', '[ci-prose:ci]'])
  const lf = (id) => (listed.findings ?? []).find((x) => x.id === id)
  check('audit: lists written as a block writes them ([a, b], @login) parse: a --operators login\'s comment catches; a bracketed --floor id is honoured',
    lf('label:is-blocked')?.caught === 1 && lf('label:is-blocked').recommendation === 'keep' && lf('ci-prose:ci')?.floor === true, JSON.stringify(listed))
  check('audit: a label that stayed on until the merge → caught, keep', f('label:needs-operator')?.cost === 660 && f('label:needs-operator').caught === 1 && f('label:needs-operator').recommendation === 'keep', brief)
  check('audit: review rounds → 2 rounds, 1 followed by a commit, 360 min from commit to review, keep',
    f('review-rounds')?.rounds === 2 && f('review-rounds').caught === 1 && f('review-rounds').cost === 360 && f('review-rounds').recommendation === 'keep', brief)
  check('audit: a run with no cost yet (in progress) gives no finding, and a run of no PR in the period is not counted',
    !(r.findings ?? []).some((x) => x.id.endsWith(':lint')) && !brief.includes('9999') && f('ci-prose:ci')?.runs === 1, brief)
  check('audit: a finding with a zero cost (a run that took no time) is not posted: both numbers or nothing',
    !(r.findings ?? []).some((x) => x.id.endsWith(':docs')), brief)
  check('audit: findings come in cost order', JSON.stringify((r.findings ?? []).map((x) => x.id)) ===
    JSON.stringify(['label:is-blocked', 'label:needs-operator', 'review-rounds', 'ci-prose:ci', 'reruns:ci', 'cancelled:ci']), brief)
  // #103 review: a re-run of a real failure caught nothing (the first attempt found it); one claim
  // per item settles no race.
  const rerunFx = (runs, attempts, extra = {}) => ({
    prs: [{ number: 31, createdAt: at('04T08:00:00'), closedAt: at('04T20:00:00'), mergedAt: null, files: [{ path: 'src/b.js' }] }],
    prCommits: { 31: [{ sha: 'd31', commit: { committer: { date: at('04T09:00:00') } } }] },
    runs, attempts, issueComments: { 31: [], ...(extra.comments ?? {}) }, items: extra.items ?? [], events: extra.events ?? {},
  })
  const det = run(ctx, 'audit.mjs', ['--repo', REPO, '--since', '2026-03-01', '--until', '2026-03-31', '--format', 'json'], rerunFx(
    [wfRun(3101, 'd31', '04T10:20:00', '04T10:30:00', { run_attempt: 3, conclusion: 'failure' })],
    { '3101/1': wfRun(3101, 'd31', '04T10:00:00', '04T10:10:00', { conclusion: 'failure' }), '3101/2': wfRun(3101, 'd31', '04T10:10:00', '04T10:20:00', { run_attempt: 2, conclusion: 'failure' }) },
    { comments: { 33: [comment('[executor] Claimed by exec-a', at('20T10:00:00'), 'acme')] }, items: [{ number: 33, state: 'open', closed_at: null }],
      events: { 33: [{ event: 'labeled', label: { name: 'in-progress' }, created_at: at('20T10:00:00') }, { event: 'unlabeled', label: { name: 'in-progress' }, created_at: at('20T12:00:00') }] } }))
  const detF = (id) => (JSON.parse(det.startsWith('{') ? det : '{}').findings ?? []).find((x) => x.id === id)
  check('audit: a deterministic failure re-run twice → cost of attempts 2 and 3 (20 min), caught 0, narrow with the never-again rule',
    detF('reruns:ci')?.cost === 20 && detF('reruns:ci').runs === 2 && detF('reruns:ci').caught === 0 && detF('reruns:ci').recommendation === 'narrow' &&
      /never again after it fails a second time/.test(detF('reruns:ci').rule), det)
  const detJ = JSON.parse(det.startsWith('{') ? det : '{}')
  check('audit: a single long claim gives no claims finding; it is measured (120 min held, one claim, no race)',
    !detF('claims') && JSON.stringify(detJ.claims) === JSON.stringify({ items: [33], minutes: 120, claims: 1, races: 0 }), det)
  const resumed = run(ctx, 'audit.mjs', ['--repo', REPO, '--since', '2026-03-01', '--until', '2026-03-31', '--format', 'json'], rerunFx(
    [wfRun(3301, 'd31', '04T10:02:00', '04T10:12:00', { run_attempt: 2 })], { '3301/1': wfRun(3301, 'd31', '04T10:00:00', '04T10:02:00', { conclusion: 'cancelled' }) }))
  const resumedJ = JSON.parse(resumed.startsWith('{') ? resumed : '{}')
  check('audit: a cancelled attempt re-run to a pass → no reruns finding (the head needed a result); cancelled:ci costs the 2 cancelled minutes',
    !(resumedJ.findings ?? []).some((x) => x.id === 'reruns:ci') && (resumedJ.findings ?? []).find((x) => x.id === 'cancelled:ci')?.cost === 2, resumed)
  const flake = run(ctx, 'audit.mjs', ['--repo', REPO, '--since', '2026-03-01', '--until', '2026-03-31', '--format', 'json'], rerunFx(
    [wfRun(3201, 'd31', '04T10:10:00', '04T10:20:00', { run_attempt: 2 })], { '3201/1': wfRun(3201, 'd31', '04T10:00:00', '04T10:10:00', { conclusion: 'failure' }) }))
  const flakeF = (JSON.parse(flake.startsWith('{') ? flake : '{}').findings ?? []).find((x) => x.id === 'reruns:ci')
  check('audit: a flake (failure, then a pass on re-run) → cost of the re-run alone (10 min), caught 1, keep',
    flakeF?.cost === 10 && flakeF.caught === 1 && flakeF.recommendation === 'keep', flake)
  const fl = audit(['--floor', 'ci-prose:ci,label:typo'])
  const flp = (fl.findings ?? []).find((x) => x.id === 'ci-prose:ci')
  check('audit: a floor control keeps its cost but gets no recommendation; a floor id that matched nothing is listed',
    flp?.cost === 11 && flp.floor === true && flp.recommendation === null && flp.rule === null && JSON.stringify(fl.unmatchedFloor) === '["label:typo"]', JSON.stringify(fl))
  const md = run(ctx, 'audit.mjs', ['--repo', REPO, '--since', '2026-03-01', '--until', '2026-03-31', '--floor', 'ci-prose:ci'], fx)
  const section = md.split('\n### ').find((s) => s.startsWith('`ci-prose:ci`')) ?? ''
  check('audit md: the header names the period and the exact arguments to reproduce it; a floor line is cost only; PRs by number',
    md.startsWith('# [auditor] Audit 2026-03-01..2026-03-31\n') && md.includes('Reproduce: `node scripts/audit.mjs --repo acme/widgets --since 2026-03-01T00:00:00Z --until 2026-03-31T23:59:59Z --floor ci-prose:ci`') &&
      section.includes('In `audit-floor`: cost only') && !section.includes('Recommendation') && section.includes('#10'), md)
  const bad = run(ctx, 'audit.mjs', ['--repo', REPO], fx)
  check('audit: no --since → usage error, exit 1', /^EXIT 1/.test(bad) && /--since is required/.test(bad), bad)
  const failed = run(ctx, 'audit.mjs', ['--repo', REPO, '--since', '7d'], { fail: true })
  check('audit: a failed gh call → one audit: line, exit 2', /^EXIT 2\n\naudit: HTTP 502/.test(failed), failed)
  // An auditor's report is an issue for the operator: no executor may pick it as work.
  const picked = run(ctx, 'pick-next.mjs', ['--repo', REPO], { issues: [{ number: 5, title: 'a', body: '', labels: [{ name: 'auditor-report' }] }, { number: 6, title: 'b', body: '', labels: [] }] }).trim()
  const own = run(ctx, 'pick-next.mjs', ['--repo', REPO], { issues: [{ number: 5, title: 'a', body: '', labels: [{ name: 'audit' }] }, { number: 6, title: 'b', body: '', labels: [] }] }).trim()
  check('pick: an issue labelled auditor-report is never picked; a project\'s own audit label is not that label', picked === 'ISSUE:6' && own === 'ISSUE:5', `${picked} ${own}`)
  rmSync(ctx.home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- already read before the role's own post (#28)
// A consumer's case: the executor pushes, the reviewer's one-shot run prints REVIEW, the executor's comment
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
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(seed, name)), { recursive: true })
      writeFileSync(path.join(seed, name), text)
    }
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
  // #106: a gate that stands for a push during a run. It rewrites the fixture's listing (the fake
  // gh reads it on every call) from inside the gate, then works for a while.
  const relist = (edits) =>
    `node -e "const fs=require('fs');const f=process.env.FAKE_GH_FIXTURE;const x=JSON.parse(fs.readFileSync(f,'utf8'));const e=${JSON.stringify(edits).replace(/"/g, "'")};` +
    `x.prs=x.prs.filter(p=>e[p.number]!=='closed').map(p=>e[p.number]?Object.assign({},p,{headRefOid:e[p.number]}):p);fs.writeFileSync(f+'.t',JSON.stringify(x));fs.renameSync(f+'.t',f)"`
  const s41 = makePr(41, '41')
  const s41b = makePr(41, '41b')
  const s43 = makePr(43, '43')
  const s40 = makePr(40, { 'pr.txt': '40\n', 'gate.sh': `echo "start 40 $(git rev-parse HEAD)" >> "$TRACE"\n${relist({ 41: s41b, 43: 'closed' })}\necho "40 passed"\n` })
  writeFileSync(ctx.log, '')
  const out40 = lci({ prs: [pr(40, s40), pr(41, s41), pr(43, s43)], statuses: {} })
  check('local-ci: a queued head its PR no longer has is never run: error "superseded by <sha>: not run"',
    states(s41) === 'pending,error' && statuses()[s41][1].description === `superseded by ${s41b.slice(0, 7)}: not run` &&
      !traceText().includes(`start 41 ${s41}`) && out40.includes(`#41 ${s41.slice(0, 7)} error: superseded by ${s41b.slice(0, 7)}: not run`),
    `${out40}${JSON.stringify(statuses()[s41])}`)
  check('local-ci: … a queued head whose PR closed is not run and gets no further post (it stays as it was)',
    states(s43) === 'pending' && !traceText().includes('start 43 ') && !out40.includes('#43 '), `${out40}${JSON.stringify(statuses()[s43])}`)
  check('local-ci: … and the run before them finished as usual', states(s40) === 'pending,success' && statuses()[s40][1].description === '40 passed', JSON.stringify(statuses()[s40]))

  // A push while a gate runs: the new head is pending before that run ends (--wait 1: a light poll
  // every second while the gate runs).
  const s45 = makePr(45, '45')
  const s45b = makePr(45, '45b')
  const s44 = makePr(44, { 'pr.txt': '44\n', 'gate.sh': `echo "start 44 $(git rev-parse HEAD)" >> "$TRACE"\n${relist({ 45: s45b })}\nsleep 4\necho "44 passed"\n` })
  writeFileSync(ctx.log, '')
  // #45's old head is already done, so the pass queues only #44; its gate moves #45 to a new head
  // with no status.
  setFixture(ctx, { prs: [pr(44, s44), pr(45, s45)], statuses: { [s45]: [{ state: 'success', context: 'local-ci', description: 'all 3 passed' }] } })
  const wp = spawn('node', [path.join(scripts, 'local-ci.mjs'), '--repo', REPO, '--gate', 'sh gate.sh', '--wait', '1'], { cwd: runner, env })
  const until = async (cond, ms = 20000) => {
    const t0 = Date.now()
    while (!cond() && Date.now() - t0 < ms) await pause(100)
    return cond()
  }
  await until(() => states(s44) === 'pending,success')
  const posted = readFileSync(ctx.log, 'utf8').split('\n').filter((l) => l.includes('/statuses/') && l.includes('POST'))
  const pendingAt = posted.findIndex((l) => l.includes(`/statuses/${s45b}`) && l.includes('state=pending'))
  const doneAt = posted.findIndex((l) => l.includes(`/statuses/${s44}`) && l.includes('state=success'))
  check('local-ci --wait: a head pushed while a gate runs is pending before that run ends',
    pendingAt !== -1 && doneAt !== -1 && pendingAt < doneAt, posted.join('\n'))
  await until(() => states(s45b) === 'pending,success')
  wp.kill('SIGTERM')
  await new Promise((r) => (wp.exitCode !== null ? r() : wp.on('close', r)))
  check('local-ci --wait: … and runs in a later pass, once (no second pending)', states(s45b) === 'pending,success' && traceText().includes(`start 45b ${s45b}`), JSON.stringify(statuses()[s45b]))

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

  // --install (#111): the install runs when the head's lockfiles differ from those of the clone's last
  // successful install, in either direction. It records the head it ran on in $TRACE.install.
  const stateDir = path.join(ctx.home, '.agent-loop', 'state')
  const installRecords = () => readdirSync(stateDir).filter((f) => f.startsWith('local-ci-install-'))
  check('local-ci: without --install, no install record is written', installRecords().length === 0, installRecords().join())
  const INSTALL = 'echo "install $(git rev-parse HEAD)" >> "$TRACE.install"; if [ -f fail-install ]; then echo "npm ERR! could not resolve"; exit 1; fi; echo "added 1 package"'
  const installs = () => {
    try {
      return readFileSync(`${trace}.install`, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')[1])
    } catch {
      return []
    }
  }
  const lciI = (n, sha, extra = []) => lci({ prs: [pr(n, sha)], statuses: {} }, ['--install', INSTALL, ...extra])
  const installedFor = (sha, f) => {
    const before = installs().length
    const out = f()
    return { out, installed: installs().slice(before).includes(sha) && installs().length === before + 1, ran: installs().length > before }
  }
  const lockA = '{"packages":{"left-pad":"1.0.0"}}\n'
  const lockB = '{"packages":{"left-pad":"1.0.0","is-odd":"3.0.1"}}\n'
  const s20 = makePr(20, { 'pr.txt': '20\n', 'package-lock.json': lockA })
  const r20 = installedFor(s20, () => lciI(20, s20))
  const log20 = readdirSync(logDir).find((f) => f.startsWith(`20-${s20.slice(0, 12)}-`))
  const log20Text = log20 ? readFileSync(path.join(logDir, log20), 'utf8') : ''
  check('local-ci --install: no record yet → the install runs before the gate, and the record is written',
    r20.installed && states(s20) === 'pending,success' && statuses()[s20][1].description === 'all 3 passed' && installRecords().length === 1,
    `${r20.out}${installs()}${JSON.stringify(statuses()[s20])}`)
  check('local-ci --install: … the install\'s output and then the gate\'s go to the run\'s log',
    /added 1 package[\s\S]*all 3 passed/.test(log20Text), log20Text)
  const s21 = makePr(21, { 'pr.txt': '21\n', 'package-lock.json': lockA })
  const r21 = installedFor(s21, () => lciI(21, s21))
  check('local-ci --install: a head with the same lockfiles → no install, the gate runs',
    !r21.ran && states(s21) === 'pending,success' && traceText().includes(`start 21 ${s21}`), `${r21.out}${installs()}`)
  const s22 = makePr(22, { 'pr.txt': '22\n', 'package-lock.json': lockB })
  const r22 = installedFor(s22, () => lciI(22, s22))
  check('local-ci --install: a head that adds a package → install', r22.installed && states(s22) === 'pending,success', `${r22.out}${installs()}`)
  const s23 = makePr(23, { 'pr.txt': '23\n', 'package-lock.json': lockA })
  const r23 = installedFor(s23, () => lciI(23, s23))
  check('local-ci --install: the next head, which removes it again → install (either direction)', r23.installed && states(s23) === 'pending,success', `${r23.out}${installs()}`)
  const s27 = makePr(27, '27')
  const r27 = installedFor(s27, () => lciI(27, s27))
  check('local-ci --install: a head with no lockfile at all, after one with → install', r27.installed && states(s27) === 'pending,success', `${r27.out}${installs()}`)
  const s28 = makePr(28, { 'pr.txt': '28\n', 'sub/pkg/yarn.lock': 'left-pad@1\n' })
  const r28 = installedFor(s28, () => lciI(28, s28))
  check('local-ci --install: a lockfile in a subfolder counts', r28.installed, `${r28.out}${installs()}`)

  const s24 = makePr(24, { 'pr.txt': '24\n', 'package-lock.json': lockB, 'fail-install': 'x\n' })
  const r24 = installedFor(s24, () => lciI(24, s24))
  check('local-ci --install: a failed install → error "install failed: <its last line>", the gate does not run, no record left',
    r24.installed && states(s24) === 'pending,error' && statuses()[s24][1].description === 'install failed: npm ERR! could not resolve' &&
    r24.out.includes(`#24 ${s24.slice(0, 7)} error: install failed: npm ERR! could not resolve`) && !traceText().includes(`start 24 `) &&
    installRecords().length === 0, `${r24.out}${JSON.stringify(statuses()[s24])}${installRecords()}`)
  // The head gated before the failed install (#28) had these lockfiles; the failed install may have
  // changed what is installed, so it installs again.
  const s25 = makePr(25, { 'pr.txt': '25\n', 'sub/pkg/yarn.lock': 'left-pad@1\n' })
  const r25 = installedFor(s25, () => lciI(25, s25))
  check('local-ci --install: after a failed install, a head with the last good install\'s lockfiles installs again',
    r25.installed && states(s25) === 'pending,success' && installRecords().length === 1, `${r25.out}${installs()}`)

  const s29 = makePr(29, { 'pr.txt': '29\n', 'deps.txt': 'x\n', 'package-lock.json': lockA })
  const s30 = makePr(30, { 'pr.txt': '30\n', 'deps.txt': 'x\n', 'package-lock.json': lockB })
  const r29 = installedFor(s29, () => lciI(29, s29, ['--lockfiles', 'deps.txt']))
  const r30 = installedFor(s30, () => lciI(30, s30, ['--lockfiles', 'deps.txt']))
  check('local-ci --install: --lockfiles replaces the list (deps.txt counts, package-lock.json no longer does)',
    r29.installed && !r30.ran && states(s30) === 'pending,success', `${r29.out}${r30.out}${installs()}`)
  const s31 = makePr(31, { 'pr.txt': '31\n', 'deps.txt': 'x\n' })
  const r31 = installedFor(s31, () => lciI(31, s31, ['--lockfiles', './deps.txt']))
  check('local-ci --install: a --lockfiles entry with a slash is a path from the clone\'s root', !r31.ran, `${r31.out}${installs()}`)
  const s32 = makePr(32, { 'pr.txt': '32\n', 'deps.txt': 'x\n' })
  const before32 = installs().length
  const out32 = lci({ prs: [pr(32, s32)], statuses: {} }, ['--install', `${INSTALL} # v2`, '--lockfiles', 'deps.txt'])
  check('local-ci --install: a changed install command → install', installs().length === before32 + 1, `${out32}${installs()}`)
  const s33 = makePr(33, { 'pr.txt': '33\n', 'deps.txt': 'y\n', 'gate.sh': 'exit 0\n' })
  lciI(33, s33, ['--lockfiles', 'deps.txt'])
  check('local-ci --install: the description is the gate\'s own last line, never the install\'s',
    states(s33) === 'pending,success' && statuses()[s33][1].description === 'gate passed', JSON.stringify(statuses()[s33]))
  // A tree whose full listing is over 1 MiB (execFileSync's default buffer): only the lockfiles are listed.
  const bigTree = { 'pr.txt': '35\n', 'package-lock.json': '{"big":1}\n' }
  for (let i = 0; i < 3000; i++) bigTree[`gen/${'d'.repeat(200)}/${'f'.repeat(150)}${i}.txt`] = ''
  const s35 = makePr(35, bigTree)
  const r35 = installedFor(s35, () => lciI(35, s35))
  check('local-ci --install: a tree listing over 1 MiB → the install and the gate run (success, not error)',
    r35.installed && states(s35) === 'pending,success', `${r35.out}${JSON.stringify(statuses()[s35])}`)
  // A run without --install may change what is installed: it removes the record, so the next
  // --install run installs even for the same lockfiles.
  const hadRecord = installRecords().length === 1
  lci({ prs: [], statuses: {} })
  const s36 = makePr(36, { 'pr.txt': '36\n', 'package-lock.json': '{"big":1}\n' })
  const r36 = installedFor(s36, () => lciI(36, s36))
  check('local-ci: a run without --install removes the record; the next --install run installs for the same lockfiles',
    hadRecord && r36.installed && states(s36) === 'pending,success', `${hadRecord}${r36.out}${installs()}`)
  const noInstall = lci(null, ['--install', ''])
  const lockOnly = lci(null, ['--lockfiles', 'deps.txt'])
  check('local-ci: --install with no command, and --lockfiles without --install → exit 1',
    noInstall.startsWith('EXIT 1') && /--install/.test(noInstall) && lockOnly.startsWith('EXIT 1') && /--lockfiles needs --install/.test(lockOnly), `${noInstall}${lockOnly}`)

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

  // A stop during an install stops the install; it leaves no record, so the next start installs again.
  const s34 = makePr(34, { 'pr.txt': '34\n', 'package-lock.json': '{"stop":1}\n' })
  setFixture(ctx, { prs: [pr(34, s34)], statuses: {} })
  const wi = spawn('node', [path.join(scripts, 'local-ci.mjs'), '--repo', REPO, '--gate', 'sh gate.sh', '--install', 'echo $$ > "$TRACE.ipid"; sleep 30', '--wait', '1'], { cwd: runner, env })
  const iStarted = await waitFor(() => existsSync(`${trace}.ipid`))
  const installPid = iStarted ? Number(readFileSync(`${trace}.ipid`, 'utf8')) : 0
  wi.kill('SIGTERM')
  await new Promise((r) => (wi.exitCode !== null ? r() : wi.on('close', r)))
  await pause(300)
  let installAlive = false
  try {
    process.kill(installPid, 0)
    installAlive = true
  } catch {
    // gone
  }
  check('local-ci --wait --install: a stop stops a running install; no record is left and the head stays pending',
    iStarted && !installAlive && installRecords().length === 0 && states(s34) === 'pending' && !traceText().includes(`start 34 `),
    `${iStarted} ${installAlive} ${installRecords()} ${states(s34)}`)
  rmSync(ctx.home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- inbox.mjs (#77)
// Needs no gh. Each case gets a fresh HOME (the record) and a folder; `cwd` is a clone stand-in.
function inbox(ctx, args, cwd = ctx.home) {
  const r = spawnSync('node', [path.join(scripts, 'inbox.mjs'), ...args], { env: ctx.env, cwd, encoding: 'utf8' })
  return { out: r.stdout, err: r.stderr, code: r.status }
}
// An A2A 1.0 Message; `meta` overrides keys in its metadata (from, to, sentAt).
const message = (id, extra = {}, meta = {}) => ({
  messageId: id,
  role: 'ROLE_USER',
  contextId: 'acme/widgets#7',
  parts: [{ text: 'rebase on main' }],
  metadata: { from: 'operator', to: 'executor', sentAt: '2026-01-01T10:00:00Z', ...meta },
  ...extra,
})
// A home-relative folder as a block names it (a tilde, then the path), here under the test HOME's
// .agent-loop. Built with path.join: second-read refuses a tilde path written out in code.
const homeRel = (...p) => path.join('~', '.agent-loop', ...p)
const putMessage = (dir, id, extra, meta) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(message(id, extra, meta)))
}
{
  const ctx = makeEnv()
  const dir = path.join(ctx.home, 'box')
  const read = () => inbox(ctx, ['--dir', dir])
  const missing = read()
  check('inbox: no such folder → NONE, exit 0', signals(missing.out).join() === 'NONE' && missing.code === 0, JSON.stringify(missing))
  putMessage(dir, 'm1')
  const first = read()
  check('inbox: a new message file → one line, MESSAGE:<messageId>', first.out === 'MESSAGE:m1\n' && first.code === 0, JSON.stringify(first))
  const again = read()
  check('inbox: … a reported message is not reported again → NONE', signals(again.out).join() === 'NONE', again.out)
  putMessage(dir, 'a-late', {}, { sentAt: '2026-01-02T10:00:00Z' })
  putMessage(dir, 'z-early', {}, { sentAt: '2026-01-01T11:00:00Z' })
  const two = read()
  check('inbox: two new messages → one line each, oldest metadata.sentAt first (not by name)', two.out === 'MESSAGE:z-early\nMESSAGE:a-late\n', two.out)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const dir = path.join(ctx.home, 'box')
  mkdirSync(dir)
  const body = JSON.stringify(message('t1'))
  writeFileSync(path.join(dir, '.t1.4242.tmp'), body)
  writeFileSync(path.join(dir, 't1.json.tmp'), body)
  writeFileSync(path.join(dir, '.t1.json'), JSON.stringify(message('.t1')))
  writeFileSync(path.join(dir, '._t1.json'), 'AppleDouble junk')
  writeFileSync(path.join(dir, 't1.txt'), body)
  mkdirSync(path.join(dir, 'd1.json'))
  writeFileSync(path.join(ctx.home, 'outside.json'), JSON.stringify(message('s1')))
  symlinkSync(path.join(ctx.home, 'outside.json'), path.join(dir, 's1.json'))
  const r = inbox(ctx, ['--dir', dir])
  check('inbox: temporary names, dotfiles, other extensions, folders and symlinks are not messages → NONE', signals(r.out).join() === 'NONE' && r.code === 0, JSON.stringify(r))
  renameSync(path.join(dir, '.t1.4242.tmp'), path.join(dir, 't1.json'))
  const renamed = inbox(ctx, ['--dir', dir])
  check('inbox: … the temporary file renamed to its message name → MESSAGE:t1', renamed.out === 'MESSAGE:t1\n', renamed.out)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const dir = path.join(ctx.home, 'box')
  mkdirSync(dir)
  writeFileSync(path.join(dir, 'bad.json'), '{"messageId": "bad", ')
  putMessage(dir, 'other', { messageId: 'not-other' })
  putMessage(dir, 'norole', { role: 'user' })
  putMessage(dir, 'noparts', { parts: [] })
  putMessage(dir, 'kindonly', { parts: [{ kind: 'text' }] })
  putMessage(dir, 'twocontent', { parts: [{ text: 'a', data: { b: 1 } }] })
  putMessage(dir, 'toplevel', { from: 'operator' })
  putMessage(dir, 'nometa', { metadata: undefined })
  putMessage(dir, 'nofrom', {}, { from: '' })
  putMessage(dir, 'baddate', {}, { sentAt: 'soon' })
  putMessage(dir, 'ok')
  putMessage(dir, 'okparts', { parts: [{ data: null }, { url: 'https://example.com/a.txt', mediaType: 'text/plain', filename: 'a.txt', metadata: {} }, { raw: 'aGk=' }] },
    { sentAt: '2026-01-01T10:01:00Z', priority: 'high' })
  const r = inbox(ctx, ['--dir', dir])
  const lines = r.out.trim().split('\n')
  check('inbox: A2A 1.0 parts (data, a url with mediaType/filename/metadata, raw) and other metadata keys are valid; the rest → INVALID:<name>, after the valid ones',
    lines.slice(0, 2).join() === 'MESSAGE:ok,MESSAGE:okparts' &&
    lines.slice(2).sort().join() === 'INVALID:bad,INVALID:baddate,INVALID:kindonly,INVALID:nofrom,INVALID:nometa,INVALID:noparts,INVALID:norole,INVALID:other,INVALID:toplevel,INVALID:twocontent' && r.code === 0, r.out)
  check('inbox: … each with its reason on stderr (an A2A 0.3 role "user", a part with only a kind, two content fields)',
    /bad\.json: unreadable/.test(r.err) && /other\.json: messageId is not the file name/.test(r.err) && /norole\.json: role must be ROLE_USER or ROLE_AGENT/.test(r.err) &&
    /noparts\.json: parts/.test(r.err) && /kindonly\.json: every part needs exactly one of/.test(r.err) && /twocontent\.json: every part needs exactly one of/.test(r.err), r.err)
  check('inbox: … from, to and sentAt only in metadata (top-level from, no metadata, an empty metadata.from, a metadata.sentAt that is not a date)',
    /toplevel\.json: from belongs in metadata/.test(r.err) && /nometa\.json: metadata must be an object/.test(r.err) &&
    /nofrom\.json: metadata\.from must be/.test(r.err) && /baddate\.json: metadata\.sentAt must be a date/.test(r.err), r.err)
  const again = inbox(ctx, ['--dir', dir])
  check('inbox: … and reported once, like a message', signals(again.out).join() === 'NONE' && again.err === '', JSON.stringify(again))
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const dir = path.join(ctx.home, 'box')
  putMessage(dir, 'gone')
  putMessage(dir, 'stays')
  inbox(ctx, ['--dir', dir])
  rmSync(path.join(dir, 'gone.json'))
  inbox(ctx, ['--dir', dir])
  const stateDir = path.join(ctx.home, '.agent-loop', 'state')
  const record = readdirSync(stateDir).filter((f) => /^inbox-[0-9a-f]{16}\.json$/.test(f))
  const state = record.length === 1 ? JSON.parse(readFileSync(path.join(stateDir, record[0]), 'utf8')) : null
  check('inbox: the record is one file per folder, pruned to the files still there', state?.reported.join() === 'stays', `${record} ${JSON.stringify(state)}`)
  const other = path.join(ctx.home, 'box2')
  putMessage(other, 'gone')
  const r = inbox(ctx, ['--dir', other])
  check('inbox: … another folder keeps its own record (the same id there is new)', r.out === 'MESSAGE:gone\n', r.out)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const dir = path.join(ctx.home, 'box')
  putMessage(dir, 'seen')
  inbox(ctx, ['--dir', dir])
  const quiet = await start(ctx, 'inbox.mjs', ['--dir', dir, '--wait', '1', '--max', '2']).done
  check('inbox --wait: nothing new → NONE at --max, exit 0', signals(quiet.out).join() === 'NONE' && quiet.ms >= 2000 && quiet.code === 0, `${quiet.ms}ms\n${quiet.out}${quiet.err}`)
  const w = start(ctx, 'inbox.mjs', ['--dir', dir, '--wait', '1', '--max', '15'])
  await pause(1500)
  const t0 = Date.now()
  putMessage(dir, 'new')
  const r = await w.done
  const after = Date.now() - t0
  check('inbox --wait: a new file → PENDING within one poll (1 s here), exit 0', r.out === 'PENDING\n' && r.code === 0 && after < 2500, `${after}ms after the write\n${r.out}${r.err}`)
  const next = inbox(ctx, ['--dir', dir])
  check('inbox --wait: … the waiter recorded nothing, so the next run reports it', next.out === 'MESSAGE:new\n', next.out)
  const missing = await start(ctx, 'inbox.mjs', ['--dir', path.join(ctx.home, 'nope'), '--wait', '1', '--max', '2']).done
  check('inbox --wait: no such folder → keeps polling, NONE at --max', signals(missing.out).join() === 'NONE' && missing.ms >= 2000 && missing.code === 0, `${missing.ms}ms\n${missing.out}${missing.err}`)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const dir = path.join(ctx.home, 'shared', 'box')
  const sent = inbox(ctx, ['--send', '--dir', dir, '--role', 'ROLE_AGENT', '--from', 'executor', '--to', 'operator', '--context', 'acme/widgets#7', '--task', 'recheck abc123', '--text', 'Pushed the fix.\nSecond line.'])
  const id = /^SENT:([0-9a-f-]{36})\n$/.exec(sent.out)?.[1]
  check('inbox --send: prints SENT:<messageId>, exit 0, creating the folder', id && sent.code === 0, JSON.stringify(sent))
  const files = readdirSync(dir)
  const msg = JSON.parse(readFileSync(path.join(dir, `${id}.json`), 'utf8'))
  check('inbox --send: one file, <messageId>.json, no temporary file left', files.join() === `${id}.json`, files.join())
  check('inbox --send: the fields, with messageId and metadata.sentAt filled in, and only A2A 1.0 Message fields at the top level',
    msg.messageId === id && msg.role === 'ROLE_AGENT' && msg.contextId === 'acme/widgets#7' && msg.taskId === 'recheck abc123' &&
    JSON.stringify(Object.keys(msg.metadata).sort()) === '["from","sentAt","to"]' &&
    msg.metadata.from === 'executor' && msg.metadata.to === 'operator' && JSON.stringify(msg.parts) === JSON.stringify([{ text: 'Pushed the fix.\nSecond line.' }]) &&
    Math.abs(Date.parse(msg.metadata.sentAt) - Date.now()) < 60000 &&
    Object.keys(msg).every((k) => ['messageId', 'role', 'contextId', 'taskId', 'parts', 'metadata'].includes(k)), JSON.stringify(msg))
  const read = inbox(ctx, ['--dir', dir])
  check('inbox --send: … and inbox.mjs then reports it', read.out === `MESSAGE:${id}\n`, read.out)
  const noTask = inbox(ctx, ['--send', '--dir', dir, '--role', 'ROLE_USER', '--from', 'o', '--to', 'e', '--context', 'acme/widgets#8', '--text', 'go'])
  const noTaskId = /^SENT:(\S+)\n$/.exec(noTask.out)?.[1]
  const plain = noTaskId ? JSON.parse(readFileSync(path.join(dir, `${noTaskId}.json`), 'utf8')) : {}
  check('inbox --send: without --task there is no taskId field', noTaskId && !('taskId' in plain) && plain.role === 'ROLE_USER', JSON.stringify(plain))
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const dir = path.join(ctx.home, 'box')
  const ok = ['--role', 'ROLE_USER', '--from', 'o', '--to', 'e', '--context', 'c', '--text', 't']
  const without = (flag) => ok.filter((_, i) => ok[i] !== flag && ok[i - 1] !== flag)
  const cases = [
    ['no --role', without('--role')],
    ['--role system', ['--role', 'system', ...without('--role')]],
    ['--role user (A2A 0.3)', ['--role', 'user', ...without('--role')]],
    ['no --from', without('--from')],
    ['no --to', without('--to')],
    ['no --context', without('--context')],
    ['no --text', without('--text')],
    ['an empty --text', [...without('--text'), '--text', '']],
    ['--task with no value', [...ok, '--task']],
    ['--wait', [...ok, '--wait', '1']],
  ]
  for (const [name, args] of cases) {
    const r = inbox(ctx, ['--send', '--dir', dir, ...args])
    check(`inbox --send: ${name} → usage error, exit 1, nothing written`, r.code === 1 && /Usage: inbox\.mjs/.test(r.err) && !existsSync(dir), JSON.stringify(r))
  }
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  // A reply copies to, contextId and taskId from the message (#80 review): nothing the writer
  // chose passes through the shell, and a value split by the shell fails loudly.
  const ctx = makeEnv()
  const inb = path.join(ctx.home, 'in')
  const out = path.join(ctx.home, 'out')
  putMessage(inb, 'm1', { taskId: 'recheck abc1234', contextId: 'owner/repo#123' }, { from: 'operator (host); $(touch x)' })
  const r = inbox(ctx, ['--send', '--dir', out, '--reply-to', 'm1', '--inbox', inb, '--from', 'review-clone', '--text', 'Rechecked.'])
  const id = /^SENT:(\S+)\n$/.exec(r.out)?.[1]
  let reply = null
  try {
    reply = JSON.parse(readFileSync(path.join(out, `${id}.json`), 'utf8'))
  } catch {
    // checked below
  }
  check('inbox --send --reply-to: the reply carries the message\'s taskId, contextId and from as to, exactly, as ROLE_AGENT',
    r.code === 0 && reply?.taskId === 'recheck abc1234' && reply?.contextId === 'owner/repo#123' && reply?.metadata.to === 'operator (host); $(touch x)' && reply?.metadata.from === 'review-clone' && reply?.role === 'ROLE_AGENT' && reply?.parts[0].text === 'Rechecked.',
    JSON.stringify({ r, reply }))
  putMessage(inb, 'bad', { role: 'user' })
  const refusals = [
    ['an invalid message', ['--reply-to', 'bad', '--inbox', inb]],
    ['a missing message', ['--reply-to', 'gone', '--inbox', inb]],
    ['a traversal id', ['--reply-to', '../in/m1', '--inbox', path.join(ctx.home, 'x')]],
    ['no --inbox', ['--reply-to', 'm1']],
    ['a --task beside it', ['--reply-to', 'm1', '--inbox', inb, '--task', 't']],
    ['a --to beside it', ['--reply-to', 'm1', '--inbox', inb, '--to', 'someone']],
  ]
  const outbox2 = path.join(ctx.home, 'out2')
  for (const [name, args] of refusals) {
    const x = inbox(ctx, ['--send', '--dir', outbox2, ...args, '--from', 'e', '--text', 't'])
    check(`inbox --send --reply-to: ${name} → usage error, exit 1, nothing written`, x.code === 1 && /Usage: inbox\.mjs/.test(x.err) && !existsSync(outbox2), JSON.stringify(x))
  }
  const split = inbox(ctx, ['--send', '--dir', outbox2, '--role', 'ROLE_AGENT', '--from', 'e', '--to', 'o', '--context', 'c', '--task', 'recheck', 'abc1234', '--text', 't'])
  check('inbox --send: --task recheck abc1234 (a value the shell split) → usage error naming the stray word, exit 1, nothing written',
    split.code === 1 && /unexpected argument "abc1234"/.test(split.err) && !existsSync(outbox2), JSON.stringify(split))
  const stray = inbox(ctx, ['--dir', inb, 'extra'])
  check('inbox: any argument that is no flag or value → usage error, exit 1', stray.code === 1 && /unexpected argument "extra"/.test(stray.err) && stray.out === '', JSON.stringify(stray))
  const readInbox = inbox(ctx, ['--dir', inb, '--inbox', inb])
  check('inbox: --inbox outside --send → usage error, exit 1', readInbox.code === 1 && /--inbox goes with --send/.test(readInbox.err), JSON.stringify(readInbox))
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  // No default folder: the deployment names it, outside the clone (#77: the trust rule in SPEC "Inbox folder").
  const ctx = makeEnv()
  const clone = path.join(ctx.home, 'clone')
  mkdirSync(clone)
  putMessage(path.join(clone, '.agent-loop', 'inbox'), 'in1')
  const read = inbox(ctx, [], clone)
  check('inbox: no --dir → usage error, exit 1 (no default folder in the clone)', read.code === 1 && /--dir is required/.test(read.err) && read.out === '', JSON.stringify(read))
  const sent = inbox(ctx, ['--send', '--role', 'ROLE_AGENT', '--from', 'executor', '--to', 'operator', '--context', 'acme/widgets#7', '--text', 'done'], clone)
  check('inbox --send: no --dir → usage error, exit 1, no outbox made', sent.code === 1 && /--dir is required/.test(sent.err) && !existsSync(path.join(clone, '.agent-loop', 'outbox')), JSON.stringify(sent))
  const quoted = inbox(ctx, ['--send', '--dir', homeRel('mail', 'out'), '--role', 'ROLE_AGENT', '--from', 'e', '--to', 'o', '--context', 'c', '--text', 't'], clone)
  const qid = /^SENT:(\S+)\n$/.exec(quoted.out)?.[1]
  check('inbox --send: a quoted home-relative folder is under the home folder', qid && existsSync(path.join(ctx.home, '.agent-loop', 'mail', 'out', `${qid}.json`)) && !existsSync(path.join(clone, '~')), JSON.stringify(quoted))
  putMessage(path.join(ctx.home, '.agent-loop', 'mail', 'in'), 'home1')
  const home = inbox(ctx, ['--dir', homeRel('mail', 'in')], clone)
  check('inbox: … and so is a home-relative folder to read', home.out === 'MESSAGE:home1\n', JSON.stringify(home))
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  // --check: the mailbox the skills use only when it is safe (spec: "Inbox folder", Trust).
  const ctx = makeEnv()
  const clone = path.join(ctx.home, 'clone')
  mkdirSync(path.join(clone, 'sub'), { recursive: true })
  symlinkSync(path.join(clone, 'sub'), path.join(ctx.home, 'link-into-clone'))
  const mail = path.join(ctx.home, '.agent-loop', 'mail')
  // #88: an inbox that does not exist yet is accepted (a mount may come later) but warned about,
  // since a mistyped path reads as an empty inbox forever. Folders that exist live under `made`.
  const made = path.join(ctx.home, 'made')
  mkdirSync(path.join(made, 'in'), { recursive: true })
  writeFileSync(path.join(made, 'file'), 'x\n')
  symlinkSync(path.join(made, 'in'), path.join(made, 'link-in'))
  symlinkSync(path.join(made, 'gone'), path.join(made, 'dangling'))
  symlinkSync(path.join(made, 'file'), path.join(made, 'link-file'))
  const OK = 'MAILBOX_OK\n'
  const WARN = 'MAILBOX_OK\nMAILBOX_WARN: the inbox does not exist yet; nothing arrives until it is created\n'
  const cases = [
    ['two sibling folders outside the clone, not yet made', [path.join(mail, 'in'), path.join(mail, 'out')], WARN],
    ['home-relative folders outside the clone, not yet made', [homeRel('mail', 'in'), homeRel('mail', 'out')], WARN],
    ['a sibling of the clone whose name starts with the clone\'s, not yet made', [path.join(ctx.home, 'clone-mail', 'in'), path.join(ctx.home, 'clone-mail', 'out')], WARN],
    ['an existing inbox and a missing outbox', [path.join(made, 'in'), path.join(made, 'out')], OK],
    ['an existing inbox given home-relative', [path.join('~', 'made', 'in'), path.join(made, 'out')], OK],
    ['a symlinked inbox whose target exists', [path.join(made, 'link-in'), path.join(made, 'out')], OK],
    ['a dangling symlink for the inbox', [path.join(made, 'dangling'), path.join(made, 'out')], WARN],
    // #97 review: under a file, the folder can never be made, and `--dir` would fail every cycle.
    ['an inbox under a file', [path.join(made, 'file', 'in'), path.join(made, 'out')], 'MAILBOX_REFUSED: the inbox is under a file, so it can never be created\n'],
    ['an outbox under a file', [path.join(made, 'in'), path.join(made, 'file', 'out')], 'MAILBOX_REFUSED: the outbox is under a file, so it can never be created\n'],
    ['a file at the inbox path', [path.join(made, 'file'), path.join(made, 'out')], 'MAILBOX_REFUSED: the inbox is not a folder\n'],
    ['a symlink to a file at the inbox path', [path.join(made, 'link-file'), path.join(made, 'out')], 'MAILBOX_REFUSED: the inbox is not a folder\n'],
    ['a file at the outbox path', [path.join(made, 'in'), path.join(made, 'file')], 'MAILBOX_REFUSED: the outbox is not a folder\n'],
    ['the inbox in the clone', [path.join(clone, '.agent-loop', 'inbox'), path.join(mail, 'out')], 'MAILBOX_REFUSED: the inbox is inside the clone'],
    ['the inbox is the clone', [clone, path.join(mail, 'out')], 'MAILBOX_REFUSED: the inbox is inside the clone'],
    ['the outbox in the clone', [path.join(mail, 'in'), path.join(clone, 'out')], 'MAILBOX_REFUSED: the outbox is inside the clone'],
    ['the inbox through a symlink into the clone', [path.join(ctx.home, 'link-into-clone', 'in'), path.join(mail, 'out')], 'MAILBOX_REFUSED: the inbox is inside the clone'],
    ['a relative inbox', ['.agent-loop/inbox', path.join(mail, 'out')], 'MAILBOX_REFUSED: both folders must be absolute'],
    ['the outbox inside the inbox', [path.join(mail, 'in'), path.join(mail, 'in', 'out')], 'MAILBOX_REFUSED: the inbox and the outbox must be separate'],
    ['the inbox inside the outbox', [path.join(mail, 'out', 'in'), path.join(mail, 'out')], 'MAILBOX_REFUSED: the inbox and the outbox must be separate'],
    ['one folder for both', [path.join(mail, 'box'), path.join(mail, 'box')], 'MAILBOX_REFUSED: the inbox and the outbox must be separate'],
  ]
  for (const [name, [i, o], want] of cases) {
    const r = inbox(ctx, ['--check', '--dir', i, '--outbox', o], clone)
    // OK cases are exact; a refusal is one line (never a warning too, though most name missing inboxes).
    const exact = want.endsWith('\n')
    const ok = exact ? r.out === want : r.out.startsWith(want) && r.out.endsWith('\n') && r.out.split('\n').length === 2
    check(`inbox --check: ${name} → ${want.split('\n').filter(Boolean).map((l) => l.split(':')[0]).join(' + ')}`, r.code === 0 && ok, JSON.stringify(r))
  }
  check('inbox --check: … writes nothing (no folder made)', !existsSync(mail) && !existsSync(path.join(clone, '.agent-loop')), String(existsSync(mail)))
  putMessage(path.join(mail, 'in'), 'shown')
  putMessage(path.join(mail, 'in'), 'badrole', { role: 'user' })
  writeFileSync(path.join(mail, 'secret.json'), JSON.stringify(message('secret')))
  symlinkSync(path.join(mail, 'secret.json'), path.join(mail, 'in', 'linked.json'))
  const shown = inbox(ctx, ['--dir', homeRel('mail', 'in'), '--show', 'shown'], clone)
  check('inbox --show: a valid message → its JSON, exit 0', shown.code === 0 && JSON.stringify(JSON.parse(shown.out)) === JSON.stringify(message('shown')), JSON.stringify(shown))
  const shows = [
    ['an invalid message', 'badrole', 'INVALID: role must be'],
    ['no such message', 'gone', 'INVALID: no such message'],
    ['a symlink', 'linked', 'INVALID: not a regular file'],
    ['a path for an id', '../secret', 'INVALID: not a message id'],
    ['an absolute path for an id', path.join(mail, 'secret'), 'INVALID: not a message id'],
    ['an id with a slash', 'in/../../secret', 'INVALID: not a message id'],
    ['"..", the parent folder', '..', 'INVALID: not a message id'],
  ]
  for (const [name, id, want] of shows) {
    const r = inbox(ctx, ['--dir', homeRel('mail', 'in'), '--show', id], clone)
    check(`inbox --show: ${name} → ${want.split(':')[0]}, one line and nothing of the file`, r.code === 0 && r.out.startsWith(want) && r.out.split('\n').length === 2 && !r.out.includes('rebase') && r.err === '', JSON.stringify(r))
  }
  const record = inbox(ctx, ['--dir', homeRel('mail', 'in')], clone)
  check('inbox --show: … records nothing (the next run still reports every file)', record.out === 'MESSAGE:shown\nINVALID:badrole\n', JSON.stringify(record))
  const noOut = inbox(ctx, ['--check', '--dir', path.join(mail, 'in')], clone)
  check('inbox --check: no --outbox → usage error, exit 1', noOut.code === 1 && /--outbox/.test(noOut.err), JSON.stringify(noOut))
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  // One waiter for both: a signal script's waiter given --inbox also ends on a new message (#77).
  const ctx = makeEnv()
  const dir = path.join(ctx.home, 'box')
  run(ctx, 'pr-watch.mjs', watchArgs(), watchReviewed)
  run(ctx, 'pr-watch.mjs', watchArgs(), watchReviewed)
  setFixture(ctx, watchReviewed)
  const missing = await start(ctx, 'pr-watch.mjs', watchArgs('--inbox', dir, '--wait', '1', '--max', '2')).done
  check('wait --inbox: no such folder and nothing on GitHub → NONE at --max', signals(missing.out).join() === 'NONE' && missing.ms >= 2000 && missing.code === 0, `${missing.ms}ms\n${missing.out}${missing.err}`)
  putMessage(dir, 'old')
  inbox(ctx, ['--dir', dir])
  const record = readdirSync(path.join(ctx.home, '.agent-loop', 'state')).filter((f) => f.startsWith('inbox-'))
  const before = readFileSync(path.join(ctx.home, '.agent-loop', 'state', record[0]), 'utf8')
  const seen = await start(ctx, 'pr-watch.mjs', watchArgs('--inbox', dir, '--wait', '1', '--max', '2')).done
  check('wait --inbox: a message inbox.mjs already reported is not news → NONE at --max', signals(seen.out).join() === 'NONE' && seen.ms >= 2000, `${seen.ms}ms\n${seen.out}${seen.err}`)
  const w = start(ctx, 'pr-watch.mjs', watchArgs('--inbox', dir, '--wait', '1', '--max', '15'))
  await pause(1500)
  const t0 = Date.now()
  putMessage(dir, 'new')
  const r = await w.done
  const after = Date.now() - t0
  check('wait --inbox: a new message mid-wait ends the GitHub waiter → PENDING within one poll', r.out === 'PENDING\n' && r.code === 0 && after < 2500, `${after}ms after the write\n${r.out}${r.err}`)
  check('wait --inbox: … the waiter wrote nothing to the inbox record', readFileSync(path.join(ctx.home, '.agent-loop', 'state', record[0]), 'utf8') === before, before)
  const next = inbox(ctx, ['--dir', dir])
  check('wait --inbox: … so inbox.mjs then reports the message', next.out === 'MESSAGE:new\n', next.out)
  const gh = run(ctx, 'pr-watch.mjs', watchArgs('--inbox', dir), watchReviewed)
  check('wait --inbox: a one-shot run takes the flag and prints as before', signals(gh).join() === 'NONE', gh)
  setFixture(ctx, { ...watchReviewed, fail: true })
  putMessage(dir, 'during-outage')
  const outage = await start(ctx, 'pr-watch.mjs', watchArgs('--inbox', dir, '--wait', '1', '--max', '10')).done
  check('wait --inbox: a message ends the wait even while every gh call fails', outage.out === 'PENDING\n' && outage.ms < 4000, `${outage.ms}ms\n${outage.out}${outage.err}`)
  setFixture(ctx, watchReviewed)
  putMessage(path.join(ctx.home, '.agent-loop', 'quoted'), 'q1')
  const tilde = await start(ctx, 'pr-watch.mjs', watchArgs('--inbox', homeRel('quoted'), '--wait', '1', '--max', '10')).done
  check('wait --inbox: a quoted home-relative folder is under the home folder', tilde.out === 'PENDING\n' && tilde.ms < 4000, `${tilde.ms}ms\n${tilde.out}${tilde.err}`)
  // The skills pass the block's form to both: the record must be the same file, or every waiter
  // would return at once on a message already handled, and the loop would spin.
  inbox(ctx, ['--dir', homeRel('quoted')], ctx.home)
  const handled = await start(ctx, 'pr-watch.mjs', watchArgs('--inbox', homeRel('quoted'), '--wait', '1', '--max', '2')).done
  check('wait --inbox: … once inbox.mjs reported it under the same home-relative name, not news → NONE at --max', signals(handled.out).join() === 'NONE' && handled.ms >= 2000, `${handled.ms}ms\n${handled.out}${handled.err}`)
  const bad = run(ctx, 'pr-watch.mjs', watchArgs('--wait', '1', '--inbox'), watchReviewed)
  check('wait --inbox: --inbox with no folder → usage error, exit 1', bad.startsWith('EXIT 1') && bad.includes('--inbox'), bad)
  rmSync(ctx.home, { recursive: true, force: true })
}
{
  const ctx = makeEnv()
  const dir = path.join(ctx.home, 'box')
  const lgtm = { ...BASE, comments: [comment('[reviewer] LGTM', T('2026-01-01T12:00:00Z'))] }
  poll(ctx, BASE)
  poll(ctx, lgtm)
  setFixture(ctx, lgtm)
  const w = start(ctx, 'pr-poll.mjs', ['--repo', REPO, '--pr', '7', '--inbox', dir, '--wait', '1', '--max', '15'])
  await pause(1500)
  putMessage(dir, 'exec1')
  const r = await w.done
  check('wait --inbox (poll): a standing MERGE_READY stays quiet, and a new message ends the executor\'s waiter → PENDING', r.out === 'PENDING\n' && r.ms >= 1500 && r.ms < 5000, `${r.ms}ms\n${r.out}${r.err}`)
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
  // The pending rules record (#89): keyed by the clone's real path, in the state folder.
  const record = path.join(home, '.agent-loop', 'state', `rules-${createHash('sha256').update(realpathSync(loop)).digest('hex').slice(0, 16)}.json`)
  const bin = path.join(home, 'bin')
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec node "${path.join(here, 'fake-gh.mjs')}" "$@"\n`)
  chmodSync(path.join(bin, 'gh'), 0o755)
  const fixture = path.join(home, 'fixture.json')
  writeFileSync(fixture, JSON.stringify({ issues: [{ number: 11, title: '#11', body: '', labels: [] }] }))
  const ghLog = path.join(home, 'gh.log')
  const pickEnv = { ...env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_FIXTURE: fixture, FAKE_GH_LOG: ghLog }
  // --clone as the executor runs it: the refusal comes before the RESUME lookup, which calls gh.
  const pickIn = (cwd = loop) => spawnSync('node', [path.join(scripts, 'pick-next.mjs'), '--repo', REPO, '--clone', 'loop'], { cwd, env: pickEnv, encoding: 'utf8' })
  const ack = (cwd = loop) => spawnSync('node', [path.join(scripts, 'rules-ack.mjs')], { cwd, env, encoding: 'utf8' })
  const pendingLine = (files) => `RULES_PENDING: ${files}: run node ${path.join(scripts, 'rules-ack.mjs')}, then pick again\n`

  const head0 = g(loop, 'rev-parse', 'HEAD')
  land({ 'src/a.js': '2\n' })
  const code = pull()
  check('pull: a pull that changes no rules file → nothing printed, exit 0, the clone is at the new head',
    code.status === 0 && code.stdout === '' && g(loop, 'rev-parse', 'HEAD') !== head0, `${code.status} ${code.stdout}${code.stderr}`)
  const plain = pickIn()
  check('rules record: no rules change → no record, and pick-next picks as before',
    !existsSync(record) && plain.status === 0 && plain.stdout === 'ISSUE:11\n', `${existsSync(record)} ${plain.stdout}${plain.stderr}`)
  const quiet = ack()
  check('rules-ack: nothing pending → nothing printed, exit 0', quiet.status === 0 && quiet.stdout === '' && quiet.stderr === '', `${quiet.status} ${quiet.stdout}${quiet.stderr}`)
  const idle = pull()
  check('pull: nothing new to pull → nothing printed', idle.status === 0 && idle.stdout === '', `${idle.stdout}${idle.stderr}`)

  const before = g(loop, 'rev-parse', 'HEAD')
  const after = land({ 'AGENTS.md': block('docs/a.md, ./docs/b.md'), 'src/a.js': '3\n' })
  const agents = pull()
  check('pull: AGENTS.md changed → RULES_CHANGED: AGENTS.md, and the diff command for exactly that range',
    agents.stdout === `RULES_CHANGED: AGENTS.md\n  git diff ${before.slice(0, 12)}..${after.slice(0, 12)} -- AGENTS.md\n`, agents.stdout)
  writeFileSync(ghLog, '')
  const refused = pickIn()
  check('rules record: a pull with a rules change → pick-next prints RULES_PENDING and the ack command, picks nothing, calls no gh, exit 0',
    refused.status === 0 && refused.stdout === pendingLine('AGENTS.md') && readFileSync(ghLog, 'utf8') === '', `${refused.status} ${refused.stdout}${refused.stderr}`)
  mkdirSync(path.join(loop, 'src', 'deep'), { recursive: true })
  const fromSub = pickIn(path.join(loop, 'src', 'deep'))
  check('rules record: pick-next run from a folder inside the clone → the same record, still refused, no gh call',
    fromSub.stdout === pendingLine('AGENTS.md') && readFileSync(ghLog, 'utf8') === '', fromSub.stdout + fromSub.stderr)

  land({ 'docs/b.md': 'b\n', 'not-this.md': 'x\n', 'src/a.js': '4\n' })
  const one = pull()
  land({ 'docs/a.md': 'a\n', 'docs/b.md': 'b2\n' })
  const two = pull()
  check('pull: a rules key with two paths → each listed file that changed, and nothing outside the block\'s list',
    /^RULES_CHANGED: docs\/b\.md\n/.test(one.stdout) && /^RULES_CHANGED: docs\/a\.md docs\/b\.md\n {2}git diff \w+\.\.\w+ -- docs\/a\.md docs\/b\.md\n$/.test(two.stdout),
    `${one.stdout}---\n${two.stdout}`)
  const kept = JSON.parse(readFileSync(record, 'utf8')).pending
  check('rules record: more changes before an ack → every range kept, oldest first, and pick-next names each file once',
    kept.length === 3 && kept[0].from === before && kept[0].to === after && kept[1].files.join() === 'docs/b.md' && kept[2].files.join() === 'docs/a.md,docs/b.md' &&
      kept[0].to === kept[1].from && pickIn().stdout === pendingLine('AGENTS.md docs/b.md docs/a.md'), JSON.stringify(kept))
  const acked = ack()
  const heads = acked.stdout.split('\n').filter((l) => l.startsWith('RULES_DIFF: '))
  check('rules-ack: prints each pending range\'s diff command and diff, oldest first, then clears the record',
    acked.status === 0 && heads.length === 3 && heads[0] === `RULES_DIFF: git diff ${before.slice(0, 12)}..${after.slice(0, 12)} -- AGENTS.md` &&
      acked.stdout.includes('+rules: docs/a.md, ./docs/b.md') && acked.stdout.includes('+b2') && !acked.stdout.includes('RULES_CUT') && !existsSync(record),
    `${acked.status} ${acked.stdout}${acked.stderr}`)
  const after2 = pickIn()
  check('rules record: after the ack, pick-next picks again', after2.stdout === 'ISSUE:11\n', after2.stdout + after2.stderr)
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
  // A mailbox comes from the start arguments only (#77), so the restart line must carry them.
  const mailed = pull('--start', '/agent-loop:start-executor --inbox /srv/agent-mail/<clone>/inbox --outbox /srv/agent-mail/<clone>/outbox', '--milestone', 'M3')
  check('pull --start: a start with --inbox and --outbox → the restart line keeps both, exactly, before --milestone',
    mailed.stdout === 'RESTART: exit this session, start a new one in this clone, then run: /agent-loop:start-executor --inbox /srv/agent-mail/<clone>/inbox --outbox /srv/agent-mail/<clone>/outbox --milestone "M3"\n',
    mailed.stdout)

  const spacedAck = ack()
  check('rules-ack: a path with a space or a quote is one shell word in the RULES_DIFF line',
    spacedAck.stdout.includes(`-- 'docs/my rules.md' 'docs/it'\\''s.md'\n`) && !existsSync(record), spacedAck.stdout)

  // The clone's .git/config is writable by PR code, and a sandbox may exempt rules-ack.mjs: an
  // external diff or a textconv driver configured there must never run under it.
  const marker = path.join(home, 'driver-ran')
  const driver = path.join(home, 'driver.sh')
  writeFileSync(driver, `#!/bin/sh\ntouch '${marker}'\ncat "$1" 2>/dev/null\n`)
  chmodSync(driver, 0o755)
  g(loop, 'config', 'diff.external', driver)
  g(loop, 'config', 'diff.planted.textconv', driver)
  writeFileSync(path.join(loop, '.git', 'info', 'attributes'), '* diff=planted\n')
  land({ 'AGENTS.md': `${block("docs/my rules.md, docs/it's.md")}\nplanted drivers\n` })
  pull()
  const drivers = ack()
  check('rules-ack: a diff.external or textconv driver set in the clone\'s config never runs; the plain diff is printed',
    drivers.status === 0 && !existsSync(marker) && drivers.stdout.includes('+planted drivers') && !existsSync(record), `${drivers.status} ${existsSync(marker)} ${drivers.stdout}${drivers.stderr}`)
  g(loop, 'config', '--unset', 'diff.external')
  g(loop, 'config', '--unset', 'diff.planted.textconv')
  rmSync(path.join(loop, '.git', 'info', 'attributes'))

  const long =Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')
  const bigFrom = g(loop, 'rev-parse', 'HEAD')
  const bigTo = land({ 'AGENTS.md': `${block("docs/my rules.md, docs/it's.md")}\n${long}\n` })
  pull()
  const nextTo = land({ 'AGENTS.md': `${block("docs/my rules.md, docs/it's.md")}\n${long}\nmore\n` })
  pull()
  const capped = ack()
  const out = capped.stdout.split('\n').filter(Boolean)
  const cut = out.findIndex((l) => l.startsWith('RULES_CUT: '))
  check('rules-ack: an over-cap diff → 200 lines, then RULES_CUT and the command for the cut range and every one after it; the record cleared',
    capped.status === 0 && cut === 200 && /^RULES_CUT: \d+ more lines; run each command below for the rest$/.test(out[cut]) &&
      out[cut + 1] === `  git diff ${bigFrom.slice(0, 12)}..${bigTo.slice(0, 12)} -- AGENTS.md` &&
      out[cut + 2] === `  git diff ${bigTo.slice(0, 12)}..${nextTo.slice(0, 12)} -- AGENTS.md` && out.length === cut + 3 && !existsSync(record),
    `${capped.status} ${out.length} ${cut} ${out.slice(195).join('\n')}${capped.stderr}`)

  mkdirSync(path.dirname(record), { recursive: true })
  writeFileSync(record, '{not json')
  const unreadable = pickIn()
  const unreadAck = ack()
  check('rules record: an unreadable record → pick-next refuses; rules-ack says to read the rules in full and clears it',
    unreadable.stdout === pendingLine('(unreadable record)') && unreadAck.status === 0 &&
      unreadAck.stdout.startsWith('RULES_UNREADABLE: ') && !existsSync(record) && pickIn().stdout === 'ISSUE:11\n',
    `${unreadable.stdout}${unreadAck.stdout}${unreadAck.stderr}`)
  const headNow = g(loop, 'rev-parse', 'HEAD')
  writeFileSync(record, JSON.stringify({ pending: [{ from: 'deadbeef0000', to: headNow, files: ['AGENTS.md'] }, { from: bigFrom, to: bigTo, files: ['AGENTS.md'] }] }))
  const lost = ack()
  check('rules-ack: a range whose commits the clone lacks → RULES_UNREADABLE first, naming it, the other range still diffed, the record cleared',
    lost.status === 0 && lost.stdout.startsWith(`RULES_UNREADABLE: this clone lacks the commits of deadbeef0000..${headNow.slice(0, 12)}; read AGENTS.md`) &&
      lost.stdout.includes(`RULES_DIFF: git diff ${bigFrom.slice(0, 12)}..${bigTo.slice(0, 12)} -- AGENTS.md`) && !existsSync(record),
    `${lost.status} ${lost.stdout.slice(0, 400)}${lost.stderr}`)

  // #93 review: the record outlives the clone; a shallow clone at the same path lacks the range.
  const again = path.join(home, 'again')
  g(home, 'clone', '-q', '--branch', 'main', origin, again)
  land({ 'AGENTS.md': `${block("docs/my rules.md, docs/it's.md")}\nshallow\n` })
  spawnSync('node', [path.join(scripts, 'pull.mjs')], { cwd: again, env, encoding: 'utf8' })
  const againRecord = path.join(home, '.agent-loop', 'state', `rules-${createHash('sha256').update(realpathSync(again)).digest('hex').slice(0, 16)}.json`)
  const recorded = existsSync(againRecord)
  rmSync(again, { recursive: true, force: true })
  g(home, 'clone', '-q', '--depth', '1', '--branch', 'main', `file://${origin}`, again)
  const shallowAck = ack(again)
  const shallowPick = pickIn(again)
  check('rules-ack: a shallow re-clone at the same path → RULES_UNREADABLE, exit 0, the record cleared, and the next pick proceeds',
    recorded && shallowAck.status === 0 && shallowAck.stdout.startsWith('RULES_UNREADABLE: this clone lacks the commits of ') &&
      !existsSync(againRecord) && shallowPick.stdout === 'ISSUE:11\n', `${recorded} ${shallowAck.status} ${shallowAck.stdout}${shallowAck.stderr}${shallowPick.stdout}`)

  writeFileSync(record, JSON.stringify({ pending: [{ from: bigFrom, to: bigTo, files: ['AGENTS.md'] }] }))
  chmodSync(path.dirname(record), 0o555)
  const stuck = ack()
  chmodSync(path.dirname(record), 0o755)
  check('rules-ack: a record it can\'t clear → exit 2, one rules-ack: line naming the record, nothing on stdout, the record kept',
    stuck.status === 2 && stuck.stdout === '' && stuck.stderr.startsWith('rules-ack: ') && stuck.stderr.trimEnd().endsWith(`(record: ${record})`) &&
      stuck.stderr.split('\n').filter(Boolean).length === 1 && existsSync(record), `${stuck.status} ${stuck.stdout}${stuck.stderr}`)
  rmSync(record)

  chmodSync(path.dirname(record), 0o555)
  land({ 'AGENTS.md': `${block("docs/my rules.md, docs/it's.md")}\nunwritable\n` })
  const noState = pull()
  const noStatePick = pickIn()
  chmodSync(path.dirname(record), 0o755)
  check('pull: an unwritable state folder → RULES_NOT_RECORDED after the diff command (run it yourself), exit 0, no record, the pick not held',
    noState.status === 0 && /^RULES_CHANGED: AGENTS\.md\n {2}git diff \w+\.\.\w+ -- AGENTS\.md\nRULES_NOT_RECORDED: run the git diff command above yourself; pick-next\.mjs will not wait for it\n$/.test(noState.stdout) &&
      /^pull: rules change not recorded: /.test(noState.stderr) && !existsSync(record) && noStatePick.stdout === 'ISSUE:11\n',
    `${noState.status} ${noState.stdout}${noState.stderr}${noStatePick.stdout}`)

  mkdirSync(record)
  land({ 'AGENTS.md': `${block("docs/my rules.md, docs/it's.md")}\nlast\n` })
  const unrecorded = pull()
  check('pull: a record it can\'t write → a pull: warning on stderr, exit 0, RULES_CHANGED still printed',
    unrecorded.status === 0 && unrecorded.stdout.startsWith('RULES_CHANGED: AGENTS.md\n') && /^pull: rules change not recorded: /.test(unrecorded.stderr),
    `${unrecorded.status} ${unrecorded.stdout}${unrecorded.stderr}`)
  rmSync(record, { recursive: true })

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
  // The review of #136: every Claude Code start now runs start-check.mjs, which takes the clone
  // through session.mjs --start; a restart in the old session must still pass.
  const startCheck = 'node /p/scripts/start-check.mjs --role executor --session sess-old --model "Opus 5.5" --effort high --inbox /a --outbox /b'
  check('guard: … a plain start-check.mjs call passes too, in the skills\' shape (a restart in the old session)',
    guard('sess-old', 'Bash', { command: startCheck }) === 'ALLOW', guard('sess-old', 'Bash', { command: startCheck }))
  check('guard: … and nothing chained onto start-check.mjs slips past',
    [`${startCheck} && git checkout main`, `${startCheck}; rm -rf .`, `${startCheck} | tee x`, 'node /p/scripts/start-check.mjs --model $(id)', 'node /p/scripts/restart-check.mjs --role qa']
      .every((c) => /superseded/.test(guard('sess-old', 'Bash', { command: c }))))
  check('guard: the session holding the clone, and one the file never named, are not affected',
    guard('sess-new', 'Bash', { command: 'git status' }) === 'ALLOW' && guard('sess-new', 'Edit', { file_path: 'x' }) === 'ALLOW' &&
    guard('sess-operator', 'Bash', { command: 'git status' }) === 'ALLOW')
  check('guard: merging is still refused for the holder', /operator's action/.test(guard('sess-new', 'Bash', { command: 'gh pr merge 7' })))
  // #87: the executor runs the push-time checks with `git push --dry-run` before the gate.
  check('guard: git push --dry-run to a feature branch passes; to main it is refused like a push',
    guard('sess-new', 'Bash', { command: 'git push --dry-run origin 87-cheap-checks' }) === 'ALLOW' &&
      /operator's action/.test(guard('sess-new', 'Bash', { command: 'git push --dry-run origin main' })))
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
  const hookPath = path.resolve(scripts, '..', 'adapters', 'claude-code', 'hooks', 'operator-lines.mjs')
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
    runs('PostToolUse', 'operator-lines.mjs') && runs('PostToolUseFailure', 'operator-lines.mjs') &&
    hooks.PostToolUse.length === 1 && hooks.PostToolUseFailure.length === 1 &&
    hooks.PreToolUse.length === 1 && hooks.PreToolUse[0].matcher === 'Bash|Edit|Write|NotebookEdit' && hooks.PreToolUse[0].hooks[0].command.includes('hooks/guard.mjs'))

  // #128: the same hook shows start-check.mjs's ⚠ lines, in any loop clone.
  const qa = clone('qa')
  const startCmd = 'node /plugins/agent-loop/scripts/start-check.mjs --role reviewer --session s1 --model "Opus 5.5" --effort high --inbox /m/in'
  const warn1 = '⚠ No mailbox: --inbox and --outbox go together.'
  const warn2 = '⚠ AGENTS.md expects sonnet for the reviewer; this session runs Opus 5.5 · high. Restart it with /model and /effort if that is wrong.'
  const startOut = `NEW\nNO_MAILBOX\n${warn1}\n${warn2}\n`
  check('start lines hook: start-check.mjs in a reviewer, executor or QA clone → all its ⚠ lines, in order, as one systemMessage, and nothing else',
    [reviewer, exec, qa].every((d) => shown(ok(startCmd, startOut, d)) === `${warn1}\n${warn2}`), shown(ok(startCmd, startOut, reviewer)))
  check('start lines hook: … also from a failed run (PostToolUseFailure shape), and from a quoted path',
    shown({ cwd: reviewer, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: startCmd }, error: `Exit code 1\n${warn1}` }) === warn1 &&
      shown(ok('node "/My Plugins/agent-loop/scripts/start-check.mjs" --role qa --session s --model m', startOut, qa)) === `${warn1}\n${warn2}`)
  check('start lines hook: no ⚠ line → silent', shown(ok(startCmd, 'MINE\nNO_MAILBOX\n', reviewer)) === 'SILENT')
  const auditor = clone('auditor')
  check('start lines hook: a clone with no role marker yet (a start runs there too) → the lines; another role\'s marker → silent',
    shown(ok(startCmd, startOut, bare)) === `${warn1}\n${warn2}` && shown(ok(startCmd, startOut, auditor)) === 'SILENT', shown(ok(startCmd, startOut, bare)))
  rmSync(auditor, { recursive: true, force: true })
  check('start lines hook: ⚠ lines from another command (session.mjs, inbox.mjs --check, a grep naming start-check.mjs) → silent',
    ['node /p/scripts/session.mjs --start s1', 'node /p/scripts/inbox.mjs --check --dir /a --outbox /b', 'grep -n x scripts/start-check.mjs.bak', 'node /p/scripts/restart-check.mjs']
      .every((c) => shown(ok(c, startOut, reviewer)) === 'SILENT'))
  check('start lines hook: a RESTART line in start-check output is not shown, nor a ⚠ line in pull.mjs output',
    shown(ok(startCmd, `RESTART: x\n`, exec)) === 'SILENT' && shown(ok(pull, `${warn1}\n`)) === 'SILENT')
  for (const dir of [exec, reviewer, bare, qa]) rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- start-check.mjs, the start's checks (#128)
{
  const home = mkdtempSync(path.join(tmpdir(), 'agent-loop-start-'))
  const root = path.join(home, 'app-review')
  mkdirSync(path.join(root, '.agent-loop'), { recursive: true })
  const agents = (models) => writeFileSync(path.join(root, 'AGENTS.md'), `# App\n\n## Agent loop\n\nrepo: acme/widgets\n${models ? `models: ${models}\n` : ''}\n## Other\n`)
  const start = (args) => spawnSync('node', [path.join(scripts, 'start-check.mjs'), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home } })
  const lines = (args) => {
    const r = start(args)
    return r.status === 0 ? r.stdout.trimEnd().split('\n') : [`EXIT ${r.status}`, r.stderr]
  }
  const base = (role = 'reviewer', session = 'sess-a') => ['--role', role, '--session', session, '--model', 'Opus 5.5', '--effort', 'high']
  const inbox = path.join(home, 'mail', 'in')
  const outbox = path.join(home, 'mail', 'out')
  mkdirSync(inbox, { recursive: true })

  agents('executor=opus, reviewer=opus/high')
  check('start-check: everything matches → the session line, NO_MAILBOX, no ⚠ line', lines(base()).join('|') === 'NEW|NO_MAILBOX', lines(base()).join('|'))
  check('start-check: … the same session again → MINE', lines(base())[0] === 'MINE')
  const took = lines(base('reviewer', 'sess-b'))
  check('start-check: another session held the clone → TOOK_OVER, and the ⚠ takeover line',
    /^TOOK_OVER sess-a \d+$/.test(took[0]) && took[2] === '⚠ Took over this clone from session sess-a, last active 0 min ago. If it still runs, its next command is refused and it stops.', took.join('\n'))
  for (const id of ['', '${CLAUDE_SESSION_ID}']) {
    const none = lines(base('reviewer', id))
    check(`start-check: session id ${JSON.stringify(id)} (not filled in) → SESSION_NONE and the ⚠ no-session line, exit 0`,
      none[0] === 'SESSION_NONE' && none.includes('⚠ No session id: a second session in this clone would go unnoticed.'), none.join('\n'))
  }

  // The review of #128: the tool fills the id and the effort in unquoted, so an empty fill leaves no
  // word at all. The start must still go on, never stop on a usage error.
  const emptySession = lines(['--role', 'reviewer', '--session', '--model', 'Opus 5.5', '--effort', 'high'])
  check('start-check: --session with nothing after it (an empty fill, followed by --model) → SESSION_NONE and the ⚠ line, exit 0',
    emptySession[0] === 'SESSION_NONE' && emptySession.includes('⚠ No session id: a second session in this clone would go unnoticed.'), emptySession.join('\n'))
  const emptyEffort = [lines(['--role', 'reviewer', '--session', 'sess-b', '--model', 'Opus 5.5', '--effort']),
    lines(['--role', 'reviewer', '--session', 'sess-b', '--model', 'Opus 5.5', '--effort', '--inbox', inbox])]
  check('start-check: --effort last, or followed by --inbox (an empty fill) → no usage error; the next option still read',
    emptyEffort[0][0] === 'MINE' && emptyEffort[1][0] === 'MINE' && emptyEffort[1].includes('⚠ No mailbox: --inbox and --outbox go together.'), emptyEffort.map((l) => l.join('|')).join('\n'))

  agents('executor=opus, reviewer=sonnet')
  const wrong = lines(base('reviewer', 'sess-b'))
  check('start-check: the models entry names another model → the ⚠ model line, with the entry and this session',
    wrong.includes('⚠ AGENTS.md expects sonnet for the reviewer; this session runs Opus 5.5 · high. Restart it with /model and /effort if that is wrong.'), wrong.join('\n'))
  agents('reviewer=opus/max')
  check('start-check: … the same model, another effort → the ⚠ model line', lines(base('reviewer', 'sess-b')).some((l) => l.startsWith('⚠ AGENTS.md expects opus/max for the reviewer')))
  check('start-check: … an effort not filled in is not compared → no line',
    !lines(['--role', 'reviewer', '--session', 'sess-b', '--model', 'Opus 5.5', '--effort', '${CLAUDE_EFFORT}']).some((l) => l.startsWith('⚠')))
  agents('executor=sonnet')
  check('start-check: an entry for another role only → no line', !lines(base('reviewer', 'sess-b')).some((l) => l.startsWith('⚠')))
  agents('reviewer=\u001b[2Jsonnet\u0007' + 'x'.repeat(200))
  const hostile = lines(base('reviewer', 'sess-b')).find((l) => l.startsWith('⚠ AGENTS.md')) ?? ''
  check('start-check: a models entry with control characters or a long value → printed cleaned and cut',
    hostile !== '' && !/[\u0000-\u001f]/.test(hostile) && hostile.length < 300, JSON.stringify(hostile))
  agents('reviewer=opus')

  const one = [lines([...base('reviewer', 'sess-b'), '--inbox', inbox]), lines([...base('reviewer', 'sess-b'), '--outbox', outbox])]
  check('start-check: only --inbox, or only --outbox → NO_MAILBOX and the ⚠ one-folder line',
    one.every((l) => l[1] === 'NO_MAILBOX' && l.includes('⚠ No mailbox: --inbox and --outbox go together.')), one.map((l) => l.join('|')).join('\n'))
  check('start-check: … and nothing written to the outbox', !existsSync(outbox))
  const okBox = lines([...base('reviewer', 'sess-b'), '--inbox', inbox, '--outbox', outbox])
  check('start-check: both folders, acceptable → MAILBOX <inbox>, no ⚠ line, no outbox message',
    okBox[1] === `MAILBOX ${inbox}` && okBox.length === 2 && !existsSync(outbox), okBox.join('\n'))
  const refused = lines([...base('reviewer', 'sess-b'), '--inbox', path.join(root, 'in'), '--outbox', outbox])
  check('start-check: a refused pair (the inbox in the clone) → NO_MAILBOX and ⚠ No mailbox: <reason>.',
    refused[1] === 'NO_MAILBOX' && refused.includes('⚠ No mailbox: the inbox is inside the clone, where PR code runs.') && !existsSync(outbox), refused.join('\n'))
  const later = path.join(home, 'mail', 'later')
  const warned = lines([...base('reviewer', 'sess-b'), '--inbox', later, '--outbox', outbox])
  check('start-check: an inbox that does not exist yet → MAILBOX, and the ⚠ inbox line',
    warned[1] === `MAILBOX ${later}` && warned.includes(`⚠ Inbox ${later}: does not exist yet; nothing arrives until it is created.`), warned.join('\n'))
  const sent = existsSync(outbox) ? readdirSync(outbox).filter((f) => f.endsWith('.json')) : []
  const msg = sent.length === 1 ? JSON.parse(readFileSync(path.join(outbox, sent[0]), 'utf8')) : null
  check('start-check: … with a mailbox and a ⚠ line, the lines go to the outbox as one message to the operator',
    msg?.metadata?.to === 'operator' && msg.metadata.from === 'app-review' && msg.contextId === 'acme/widgets' && msg.parts[0].text.includes(`⚠ Inbox ${later}: does not exist yet`),
    JSON.stringify(msg))
  writeFileSync(path.join(home, 'mail', 'blocker'), 'a file')
  const badOut = lines(['--role', 'reviewer', '--session', 'sess-c', '--model', 'Opus 5.5', '--inbox', later, '--outbox', path.join(home, 'mail', 'blocker')])
  check('start-check: an outbox that is a file is refused before any send → NO_MAILBOX, exit 0', badOut[1] === 'NO_MAILBOX', badOut.join('\n'))
  const usage = [start(['--role', 'boss', '--session', 's', '--model', 'm']), start(['--role', 'qa', '--session', 's']), start([...base(), 'extra'])]
  check('start-check: an unknown role, no --model, or a stray argument → exit 1', usage.every((r) => r.status === 1), usage.map((r) => r.stderr).join('\n'))
  rmSync(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- loop texts' command forms (#90, #91)
{
  // Each slip cost a live session a failed call, an improvised command or an approval prompt.
  const adapters = path.resolve(scripts, '..', 'adapters')
  const flat = (t) => t.replace(/\n\s*/g, ' ')
  const read = (f) => readFileSync(path.join(adapters, f), 'utf8')
  const paragraphWith = (f, needle) => read(f).split(/\n[ \t]*\n/).map(flat).find((p) => p.includes(needle)) ?? ''
  const texts = readdirSync(adapters, { recursive: true }).filter((f) => /\.(md|sh)$/.test(f))
  const brackets = texts.flatMap((f) => [...flat(read(f)).matchAll(/--jq '([^']*)'/g)].filter((m) => m[1].includes(']]')).map((m) => `${f}: ${m[1]}`))
  check('loop texts: no --jq filter holds ]] (Claude Code\'s safety check prompts on it)', brackets.length === 0, brackets.join('\n'))

  const fallback = "git grep -n '<pattern>' -- '<pathspec>'"
  const grepTexts = ['claude-code/skills/start-executor/reference/implement.md', 'claude-code/skills/start-reviewer/reference/review.md',
    'claude-code/skills/start-qa/reference/evaluate.md', 'generic/executor.md', 'generic/reviewer.md', 'generic/qa.md',
    'kiro/skills/start-executor/SKILL.md', 'kiro/skills/start-reviewer/SKILL.md', 'kiro/skills/start-qa/SKILL.md']
  const noGrepClause = grepTexts.filter((f) => {
    const p = paragraphWith(f, fallback).toLowerCase()
    return !(p.includes("options go before the pattern (`git grep -n -a<n> '<pattern>' -- '<pathspec>'`): after it, git reads them as a revision") &&
      p.includes("no `{…,…}` in a pattern or a pathspec: write alternatives as `-e '(a|b)'` and give each pathspec separately (`'*.ts' '*.tsx'`)"))
  })
  check('loop texts: beside every git grep fallback, options go before the pattern and no braces', noGrepClause.length === 0, noGrepClause.join('\n'))

  const editTexts = grepTexts.filter((f) => !/qa/.test(f))
  const noEditClause = editTexts.filter((f) => {
    const p = paragraphWith(f, fallback)
    return !(/Change files .*, never through (Bash|the shell): no heredoc, `python3 -`, `node -e`, `sed -i`, `tee` or `>` redirect/.test(p) &&
      p.includes('generators and formatters, run as one plain command, are build steps, not hand edits'))
  })
  check('loop texts: the executor\'s and reviewer\'s plain-command rules change files with the edit tools, never through the shell', noEditClause.length === 0, noEditClause.join('\n'))

  const perRow = 'emit one array per row with `.[] | [ … ]`, not `[.[] | [ … ]]`'
  const jqTexts = [['claude-code/skills/start-executor/SKILL.md', '**One plain command per Bash call**'], ['claude-code/skills/start-reviewer/SKILL.md', '**One plain command per Bash call**'],
    ['claude-code/skills/start-qa/SKILL.md', 'one plain command per Bash call in the loop'], ...grepTexts.slice(3).map((f) => [f, fallback])]
  const noJqClause = jqTexts.filter(([f, needle]) => !paragraphWith(f, needle).includes(perRow)).map(([f]) => f)
  check('loop texts: every loop\'s plain-command rule says --jq filters never end in ]], one array per row', noJqClause.length === 0, noJqClause.join('\n'))

  // #134: each line carries its author's login and association, which the trust rule needs.
  const listing = 'gh api --paginate "repos/<repo>/issues/<N>/comments" --jq \'.[] | select((.body // "") | startswith("[executor] Claimed by ")) | "\\(.id) \\(.created_at) \\(.user.login) \\(.author_association) \\(.body)"\''
  // Counted flat (lines rewrapped) and raw: a copy may wrap at jq's whitespace, never inside the
  // "[executor] Claimed by " string, where the line break would become part of the match (#99 review).
  const count = (f) => flat(read(f)).split(listing).length - 1
  const unbroken = (f) => read(f).split('startswith("[executor] Claimed by "))').length - 1
  const cc = flat(read('claude-code/skills/start-executor/SKILL.md'))
  const listings = ['claude-code/skills/start-executor/SKILL.md', 'claude-code/skills/start-executor/reference/implement.md', 'generic/executor.md', 'kiro/skills/start-executor/SKILL.md']
  // #134: in that race only a trusted author's claim counts, and an untrusted own claim stops.
  const raceTrust = listings.slice(1).filter((f) => {
    const t = flat(read(f))
    return !t.includes('**Only a trusted author\'s claim counts** (#134)') || !t.includes('Anyone else\'s line is ignored as if it weren\'t there.') ||
      !t.includes('is not trusted (trusted-authors or allow-author-associations in AGENTS.md), so its claims never count: add it, then restart.`') ||
      t.indexOf('**Only a trusted author\'s claim counts**') < t.indexOf(listing) || t.indexOf('**Only a trusted author\'s claim counts**') > t.toLowerCase().indexOf('the lowest id', t.indexOf(listing))
  })
  check('claim race (#134): every executor\'s claim step counts only trusted authors\' claims, before the lowest id decides, and stops on an untrusted own claim',
    raceTrust.length === 0, raceTrust.join('\n'))
  // #129: the resume's check is claims.mjs; the listing is left only in the claim step's race.
  check('loop texts: every executor lists claims only in its claim step, never wrapped inside a string',
    count('claude-code/skills/start-executor/SKILL.md') === 0 && count('claude-code/skills/start-executor/reference/implement.md') === 1 &&
      !cc.includes('list them with the command in') && count('generic/executor.md') === 1 && count('kiro/skills/start-executor/SKILL.md') === 1 &&
      listings.every((f) => unbroken(f) === count(f)),
    listings.map((f) => `${f}: ${count(f)} flat, ${unbroken(f)} unbroken`).join('\n'))
  const claimCmd = (prefix) => `${prefix}claims.mjs --repo <repo> --issue <N> --clone <clone> --in-progress-label <`
  const resumes = [['claude-code/skills/start-executor/SKILL.md', claimCmd('node ${CLAUDE_PLUGIN_ROOT}/scripts/')], ['generic/executor.md', claimCmd('node scripts/')],
    ['kiro/skills/start-executor/SKILL.md', claimCmd('node scripts/')]]
  const noCheck = resumes.filter(([f, cmd]) => {
    const t = flat(read(f))
    return !t.includes(cmd) || !t.includes('Off a clean `main` (another branch, or uncommitted changes), with a `<N>`, run it before deciding anything:') ||
      !t.includes('`Could not check the claim on #<N>: <the claims: line>. Restart when gh works.`') ||
      !['`CLAIM_HELD`', '`CLAIM_NONE`', '`CLAIM_LOST <clone>`', '`CLAIM_RELEASED`', '`CLAIM_CLOSED`', '`CLAIM_BLOCKED`'].every((s) => t.includes(s))
  }).map(([f]) => f)
  check('claim check (#129): every executor\'s resume runs claims.mjs off a clean main, branches on each of its lines, and stops on a failed run', noCheck.length === 0, noCheck.join('\n'))
  // #138: "every start" read as covering a clean main too, so a start there claimed on
  // CLAIM_RELEASED before the open-PR lookup ran, and an unblocked issue with a PR got a second one.
  // On a clean main no claim check runs: the issue path's lookup comes first, before any claim.
  const lookupCmd = 'pr-for-issue.mjs --repo <repo> --closes <N>'
  const claimAt = { 'claude-code/skills/start-executor/SKILL.md': '`NONE` → claim and', 'generic/executor.md': '--body "[executor] Claimed by <clone>"',
    'kiro/skills/start-executor/SKILL.md': '--body "[executor] Claimed by <clone>"' }
  const cleanMain = resumes.filter(([f]) => {
    const t = flat(read(f))
    const noCheckOnMain = t.indexOf('No claim check runs on a clean `main`:')
    return noCheckOnMain === -1 || !/where the open-PR lookup \(`pr-for-issue\.mjs`\) runs before any claim/.test(t) ||
      noCheckOnMain > t.indexOf('Off a clean `main` (another branch, or uncommitted changes), with a `<N>`') ||
      /run it before deciding anything, every start/.test(t) || t.indexOf(lookupCmd) === -1 || t.indexOf(lookupCmd) > t.indexOf(claimAt[f])
  }).map(([f]) => f)
  check('claim check (#138): on a clean main no claim check runs; an issue number takes the open-PR lookup before any claim', cleanMain.length === 0, cleanMain.join('\n'))
  const outcomes = resumes.filter(([f]) => {
    const t = flat(read(f))
    return !t.includes('nobody holds it, released on a stop or never claimed') || t.includes('you released it, say on a') ||
      !/no such branch in this clone → `git checkout main`, [^;]*so the open-PR lookup runs before anything is built/.test(t)
  }).map(([f]) => f)
  check('claim check (#138): CLAIM_RELEASED reads as claims.mjs has it (released or never claimed), and a held issue with no branch here goes through the open-PR lookup',
    outcomes.length === 0, outcomes.join('\n'))
  // That route meets the claim step again, where the label is now on and claims.mjs says
  // CLAIM_HELD: "resume" with no branch here would send it back to the lookup, a loop (or nowhere,
  // in Claude Code). The claim step's exception builds it instead.
  const claimSteps = ['claude-code/skills/start-executor/reference/implement.md', 'generic/executor.md', 'kiro/skills/start-executor/SKILL.md']
  const loops = claimSteps.filter((f) => {
    const t = flat(read(f))
    const at = t.indexOf('prints `CLAIM_HELD`: then it is yours, so resume')
    const tail = at === -1 ? '' : t.slice(at, at + 700)
    return !/No such branch in this clone[^→]*→ it is yours and nothing of it is built here: don't claim it again and don't go back to [^;]*; [^.]*on a new branch from `main`/.test(tail)
  })
  check('claim check (#138): the claim step\'s CLAIM_HELD with no branch in this clone builds the issue on a new branch, never back to the lookup',
    loops.length === 0, loops.join('\n'))
  const heldOnly = ['claude-code/skills/start-executor/reference/implement.md', 'generic/executor.md', 'kiro/skills/start-executor/SKILL.md']
    .filter((f) => !/unless (`node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/claims\.mjs [^`]*`|the claim check \(`claims\.mjs`, above\)) prints `CLAIM_HELD`/.test(flat(read(f))))
  check('claim check (#129): the claim step\'s "in progress, unless it is yours" also asks claims.mjs', heldOnly.length === 0, heldOnly.join('\n'))

  // #128: a Claude Code start's ⚠ lines come from start-check.mjs, which the hook shows; live starts
  // dropped the ones the text asked the session to print, the literal one-folder line included.
  const startCmd = (r) => `node \${CLAUDE_PLUGIN_ROOT}/scripts/start-check.mjs --role ${r} --session \${CLAUDE_SESSION_ID} --model "<model>" --effort \${CLAUDE_EFFORT}`
  const noStart = ['executor', 'reviewer', 'qa'].filter((r) => {
    const t = flat(read(`claude-code/skills/start-${r}/SKILL.md`))
    return !t.includes(startCmd(r)) || !t.includes('for each of the two that `$ARGUMENTS` holds, **even one alone**, and never one it doesn\'t hold') ||
      !t.includes('`MAILBOX <inbox>` → you have a mailbox, and `<inbox-flag>` below is `--inbox <inbox>`.') || !t.includes('`NO_MAILBOX` → `<inbox-flag>` is empty') ||
      !t.includes("The plugin's operator-lines hook shows them to the operator as a system message") || !t.includes("don't copy them into your text") ||
      // none of the old self-printed start lines, nor a second session or mailbox command, is left
      /print `⚠ (No mailbox|Took over|No session id|Inbox <inbox>|AGENTS\.md expects)/.test(t) || t.includes('scripts/session.mjs --start') || t.includes('inbox.mjs --check')
  })
  check('start lines (#128): every Claude Code start runs start-check.mjs with each mailbox folder it was given, branches on its lines, and leaves the ⚠ lines to the hook',
    noStart.length === 0, noStart.join('\n'))
}

// ---------------------------------------------------------------- the RESTART line: the hook's in Claude Code (#105)
{
  // The session's own copy of the RESTART line dropped out in live runs however it was asked for;
  // the operator-lines hook shows it regardless. Claude Code relies on the hook; generic and Kiro,
  // with no hook, keep the text line.
  const adapters = path.resolve(scripts, '..', 'adapters')
  const flat = (f) => readFileSync(path.join(adapters, f), 'utf8').replace(/\n\s*/g, ' ')
  const cc = flat('claude-code/skills/start-executor/SKILL.md') + flat('claude-code/skills/start-executor/reference/signals.md')
  check('RESTART line (Claude Code): the executor relies on the hook and asks for no text copy or closing repeat',
    cc.includes("the plugin's operator-lines hook shows it to them as a system message") && !/repeat the `RESTART: …` line/.test(cc) &&
      !/Write, as your own text, a one-line note to the operator and the `RESTART: …` line/.test(cc) && !/write as your own text a one-line note to the operator, and the `RESTART: …` line/.test(cc), '')
  const readme = flat('claude-code/README.md')
  check('RESTART line (Claude Code README): the hook is the operator\'s copy; the executor doesn\'t write the line',
    readme.includes("It is the operator's copy: the executor doesn't write the line in its own text.") && !readme.includes('The executor still writes the line in its own text'), '')
  const generic = flat('generic/executor.md')
  const kiro = flat('kiro/skills/start-executor/SKILL.md')
  check('RESTART line (generic, Kiro): with no hook, the text line stays, and the text says why',
    generic.includes('write in your own reply a one-line note and its `RESTART: …` line') && generic.includes('your text is the only copy') &&
      kiro.includes('write in your own reply a one-line note to the user and its `RESTART: …` line') && kiro.includes('your text is the only copy'), '')
}

// ---------------------------------------------------------------- resume: the branch first, a PR names its issue (#104)
{
  // A PR number in the arguments once stood in for the issue number: the claim check ran on the
  // PR's comments, found no claim, and "yours only when $ARGUMENTS names it" looked satisfied.
  const adapters = path.resolve(scripts, '..', 'adapters')
  const flat = (f) => readFileSync(path.join(adapters, f), 'utf8').replace(/\n\s*/g, ' ')
  const files = ['claude-code/skills/start-executor/SKILL.md', 'generic/executor.md', 'kiro/skills/start-executor/SKILL.md']
  const missing = files.filter((f) => {
    const t = flat(f)
    return !(t.includes('**the branch name comes first:** on a branch whose name carries an issue number') || t.includes('**The branch name comes first:** on a branch whose name carries an issue number')) ||
      !/never decides it\. Only on `main` with uncommitted changes, or on a branch whose name carries no issue number, take the number from/.test(t) ||
      !t.includes('`gh pr view <n> --repo <repo> --json number,body` succeeds → the number is a PR, and `<N>` is the first issue its body closes (`Closes #<N>`') ||
      !t.includes('no `Closes #N` → there is no `<N>`') ||
      // The review of #122: only "not a PR" means an issue; a blip must not send a PR's number down the issue path.
      !t.includes('It fails with `Could not resolve to a PullRequest` → `<N>` is the number. Any other failure (network, auth) →') ||
      !t.includes('`Could not tell whether <n> is a PR: <the error>. Restart when gh works.`') ||
      !t.includes("The claim check never runs on a PR's number") && !t.includes("The claim check below never runs on a PR's number") ||
      !t.includes('by its own number or by a PR whose `Closes #<N>` names it')
  })
  check('resume: every executor takes <N> from the branch first, and resolves a PR argument through Closes #N (never checking a PR as an issue)', missing.length === 0, missing.join('\n'))
}

// ---------------------------------------------------------------- start: telling a PR from an issue (#126)
{
  // As on resume (#123): only "not a PR" makes a start argument an issue number; a blip on a real
  // PR number must not claim the PR's number as an issue.
  const adapters = path.resolve(scripts, '..', 'adapters')
  const flat = (f) => readFileSync(path.join(adapters, f), 'utf8').replace(/\n\s*/g, ' ')
  const startStep = {
    'claude-code/skills/start-executor/SKILL.md': 'If it fails with `Could not resolve to a PullRequest`, `<arg>` is an issue number',
    'kiro/skills/start-executor/SKILL.md': '- If it fails with `Could not resolve to a PullRequest`, or $ARGUMENTS is empty: treat as issue number or pick next.',
    'generic/executor.md': 'Tell a PR from an issue with `gh pr view <n> --repo <repo> --json number,body`. It succeeds → a PR. It fails with `Could not resolve to a PullRequest` → an issue.',
  }
  const missing = Object.entries(startStep).filter(([f, s]) => {
    const t = flat(f)
    const at = t.indexOf(s)
    return at === -1 || !t.slice(at, at + 600).includes('Restart when gh works.`')
  }).map(([f]) => f)
  check('start: every executor takes a start argument as an issue only on "not a PR", and stops on any other gh pr view failure', missing.length === 0, missing.join('\n'))
  const loose = ['claude-code/skills/start-executor/SKILL.md', 'kiro/skills/start-executor/SKILL.md'].filter((f) => /Otherwise, with an issue number|If it fails or \$ARGUMENTS is empty/.test(flat(f)))
  check('start: … and no executor still reads any failure as "an issue"', loose.length === 0, loose.join('\n'))
}

// ---------------------------------------------------------------- pr-for-issue.mjs, the open-PR lookup (#110)
{
  const ctx = makeEnv()
  const pr = (number, body, headRefName, isCrossRepository = false) => ({ number, body, headRefName, isCrossRepository })
  const prs = [
    pr(9, 'Fixes it.\n\nCloses #42', 'issue-42-later'),
    pr(3, 'Closes #420', 'issue-420'),
    pr(7, 'closes #42', 'from-a-fork', true),
    pr(5, 'Body.\n\nCLOSES #42.', 'issue-42-first'),
    pr(2, null, 'no-body'),
  ]
  const look = (args, fixture = { prs }) => run(ctx, 'pr-for-issue.mjs', ['--repo', REPO, ...args], fixture)
  // The fixture lists PRs out of order, so a pick by list position (first or last) fails too.
  check('pr-for-issue: the newest (highest-numbered) open same-repo PR closing #42 (any case) → PR:<n> <branch>, as the old filter and pick-next took',
    look(['--closes', '42']) === 'PR:9 issue-42-later\n', look(['--closes', '42']))
  check('pr-for-issue: … "#42" as the argument works too', look(['--closes', '#42']) === 'PR:9 issue-42-later\n', look(['--closes', '#42']))
  check('pr-for-issue: … whatever the list order (the higher number listed last)',
    look(['--closes', '42'], { prs: [pr(5, 'Closes #42', 'issue-42-first'), pr(1, 'x', 'other'), pr(9, 'Closes #42', 'issue-42-later')] }) === 'PR:9 issue-42-later\n')
  check('pr-for-issue: "Closes #420" is not #42, and a fork\'s PR is never returned', look(['--closes', '4']) === 'NONE\n' &&
    look(['--closes', '42'], { prs: [pr(7, 'Closes #42', 'from-a-fork', true), pr(3, 'Closes #420', 'issue-420')] }) === 'NONE\n', look(['--closes', '4']))
  check('pr-for-issue: no open PR closes it (a null body included) → NONE', look(['--closes', '99']) === 'NONE\n', look(['--closes', '99']))
  const failed = look(['--closes', '42'], { fail: true })
  check('pr-for-issue: a failed gh call → exit 2 with a pr-for-issue: line', failed.startsWith('EXIT 2') && /pr-for-issue: HTTP 502/.test(failed), failed)
  const usage = [look([]), look(['--closes', 'x']), look(['--closes', '42', 'extra'])]
  check('pr-for-issue: no --closes, a --closes that is no number, or a stray argument → exit 1', usage.every((o) => o.startsWith('EXIT 1')), usage.join('\n'))
  rmSync(ctx.home, { recursive: true, force: true })

  // The adapters: the lookup goes through the script, and no --jq filter holds a $ inside a
  // double-quoted string, the likely trigger of the prompt the old filter drew.
  const adapters = path.resolve(scripts, '..', 'adapters')
  const texts = readdirSync(adapters, { recursive: true }).filter((f) => /\.(md|sh)$/.test(f))
  const flatOf = (f) => readFileSync(path.join(adapters, f), 'utf8').replace(/\n\s*/g, ' ')
  const sigilInQuotes = texts.flatMap((f) => [...flatOf(f).matchAll(/--jq '([^']*)'/g)].filter((m) => /"[^"]*\$[^"]*"/.test(m[1])).map((m) => `${f}: ${m[1]}`))
  check('loop texts: no --jq filter holds a $ inside a double-quoted string', sigilInQuotes.length === 0, sigilInQuotes.join('\n'))
  const executors = ['claude-code/skills/start-executor/SKILL.md', 'kiro/skills/start-executor/SKILL.md', 'generic/executor.md']
  const noScript = executors.filter((f) => !/scripts\/pr-for-issue\.mjs --repo <repo> --closes <N>/.test(flatOf(f)))
  check('open-PR lookup: every executor uses pr-for-issue.mjs', noScript.length === 0, noScript.join('\n'))
  // A failed lookup read as "no PR" would claim an issue whose PR is open (#130 review).
  const noStop = executors.filter((f) => !flatOf(f).includes('A failed lookup (exit 2, a `pr-for-issue:` line) is neither: never claim on it.') ||
    !flatOf(f).includes('say `Could not look up open PRs for #<N>: <the pr-for-issue: line>. Restart when gh works.`'))
  check('open-PR lookup: every executor stops on a failed lookup, never claims on it', noStop.length === 0, noStop.join('\n'))
  const clause = 'holds no `$` inside a double-quoted string (a regex such as `test("…$")`, which drew the same prompt): a lookup that needs one goes through a plugin script'
  const clauseTexts = ['claude-code/skills/start-executor/SKILL.md', 'claude-code/skills/start-reviewer/SKILL.md', 'generic/executor.md', 'generic/qa.md', 'generic/reviewer.md',
    'kiro/skills/start-executor/SKILL.md', 'kiro/skills/start-qa/SKILL.md', 'kiro/skills/start-reviewer/SKILL.md']
  const noClause = [...clauseTexts.filter((f) => !flatOf(f).includes(clause)),
    ...(flatOf('claude-code/skills/start-qa/SKILL.md').includes('holds no `$` inside a double-quoted string, a regex such as `test("…$")`, which drew the same prompt: a lookup that needs one goes through a plugin script') ? [] : ['claude-code/skills/start-qa/SKILL.md'])]
  check('loop texts: beside every ]] clause, a --jq filter holds no $ inside a double-quoted string', noClause.length === 0, noClause.join('\n'))
}

// ---------------------------------------------------------------- claims.mjs, the resume claim check (#129)
{
  const ctx = makeEnv()
  const claimed = (clone, id, login = 'acme', association = 'OWNER') =>
    ({ id, body: `[executor] Claimed by ${clone}`, created_at: '2026-01-01T10:00:00Z', user: user(login), author_association: association })
  const held = (labels, comments, state = 'OPEN', agents) =>
    ({ issues: [{ number: 42, labels: labels.map((name) => ({ name })), state }], issueComments: { 42: comments }, ...(agents === undefined ? {} : { agents }) })
  const ask = (fixture, extra = []) => run(ctx, 'claims.mjs', ['--repo', REPO, '--issue', '42', '--clone', 'exec-a', ...extra], fixture).trim()
  const other = { id: 9, body: 'Looks good', created_at: '2026-01-01T09:00:00Z', user: user('acme') }
  check('claims: open, in progress, the newest claim names this clone → CLAIM_HELD',
    ask(held(['in-progress'], [claimed('exec-b', 1), other, claimed('exec-a', 12)])) === 'CLAIM_HELD')
  check('claims: … the newest names another clone → CLAIM_LOST <clone>',
    ask(held(['in-progress'], [claimed('exec-a', 1), claimed('exec-b', 12)])) === 'CLAIM_LOST exec-b')
  check('claims: … newest by id, whatever the list order',
    ask(held(['in-progress'], [claimed('exec-a', 12), claimed('exec-b', 1)])) === 'CLAIM_HELD')
  check('claims: a clone name that only starts the same ("exec-a2") is another clone → CLAIM_LOST exec-a2',
    ask(held(['in-progress'], [claimed('exec-a2', 5)])) === 'CLAIM_LOST exec-a2')
  check('claims: "Claimed by exec-a and more" names no clone exactly → CLAIM_LOST (unnamed), never HELD and never this clone\'s name',
    ask(held(['in-progress'], [claimed('exec-a and more', 5)])) === 'CLAIM_LOST (unnamed)' &&
    ask(held(['in-progress'], [claimed('exec-b\nexec-a', 5)])) === 'CLAIM_LOST (unnamed)')
  check('claims: a claim naming no clone (control characters, a backtick, nothing) → CLAIM_LOST (unnamed), never the raw text',
    ask(held(['in-progress'], [claimed('\u001b[2J`rm`', 5)])) === 'CLAIM_LOST (unnamed)' && ask(held(['in-progress'], [claimed('', 5)])) === 'CLAIM_LOST (unnamed)')
  check('claims: open, in progress, no claim comment → CLAIM_NONE', ask(held(['in-progress'], [other])) === 'CLAIM_NONE')
  check('claims: open without the in-progress label → CLAIM_RELEASED (a claim of ours on it is old)',
    ask(held([], [claimed('exec-a', 5)])) === 'CLAIM_RELEASED')
  check('claims: blocked (with or without in-progress) → CLAIM_BLOCKED',
    ask(held(['is-blocked'], [])) === 'CLAIM_BLOCKED' && ask(held(['in-progress', 'is-blocked'], [claimed('exec-a', 5)])) === 'CLAIM_BLOCKED')
  check('claims: closed → CLAIM_CLOSED', ask(held(['in-progress'], [claimed('exec-a', 5)], 'CLOSED')) === 'CLAIM_CLOSED')
  check('claims: the project\'s own labels are used',
    ask(held(['wip'], [claimed('exec-a', 5)]), ['--in-progress-label', 'wip', '--blocked-label', 'parked']) === 'CLAIM_HELD' &&
    ask(held(['parked', 'wip'], []), ['--in-progress-label', 'wip', '--blocked-label', 'parked']) === 'CLAIM_BLOCKED' &&
    ask(held(['in-progress'], [claimed('exec-a', 5)]), ['--in-progress-label', 'wip']) === 'CLAIM_RELEASED')
  check('claims: claims across pages are all read',
    ask({ ...held(['in-progress'], []), issueComments: undefined, comments_pages: [[claimed('exec-a', 1)], [claimed('exec-b', 2)]] }) === 'CLAIM_LOST exec-b')
  // #134: a claim is text anyone who can comment can post; only a trusted author's counts.
  const listBlock = (list) => `## Agent loop\n\nrepo: acme/widgets\ntrusted-authors: ${list}\n`
  check('claims (#134): an untrusted login\'s newer claim is ignored → CLAIM_HELD stays CLAIM_HELD (no list: the association decides)',
    ask(held(['in-progress'], [claimed('exec-a', 5), claimed('exec-b', 12, 'mallory', 'NONE')])) === 'CLAIM_HELD')
  check('claims (#134): … only untrusted claims → CLAIM_NONE, as if they weren\'t there',
    ask(held(['in-progress'], [claimed('exec-b', 12, 'mallory', 'CONTRIBUTOR')])) === 'CLAIM_NONE')
  check('claims (#134): with no list, a MEMBER\'s or COLLABORATOR\'s claim counts → CLAIM_LOST <clone>',
    ask(held(['in-progress'], [claimed('exec-a', 5), claimed('exec-b', 12, 'teammate', 'MEMBER')])) === 'CLAIM_LOST exec-b' &&
      ask(held(['in-progress'], [claimed('exec-a', 5), claimed('exec-c', 12, 'helper', 'COLLABORATOR')])) === 'CLAIM_LOST exec-c')
  check('claims (#134): allow-author-associations narrows the fallback (OWNER only → a MEMBER\'s claim is ignored)',
    ask(held(['in-progress'], [claimed('exec-a', 5), claimed('exec-b', 12, 'teammate', 'MEMBER')], 'OPEN', '## Agent loop\n\nrepo: acme/widgets\nallow-author-associations: [OWNER]\n')) === 'CLAIM_HELD')
  check('claims (#134): a trusted second account\'s claim → CLAIM_LOST <clone>, whatever its association',
    ask(held(['in-progress'], [claimed('exec-a', 5), claimed('exec-b', 12, 'bot2', 'NONE')], 'OPEN', listBlock('[acme, "@bot2"]'))) === 'CLAIM_LOST exec-b')
  check('claims (#134): with trusted-authors, the list alone decides: an OWNER not on it is ignored; logins match without case',
    ask(held(['in-progress'], [claimed('exec-a', 5, 'ACME'), claimed('exec-b', 12, 'other-owner', 'OWNER')], 'OPEN', listBlock('[acme]'))) === 'CLAIM_HELD')
  check('claims (#134): an empty trusted-authors list is no list → the association fallback',
    ask(held(['in-progress'], [claimed('exec-a', 5), claimed('exec-b', 12, 'mallory', 'NONE')], 'OPEN', listBlock('[]'))) === 'CLAIM_HELD')
  check('claims (#134): the clone\'s copy of AGENTS.md is never read (the fixture serves the default branch\'s)',
    !readFileSync(path.join(scripts, 'claims.mjs'), 'utf8').includes('readFileSync'))
  const blind = ask(held(['in-progress'], [claimed('exec-a', 5)], 'OPEN', 'error'))
  check('claims (#134): the default branch\'s block unreadable → exit 2 with a claims: line, never a claim line', /^EXIT 2\n\nclaims: HTTP 502/.test(blind), blind)
  writeFileSync(ctx.log, '')
  const hostileRepo = ['acme/$(touch x)', 'acme/`id`', 'acme/w;id'].map((r) => run(ctx, 'claims.mjs', ['--repo', r, '--issue', '42', '--clone', 'exec-a'], {}))
  check('claims (#134): a --repo outside GitHub\'s name characters → exit 1, no gh call (it reaches a shell line)',
    hostileRepo.every((o) => o.startsWith('EXIT 1')) && readFileSync(ctx.log, 'utf8') === '', hostileRepo.join('\n'))
  const failed = ask({ fail: true })
  check('claims: a failed gh call → exit 2 with a claims: line, nothing on stdout', /^EXIT 2\n\nclaims: HTTP 502/.test(failed), failed)
  const missing = ask({ issues: [] })
  check('claims: no such issue → exit 2 (never a claim line)', /^EXIT 2\n\nclaims: /.test(missing), missing)
  const usage = [run(ctx, 'claims.mjs', ['--repo', REPO, '--issue', '42'], {}), run(ctx, 'claims.mjs', ['--repo', REPO, '--issue', 'x', '--clone', 'exec-a'], {}),
    run(ctx, 'claims.mjs', ['--repo', REPO, '--issue', '42', '--clone', '../x'], {}), run(ctx, 'claims.mjs', ['--repo', REPO, '--issue', '42', '--clone', 'exec-a', 'extra'], {})]
  check('claims: no --clone, an --issue that is no number, a --clone that is not a clone name, or a stray argument → exit 1',
    usage.every((o) => o.startsWith('EXIT 1')), usage.join('\n'))
  rmSync(ctx.home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- the local-ci key (#107)
{
  // With `local-ci: <context>` every executor leaves the gate to the runner before the PR, runs its
  // poll as is (pr-poll reads the key from the block, #129), and runs the gate only on NO_LOCAL_CI.
  const adapters = path.resolve(scripts, '..', 'adapters')
  const flat = (f) => readFileSync(path.join(adapters, f), 'utf8').replace(/\n\s*/g, ' ')
  const texts = {
    'claude-code': flat('claude-code/skills/start-executor/SKILL.md') + flat('claude-code/skills/start-executor/reference/implement.md') + flat('claude-code/skills/start-executor/reference/signals.md'),
    generic: flat('generic/executor.md'),
    kiro: flat('kiro/skills/start-executor/SKILL.md'),
  }
  const missing = Object.entries(texts).filter(([, t]) =>
    !(t.includes('reads `qa-gate`, `gate` and `local-ci` from the block on the default branch itself') && t.includes('Gate: runs as the <context> check.') &&
      t.includes('`[executor] No <context> check on <short sha>: Gate on <short sha>:') && /never run the gate before opening the PR|the gate is never yours before opening the PR/.test(t))
  ).map(([k]) => k)
  check('local-ci key: every executor skips the gate before the PR, leaves the key to the poll, and runs the gate on NO_LOCAL_CI', missing.length === 0, missing.join('\n'))
  const cc = flat('claude-code/skills/start-executor/SKILL.md')
  check('local-ci key: the Claude Code executor reads the key from the block, and handles NO_LOCAL_CI in its signal order; both waiters run the poll with no flags',
    cc.includes('`local-ci` (optional: the context a local runner posts the gate\'s result under') && cc.includes('`MERGED`, `CI_FAILING`, `NO_LOCAL_CI`,') &&
      (cc.match(/scripts\/pr-poll\.mjs --repo <repo> --pr <PR> --wait 30 --max (1500|3300) <inbox-flag>/g) ?? []).length === 2, '')
  // #129: a Sonnet executor dropped --local-ci; no text asks for the flags any more.
  const all = readdirSync(adapters, { recursive: true }).filter((f) => /\.md$/.test(f))
  const asks = all.filter((f) => /(--require-qa|--require-gate|--local-ci <context>)`? (when|to pr-poll)|[Pp]ass `--require|\[--require-(qa|gate)\]|\[--local-ci/.test(flat(f)))
  check('block keys (#129): no adapter text asks the caller to pass --require-qa, --require-gate or --local-ci to pr-poll', asks.length === 0, asks.join('\n'))
}

// ---------------------------------------------------------------- the executor's author check (#81)
{
  // `gh issue view --json` has no authorAssociation field (it exits 1), so the author check must
  // read the REST issue, which has author_association and user.login.
  const adapters = path.resolve(scripts, '..', 'adapters')
  const prompts = readdirSync(adapters, { recursive: true }).filter((f) => f.endsWith('.md')).map((f) => [f, readFileSync(path.join(adapters, f), 'utf8')])
  const asksView = prompts.filter(([, t]) => /gh issue view[^`]*authorAssociation/.test(t)).map(([f]) => f)
  check('author check: no adapter asks gh issue view for authorAssociation', asksView.length === 0, asksView.join('\n'))
  const executors = ['claude-code/skills/start-executor/reference/implement.md', 'generic/executor.md', 'kiro/skills/start-executor/SKILL.md']
  // An array with the login and association first, never a {a, b} object: Claude Code's safety
  // check prompts on a jq object with a comma even where `Bash(gh *)` matches.
  const refetch = (t) => /`gh api repos\/<repo>\/issues\/<N> --jq '\[\.user\.login, \.author_association, \[\.labels\[\]\.name\][^`{}]*\]'`/.test(t.replace(/\n\s*/g, ' '))
  const missing = executors.filter((f) => !refetch(readFileSync(path.join(adapters, f), 'utf8')))
  check('author check: every executor re-fetches the issue as one gh api command, an array starting with user.login and author_association', missing.length === 0, missing.join('\n'))
  const noClaim = executors.filter((f) => !/whose first or second element is null or empty, is no author check: never claim on it/.test(readFileSync(path.join(adapters, f), 'utf8').replace(/\n\s*/g, ' ')))
  check('author check: every executor says a failed re-fetch, or a null or empty login or association, is no author check', noClaim.length === 0, noClaim.join('\n'))
  const objects = prompts.flatMap(([f, t]) => [...t.replace(/\n\s*/g, ' ').matchAll(/--jq '([^']*)'/g)].filter((m) => /\{[^}]*,[^}]*\}/.test(m[1])).map((m) => `${f}: ${m[1]}`))
  check('no adapter\'s --jq holds an object with a comma (a permission prompt in Claude Code)', objects.length === 0, objects.join('\n'))
}

// ---------------------------------------------------------------- the waiter's exit-3 rule (#86)
{
  // A loop once carried "a waiter is running" from an exit-3 cycle into the next one and started
  // none. The scope has to sit in the rule's own paragraph, and the invariant has to say which
  // waiter counts.
  const skills = path.resolve(scripts, '..', 'adapters', 'claude-code', 'skills')
  const paragraph = (text, start) => text.split(/\n[ \t]*\n/).map((p) => p.replace(/\n\s*/g, ' ')).find((p) => p.startsWith(start)) ?? ''
  for (const role of ['executor', 'reviewer', 'qa']) {
    const text = readFileSync(path.join(skills, `start-${role}`, 'SKILL.md'), 'utf8')
    const rule = paragraph(text, "A waiter's notification that says **`failed with exit code 3`** is the exception")
    check(`exit-3 rule (${role}): its paragraph scopes it to this cycle only, names the surviving waiter's own exit as another wake, and says never to assume a waiter`,
      rule.includes('This covers only the cycle this exit-3 notification starts.') &&
        rule.includes("The next wake of any other kind (the surviving waiter's own exit, a message, the fallback wakeup) runs a full cycle, ended as usual with a new waiter") &&
        rule.includes('a waiter whose exit has notified you is gone, so never assume one is still running because an earlier cycle saw it'), rule)
    const invariant = paragraph(text, '**Loop invariant: every cycle ends with a waiter running')
    check(`exit-3 rule (${role}): the loop invariant says a waiter running is one this cycle started, never one an earlier cycle saw`,
      invariant.includes('"A waiter running" means one this cycle started or, on an exit-3 wake only, the one that refused a second; never one an earlier cycle saw.'), invariant)

    // #95: no cycle ends with neither a waiter nor the short timer.
    check(`no cycle without a waiter (${role}): an exit-3 wake takes the 300-second timer, never the last cycle's delay`,
      rule.includes('only call `ScheduleWakeup({ delaySeconds: 300, … })`, step 5\'s call with the short delay') && !rule.includes("the last cycle's delay"), rule)
    const restart = paragraph(text, '**A failed waiter gets one restart.**')
    check(`no cycle without a waiter (${role}): a failed waiter, exit 3 included, gets one restart, and a second failure is reported once`,
      restart.includes('Exit 3 and any other failed exit except 4 are both a failed waiter.') &&
        restart.includes('runs a full cycle ended with a waiter as usual: that is the restart. When that waiter fails too, the second failure in a row,') &&
        restart.includes("`⚠ No waiter: <the exit code and the waiter's first line>; checking every 5 minutes instead.`") &&
        restart.includes('--role ROLE_AGENT --from <clone> --to operator') &&
        restart.includes('A waiter that exits 0 (`PENDING` or `NONE`) ends the count and the 5-minute rhythm'), restart)
    // The review of #115: a restart within an old waiter's lifetime must not leave the loop without
    // waiters for good. Exit 3 keeps trying, bounded by the lock; only a broken waiter stops.
    check(`no cycle without a waiter (${role}): after exit 3 the loop keeps trying a waiter, which the other waiter's lock bounds; only a broken waiter is not retried`,
      restart.includes('after exit 3, go on as above: each wake the failure causes ends with the 300-second `ScheduleWakeup`, and the next wake runs a full cycle that starts a waiter again.') &&
        restart.includes('so this stops by itself; the report is not repeated.') &&
        restart.includes('After any other failure, the waiter itself is broken: start no more waiters') &&
        restart.includes('`ScheduleWakeup({ delaySeconds: 300, … })` alone'), restart)
    const endCheck = paragraph(text, '**Before the turn ends, check the waiter.**')
    check(`no cycle without a waiter (${role}): before the turn ends, a cycle with neither its waiter nor the 300-second timer starts the waiter and says so`,
      endCheck.includes('ran a Bash call with `run_in_background: true` that started') &&
        endCheck.includes('Neither → start the waiter now, and add `↻ waiter started at the end of the cycle` to the status line.') &&
        text.indexOf('**Before the turn ends, check the waiter.**') < text.indexOf('**Loop invariant:'), endCheck)
    check(`no cycle without a waiter (${role}): the invariant allows only the 300-second timer in place of a waiter`,
      invariant.includes('A cycle that may start no waiter (above) ends with the 300-second `ScheduleWakeup` instead, never a longer one'), invariant)

    // #116: a waiter taken over exits 4. Its wake must start no waiter (one would take the live one
    // over, whose exit wakes again) and schedule past any --max, and it is no failed waiter.
    const taken = paragraph(text, "A waiter's notification that says **`failed with exit code 4`**")
    check(`taken over (${role}): an exit-4 wake starts no waiter, waits 3600 seconds, and is not a failed waiter`,
      taken.includes('a newer waiter took its lock over (it printed `TAKEN_OVER`), and that one wakes you when it ends') &&
        taken.includes('Beat, then run nothing else and start no waiter; call `ScheduleWakeup({ delaySeconds: 3600, … })`, longer than any waiter\'s `--max`') &&
        taken.includes('Exit 4 is not a failed waiter: the count below stays as it was.') &&
        rule.includes('Any **other failed exit** (not 3, and not 4 below) means the waiter itself broke') &&
        endCheck.includes('or an exit-4 wake that called it with 3600 seconds') &&
        invariant.includes('an exit-4 wake, whose newer waiter is alive, ends with the 3600-second one'), taken)
  }
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
  // #84: a title or body edit right after a push cancelled the push's run, whose always() job then
  // reported contract-tests failed on a passing head. An edit that keeps the base runs in a group
  // of its own (per run, so a second edit can't cancel the first); a base change still shares the
  // pull request's group and replaces the stale run.
  const group = /^concurrency:\n {2}group: (.*)\n {2}cancel-in-progress: (.*)$/m.exec(ci)
  check('ci: one workflow-level concurrency group, cancel-in-progress: true', group !== null && group[2] === 'true' && ci.match(/^\s*concurrency:/gm).length === 1, group?.[0])
  // The expression read as JavaScript (its &&, || and ! return values the same way; a missing
  // property is null there, so every . is ?.), per event.
  const expr = /^ci-\$\{\{ (.*) \}\}$/.exec(group?.[1] ?? '')?.[1] ?? 'null'
  const js = expr.replace(/==/g, '===').replace(/\.(?=[A-Za-z_])/g, '?.')
  const groupFor = (event) => `ci-${new Function('github', 'format', `return ${js}`)(event, (f, ...a) => f.replace(/\{(\d+)\}/g, (_, i) => a[i]))}`
  const pr = (action, changes) => ({ event: { action, changes, pull_request: { number: 84 } }, sha: 'h1', run_id: 9001 })
  const groups = {
    push: groupFor({ event: { before: 'h0' }, sha: 'h1', run_id: 9001 }),
    synchronize: groupFor(pr('synchronize')),
    base: groupFor(pr('edited', { base: { ref: { from: 'dev' }, sha: { from: 'b0' } } })),
    title: groupFor(pr('edited', { title: { from: 'old' } })),
    body: groupFor({ ...pr('edited', { body: { from: 'old' } }), run_id: 9002 }),
  }
  check('ci: the group per event: push → ci-<sha>; a new head and a base change → ci-<pr>; a title or body edit → ci-<pr>-edit-<run id>, one per run',
    groups.push === 'ci-h1' && groups.synchronize === 'ci-84' && groups.base === 'ci-84' && groups.title === 'ci-84-edit-9001' && groups.body === 'ci-84-edit-9002',
    JSON.stringify(groups))
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
