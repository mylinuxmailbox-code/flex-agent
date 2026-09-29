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

    // Only the SDK's small safe environment (PATH, HOME, ...) plus what the
    // server's config asks for. Passing all of process.env would hand every
    // API key in the parent to every third-party server.
    this.transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args ?? [],
      env: this.config.env ?? {},
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      stderr: 'ignore',
    })

    const timeoutMs = this.config.timeoutMs ?? 15_000
    await withTimeout(
      (async () => {
        await this.client?.connect(this.transport as StdioClientTransport)
      })(),
      timeoutMs,
      `MCP server "${this.config.name}" did not start within ${timeoutMs / 1000}s`,
    ).catch(async (err) => {
      await this.close()
      throw err
    })

    const listResult = await this.client.listTools()
    this.tools = listResult.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as MCPToolDefinition['inputSchema'],
    }))

    return this.tools
  }

  async callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    options?: { signal?: AbortSignal },
  ): Promise<{
    content: Array<{ type: string; text?: string; [key: string]: unknown }>
    isError?: boolean
  }> {
    if (!this.client) {
      throw new Error(`MCP server "${this.config.name}" is not connected.`)
    }

    const result = await this.client.callTool(
      { name: params.name, arguments: params.arguments ?? {} },
      undefined,
      options?.signal ? { signal: options.signal } : undefined,
    )

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

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
