export interface MCPServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  timeoutMs?: number
  disabled?: boolean
  /** Where the definition came from; project-level servers must be opted into. */
  source?: 'user' | 'project' | 'plugin'
  /**
   * What this server is allowed to do. A plugin author declares these; an
   * absent declaration is treated as the most restrictive reading.
   */
  capabilities?: {
    readOnlyTools?: string[]
    networkHosts?: string[]
    filesystem?: 'none' | 'workspace'
    shell?: 'none' | 'sandboxed'
    credentials?: 'none' | 'requested'
  }
}

export interface MCPConfigFile {
  mcpServers: Record<string, Omit<MCPServerConfig, 'name'>>
}

export interface MCPToolDefinition {
  name: string
  description?: string
  inputSchema: {
    type: string
    properties?: Record<string, unknown>
    required?: string[]
    [key: string]: unknown
  }
}
