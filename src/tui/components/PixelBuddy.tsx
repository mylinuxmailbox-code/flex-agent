import { Text } from 'ink'
import type { AgentState } from '../../agent/events.js'
import { statePhrase, stateStyle, theme } from '../theme.js'

/**
 * Pixel Buddy — Flex's mascot and status indicator.
 *
 * Two rendering modes on purpose. `Sprite` is the full pixel-art companion for
 * the header and first-run banner. `BuddyLine` is the compact one-liner used
 * while work is streaming, because a seven-line sprite in the middle of a
 * transcript is noise, not personality.
 *
 * Animation is frame-indexed off a shared tick passed in as a prop. The
 * component itself owns no timer, so a hundred buddies in a list cost nothing
 * and never fight each other for timers.
 */

type Sprite = readonly string[]

/**
 * The base creature, 9 wide. Frames differ only where it matters: the eyes and
 * the mouth carry the entire emotional range, which is what makes it read at
 * 9 columns.
 */
const SPRITES: Record<AgentState, readonly Sprite[]> = {
  idle: [
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ▄   ▄ █', '█ ▀▄▄▄▀ █', '██     ██', ' ▀▀▀▀▀▀▀ '],
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ▄   ▄ █', '█ ▀▄▄▄▀ █', '██     ██', ' ▀▀▀▀▀▀▀ '],
  ],
  thinking: [
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ░   ░ █', '█ ▀▄▄▄▀ █', '██     ██', ' ▀▀▀▀▀▀▀ '],
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ▒   ▒ █', '█ ▀▄▄▄▀ █', '██     ██', ' ▀▀▀▀▀▀▀ '],
  ],
  gathering: [
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ▄▄   ██', '█ ▀▀▄▄▄ █', '██     ██', ' ▀▀▀▀▀▀▀ '],
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█   ▄▄ ██', '█ ▄▄▀▀ ██', '██     ██', ' ▀▀▀▀▀▀▀ '],
  ],
  planning: [
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ▄▄ ▄▄ █', '█ ▀▀ ▀▀ █', '██     ██', ' ▀▀▀▀▀▀▀ '],
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ▄▄ ▄▄ █', '█ ▀▀ ▀▀ █', '██     ██', ' ▀▀▀▀▀▀▀ '],
  ],
  acting: [
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ▓▓ ▓▓ █', '█ ▀▄▄▄▀ █', '██     ██', ' ▀▀▀▀▀▀▀ '],
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ▓▓ ▓▓ █', '█ ▀▄▄▄▀ █', '██  ▄  ██', ' ▀▀▀▀▀▀▀ '],
  ],
  verifying: [
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ▒▒ ▒▒ █', '█ ▀▄▄▄▀ █', '██     ██', ' ▀▀▀▀▀▀▀ '],
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ▓▓ ▓▓ █', '█ ▀▄▄▄▀ █', '██     ██', ' ▀▀▀▀▀▀▀ '],
  ],
  reviewing: [
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ░▒▒░ █', '█ ▀▄▄▄▀ █', '██  ▄  ██', ' ▀▀▀▀▀▀▀ '],
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ░▒▒░ █', '█ ▀▄▄▄▀ █', '██     ██', ' ▀▀▀▀▀▀▀ '],
  ],
  waiting_permission: [
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ░   ░ █', '█ ▀▀▀▀▀ █', '██     ██', ' ▀▀▀▀▀▀▀ '],
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ░   ░ █', '█ ▀▀▀▀▀ █', '██     ██', ' ▀▀▀▀▀▀▀ '],
  ],
  done: [
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ▄   ▄ █', '█ ▀▄▄▄▀ █', '██  ▄  ██', ' ▀▀▀▀▀▀▀ '],
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ▄▄ ▄▄ █', '█ ▀▀▀▀▀ █', '██     ██', ' ▀▀▀▀▀▀▀ '],
  ],
  error: [
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ▒   ▒ █', '█ ▀▄▄▄▀ █', '██     ██', ' ▀▀▀▀▀▀▀ '],
    [' ▄▄▄▄▄▄▄ ', '██     ██', '█ ▒   ▒ █', '█ ▀▄▄▄▀ █', '██     ██', ' ▀▀▀▀▀▀▀ '],
  ],
}

export interface SpriteProps {
  state: AgentState
  /** Shared animation tick. 0 renders the first frame. */
  tick?: number
  color?: string
}

/** Full pixel-art buddy. Nine columns, six rows. */
export function PixelBuddy({ state, tick = 0, color = theme.brand }: SpriteProps) {
  const frames = SPRITES[state]
  const frame = frames[Math.floor(tick) % frames.length] ?? frames[0]
  return (
    <Text color={color} bold>
      {frame?.join('\n')}
    </Text>
  )
}

export interface BuddyLineProps {
  state: AgentState
  tick?: number
  /** Overrides the default phrase, e.g. "reading src/auth.ts". */
  detail?: string
  showLabel?: boolean
}

/** The compact status line: `◆ Pixel is thinking...` */
export function BuddyLine({ state, tick = 0, detail, showLabel = true }: BuddyLineProps) {
  const style = stateStyle(state)
  const phrase = detail ?? statePhrase(state)
  const spinner = state === 'idle' || state === 'done' ? style.glyph : glyphFor(tick)
  return (
    <Text>
      <Text color={style.color} bold>
        {spinner}
      </Text>
      {showLabel ? (
        <Text color={theme.textFaint}>
          {' '}
          {state === 'idle' || state === 'done' ? 'Pixel Buddy' : 'Pixel'}{' '}
        </Text>
      ) : (
        <Text> </Text>
      )}
      <Text color={style.color}>{phrase}</Text>
      {state === 'thinking' || state === 'acting' ? (
        <Text color={theme.textFaint}>{'.'.repeat(1 + (Math.floor(tick) % 3))}</Text>
      ) : null}
    </Text>
  )
}

function glyphFor(tick: number): string {
  return ['◐', '◓', '◑', '◒'][Math.floor(tick) % 4] ?? '◐'
}

const glyph2 = ['◐', '◓', '◑', '◒']

export { glyph2 as spinnerFrames }
