import { z } from 'zod'
import type { PlanStep } from '../../agent/events.js'
import type { Tool, ToolResult } from '../types.js'
import { ok } from '../types.js'

/**
 * The plan tool.
 *
 * The model keeps its plan here rather than in prose so the UI can render it,
 * and so a compaction can drop the reasoning while keeping the checklist. Plans
 * are updated as reality changes — a step that turned out to be wrong gets
 * marked failed or dropped, not quietly left as "done".
 */

const todoSchema = z.object({
  steps: z
    .array(
      z.object({
        text: z
          .string()
          .min(1)
          .describe('One concrete step, phrased as something to do, not a topic.'),
        status: z
          .enum(['pending', 'active', 'done', 'skipped', 'failed'])
          .optional()
          .describe('Defaults to pending. Mark exactly one step active while you work on it.'),
        detail: z.string().optional().describe('Short qualifier, e.g. a file or command.'),
      }),
    )
    .min(1)
    .max(40)
    .describe('The full plan, in order. Send the whole list every time, not just the changes.'),
})

export const todoTool: Tool<typeof todoSchema> = {
  name: 'update_plan',
  description:
    'Record or revise the plan for a substantial task. Send the complete list each time with updated statuses, so the user always sees the real state. Use it for multi-step work; skip it for a single obvious edit.',
  inputSchema: todoSchema,
  readOnly: false,
  category: 'task',
  promptGuidance: [
    'Write steps that are concrete and verifiable ("add a regression test for the null token path"), not topics ("look at auth").',
    'Keep exactly one step active. When reality contradicts the plan, change the plan rather than pretending.',
  ].join(' '),

  plan(input) {
    return { tool: this.name, input, purpose: `plan (${input.steps.length} steps)` }
  },

  async execute(input, ctx): Promise<ToolResult> {
    const steps: PlanStep[] = input.steps.map((step, index) => ({
      id: `step-${index}`,
      text: step.text,
      status: step.status ?? 'pending',
      detail: step.detail,
    }))

    // More than one active step means the plan has stopped describing reality.
    const active = steps.filter((s) => s.status === 'active')
    const note =
      active.length > 1
        ? `\n\n[Note: ${active.length} steps are marked active. Only one should be at a time.]`
        : ''

    ctx.emit({ type: 'plan', steps })

    return ok(
      `Plan recorded: ${steps.length} steps (${steps.filter((s) => s.status === 'done').length} done, ${active.length} active).${note}`,
      `plan (${steps.length})`,
      { steps },
    )
  },
}
