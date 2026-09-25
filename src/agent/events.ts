import type { StopReason, Usage } from '../models/types.js'
import type { PermissionPrompt } from '../permissions/types.js'
import type { ToolEvent } from '../tools/types.js'

/**
 * Everything the agent runtime tells the outside world.
 *
 * The TUI renders this and nothing else; the loop never touches Ink. That
 * separation is what lets the same agent run headless, under test, or behind a
 * plugin UI without changing a line of runtime code.
 */
export type AgentEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'citation'; url: string; title?: string }
  /** A tool call has been authorized and is about to run. */
  | { type: 'tool_start'; id: string; name: string; display: string }
  /** A tool the model asked for is waiting on the user. */
  | { type: 'permission_request'; prompt: PermissionPrompt }
  | { type: 'tool_progress'; id: string; event: ToolEvent }
  | {
      type: 'tool_end'
      id: string
      name: string
      display: string
      isError: boolean
      durationMs: number
      summary: string
    }
  /** The model asked for permission and was refused; it will try another route. */
  | { type: 'permission_denied'; id: string; name: string; reason: string }
  | { type: 'plan'; steps: PlanStep[] }
  /** A subagent started, finished, or reported activity. */
  | {
      type: 'agent_activity'
      id: string
      role: string
      label: string
      state: 'starting' | 'running' | 'done' | 'failed' | 'cancelled'
      detail?: string
    }
  | { type: 'status'; state: AgentState; detail?: string }
  | { type: 'usage'; usage: Usage; contextUsed: number; contextWindow: number }
  | { type: 'context_compacted'; beforeTokens: number; afterTokens: number }
  | { type: 'turn_end'; turn: number; stopReason: StopReason }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'error'; error: Error }
  | { type: 'done'; stopReason: StopReason }

export type AgentState =
  | 'idle'
  | 'thinking'
  | 'gathering'
  | 'planning'
  | 'acting'
  | 'verifying'
  | 'reviewing'
  | 'waiting_permission'
  | 'done'
  | 'error'

export interface PlanStep {
  id: string
  text: string
  status: 'pending' | 'active' | 'done' | 'skipped' | 'failed'
  /** Tool calls or subagents that belong to this step. */
  detail?: string
}

/** Pixel Buddy's mood follows the agent's state. */
export const STATE_GLYPH: Record<AgentState, string> = {
  idle: '●',
  thinking: '◐',
  gathering: '◍',
  planning: '◇',
  acting: '◆',
  verifying: '◈',
  reviewing: '◉',
  waiting_permission: '⏸',
  done: '●',
  error: '✗',
}

export const STATE_LABEL: Record<AgentState, string> = {
  idle: 'Ready',
  thinking: 'thinking',
  gathering: 'exploring',
  planning: 'planning',
  acting: 'working',
  verifying: 'verifying',
  reviewing: 'reviewing',
  waiting_permission: 'waiting for you',
  done: 'finished',
  error: 'hit an error',
}
