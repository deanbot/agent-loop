#!/usr/bin/env node
/**
 * The log of a head's latest local-ci run on this machine (#137), so an executor on the runner's
 * machine reads a failure there instead of re-running the whole gate to see it.
 *
 * Usage:
 *   node scripts/local-ci-log.mjs --repo owner/repo --pr <n> --sha <sha>
 *
 * Looks in the runner's log folder, ~/.agent-loop/local-ci/<owner>-<repo>/, for the files
 * local-ci.mjs writes, `<pr>-<first 12 of sha>-<time>.log`, and prints one line:
 *   <path>         the newest log of that PR's head <sha> (a sha of 7 to 40 hex digits; one shorter
 *                  than 12 matches the logs whose sha starts with it), readable by this session
 *   NO_LOCAL_LOG   no such log here: the runner runs elsewhere (or as another user), the folder
 *                  isn't readable, or this head has no run yet
 * Exit 0 either way; exit 1 on a usage error. It reads names only, never a log's contents, and
 * writes nothing.
 */

import { readdirSync, accessSync, constants } from 'fs'
import { homedir } from 'os'
import path from 'path'

const USAGE = 'local-ci-log.mjs --repo owner/repo --pr <n> --sha <sha>'
const OPTIONS = ['--repo', '--pr', '--sha']

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
if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) usageError(repo ? `--repo: expected owner/repo, got "${repo}"` : '--repo is required')
const pr = arg('--pr')
if (!pr || !/^\d+$/.test(pr)) usageError(pr ? `--pr: expected a PR number, got "${pr}"` : '--pr is required')
const shaArg = arg('--sha')
if (!shaArg || !/^[0-9a-fA-F]{7,40}$/.test(shaArg)) usageError(shaArg ? `--sha: expected a commit sha (7 to 40 hex digits), got "${shaArg}"` : '--sha is required')
const sha = shaArg.toLowerCase().slice(0, 12)

// local-ci.mjs's LOG_DIR and log name, `${pr}-${sha.slice(0, 12)}-${stamp}.log`.
const dir = path.join(homedir(), '.agent-loop', 'local-ci', repo.replace('/', '-'))
const NAME = /^(\d+)-([0-9a-f]{12})-([0-9TZ-]+)\.log$/

let names = []
try {
  names = readdirSync(dir)
} catch {
  // no folder, or not readable: no log here
}
// The time stamps are ISO times with ':' and '.' as '-': for one PR and sha they sort by name.
const newest = names
  .map((n) => [n, NAME.exec(n)])
  .filter(([, m]) => m && m[1] === pr && m[2].startsWith(sha))
  .map(([n]) => n)
  .sort()
  .at(-1)
let line = 'NO_LOCAL_LOG'
if (newest) {
  const file = path.join(dir, newest)
  try {
    accessSync(file, constants.R_OK)
    line = file
  } catch {
    // listed but not readable
  }
}
process.stdout.write(`${line}\n`)
