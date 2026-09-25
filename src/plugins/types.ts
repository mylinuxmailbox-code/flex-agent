import type { Tool } from '../tools/types.js'
import type { Command } from '../tui/commands.js'

export interface PluginCapabilities {
  filesystem?: 'none' | 'workspace' | 'full'
  network?: boolean | string[]
  shell?: boolean
  credentials?: boolean
}

export interface PluginManifest {
  name: string
  version: string
  description: string
  author?: string
  capabilities?: PluginCapabilities
  tools?: string[]
  commands?: string[]
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
  hooks?: {
    onTaskStart?: string
    onTaskComplete?: string
    onError?: string
  }
}

export interface FlexPlugin {
  manifest: PluginManifest
  dir: string
  enabled: boolean
  tools: Tool[]
  commands: Command[]
}
