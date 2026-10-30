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

// A key's single value, a pair of quotes or backticks around it removed; null when absent or empty.
export function blockValue(agents, key) {
  const v = blockLine(agents, key)?.replace(/^(["'`])(.*)\1$/, '$2').trim()
  return v ? v : null
}
