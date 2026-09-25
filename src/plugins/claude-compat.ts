import type { PluginManifest } from './types.js'

/**
 * Claude Code plugin compatibility.
 *
 * The goal is that an existing Claude Code plugin imports with minimal or no
 * modification. The manifest is parsed and validated rather than copied
 * blindly, and the permission block is translated conservatively: an absent or
 * unrecognised declaration resolves to the *restrictive* reading, because a
 * plugin that fails to declare its capabilities should be less capable, not
 * more.
 */

export interface ClaudePluginRawManifest {
  name?: string
  version?: string
  description?: string
  commands?: Array<{ name: string; description: string; script?: string }>
  tools?: string[]
  skills?: string[]
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
  permissions?: {
    filesystem?: string
    network?: string[] | boolean
    terminal?: boolean
  }
}

/** Cheap sniff so the importer can pick a candidate without a schema. */
export function isClaudePlugin(raw: Record<string, unknown>): boolean {
  return Boolean(
    raw.claudePlugin ||
      raw.skills ||
      (raw.commands && Array.isArray(raw.commands)) ||
      raw.mcpServers,
  )
}

export function translateClaudePlugin(
  raw: ClaudePluginRawManifest,
  defaultName = 'imported-claude-plugin',
): PluginManifest {
  const name = raw.name || defaultName
  const version = raw.version || '0.1.0'
  const description = raw.description || `Imported Claude Code plugin: ${name}`

  // `network: true` in a Claude manifest means "may reach the network", not a
  // host list. Flex's boolean capability records *whether* network is reachable;
  // the actual destinations are still gated per call by the risk engine, so an
  // unconstrained grant here does not auto-approve anything.
  // A host list is preserved verbatim; `true` becomes "network reachable,
  // destinations decided per call".
  const network = Array.isArray(raw.permissions?.network)
    ? raw.permissions.network
    : raw.permissions?.network === true
      ? true
      : undefined

  return {
    name,
    version,
    description,
    capabilities: {
      filesystem:
        raw.permissions?.filesystem === 'full' || raw.permissions?.filesystem === '*'
          ? 'full'
          : 'workspace',
      network,
      shell: raw.permissions?.terminal === true,
      credentials: false,
    },
    tools: raw.tools ?? [],
    commands: raw.commands?.map((c) => c.name) ?? [],
    mcpServers: raw.mcpServers,
  }
}

export const ClaudeCodeAdapter = {
  isClaudePlugin,
  translate: translateClaudePlugin,
}
