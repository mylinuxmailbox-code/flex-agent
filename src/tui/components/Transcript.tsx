import { Box, Text, useInput } from 'ink'
import type { TranscriptItem } from '../store.js'
import { theme } from '../theme.js'
import { formatElapsed } from './Chrome.jsx'
import { Markdown } from './Markdown.jsx'

/**
 * The conversation.
 *
 * Three rules shape this: the user's own words are visually distinct from the
 * agent's, tool calls collapse to one line until you ask for detail, and
 * nothing is hidden that the user might need to audit.
 */

export interface TranscriptProps {
  items: readonly TranscriptItem[]
  width: number
  expanded: ReadonlySet<string>
  onToggle: (id: string) => void
}

export function Transcript({ items, width, expanded, onToggle }: TranscriptProps) {
  if (items.length === 0) {
    return <Welcome width={width} />
  }
  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <TranscriptRow
          key={item.id}
          item={item}
          width={width}
          isExpanded={expanded.has(item.id)}
          onToggle={onToggle}
        />
      ))}
    </Box>
  )
}

function TranscriptRow({
  item,
  width,
  isExpanded,
  onToggle,
}: {
  item: TranscriptItem
  width: number
  isExpanded: boolean
  onToggle: (id: string) => void
}) {
  switch (item.kind) {
    case 'user':
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.textFaint}>You</Text>
          <Box paddingLeft={2} flexDirection="column">
            <Text color={theme.text}>{item.text}</Text>
          </Box>
        </Box>
      )

    case 'assistant':
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.brand} bold>
            ◆ Pixel
          </Text>
          <Box paddingLeft={2}>
            <Markdown text={item.text || (item.streaming ? '' : '(no output)')} width={width - 4} />
          </Box>
          {item.citations.length > 0 ? <Citations citations={item.citations} /> : null}
        </Box>
      )

    case 'tool':
      return (
        <ToolRow
          id={item.id}
          name={item.name}
          display={item.display}
          status={item.status}
          summary={item.summary}
          durationMs={item.durationMs}
          output={item.output}
          width={width}
          isExpanded={isExpanded}
          onToggle={onToggle}
        />
      )

    case 'notice':
      return (
        <Box marginTop={1}>
          <Text color={noticeColor(item.level)}>
            {item.level === 'error' ? '✗ ' : item.level === 'warn' ? '! ' : '· '}
            {item.text}
          </Text>
        </Box>
      )

    case 'plan':
      return <PlanPanel steps={item.steps} />

    case 'divider':
      return (
        <Box marginTop={1}>
          <Text color={theme.border}>
            {'─'.repeat(width)} {item.text}
          </Text>
        </Box>
      )

    case 'diff':
      return (
        <Box marginTop={1} paddingLeft={2}>
          <Text color={theme.info}>{item.path}</Text>
          <DiffLines diff={item.diff} width={width - 4} />
        </Box>
      )

    default:
      return null
  }
}

function noticeColor(level: 'info' | 'warn' | 'error'): string {
  return level === 'error' ? theme.error : level === 'warn' ? theme.warn : theme.textFaint
}

// ---------------------------------------------------------------------------
// tool rows
// ---------------------------------------------------------------------------

interface ToolRowProps {
  id: string
  /** Kept for the expanded view's heading. */
  name: string
  display: string
  status: 'running' | 'done' | 'error' | 'denied'
  summary: string
  durationMs: number
  output: string
  width: number
  isExpanded: boolean
  onToggle: (id: string) => void
}

function ToolRow({
  id,
  name,
  display,
  status,
  summary,
  durationMs,
  output,
  width,
  isExpanded,
  onToggle,
}: ToolRowProps) {
  // Enter expands the focused row. Only one row is focusable at a time, which
  // is why this lives inside the row rather than in a global keymap.
  useInput((_input, key) => {
    if (key.return) onToggle(id)
  })

  const marker =
    status === 'running' ? '◐' : status === 'error' ? '✗' : status === 'denied' ? '⊘' : '✓'
  const color =
    status === 'running'
      ? theme.brand
      : status === 'error'
        ? theme.error
        : status === 'denied'
          ? theme.warn
          : theme.accent

  const timing = status === 'running' ? '' : formatElapsed(durationMs)

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={color}>{marker} </Text>
        <Text color={theme.textDim}>⚙ </Text>
        <Text color={status === 'running' ? theme.text : theme.textDim}>{display}</Text>
        {timing ? <Text color={theme.textFaint}> {timing}</Text> : null}
        {output || summary ? <Text color={theme.textFaint}> ⏎</Text> : null}
      </Box>

      {isExpanded ? (
        <Box flexDirection="column" paddingLeft={4} marginTop={0}>
          <Text color={theme.textFaint}>{name}</Text>
          {summary ? (
            <Text color={status === 'error' ? theme.error : theme.textDim}>{summary}</Text>
          ) : null}
          {output ? <DiffLines diff={output} width={width - 6} /> : null}
        </Box>
      ) : null}
    </Box>
  )
}

