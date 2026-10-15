#!/usr/bin/env node
// Fake `gh` for script tests. Serves canned responses from the JSON fixture named by
// FAKE_GH_FIXTURE. Every call is appended to FAKE_GH_LOG (one line of args per call).
//
// Fixture shape (all keys optional):
//   pr        → gh api repos/o/r/pulls/N                    (object: { merged, head: { sha } })
//   comments  → gh api repos/o/r/issues/N/comments           (array)
//   reviews   → gh api repos/o/r/pulls/N/reviews             (array)
//   inline    → gh api repos/o/r/pulls/N/comments            (array)
//   commits   → gh api repos/o/r/pulls/N/commits             (array)
//   checks    → gh pr checks N ... --json                    (array; null → "no checks reported", exit 1)
//   prs       → gh pr list ... --json                        (array)
//   prView    → gh pr view N ... --json                      (object)
import { readFileSync, appendFileSync } from 'fs'

const args = process.argv.slice(2)
const fixture = JSON.parse(readFileSync(process.env.FAKE_GH_FIXTURE, 'utf8'))
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, args.join(' ') + '\n')

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
  const target = args.filter((a) => !a.startsWith('--')).at(-1)
  if (/\/issues\/\d+\/comments$/.test(target)) outList('comments')
  if (/\/pulls\/\d+\/reviews$/.test(target)) outList('reviews')
  if (/\/pulls\/\d+\/comments$/.test(target)) outList('inline')
  if (/\/pulls\/\d+\/commits$/.test(target)) outList('commits')
  if (/\/pulls\/\d+$/.test(target)) out(fixture.pr)
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
if (args[0] === 'pr' && args[1] === 'list') out(fixture.prs)
if (args[0] === 'pr' && args[1] === 'view') out(fixture.prView)
process.stderr.write(`fake-gh: unhandled command: ${joined}\n`)
process.exit(2)
