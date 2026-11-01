// The `## Agent loop` block of an AGENTS.md text: `key: value` lines up to the next `## ` heading.

// The block's text, or '' when the file has none.
export function agentLoopBlock(agents) {
  return (agents ?? '').split(/^## /m).find((s) => s.startsWith('Agent loop')) ?? ''
}

// A key's raw value (the rest of its first line, trimmed), or null when the block has no such key.
export function blockLine(agents, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`^${escaped}:[ \\t]*(.*)$`, 'm').exec(agentLoopBlock(agents))
  return m ? m[1].trim() : null
}

// The default branch's AGENTS.md text, through `gh(cmd, opts)`. Throws an Error saying why when it
// can't be read. A project that runs the loop has a block, so a missing file (a misnamed one
// included: the API is case-sensitive) is a fault, never a block with no keys; over 1 MB the API
// sends no content (encoding "none"): unreadable, never an empty block.
export function fetchAgents(gh, repo) {
  try {
    const file = JSON.parse(gh(`gh api "repos/${repo}/contents/AGENTS.md"`, { stdio: ['ignore', 'pipe', 'pipe'] }))
    if (file.encoding !== 'base64') throw new Error(`AGENTS.md came back with encoding "${file.encoding}"`)
    return Buffer.from(file.content ?? '', 'base64').toString('utf8')
  } catch (e) {
    const stderr = String(e?.stderr ?? '')
    throw new Error(/HTTP 404|Not Found/.test(stderr) ? 'no AGENTS.md on the default branch' : stderr.trim() || e?.message)
  }
}

// A key's single value, a pair of quotes or backticks around it removed; null when absent or empty.
export function blockValue(agents, key) {
  const v = blockLine(agents, key)?.replace(/^(["'`])(.*)\1$/, '$2').trim()
  return v ? v : null
}

// A key's list value (`[a, "@b"]` or `a, b`), each item with its quotes and a leading @ removed;
// [] when the key is absent or empty.
export function blockList(agents, key) {
  return (blockLine(agents, key) ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^['"@]+|['"]+$/g, ''))
    .filter(Boolean)
}

export const DEFAULT_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR']

// Whom the project trusts, from its block (spec: "Security"): `trusted-authors` when it lists
// anyone, else `allow-author-associations` (default OWNER, MEMBER, COLLABORATOR). Returns a test of a
// REST comment or issue ({ user: { login }, author_association }). Logins compare without case, as
// GitHub's do.
export function trustTest(agents) {
  const logins = blockList(agents, 'trusted-authors').map((l) => l.toLowerCase())
  if (logins.length > 0) return (c) => logins.includes(String(c?.user?.login ?? '').toLowerCase())
  const listed = blockList(agents, 'allow-author-associations').map((a) => a.toUpperCase())
  const associations = listed.length > 0 ? listed : DEFAULT_ASSOCIATIONS
  return (c) => associations.includes(String(c?.author_association ?? '').toUpperCase())
}

// owner/repo in GitHub's own name characters: fetchAgents puts it on a gh command line.
export const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
