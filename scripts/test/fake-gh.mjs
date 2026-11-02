#!/usr/bin/env node
// Fake `gh` for script tests. Serves canned responses from the JSON fixture named by
// FAKE_GH_FIXTURE. Every call is appended to FAKE_GH_LOG (one line of args per call).
//
// Fixture shape (all keys optional):
//   pr        → gh api repos/o/r/pulls/N                    (object: { merged, head: { sha }, mergeable, mergeable_state });
//               without it, N as `prs` lists it ({ state: 'open', head: { sha: headRefOid } }), or closed
//   comments  → gh api repos/o/r/issues/N/comments           (array; issueComments: { N: array } serves
//               one issue's own list, for scripts that read several issues)
//   reviews   → gh api repos/o/r/pulls/N/reviews             (array)
//   inline    → gh api repos/o/r/pulls/N/comments            (array)
//   commits   → gh api repos/o/r/pulls/N/commits             (array)
//   checks    → gh pr checks N ... --json                    (array; null → "no checks reported", exit 1)
//   prs       → gh pr list ... --json                        (array)
//   openPrs   → gh pr list ... --state open --json, when set (array; else `prs`)
//   prView    → gh pr view N ... --json                      (object)
//   issues    → gh issue list (open ones, --milestone filters on .milestone.title) and
//               gh api repos/o/r/issues/N → { state: 'open' | 'closed', labels, and user, author_association,
//               title, body, created_at, pull_request as given } (array: { number, body, labels,
//               state?: 'OPEN' | 'CLOSED' | 'MERGED', milestone? }; a MERGED entry is a PR)
//   milestones → gh api repos/o/r/milestones?…                 (array: { number, title, state })
//   repo      → gh api repos/o/r                              (object; default { default_branch: 'main' })
//   statuses  → commit statuses by sha, oldest first           (object: sha → [{ state, context, description, target_url? }])
//               gh api repos/o/r/commits/SHA/status serves the newest per context; gh api -X POST
//               repos/o/r/statuses/SHA -f k=v … appends one and writes the fixture back
//   prCommits → gh api repos/o/r/pulls/N/commits, per PR        (object: N → array; else `commits`)
//   runs      → gh api repos/o/r/actions/runs?…                 (array of workflow runs, served as one page)
//   attempts  → gh api repos/o/r/actions/runs/ID/attempts/K     (object: "ID/K" → run)
//   items     → gh api repos/o/r/issues?…                       (array: issues and PRs, as the list endpoint)
//   events    → gh api repos/o/r/issues/N/events                (object: N → array)
//   agents    → gh api repos/o/r/contents/AGENTS.md             (string: the default branch's file, served
//               base64 as the contents API does; absent → a block with only `repo`; null → 404;
//               'error' → HTTP 502;
//               'too-large' → encoding "none" and no content, as for a file over 1 MB)
//   A query string (`?per_page=100`) on a path is ignored.
//               gh issue list --state closed [--label L] serves the CLOSED ones (carrying L), as { number }
//   closedListFail → that closed-issue list fails like a network error (true)
//   editFail  → gh issue edit N … fails for these numbers (array); otherwise it succeeds
//   fail      → every call fails like a network error         (true)
//   delayMs   → every call takes this long before answering    (number)
import { readFileSync, appendFileSync, writeFileSync, renameSync } from 'fs'

const args = process.argv.slice(2)
const fixture = JSON.parse(readFileSync(process.env.FAKE_GH_FIXTURE, 'utf8'))
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, args.join(' ') + '\n')
if (fixture.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, fixture.delayMs)

if (fixture.fail) {
  process.stderr.write('HTTP 502: Bad Gateway (https://api.github.com/)\n')
  process.exit(1)
}

function out(v) {
  process.stdout.write(JSON.stringify(v ?? []))
  process.exit(0)
}

