import { z } from 'zod'
import {
  formatSubagentResults,
  type SubagentResult,
  type SubagentRunner,
} from '../../agent/orchestrator/runner.js'
import { SUBAGENT_ROLES, type SubagentRole } from '../../agent/subagents/roles.js'
import type { Tool, ToolResult } from '../types.js'
import { errorResult, fail, ok } from '../types.js'

/**
 * Parallel subagent delegation.
 *
 * The main agent decides *what* is worth parallelising; this tool is how it
 * says so. It is only advertised when the effort profile has subagents enabled,
 * so in single-agent modes the model never sees a way to spawn work it was not
 * asked to fan out.
 *
 * The report that comes back is the structured summary, not a transcript — the
 * main agent reasons over conclusions, not over 40k tokens of tool output.
 */

const ROLES = Object.keys(SUBAGENT_ROLES) as [SubagentRole, ...SubagentRole[]]

const inputSchema = z.object({
  agents: z
    .array(
      z.object({
        role: z
          .enum(ROLES)
          .describe(
            'What this subagent is for: explorer, researcher, architect, debugger, implementer, reviewer, tester, security-reviewer, performance-analyst, dependency-analyst, documentation-researcher.',
          ),
        task: z
          .string()
          .min(1)
          .describe(
            'A self-contained brief. The subagent cannot see your conversation, so include everything it needs: the goal, the relevant context, and what a useful answer looks like.',
          ),
      }),
    )
    .min(1)
    .max(8)
    .describe('The subagents to run. All of them run in parallel.'),
})

export function createSpawnSubagentTool(
  runner: SubagentRunner | null,
  maxConcurrency: number,
): Tool<typeof inputSchema> {
  return {
    name: 'spawn_subagent',
    description:
      'Delegate independent work to subagents that run in parallel, then read their reports. Use it when the work genuinely splits — exploring different areas, researching documentation, reviewing from independent angles. Do not use it for a question you can answer yourself in one step: a subagent that re-derives what you already know is pure cost.',
    inputSchema,
    readOnly: false,
    category: 'task',
    promptGuidance: [
      'Each `task` must be self-contained. A subagent cannot see this conversation.',
      'Spawn for real parallelism: independent areas of investigation, or independent reviews of the same change.',
      'Roles are scoped. An explorer cannot edit; a reviewer deliberately cannot edit. Choose the role for what you need, not for prestige.',
      'You remain responsible for the final answer. Subagents report; you decide.',
    ].join(' '),

    plan(input, ctx) {
      return {
        tool: this.name,
        input,
        purpose: `spawn ${input.agents.length} subagent(s): ${input.agents.map((a) => a.role).join(', ')}`,
        cwd: ctx.cwd,
        // Delegation can produce side effects through an implementer role, so
        // it is never auto-approved.
        signals: input.agents.some((a) => a.role === 'implementer' || a.role === 'tester')
          ? ['production-modification']
          : undefined,
      }
    },

    async execute(input, ctx): Promise<ToolResult> {
      if (!runner) {
        return fail(
          'Subagents are not available in this mode. Switch to /effort ultracode or /effort maxcode.',
          'spawn unavailable',
        )
      }
      if (input.agents.length > maxConcurrency + 2) {
        return fail(
          `That is ${input.agents.length} subagents; the current mode runs at most ${maxConcurrency} concurrently. ` +
            'Pick the ones that actually need to run in parallel.',
          'spawn too many',
        )
      }

      const controller = new AbortController()
      // Honour cancellation of the parent turn.
      const onAbort = () => controller.abort()
      ctx.signal.addEventListener('abort', onAbort, { once: true })

      try {
        const results: SubagentResult[] = await runner.fanOut({
          specs: input.agents.map((agent, i) => ({
            id: `sub-${i}-${agent.role}`,
            role: agent.role,
            task: agent.task,
          })),
          signal: controller.signal,
          onActivity: (id, text) => ctx.emit({ type: 'status', text: `${id}: ${text}` }),
        })

        const summary = [
          `${results.length} subagent(s) finished.`,
          `Tool calls: ${results.reduce((n, r) => n + r.toolCalls, 0)}.`,
          '',
          formatSubagentResults(results),
          '',
          'Synthesise these into one answer. If they disagree, say so and say which you believe and why.',
        ].join('\n')

        const failed = results.filter((r) => r.status !== 'completed')
        return ok(summary, `${results.length} subagents (${failed.length} failed)`, {
          results: results.map((r) => ({ role: r.role, status: r.status, report: r.report })),
        })
      } catch (err) {
        return errorResult(err, 'spawn failed')
      } finally {
        ctx.signal.removeEventListener('abort', onAbort)
      }
    },
  }
}
