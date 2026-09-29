import { Box, Text, useWindowSize } from 'ink'
import type { AgentState } from '../../agent/events.js'
import type { StatusInfo } from '../store.js'
import { stateStyle, theme } from '../theme.js'
import { PixelBuddy } from './PixelBuddy.js'

/**
 * The top chrome: identity, live model state, and where you are.
 *
 * Kept to one line plus a rule. A header that grows becomes furniture, and
 * furniture costs the transcript the vertical space the user actually wants.
 */

export interface HeaderProps {
  status: StatusInfo
  agentState: AgentState
  tick: number
}

export function Header({ status, agentState, tick }: HeaderProps) {
  const { columns } = useWindowSize()
  const width = Math.max(40, columns - 2)
  const style = stateStyle(agentState)

  const cwd = shortenPath(status.cwd, Math.floor(width * 0.35))
  const right = [
    status.modelLabel,
    formatEffort(status.effort),
    status.permissionMode === 'full-control'
      ? status.sandboxIsolated
        ? '⚡ NO PROMPTS'
        : '⚡ FULL CONTROL'
      : status.permissionMode === 'auto'
        ? 'Auto'
        : 'Ask',
    status.sandboxIsolated ? 'Sandbox' : '⚠ No sandbox',
  ]

  const leftWidth = Math.max(10, width - right.join('   ').length - 4)
  const rightText = right.join('   ')

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.brand} bold>
          {'▌'}
        </Text>
        <Text color={theme.brand} bold>
          {' FLEX'}
        </Text>
        <Text color={theme.textFaint}>{' '.repeat(Math.max(1, leftWidth - 6))}</Text>
        <Text color={status.permissionMode === 'full-control' ? theme.warn : theme.textDim}>
          {rightText}
        </Text>
      </Box>

      <Box marginTop={0}>
        <Box width={11}>
          <Text>{compactBuddy(agentState, tick)}</Text>
        </Box>
        <Box flexDirection="column">
          <Text color={style.color}>{stateWord(agentState)}</Text>
          <Text color={theme.textFaint}>
            {cwd}
            {status.gitBranch ? `   ${status.gitBranch}` : ''}
          </Text>
        </Box>
      </Box>

      <Text color={theme.border}>{'─'.repeat(width)}</Text>
    </Box>
  )
}

/** One-line Pixel Buddy: a glyph plus a word, never the full sprite. */
function compactBuddy(state: AgentState, tick: number): string {
  const frames = ['◐', '◓', '◑', '◒']
  const glyphChar =
    state === 'idle' || state === 'done' ? '●' : (frames[Math.floor(tick) % 4] ?? '◐')
  return `${glyphChar} `
}

function stateWord(state: AgentState): string {
  switch (state) {
    case 'idle':
      return 'Ready'
    case 'thinking':
      return 'Thinking'
    case 'gathering':
      return 'Exploring'
    case 'planning':
      return 'Planning'
    case 'acting':
      return 'Working'
    case 'verifying':
      return 'Verifying'
    case 'reviewing':
      return 'Reviewing'
    case 'waiting_permission':
      return 'Needs approval'
    case 'done':
      return 'Done'
    case 'error':
      return 'Error'
  }
}

function formatEffort(effort: string): string {
  if (effort === 'xhigh') return 'xHigh'
  if (effort === 'ultracode') return 'Ultracode'
  if (effort === 'maxcode') return 'Maxcode'
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** `~/dev/flex` rather than a 60-character absolute path that ruins the layout. */
export function shortenPath(path: string, max: number): string {
  const home = process.env.HOME
  let short = path
  if (home && path.startsWith(home)) short = `~${path.slice(home.length)}`
  if (short.length <= max) return short
  const parts = short.split('/')
  let out = parts[parts.length - 1] ?? short
  for (let i = parts.length - 2; i >= 0; i--) {
    const candidate = `${parts[i]}/${out}`
    if (candidate.length + 2 > max) break
    out = candidate
  }
  return `…/${out}`
}

export interface StatusBarProps {
  status: StatusInfo
  width: number
  hint?: string
}

/**
 * The bottom bar: the things worth knowing without asking.
 *
 * Model, effort, permission posture, isolation, context, tools, elapsed time.
 * Each segment is dropped from the right as the terminal narrows, so a narrow
 * window loses detail rather than wrapping into a second line.
 */
export function StatusBar({ status, width, hint }: StatusBarProps) {
  const segments: Array<{ text: string; color: string; key: string }> = [
    { key: 'model', text: status.modelLabel, color: theme.text },
    { key: 'effort', text: formatEffort(status.effort), color: theme.brand },
    {
      key: 'perm',
      text:
        status.permissionMode === 'full-control'
          ? status.sandboxIsolated
            ? '⚡ no-prompts'
            : '⚡ full-control'
          : status.permissionMode === 'auto'
            ? 'auto'
            : 'ask',
      color: status.permissionMode === 'full-control' ? theme.warn : theme.textDim,
    },
    {
      key: 'sandbox',
      text: status.sandboxIsolated ? `sandbox:${status.sandboxBackend}` : '⚠ unsandboxed',
      color: status.sandboxIsolated ? theme.accent : theme.warn,
    },
    { key: 'ctx', text: formatContext(status), color: contextColor(status) },
    { key: 'tools', text: `${status.toolCount} tools`, color: theme.textDim },
    { key: 'time', text: formatElapsed(status.elapsedMs), color: theme.textDim },
  ]

  let used = 0
  const shown: typeof segments = []
  for (const segment of segments) {
    const cost = segment.text.length + 3
    if (used + cost > width - 2) break
    used += cost
    shown.push(segment)
  }

  return (
    <Box flexDirection="column">
      <Text color={theme.border}>{'─'.repeat(Math.max(10, width))}</Text>
      <Box>
        <Text color={theme.brandDim} bold>
          FLEX
        </Text>
        <Text color={theme.border}>{' │ '}</Text>
        {shown.map((segment, i) => (
          <Text key={segment.key}>
            {i > 0 ? <Text color={theme.border}> │ </Text> : null}
            <Text color={segment.color}>{segment.text}</Text>
          </Text>
        ))}
        {hint ? (
          <Text>
            <Text color={theme.border}> │ </Text>
            <Text color={theme.textFaint}>{hint}</Text>
          </Text>
        ) : null}
      </Box>
    </Box>
  )
}

function formatContext(status: StatusInfo): string {
  const used = status.contextUsed
  const window = status.contextWindow
  if (used === 0) return '0 ctx'
  if (used < 1000) return `${used} ctx`
  if (window >= 1_000_000)
    return `${Math.round(used / 1000)}k/${Math.round(window / 1000_000)}M ctx`
  return `${Math.round(used / 1000)}k/${Math.round(window / 1000)}k ctx`
}

function contextColor(status: StatusInfo): string {
  const ratio = status.contextWindow > 0 ? status.contextUsed / status.contextWindow : 0
  if (ratio > 0.85) return theme.error
  if (ratio > 0.6) return theme.warn
  return theme.textDim
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
}

export { PixelBuddy }
