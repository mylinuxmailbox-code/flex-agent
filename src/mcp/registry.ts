import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ToolRegistry } from '../tools/registry.js'
import { adaptMCPTool } from './adapter.js'
import { MCPServerConnection } from './client.js'
import type { MCPConfigFile, MCPServerConfig } from './types.js'

export class MCPManager {
  private connections = new Map<string, MCPServerConnection>()

  async loadConfigs(workspaceRoot: string): Promise<MCPServerConfig[]> {
    const configs: MCPServerConfig[] = []
    const paths = [
      join(homedir(), '.flex', 'mcp.json'),
      join(workspaceRoot, '.flex', 'mcp.json'),
      join(workspaceRoot, '.mcp.json'),
    ]

    for (const p of paths) {
      try {
        const text = await readFile(p, 'utf8')
        const parsed = JSON.parse(text) as MCPConfigFile
        if (parsed.mcpServers) {
          for (const [name, server] of Object.entries(parsed.mcpServers)) {
            if (!server.disabled) {
              configs.push({ name, ...server })
            }
          }
        }
      } catch {
        // file doesn't exist or not json
      }
    }

    return configs
  }

  async registerServers(
    configs: MCPServerConfig[],
    registry: ToolRegistry,
  ): Promise<{ connected: string[]; failed: Array<{ name: string; error: string }> }> {
    const connected: string[] = []
    const failed: Array<{ name: string; error: string }> = []

    for (const config of configs) {
      try {
        const conn = new MCPServerConnection(config)
        const tools = await conn.connect()
        this.connections.set(config.name, conn)

        for (const toolDef of tools) {
          const adapted = adaptMCPTool(config.name, toolDef, conn, config.capabilities)
          registry.register(adapted)
        }
        connected.push(config.name)
      } catch (err) {
        failed.push({
          name: config.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return { connected, failed }
  }

  async closeAll(): Promise<void> {
    for (const conn of this.connections.values()) {
      await conn.close()
    }
    this.connections.clear()
  }

  getConnectedServers(): string[] {
    return Array.from(this.connections.keys())
  }
}

export const mcpManager = new MCPManager()