// `gh api --paginate --slurp` returns an array of pages. A fixture may give `<key>_pages`
// (array of arrays) to simulate several pages; otherwise the list is served as one page.
function outList(key) {
  const slurp = args.includes('--slurp')
  const pages = fixture[`${key}_pages`]
  if (slurp) out(pages ?? [fixture[key] ?? []])
  out(pages ? pages[0] : fixture[key])
}

const joined = args.join(' ')
if (args[0] === 'api') {
  // The path: the argument naming repos/…, or else the last one that is not a flag.
  const full = args.find((a) => a.startsWith('repos/')) ?? args.filter((a) => !a.startsWith('--')).at(-1)
  const target = full.split('?')[0]
  if (/^repos\/[^/]+\/[^/]+$/.test(target)) out(fixture.repo ?? { default_branch: 'main' })
  if (/\/actions\/runs$/.test(target)) {
    const page = { total_count: (fixture.runs ?? []).length, workflow_runs: fixture.runs ?? [] }
    out(args.includes('--slurp') ? [page] : page)
  }
  if (/\/actions\/runs\/\d+\/attempts\/\d+$/.test(target)) {
    const key = target.split('/').slice(-3).filter((_, i) => i !== 1).join('/')
    const run = fixture.attempts?.[key]
    if (!run) {
      process.stderr.write('gh: Not Found (HTTP 404)\n')
      process.exit(1)
    }
    out(run)
  }
  if (/\/contents\/AGENTS\.md$/.test(target)) {
    if (fixture.agents === null) {
      process.stderr.write('gh: Not Found (HTTP 404)\n')
      process.exit(1)
    }
    if (fixture.agents === 'too-large') out({ name: 'AGENTS.md', encoding: 'none', content: '' })
    if (fixture.agents === 'error') {
      process.stderr.write('HTTP 502: Bad Gateway (https://api.github.com/)\n')
      process.exit(1)
    }
    // The API wraps base64 at 60 characters.
    const content = Buffer.from(fixture.agents ?? '## Agent loop\n\nrepo: acme/widgets\n').toString('base64').replace(/(.{60})/g, '$1\n')
    out({ name: 'AGENTS.md', encoding: 'base64', content })
  }
  if (/\/issues$/.test(target)) out(args.includes('--slurp') ? [fixture.items ?? []] : (fixture.items ?? []))
  if (/\/issues\/\d+\/events$/.test(target)) {
    const own = fixture.events?.[target.split('/').at(-2)] ?? []
    out(args.includes('--slurp') ? [own] : own)
  }
  if (/\/pulls\/\d+\/commits$/.test(target) && fixture.prCommits) {
    const own = fixture.prCommits[target.split('/').at(-2)] ?? []
    out(args.includes('--slurp') ? [own] : own)
  }
  if (/\/commits\/[0-9a-f]+\/status$/.test(target)) {
    const list = fixture.statuses?.[target.split('/').at(-2)] ?? []
    const newest = [...list].reverse().filter((s, i, all) => all.findIndex((t) => t.context === s.context) === i)
    out({ state: newest[0]?.state ?? 'pending', statuses: newest })
  }
  if (/\/statuses\/[0-9a-f]+$/.test(target) && args.includes('POST')) {
    const sha = target.split('/').at(-1)
    const status = {}
    args.forEach((a, i) => {
      if (args[i - 1] === '-f') status[a.slice(0, a.indexOf('='))] = a.slice(a.indexOf('=') + 1)
    })
    // Re-read: a test may have rewritten the fixture since this call started.
    const current = JSON.parse(readFileSync(process.env.FAKE_GH_FIXTURE, 'utf8'))
    current.statuses ??= {}
    ;(current.statuses[sha] ??= []).push(status)
    writeFileSync(`${process.env.FAKE_GH_FIXTURE}.tmp`, JSON.stringify(current))
    renameSync(`${process.env.FAKE_GH_FIXTURE}.tmp`, process.env.FAKE_GH_FIXTURE)
    out(status)
  }
  if (/\/issues\/\d+\/comments$/.test(target)) {
    const own = fixture.issueComments?.[target.split('/').at(-2)]
    if (own) out(args.includes('--slurp') ? [own] : own)
    outList('comments')
  }
  if (/\/pulls\/\d+\/reviews$/.test(target)) outList('reviews')
  if (/\/pulls\/\d+\/comments$/.test(target)) outList('inline')
  if (/\/pulls\/\d+\/commits$/.test(target)) outList('commits')
  if (/\/pulls\/\d+$/.test(target) && fixture.pr === undefined && Array.isArray(fixture.prs)) {
    // No `pr` given: the PR as `prs` lists it (open, its head), or closed when it is not listed.
    const listed = fixture.prs.find((p) => String(p.number) === target.split('/').at(-1))
    out(listed ? { number: listed.number, state: 'open', head: { sha: listed.headRefOid } } : { state: 'closed', head: { sha: null } })
  }
  if (/\/pulls\/\d+$/.test(target)) out(fixture.pr)
  if (/\/milestones(\?|$)/.test(target)) out(fixture.milestones)
  if (/\/issues\/\d+$/.test(target)) {
    const n = target.split('/').at(-1)
    const issue = (fixture.issues ?? []).find((i) => String(i.number) === n)
    if (!issue) {
      process.stderr.write('gh: Not Found (HTTP 404)\n')
      process.exit(1)
    }
    // The REST issue's other fields (user, author_association, title, body, created_at, pull_request)
    // as the fixture gives them.
    const { user, author_association, title, body, created_at, pull_request } = issue
    out({ number: issue.number, state: (issue.state ?? 'OPEN') === 'OPEN' ? 'open' : 'closed', labels: issue.labels ?? [], user, author_association, title, body, created_at, pull_request })
  }
  process.stderr.write(`fake-gh: unhandled api target ${target}\n`)
  process.exit(2)
}
if (args[0] === 'pr' && args[1] === 'checks') {
  if (fixture.checks === null || fixture.checks === undefined) {
    process.stderr.write('no checks reported on the branch\n')
    process.exit(1)
  }
  if (fixture.checks === 'error') {
    process.stderr.write('HTTP 401: Bad credentials (https://api.github.com/graphql)\n')
    process.exit(1)
  }
  out(fixture.checks)
}
if (args[0] === 'pr' && args[1] === 'list' && args[args.indexOf('--state') + 1] === 'open' && fixture.openPrs !== undefined) out(fixture.openPrs)
if (args[0] === 'pr' && args[1] === 'list') out(fixture.prs)
if (args[0] === 'pr' && args[1] === 'view') out(fixture.prView)
if (args[0] === 'issue' && args[1] === 'list' && args[args.indexOf('--state') + 1] === 'closed') {
  if (fixture.closedListFail) {
    process.stderr.write('HTTP 502: Bad Gateway (https://api.github.com/)\n')
    process.exit(1)
  }
  const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : null
  out(
    (fixture.issues ?? [])
      .filter((i) => i.state === 'CLOSED')
      .filter((i) => label === null || (i.labels ?? []).some((l) => (l?.name ?? l) === label))
      .map(({ number }) => ({ number }))
  )
}
if (args[0] === 'issue' && args[1] === 'edit') {
  if ((fixture.editFail ?? []).includes(Number(args[2]))) {
    process.stderr.write('HTTP 403: Resource not accessible by integration\n')
    process.exit(1)
  }
  process.stdout.write(`https://github.com/acme/widgets/issues/${args[2]}\n`)
  process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'list') {
  const mi = args.indexOf('--milestone')
  const title = mi === -1 ? null : args[mi + 1]
  out(
    (fixture.issues ?? [])
      .filter((i) => (i.state ?? 'OPEN') === 'OPEN')
      .filter((i) => title === null || i.milestone?.title === title)
      .map(({ state, milestone, ...rest }) => rest)
  )
}
process.stderr.write(`fake-gh: unhandled command: ${joined}\n`)
process.exit(2)
