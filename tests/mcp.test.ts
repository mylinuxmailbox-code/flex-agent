import { describe, expect, it } from 'vitest'
import { adaptMCPTool, type MCPCaller } from '../src/mcp/adapter.js'
import type { ToolContext } from '../src/tools/types.js'

describe('adaptMCPTool', () => {
  it('adapts an MCP tool into a Flex Tool with plan and execution', async () => {
    const fakeCaller: MCPCaller = {
      async callTool(params) {
        expect(params.name).toBe('query_db')
        expect(params.arguments).toEqual({ query: 'SELECT 1' })
        return {
          content: [{ type: 'text', text: 'Result: 1 row' }],
          isError: false,
        }
      },
    }

    const tool = adaptMCPTool(
      'sqlite',
      {
        name: 'query_db',
        description: 'Run SQL query',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
      fakeCaller,
    )

    expect(tool.name).toBe('mcp__sqlite__query_db')
    expect(tool.description).toContain('[MCP: sqlite]')

    const ctx = {
      cwd: '/workspace',
      workspaceRoot: '/workspace',
      emit: () => {},
      noteFileChange: () => {},
    } as unknown as ToolContext

    const plan = tool.plan({ query: 'SELECT 1' }, ctx)
    expect(plan.tool).toBe('mcp__sqlite__query_db')
    expect(plan.input).toEqual({ query: 'SELECT 1' })

    const result = await tool.execute({ query: 'SELECT 1' }, ctx)
    expect(result.content).toBe('Result: 1 row')
    expect(result.isError).toBeFalsy()
  })

  it('handles MCP tool errors cleanly', async () => {
    const fakeCaller: MCPCaller = {
      async callTool() {
        return {
          content: [{ type: 'text', text: 'Table not found' }],
          isError: true,
        }
      },
    }

    const tool = adaptMCPTool(
      'sqlite',
      {
        name: 'read_table',
        description: 'Read a table',
        inputSchema: { type: 'object' },
      },
      fakeCaller,
    )

    const ctx = {
      cwd: '/workspace',
      emit: () => {},
    } as unknown as ToolContext

    const result = await tool.execute({}, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Table not found')
  })
})
