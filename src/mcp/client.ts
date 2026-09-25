import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { MCPCaller } from './adapter.js'
import type { MCPServerConfig, MCPToolDefinition } from './types.js'

export class MCPServerConnection implements MCPCaller {
  readonly config: MCPServerConfig
  private client: Client | null = null
  private transport: StdioClientTransport | null = null
  private tools: MCPToolDefinition[] = []

  constructor(config: MCPServerConfig) {
    this.config = config
  }

  async connect(): Promise<MCPToolDefinition[]> {
    this.client = new Client(
      {
        name: `flex-mcp-${this.config.name}`,
        version: '0.1.0',
      },
      {
        capabilities: {},
      },
    )

    this.transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args ?? [],
      // StdioClientTransport wants Record<string,string>; process.env can hold
      // undefined, which is dropped rather than stringified.
      env: Object.fromEntries(
        Object.entries({ ...process.env, ...(this.config.env ?? {}) }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    })

    await this.client.connect(this.transport)

    const listResult = await this.client.listTools()
    this.tools = listResult.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as MCPToolDefinition['inputSchema'],
    }))

    return this.tools
  }

  async callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{
    content: Array<{ type: string; text?: string; [key: string]: unknown }>
    isError?: boolean
  }> {
    if (!this.client) {
      throw new Error(`MCP server "${this.config.name}" is not connected.`)
    }

    const result = await this.client.callTool({
      name: params.name,
      arguments: params.arguments ?? {},
    })

    return {
      content: result.content as Array<{ type: string; text?: string }>,
      isError: result.isError as boolean | undefined,
    }
  }

  async close(): Promise<void> {
    try {
      await this.transport?.close()
    } catch {
      // ignore
    }
    this.client = null
    this.transport = null
  }

  getTools(): readonly MCPToolDefinition[] {
    return this.tools
  }
}
