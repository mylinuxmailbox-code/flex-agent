import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { flexHome } from '../paths.js'
import type { ToolRegistry } from '../tools/registry.js'
import { adaptMCPTool } from './adapter.js'
import { MCPServerConnection } from './client.js'
import type { MCPConfigFile, MCPServerConfig } from './types.js'

export interface LoadMCPOptions {
  /** Servers from the user's merged config (`mcp.servers`). Always trusted. */
  inline?: Record<string, Record<string, unknown>>
  /** Names the user has explicitly approved from project or plugin files. */
  enabled?: readonly string[]
  /** Names the user has switched off, wherever they were defined. */
  disabled?: readonly string[]
  /** `FLEX_TRUST_PROJECT=1`: treat this repository's MCP files as trusted. */
  trustProject?: boolean
}

export interface LoadedMCPConfigs {
  configs: MCPServerConfig[]
  /** Project/plugin servers found but not started, with the reason. */
  skipped: Array<{ name: string; source: string; reason: string }>
}

async function readServers(path: string): Promise<Record<string, Omit<MCPServerConfig, 'name'>>> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as MCPConfigFile
    return parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {}
  } catch {
    return {} // missing or not JSON
  }
}

export class MCPManager {
  private connections = new Map<string, MCPServerConnection>()

  /**
   * Work out which MCP servers to start.
   *
   * A server is an arbitrary program. Anything in the user's own config starts;
   * anything that arrived with a repository (`.mcp.json`, `.flex/mcp.json`) or a
   * plugin is a program somebody else chose, so it starts only when the user
   * named it in `mcp.enabled` (or set `FLEX_TRUST_PROJECT=1`). Cloning a repo
   * and running `flex` in it must not run that repo's commands.
   */
  async loadConfigs(
    workspaceRoot: string,
    options: LoadMCPOptions = {},
  ): Promise<LoadedMCPConfigs> {
    const disabled = new Set(options.disabled ?? [])
    const enabled = new Set(options.enabled ?? [])
    const trustProject = options.trustProject ?? process.env.FLEX_TRUST_PROJECT === '1'

    const configs = new Map<string, MCPServerConfig>()
    const skipped: LoadedMCPConfigs['skipped'] = []

    const accept = (
      name: string,
      server: Omit<MCPServerConfig, 'name'>,
      source: 'user' | 'project',
    ) => {
      if (!server.command || typeof server.command !== 'string') return
      if (server.disabled || disabled.has(name)) return
      if (source === 'project' && !trustProject && !enabled.has(name)) {
        skipped.push({
          name,
          source: 'project',
          reason: `not trusted; add "${name}" to mcp.enabled in ${join(flexHome(), 'config', 'config.json')} to allow it`,
        })
        return
      }
      // Later sources win, and a project file can never replace a user-defined server.
      if (source === 'project' && configs.get(name)?.source === 'user') return
      configs.set(name, { ...server, name, source })
    }

    for (const [name, server] of Object.entries(await readServers(join(flexHome(), 'mcp.json')))) {
      accept(name, server, 'user')
    }
    for (const [name, server] of Object.entries(options.inline ?? {})) {
      accept(name, server as Omit<MCPServerConfig, 'name'>, 'user')
    }
    for (const file of [
      join(workspaceRoot, '.flex', 'mcp.json'),
      join(workspaceRoot, '.mcp.json'),
    ]) {
      for (const [name, server] of Object.entries(await readServers(file))) {
        accept(name, server, 'project')
      }
    }
    return { configs: [...configs.values()], skipped }
  }

  async registerServers(
    configs: MCPServerConfig[],
    registry: ToolRegistry,
  ): Promise<{ connected: string[]; failed: Array<{ name: string; error: string }> }> {
    const connected: string[] = []
    const failed: Array<{ name: string; error: string }> = []

    // Servers start concurrently; one slow server must not delay the prompt by
    // the sum of all their start-up times.
    await Promise.all(
      configs.map(async (config) => {
        if (this.connections.has(config.name)) return
        try {
          const conn = new MCPServerConnection(config)
          const tools = await conn.connect()
          this.connections.set(config.name, conn)
          for (const toolDef of tools) {
            const adapted = adaptMCPTool(config.name, toolDef, conn, config.capabilities)
            // Two servers (or a server and a built-in) can collide on a name;
            // the first registration keeps it.
            if (registry.has(adapted.name)) continue
            registry.register(adapted)
          }
          connected.push(config.name)
        } catch (err) {
          failed.push({
            name: config.name,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }),
    )
    return { connected, failed }
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map((c) => c.close()))
    this.connections.clear()
  }

  getConnectedServers(): string[] {
    return Array.from(this.connections.keys())
  }
}

export const mcpManager = new MCPManager()
