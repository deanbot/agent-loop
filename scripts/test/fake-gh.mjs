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

const joined = args.join(' ')
if (args[0] === 'api') {
  const target = args.filter((a) => !a.startsWith('--')).at(-1)
  if (/\/issues\/\d+\/comments$/.test(target)) out(fixture.comments)
  if (/\/pulls\/\d+\/reviews$/.test(target)) out(fixture.reviews)
  if (/\/pulls\/\d+\/comments$/.test(target)) out(fixture.inline)
  if (/\/pulls\/\d+\/commits$/.test(target)) out(fixture.commits)
  if (/\/pulls\/\d+$/.test(target)) out(fixture.pr)
  process.stderr.write(`fake-gh: unhandled api target ${target}\n`)
  process.exit(2)
}
if (args[0] === 'pr' && args[1] === 'checks') {
  if (fixture.checks === null || fixture.checks === undefined) {
    process.stderr.write('no checks reported on the branch\n')
    process.exit(1)
  }
  out(fixture.checks)
}
if (args[0] === 'pr' && args[1] === 'list') out(fixture.prs)
if (args[0] === 'pr' && args[1] === 'view') out(fixture.prView)
process.stderr.write(`fake-gh: unhandled command: ${joined}\n`)
process.exit(2)
