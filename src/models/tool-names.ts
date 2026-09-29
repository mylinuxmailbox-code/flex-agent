import type { AgentMessage, ContentBlock, ModelTool } from './types.js'

/**
 * Wire-safe tool names.
 *
 * Every major API restricts function names to `[A-Za-z0-9_-]{1,64}`. Built-in
 * tools already comply, but MCP and plugin tools are named from third-party
 * strings (`mcp__my.server__do thing`). Rather than have each adapter guess,
 * the router rewrites names on the way out and restores them on the way back,
 * so the rest of Flex only ever sees the real name.
 */

const VALID = /^[A-Za-z0-9_-]{1,64}$/

export interface ToolNameMap {
  toWire(name: string): string
  fromWire(name: string): string
  /** True when at least one name had to be rewritten. */
  readonly rewritten: boolean
}

function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36).padStart(6, '0').slice(0, 6)
}

export function buildToolNameMap(names: Iterable<string>): ToolNameMap {
  const forward = new Map<string, string>()
  const backward = new Map<string, string>()

  for (const name of names) {
    if (forward.has(name)) continue
    let wire = name
    if (!VALID.test(name)) {
      const cleaned = name.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool'
      wire = `${cleaned.slice(0, 57)}_${hash(name)}`
    }
    // Two different names must never collapse onto one wire name.
    while (backward.has(wire) && backward.get(wire) !== name)
      wire = `${wire.slice(0, 55)}_${hash(wire)}`
    forward.set(name, wire)
    backward.set(wire, name)
  }

  const rewritten = [...forward].some(([a, b]) => a !== b)
  return {
    rewritten,
    toWire: (name) =>
      forward.get(name) ??
      (VALID.test(name) ? name : name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)),
    fromWire: (name) => backward.get(name) ?? name,
  }
}

/** Collect every tool name a request mentions: advertised tools and history. */
export function requestToolNames(tools: readonly ModelTool[], messages: readonly AgentMessage[]) {
  const names = new Set<string>(tools.map((t) => t.name))
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use' || block.type === 'server_tool_use') names.add(block.name)
    }
  }
  return names
}

export function renameBlocks(
  blocks: ContentBlock[],
  rename: (name: string) => string,
): ContentBlock[] {
  return blocks.map((block) =>
    block.type === 'tool_use' ? { ...block, name: rename(block.name) } : block,
  )
}
