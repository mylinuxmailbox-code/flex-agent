import { z } from 'zod'
import type { ActionDescription } from '../permissions/types.js'
import type { Tool, ToolCategory, ToolContext, ToolResult } from '../tools/types.js'
import { errorResult, fail, ok } from '../tools/types.js'
import type { MCPToolDefinition } from './types.js'

export interface MCPCaller {
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{
    content: Array<{ type: string; text?: string; [key: string]: unknown }>
    isError?: boolean
  }>
}

export interface MCPCapabilities {
  /** Tool names the server declares as read-only. Everything else is assumed to write. */
  readOnlyTools?: readonly string[]
  /** What this server is allowed to reach. Informational in the permission dialog. */
  networkHosts?: readonly string[]
  filesystem?: 'none' | 'workspace'
  shell?: 'none' | 'sandboxed'
  credentials?: 'none' | 'requested'
}

/**
 * Adapt an MCP tool into a first-class Flex tool.
 *
 * The important decision here is the risk floor. An MCP server is third-party
 * code running outside this process; Flex cannot inspect what `create_issue`
 * or `delete_repo` actually do. Guessing "readOnly" from the tool's name and
 * then auto-approving it because it scored `low` is how a plugin ends up
 * deleting something. So: a tool is only treated as read-only when the server
 * explicitly says so, and anything undeclared is raised to `high`, which is
 * above the auto threshold in every mode.
 */
export function adaptMCPTool(
  serverName: string,
  toolDef: MCPToolDefinition,
  caller: MCPCaller,
  capabilities: MCPCapabilities = {},
): Tool {
  const flexName = `mcp__${serverName}__${toolDef.name}`
  const description = `[MCP: ${serverName}] ${toolDef.description ?? toolDef.name}`

  // Read-only is a *declaration*, not a guess from the name. `get_delete` is a
  // real thing and so is `list_repos`.
  const declaredReadOnly = capabilities.readOnlyTools?.includes(toolDef.name) ?? false
  const isReadOnly = declaredReadOnly
  const requiresApproval = !declaredReadOnly || capabilities.credentials === 'requested'

  // Flexible schema accepting whatever input properties the MCP tool expects
  const inputSchema = z.record(z.string(), z.unknown())

  return {
    name: flexName,
    description,
    inputSchema,
    readOnly: isReadOnly,
    category: 'code' as ToolCategory,

    promptGuidance:
      `This tool is provided by the external MCP server "${serverName}". ` +
      (declaredReadOnly
        ? 'It is declared read-only.'
        : 'It is NOT declared read-only, so it will require approval before it runs.'),

    plan(input: Record<string, unknown>, ctx: ToolContext): ActionDescription {
      return {
        tool: flexName,
        purpose: `MCP tool ${toolDef.name} on ${serverName}`,
        input,
        cwd: ctx.cwd,
        network: (capabilities.networkHosts ?? [`mcp:${serverName}`]).map((host) => ({
          host,
          protocol: 'other' as const,
          transmits: 'tool arguments',
        })),
        // An undeclared third-party tool is raised to high by the classifier,
        // which is above every auto threshold — so it prompts.
        signals: requiresApproval ? ['production-modification'] : undefined,
      }
    },

    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      ctx.emit({ type: 'status', text: `Calling ${flexName}` })

      try {
        const response = await caller.callTool({
          name: toolDef.name,
          arguments: input,
        })

        const textParts = response.content
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text as string)
        const combined = textParts.join('\n\n')

        if (response.isError) {
          return fail(combined || 'MCP tool reported an error.', `${flexName} failed`)
        }

        return ok(combined || '(empty response)', `${flexName} succeeded`, {
          raw: response.content,
        })
      } catch (err) {
        return errorResult(err, `${flexName} error`)
      }
    },
  }
}
