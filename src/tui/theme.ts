/**
 * Flex's visual language.
 *
 * One place for every colour, glyph and box-drawing character, so the UI reads
 * as a single system rather than a pile of components. Colours are chosen to
 * survive both light and dark terminals: no colour is load-bearing on its own,
 * every state also has a distinct glyph.
 */

import type { AgentState } from '../agent/events.js'

export const theme = {
  brand: '#7C6BFF',
  brandDim: '#4B3FA8',
  accent: '#39D98A',
  warn: '#F0B429',
  error: '#FF5C7A',
  info: '#4CC9F0',

  text: '#D4D4D8',
  textDim: '#8A8A96',
  textFaint: '#5A5A66',
  border: '#3A3A46',
  borderActive: '#7C6BFF',

  added: '#39D98A',
  removed: '#FF5C7A',
} as const

export const glyph = {
  bullet: '◆',
  diamond: '◇',
  check: '✓',
  cross: '✗',
  arrow: '›',
  spinner: ['◐', '◓', '◑', '◒'],
  bar: '│',
  horizontal: '─',
  vertical: '│',
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  teeDown: '┬',
  teeUp: '┴',
  teeRight: '├',
  teeLeft: '┤',
} as const

/** Risk colouring for the permission dialog. */
export const riskColor = {
  safe: theme.accent,
  low: theme.info,
  medium: theme.warn,
  high: '#FF9F45',
  critical: theme.error,
} as const

export const riskGlyph = {
  safe: '✓',
  low: '✓',
  medium: '!',
  high: '!!',
  critical: '!!!',
} as const

/** One glyph + colour per agent state; used by the status line and header. */
export function stateStyle(state: AgentState): { glyph: string; color: string } {
  switch (state) {
    case 'idle':
      return { glyph: '●', color: theme.accent }
    case 'thinking':
      return { glyph: '◐', color: theme.brand }
    case 'gathering':
      return { glyph: '◍', color: theme.info }
    case 'planning':
      return { glyph: '◇', color: theme.info }
    case 'acting':
      return { glyph: '◆', color: theme.brand }
    case 'verifying':
      return { glyph: '◈', color: theme.warn }
    case 'reviewing':
      return { glyph: '◉', color: theme.warn }
    case 'waiting_permission':
      return { glyph: '⏸', color: theme.warn }
    case 'done':
      return { glyph: '●', color: theme.accent }
    case 'error':
      return { glyph: '✗', color: theme.error }
  }
}

/** Human sentence for a state, used in the Pixel Buddy line. */
export function statePhrase(state: AgentState): string {
  switch (state) {
    case 'idle':
      return 'Ready'
    case 'thinking':
      return 'thinking'
    case 'gathering':
      return 'exploring the codebase'
    case 'planning':
      return 'planning'
    case 'acting':
      return 'working'
    case 'verifying':
      return 'verifying the change'
    case 'reviewing':
      return 'reviewing the work'
    case 'waiting_permission':
      return 'waiting for you'
    case 'done':
      return 'finished'
    case 'error':
      return 'hit an error'
  }
}