function DiffLines({ diff }: { diff: string; width?: number }) {
  const lines = diff.split('\n').slice(0, 60)
  return (
    <Box flexDirection="column" marginTop={0}>
      {lines.map((line, i) => {
        const color = line.startsWith('+')
          ? theme.added
          : line.startsWith('-')
            ? theme.removed
            : line.startsWith('@@')
              ? theme.info
              : theme.textFaint
        return (
          <Text key={i} color={color} wrap="truncate-end">
            {line}
          </Text>
        )
      })}
      {diff.split('\n').length > 60 ? (
        <Text color={theme.textFaint}>… {diff.split('\n').length - 60} more lines</Text>
      ) : null}
    </Box>
  )
}

function Citations({ citations }: { citations: ReadonlyArray<{ url: string; title?: string }> }) {
  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={0}>
      {citations.map((citation, i) => (
        <Text key={i} color={theme.info} wrap="truncate-end">
          {`  [${i + 1}] ${citation.title ?? citation.url}`}
        </Text>
      ))}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

function PlanPanel({ steps }: { steps: readonly import('../../agent/events.js').PlanStep[] }) {
  if (steps.length === 0) return null
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      paddingX={1}
      borderStyle="round"
      borderTop={false}
      borderRight={false}
      borderColor={theme.border}
    >
      <Text color={theme.textFaint} bold>
        PLAN
      </Text>
      {steps.map((step) => (
        <Box key={step.id}>
          <Text color={planColor(step.status)}>{planMarker(step.status)} </Text>
          <Text
            color={
              step.status === 'done'
                ? theme.textFaint
                : step.status === 'active'
                  ? theme.text
                  : theme.textDim
            }
          >
            {step.text}
          </Text>
          {step.detail ? <Text color={theme.textFaint}> {step.detail}</Text> : null}
        </Box>
      ))}
    </Box>
  )
}

function planMarker(status: string): string {
  switch (status) {
    case 'done':
      return '✓'
    case 'active':
      return '◆'
    case 'failed':
      return '✗'
    case 'skipped':
      return '–'
    default:
      return '◇'
  }
}

function planColor(status: string): string {
  switch (status) {
    case 'done':
      return theme.accent
    case 'active':
      return theme.brand
    case 'failed':
      return theme.error
    default:
      return theme.textFaint
  }
}

// ---------------------------------------------------------------------------
// welcome
// ---------------------------------------------------------------------------

function Welcome({ width }: { width: number }) {
  const boxWidth = Math.min(52, width - 4)
  const pad = ' '.repeat(Math.max(0, Math.floor((boxWidth - 30) / 2)))
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text color={theme.brand} bold>
        {`╭${'─'.repeat(boxWidth - 2)}╮`}
      </Text>
      <Text color={theme.brand}>{`│${' '.repeat(boxWidth - 2)}│`}</Text>
      <Text
        color={theme.brand}
      >{`│${pad}F L E X${' '.repeat(Math.max(0, boxWidth - 2 - pad.length - 6))}│`}</Text>
      <Text color={theme.brand}>{`│${' '.repeat(boxWidth - 2)}│`}</Text>
      <Text
        color={theme.accent}
      >{`│   ░█  Pixel Buddy  █░   ${' '.repeat(Math.max(0, boxWidth - 26))}│`}</Text>
      <Text color={theme.brand}>{`│${' '.repeat(boxWidth - 2)}│`}</Text>
      <Text color={theme.textDim}>
        {`│  Your autonomous coding partner. ${' '.repeat(Math.max(0, boxWidth - 35))}│`}
      </Text>
      <Text color={theme.brand}>{`╰${'─'.repeat(boxWidth - 2)}╯`}</Text>
      <Box marginTop={1} flexDirection="column" paddingLeft={2}>
        <Text color={theme.textDim}>Tell Pixel what you want to build, fix, or understand.</Text>
        <Text color={theme.textFaint}>/help for commands · Esc to interrupt · Ctrl+D to exit</Text>
      </Box>
    </Box>
  )
}
