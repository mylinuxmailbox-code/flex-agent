import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import type { PermissionChoice, PermissionPrompt } from '../../permissions/types.js'
import { riskColor, riskGlyph, theme } from '../theme.js'

/**
 * The permission prompt.
 *
 * The design rule here is that approval must be an informed decision. A bare
 * "Allow? y/n" forces the user to either trust blindly or interrupt everything;
 * this shows what will happen, how risky it is, and *why* the classifier
 * reached that verdict, so the answer is usually obvious.
 */

export interface PermissionDialogProps {
  prompt: PermissionPrompt
  onChoice: (choice: PermissionChoice) => void
  width: number
}

const CHOICES: ReadonlyArray<{
  key: string
  label: string
  choice: PermissionChoice
  color: string
}> = [
  { key: '1', label: 'Allow once', choice: 'allow-once', color: theme.accent },
  { key: '2', label: 'Allow for this task', choice: 'allow-for-task', color: theme.warn },
  { key: '3', label: 'Deny', choice: 'deny', color: theme.error },
]

export function PermissionDialog({ prompt, onChoice, width }: PermissionDialogProps) {
  const [selected, setSelected] = useState(0)
  const inner = Math.max(40, Math.min(78, width - 6))
  const color = riskColor[prompt.risk.level]

  useInput((inputChar, key) => {
    if (key.escape) {
      onChoice('deny')
      return
    }
    if (key.upArrow) {
      setSelected((i) => (i - 1 + CHOICES.length) % CHOICES.length)
      return
    }
    if (key.downArrow) {
      setSelected((i) => (i + 1) % CHOICES.length)
      return
    }
    if (key.return) {
      onChoice(CHOICES[selected]?.choice ?? 'deny')
      return
    }
    // Number keys and the conventional y/n, because muscle memory is real.
    if (inputChar === '1') onChoice('allow-once')
    if (inputChar === '2') onChoice('allow-for-task')
    if (inputChar === '3' || inputChar === 'n') onChoice('deny')
    if (inputChar === 'y') onChoice('allow-once')
    if (inputChar === 'a') onChoice('allow-once')
  })

  return (
    <Box flexDirection="column" marginY={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={color}
        paddingX={1}
        width={inner}
      >
        <Text color={color} bold>
          Permission required
        </Text>

        <Box marginTop={1}>
          <Text color={theme.textDim}>Pixel Buddy needs your approval.</Text>
        </Box>

        <Field label="Action" width={inner}>
          <Text color={theme.text}>{prompt.preview}</Text>
        </Field>

        <Field label="Risk" width={inner}>
          <Text color={color} bold>
            {riskGlyph[prompt.risk.level]} {prompt.risk.level.toUpperCase()}
          </Text>
          {prompt.risk.irreversible ? <Text color={theme.error}> · cannot be undone</Text> : null}
          {prompt.risk.external ? <Text color={theme.warn}> · leaves this machine</Text> : null}
        </Field>

        <Field label="Why" width={inner}>
          {prompt.risk.reasons.slice(0, 4).map((reason, i) => (
            <Text key={i} color={theme.textDim}>
              · {reason}
            </Text>
          ))}
        </Field>

        {prompt.action.purpose && prompt.action.purpose !== prompt.preview ? (
          <Field label="Purpose" width={inner}>
            <Text color={theme.textDim}>{prompt.action.purpose}</Text>
          </Field>
        ) : null}

        <Box marginTop={1} flexDirection="column">
          {CHOICES.map((choice, i) => (
            <Box key={choice.choice}>
              <Text color={i === selected ? theme.brand : theme.textFaint}>
                {i === selected ? ' ❯ ' : '   '}
              </Text>
              <Text color={choice.color} bold={i === selected}>
                {choice.label.padEnd(22)}
              </Text>
              <Text color={theme.textFaint}>[{choice.key}]</Text>
            </Box>
          ))}
        </Box>
      </Box>
      <Text color={theme.textFaint}> ↑↓ to choose · Enter to confirm · Esc denies</Text>
    </Box>
  )
}

function Field({
  label,
  children,
  width,
}: {
  label: string
  children: React.ReactNode
  width: number
}) {
  const labelWidth = 9
  return (
    <Box marginTop={1}>
      <Box width={labelWidth} flexShrink={0}>
        <Text color={theme.textFaint}>{label}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} width={width - labelWidth - 2}>
        {children}
      </Box>
    </Box>
  )
}
